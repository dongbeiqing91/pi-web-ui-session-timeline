/**
 * session-timeline — server side.
 *
 * Global (cross-project) session timeline:
 *   1. walk <agentDir>/sessions/--<cwd>--/*.jsonl for every project
 *   2. stat all files, sort by mtime desc (newest first)
 *   3. parse the head of the top-N files (header cwd/id, session_info name,
 *      first user message) — mirrors the host's own parsing
 *      (server/session-parser.ts) in a lightweight read-only form
 *   4. serve GET /list (10s cache)
 *
 * agentDir resolution mirrors the pi SDK getAgentDir():
 *   PI_CODING_AGENT_DIR env (tilde-expanded) else ~/.pi/agent.
 *
 * Note: the plugin runs inside the host server process, so raw node:fs is
 * available (same precedent as the official session-migrate plugin). The
 * manifest still declares "fs" to make the intent explicit.
 */
import { openSync, readdirSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const READ_CAP_BYTES = 512 * 1024; // per-file head search budget (system prompts can be 100KB+)
const TAIL_BYTES = 256 * 1024; // tail window for the latest rename
const LINE_CAP_BYTES = 1024 * 1024; // one line longer than this is skipped
const MAX_LINES = 300;
const FILE_CACHE_MAX = 1024;
const CACHE_TTL_MS = 10_000;
const LIMIT_MIN = 20;
const LIMIT_MAX = 2000;
const LIMIT_DEFAULT = 300;
const TITLE_MAX = 120;

function expandTilde(p) {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR
	? expandTilde(String(process.env.PI_CODING_AGENT_DIR).trim())
	: join(homedir(), ".pi", "agent");
const SESSIONS_ROOT = join(AGENT_DIR, "sessions");

/**
 * Read up to MAX_LINES lines from the first READ_CAP_BYTES of the file,
 * byte-accurate (multibyte chars never split across chunks). Lines longer
 * than LINE_CAP_BYTES are skipped. The session header (line 1) is always
 * small; the first user message normally follows the (possibly huge)
 * system message.
 */
function readHeadLines(filePath) {
	const lines = [];
	let fd = null;
	try {
		fd = openSync(filePath, "r");
		let pos = 0;
		const chunk = Buffer.alloc(64 * 1024);
		let carry = Buffer.alloc(0);
		while (pos < READ_CAP_BYTES && lines.length < MAX_LINES) {
			const n = readSync(fd, chunk, 0, Math.min(chunk.length, READ_CAP_BYTES - pos), pos);
			if (n <= 0) break;
			pos += n;
			const data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
			carry = Buffer.alloc(0);
			let start = 0;
			while (start < data.length) {
				const nl = data.indexOf(0x0a, start); // "\n"
				if (nl < 0) break;
				const lineBuf = data.subarray(start, nl);
				start = nl + 1;
				if (lineBuf.length > LINE_CAP_BYTES) continue; // oversized line — skip
				const line = lineBuf.toString("utf8");
				if (line.trim()) lines.push(line);
				if (lines.length >= MAX_LINES) break;
			}
			if (lines.length < MAX_LINES && start < data.length) carry = Buffer.from(data.subarray(start));
		}
	} catch {
		/* unreadable file — treat as empty */
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* already closed */
			}
		}
	}
	return lines;
}

/** user message content: string | [{text}] (same shape as the host parser). */
function userMessageText(msg) {
	if (!msg) return "";
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.map((p) => (p && typeof p.text === "string" ? p.text : ""))
			.filter(Boolean)
			.join(" ");
	}
	return "";
}

/**
 * Extract { id, cwd, name, firstMessage } from head lines.
 */
function extractHead(lines) {
	let id = "";
	let cwd = "";
	let name = "";
	let firstMessage = "";
	for (const line of lines) {
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		if (!rec || typeof rec !== "object") continue;
		if (rec.type === "session") {
			id = typeof rec.id === "string" ? rec.id : "";
			cwd = typeof rec.cwd === "string" ? rec.cwd : "";
		} else if (rec.type === "session_info") {
			if (typeof rec.name === "string" && rec.name.trim()) name = rec.name.trim();
		} else if (rec.type === "message" && !firstMessage) {
			if (rec.message && rec.message.role === "user") {
				const text = userMessageText(rec.message).replace(/\s+/g, " ").trim();
				if (text) firstMessage = text.slice(0, TITLE_MAX);
			}
		}
		if (name && firstMessage && cwd) break; // everything we need is in
	}
	return { id, cwd, name, firstMessage };
}

function parseSessionHead(filePath, size) {
	const head = extractHead(readHeadLines(filePath));
	// Long-running sessions get renamed late: the latest session_info can sit
	// far beyond the head window. Scan a tail window for it; last name wins
	// (same semantics as the host's full-file parse).
	const tailName = readTailName(filePath, size);
	if (tailName) head.name = tailName;
	return head;
}

/**
 * Find the latest rename (last `session_info` with a name) in the last
 * TAIL_BYTES of the file. Returns null when not found (or when the head
 * window already covered the whole file).
 */
function readTailName(filePath, size) {
	if (!size || size <= READ_CAP_BYTES) return null;
	const from = size - TAIL_BYTES;
	let buf = null;
	let fd = null;
	try {
		fd = openSync(filePath, "r");
		const full = Buffer.alloc(TAIL_BYTES);
		const n = readSync(fd, full, 0, full.length, from);
		buf = full.subarray(0, n);
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* already closed */
			}
		}
	}
	const firstNl = buf.indexOf(0x0a); // drop the (possibly partial) first line
	if (firstNl < 0) return null; // whole window is one line — skip
	let start = firstNl + 1;
	let name = null;
	while (start < buf.length) {
		const nl = buf.indexOf(0x0a, start);
		if (nl < 0) break;
		const lineBuf = buf.subarray(start, nl);
		start = nl + 1;
		if (!lineBuf.includes("session_info")) continue;
		let rec;
		try {
			rec = JSON.parse(lineBuf.toString("utf8"));
		} catch {
			continue;
		}
		if (rec && rec.type === "session_info" && typeof rec.name === "string" && rec.name.trim()) {
			name = rec.name.trim();
		}
	}
	return name;
}

/** Persistent head cache: path -> { mtime, size, head }. Old sessions are
 *  immutable, so repeated scans only re-parse files that changed. */
const fileHeadCache = new Map();

function parseSessionHeadCached(filePath, mtime, size) {
	const hit = fileHeadCache.get(filePath);
	if (hit && hit.mtime === mtime && hit.size === size) return hit.head;
	const head = parseSessionHead(filePath, size);
	fileHeadCache.set(filePath, { mtime, size, head });
	if (fileHeadCache.size > FILE_CACHE_MAX) {
		fileHeadCache.delete(fileHeadCache.keys().next().value);
	}
	return head;
}

/**
 * Scan every project dir under SESSIONS_ROOT.
 * Pass 1: stat all .jsonl files → sort by mtime desc → keep top `limit`.
 * Pass 2: parse headers only for those (keeps the scan cheap).
 */
function scanAll(limit) {
	const candidates = [];
	let projectDirs = [];
	try {
		projectDirs = readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory());
	} catch {
		projectDirs = [];
	}
	for (const d of projectDirs) {
		const dir = join(SESSIONS_ROOT, d.name);
		let entries = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.isFile() || !e.name.toLowerCase().endsWith(".jsonl")) continue;
			const fp = join(dir, e.name);
			try {
				const st = statSync(fp);
				candidates.push({ path: fp, mtime: st.mtimeMs, size: st.size });
			} catch {
				/* deleted between readdir and stat */
			}
		}
	}
	candidates.sort((a, b) => b.mtime - a.mtime);
	return candidates.slice(0, limit).map((c) => {
		const head = parseSessionHeadCached(c.path, c.mtime, c.size);
		const stem = basename(c.path).replace(/\.jsonl$/i, "");
		return {
			path: c.path,
			mtime: Math.floor(c.mtime),
			id: head.id,
			cwd: head.cwd,
			cwdName: head.cwd ? basename(head.cwd) || head.cwd : "",
			title: head.name || head.firstMessage || stem,
		};
	});
}

let cache = { key: "", at: 0, sessions: null };

function clampLimit(v) {
	const n = Math.floor(Number(v ?? ""));
	if (!Number.isFinite(n)) return LIMIT_DEFAULT;
	return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, n));
}

export default {
	activate(host) {
		const log = (level, msg) => {
			try {
				host.log(level, msg);
			} catch {
				/* host.log unavailable — ignore */
			}
		};
		log("info", `session-timeline active, scanning ${SESSIONS_ROOT}`);

		host.route("GET", "/list", (req, res) => {
			try {
				// Explicit ?limit= wins; otherwise the plugin setting (default 300).
				const q = req.query && typeof req.query === "object" ? req.query : {};
				let limit;
				if (q.limit !== undefined && q.limit !== "") limit = clampLimit(q.limit);
				else {
					const s = host.getSettings?.() ?? {};
					limit = clampLimit(s.limit);
				}
				const key = String(limit);
				const now = Date.now();
				if (!cache.sessions || cache.key !== key || now - cache.at > CACHE_TTL_MS) {
					cache = { key, at: now, sessions: scanAll(limit) };
				}
				res.json({ ok: true, count: cache.sessions.length, sessions: cache.sessions });
			} catch (e) {
				res.status(500).json({ ok: false, error: String(e?.message ?? e) });
			}
		});
	},
};

// Named exports for standalone unit tests (the host loads the default export).
export { SESSIONS_ROOT, parseSessionHead, scanAll };
