/**
 * session-timeline — pi-web-ui plugin (server side).
 *
 * Global, cross-project session timeline: scans the pi session store
 * (~/.pi/agent/sessions), sorts sessions by file mtime (newest first),
 * and serves the top N to the client over a plugin HTTP route.
 *
 * The native pi-web-ui left panel only lists the *current* project's
 * sessions; this plugin covers every project at once.
 *
 * The plugin runs in the pi-web-ui host process and reads the session
 * store directly with node:fs (same precedent as the official
 * session-migrate plugin) — no per-call fs authorization prompts.
 *
 * Session file layout (JSONL, one record per line):
 *   line 1: {"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/abs/path"}
 *   ...
 *   {"type":"session_info","name":"..."}   (rename; the LAST one wins — it
 *                                           can sit megabytes into the file)
 *   {"type":"message","message":{"role":"user","content": string|[{type:"text",text}]}}
 *
 * Title precedence (same "last rename wins" semantics as the host):
 *   latest session_info name  →  first user message  →  filename stem
 */
import { openSync, readdirSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const CHUNK_BYTES = 256 * 1024; // sequential read chunk
const CARRY_CAP_BYTES = 2 * 1024 * 1024; // a single line longer than this is dropped
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

/** Flatten a message's content (string | array of parts) to plain text. */
function userMessageText(msg) {
	const c = msg?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.filter((p) => p && (p.type === "text" || typeof p.text === "string"))
			.map((p) => p.text)
			.join(" ");
	}
	return "";
}

/**
 * Single-pass full-file scan.
 *
 * Tracks, in one sequential read:
 *   - the session header (line 1) → id + cwd
 *   - the first user message → title fallback
 *   - the LAST session_info with a name → latest rename (last wins,
 *     exactly the host's semantics — a head+tail window is NOT enough,
 *     because active sessions keep appending far more than any fixed
 *     tail budget after their last rename)
 *
 * Lines are prefiltered by substring before JSON.parse, so per-line
 * cost is a cheap `includes` for the ~99% of records that matter not.
 * Cost is one read of the file (~10-30 ms for multi-MB files on SSD).
 */
function parseSessionFile(filePath) {
	let id = "";
	let cwd = "";
	let name = "";
	let firstMessage = "";
	let foundFirstUser = false;
	let carry = "";

	const processLine = (line) => {
		if (!line) return;
		const relevant = line.includes('"session') || (!foundFirstUser && line.includes('"role":"user"'));
		if (!relevant) return;
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			return;
		}
		if (!rec || typeof rec !== "object") return;
		if (rec.type === "session") {
			if (!id) {
				id = typeof rec.id === "string" ? rec.id : "";
				cwd = typeof rec.cwd === "string" ? rec.cwd : "";
			}
		} else if (rec.type === "session_info") {
			if (typeof rec.name === "string" && rec.name.trim()) name = rec.name.trim();
		} else if (!foundFirstUser && rec.type === "message" && rec.message && rec.message.role === "user") {
			const text = userMessageText(rec.message).replace(/\s+/g, " ").trim();
			if (text) firstMessage = text.slice(0, TITLE_MAX);
			foundFirstUser = true;
		}
	};

	const fd = openSync(filePath, "r");
	const chunk = Buffer.alloc(CHUNK_BYTES);
	try {
		for (;;) {
			const n = readSync(fd, chunk, 0, chunk.length);
			if (n <= 0) break;
			const data = carry + chunk.subarray(0, n).toString("utf8");
			const lastNl = data.lastIndexOf("\n");
			if (lastNl < 0) {
				carry = data.length > CARRY_CAP_BYTES ? "" : data; // oversized single line — drop
				continue;
			}
			carry = data.slice(lastNl + 1);
			const body = data.slice(0, lastNl);
			const nl = body.indexOf("\n");
			if (nl < 0) {
				processLine(body);
			} else {
				let start = 0;
				while (start < body.length) {
					const i = body.indexOf("\n", start);
					if (i < 0) {
						processLine(body.slice(start));
						break;
					}
					processLine(body.slice(start, i));
					start = i + 1;
				}
			}
		}
		if (carry) processLine(carry);
	} finally {
		closeSync(fd);
	}
	return { id, cwd, name, firstMessage };
}

/** Persistent parse cache: path -> { mtime, size, parsed }. Old sessions
 *  are immutable (pi appends only to the active one), so repeated scans
 *  only re-read files that actually changed. */
const fileCache = new Map();

function parseSessionCached(filePath, mtime, size) {
	const hit = fileCache.get(filePath);
	if (hit && hit.mtime === mtime && hit.size === size) return hit.parsed;
	const parsed = parseSessionFile(filePath);
	fileCache.set(filePath, { mtime, size, parsed });
	if (fileCache.size > FILE_CACHE_MAX) {
		fileCache.delete(fileCache.keys().next().value);
	}
	return parsed;
}

/**
 * Scan every project dir under SESSIONS_ROOT.
 * Pass 1: stat all .jsonl files → sort by mtime desc → keep top `limit`.
 * Pass 2: single-pass parse only those (with mtime/size caching).
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
		const parsed = parseSessionCached(c.path, c.mtime, c.size);
		const stem = basename(c.path).replace(/\.jsonl$/i, "");
		return {
			path: c.path,
			mtime: Math.floor(c.mtime),
			id: parsed.id,
			cwd: parsed.cwd,
			cwdName: parsed.cwd ? basename(parsed.cwd) || parsed.cwd : "",
			title: parsed.name || parsed.firstMessage || stem,
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
				const force = q.refresh === "1" || q.refresh === "true";
				const key = String(limit);
				const now = Date.now();
				if (force || !cache.sessions || cache.key !== key || now - cache.at > CACHE_TTL_MS) {
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
export { SESSIONS_ROOT, parseSessionFile, scanAll };
