/**
 * session-timeline — client side.
 *
 * Module top level: take over the topbar 🕘 button (onUiAction → openModal).
 * Registration must happen at module top level: the host loads this bundle
 * on demand when the button is clicked, then polls for the action handler
 * for ~1.5s — registering inside mount() would be too late.
 *
 * Default export: the modal view — a cross-project session timeline
 * (newest first, grouped by project). Clicking a row jumps to that session:
 *   - current project  → host.sessions.open(path)
 *   - other project    → host.openSession({cwd, newChat:false}) (the host
 *                        pops its native dir-authorization confirm when the
 *                        project is unknown) → wait for the new project's
 *                        session list to be pushed → host.sessions.open(path)
 *
 * Re-entrant on purpose: plugins_reload re-imports the bundle and the
 * previous instance must be torn down first (same contract as conv-title).
 */

const RUNTIME_KEY = "__piSessionTimelineRuntime";

/** A "running" conversation in the client's list stays there after it is
 *  opened — even when the agent has been idle for hours. So the green
 *  "in progress" dot requires real activity: the conversation is streaming
 *  right now, or its session file was written to within this window. */
const ACTIVE_WINDOW_MS = 5 * 60_000;
/** The left-panel section always shows the last 7 days only (hard limit); the modal offers a period select. */
const SECTION_DAYS = 7;
const DAYS_OPTIONS = ["180", "30", "7", "1"]; // modal select values, widest first
const DAYS_DEFAULT = "180";
const DAYS_KEY = "stModalDays"; // localStorage: last modal period choice

function readDays() {
	try {
		const v = localStorage.getItem(DAYS_KEY);
		return DAYS_OPTIONS.includes(v) ? v : DAYS_DEFAULT;
	} catch {
		return DAYS_DEFAULT;
	}
}
function saveDays(v) {
	try {
		localStorage.setItem(DAYS_KEY, v);
	} catch {
		/* storage unavailable — choice just won't persist */
	}
}
const previous = globalThis[RUNTIME_KEY];
if (previous?.destroy) {
	try {
		previous.destroy();
	} catch {
		/* previous instance already broken */
	}
}

/** Derive the plugin API base from our own bundle URL so the plugin keeps
 *  working under nginx sub-path proxies (conv-title pattern). */
const API_BASE = (() => {
	try {
		const u = new URL(import.meta.url);
		const i = u.pathname.indexOf("/plugins/");
		const root = i >= 0 ? u.pathname.slice(0, i) : "";
		return `${u.origin}${root}/plugins-api/session-timeline`;
	} catch {
		return "/plugins-api/session-timeline";
	}
})();

function bridge() {
	return globalThis.window?.__piWebUiHost ?? null;
}

function relTime(ms) {
	const now = new Date();
	const d = now.getTime() - ms;
	if (d < 60_000) return "刚刚";
	const m = Math.floor(d / 60_000);
	if (m < 60) return `${m} 分钟前`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} 小时前`;
	const day = Math.floor(h / 24);
	if (day === 1) return "昨天";
	if (day < 7) return `${day} 天前`;
	const dt = new Date(ms);
	const mm = `${dt.getMonth() + 1}`.padStart(2, "0");
	const dd = `${dt.getDate()}`.padStart(2, "0");
	return now.getFullYear() === dt.getFullYear() ? `${mm}-${dd}` : `${dt.getFullYear()}-${mm}-${dd}`;
}

function titleMatches(a, b) {
	if (!a || !b) return false;
	if (a === b) return true;
	// Running-conversation titles and file-parsed titles can differ in
	// truncation (the timeline caps titles at 120 chars) — compare on a
	// common prefix instead.
	const ta = String(a).trim().slice(0, 80);
	const tb = String(b).trim().slice(0, 80);
	return ta.length >= 12 && (ta.startsWith(tb) || tb.startsWith(ta));
}

function waitFor(cond, timeoutMs, intervalMs = 150) {
	return new Promise((resolve) => {
		const started = Date.now();
		const tick = () => {
			let ok = false;
			try {
				ok = cond() === true;
			} catch {
				ok = false;
			}
			if (ok) return resolve(true);
			if (Date.now() - started > timeoutMs) return resolve(false);
			setTimeout(tick, intervalMs);
		};
		tick();
	});
}

function setStatus(el, text) {
	if (!el) return;
	el.textContent = text;
	el.style.display = text ? "block" : "none";
}

/**
 * Jump to a session (item from /list). `statusEl` gets human-readable
 * progress / error text. `onSettled` (optional) fires after the attempt
 * finishes so the caller can re-render (badges / running dots).
 */
async function jumpTo(item, statusEl, onSettled) {
	const b = bridge();
	if (!b) {
		setStatus(statusEl, "宿主桥不可用（页面可能尚未加载完），稍后重试");
		return;
	}
	if (!b.sessions || typeof b.sessions.open !== "function") {
		setStatus(statusEl, "当前宿主版本过低（需要插件 API v6+ 的 sessions 接口）");
		return;
	}
	const settle = () => {
		try {
			if (typeof onSettled === "function") onSettled();
		} catch {
			/* cosmetic only */
		}
	};
	const landed = () => !!(item.id && location.hash && location.hash.includes("#s=" + item.id));
	const done = (msg) => {
		setStatus(statusEl, msg);
		settle();
		setTimeout(() => {
			if (typeof b.closeModal === "function") b.closeModal(); // no-op when the section (not a modal) triggered the jump
		}, 250);
	};
	setStatus(statusEl, `正在跳转到「${item.title}」…`);
	try {
		// Fast path: the session is already in this client's list (current
		// project's history, or any running conversation) → open directly.
		let r = await b.sessions.open(item.path);
		let err = r && r.ok !== true ? r.error || "打开会话失败" : null;
		// Heavy sessions: the host's open() confirmation can time out while
		// the switch itself is still completing. The active-session URL hash
		// is the ground truth — verify instead of declaring failure.
		if (err && /超时/.test(err) && await waitFor(landed, 8000)) {
			done("已跳转 ✓（会话较大，加载稍慢）");
			return;
		}
		if (err && !item.cwd) throw new Error(err);
		if (err) {
			// Slow path (cross-project): switch workspace first. Unknown
			// projects pop the host's native dir-authorization confirm;
			// refusal fails fast. (The public bridge has no getCwd, so we
			// detect "not the current project" via the failed open.)
			if (typeof b.openSession !== "function") {
				throw new Error("宿主 API 缺少 openSession，无法跨项目跳转");
			}
			const r1 = await b.openSession({ cwd: item.cwd, newChat: false });
			if (!r1 || r1.ok !== true) throw new Error((r1 && r1.error) || "切换项目失败（目录授权被拒？）");
			// The server pushes the new project's session list on switch;
			// sessions.open() only knows ids that are currently listed —
			// wait until our target shows up (native list is capped at 200).
			const listed = await waitFor(() => {
				const list = b.sessions.list ? b.sessions.list() : [];
				return list.some((s) => s.id === item.path);
			}, 10_000);
			if (!listed) {
				throw new Error("会话不在目标项目的可见列表中（可能超出左栏 200 条上限，请改用左栏「历史对话」打开）");
			}
			r = await b.sessions.open(item.path);
			err = r && r.ok !== true ? r.error || "打开会话失败" : null;
			if (err && /超时/.test(err) && await waitFor(landed, 8000)) {
				done("已跳转 ✓（会话较大，加载稍慢）");
				return;
			}
			if (err) throw new Error(err);
		}
		done("已跳转 ✓");
	} catch (e) {
		setStatus(statusEl, `跳转失败：${e.message ?? e}`);
		settle();
	}
}

/* ------------------------------------------------------------------ */
/* topbar 🕘 button → open our modal (module top level, re-entrant)    */
/* ------------------------------------------------------------------ */
let offAction = null;
let retryTimer = null;
let destroyed = false;

function registerAction() {
	if (destroyed) return true;
	const b = bridge();
	if (b && typeof b.onUiAction === "function") {
		try {
			offAction =
				b.onUiAction("session-timeline:open", () => {
					try {
						if (typeof b.openModal === "function" && b.openModal("session-timeline:timeline")) return;
						// pre-v10 host or hidden modal entry → full plugin page
						if (typeof b.setView === "function") b.setView("plugin:session-timeline");
					} catch {
						/* modal open failed silently */
					}
				}) ?? null;
			return true;
		} catch {
			/* bridge partial — retry on next tick */
		}
	}
	return false;
}

const runtime = {
	destroy() {
		destroyed = true;
		if (retryTimer) {
			clearInterval(retryTimer);
			retryTimer = null;
		}
		if (offAction) {
			try {
				offAction();
			} catch {
				/* already unregistered */
			}
			offAction = null;
		}
		if (globalThis[RUNTIME_KEY] === runtime) delete globalThis[RUNTIME_KEY];
	},
};
globalThis[RUNTIME_KEY] = runtime;

if (!registerAction()) {
	// The host bridge is installed after the app boots; poll briefly.
	const startedAt = Date.now();
	retryTimer = setInterval(() => {
		if (registerAction()) clearInterval(retryTimer);
		else if (Date.now() - startedAt > 15_000) clearInterval(retryTimer);
	}, 300);
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* the timeline view — two surfaces, one data pipeline                 */
/*                                                                     */
/* - modal (topbar 🕘): the original design — meta row + filter +      */
/*   refresh + compact rows.                                           */
/* - left-panel section: matches the host's 运行的对话 (running        */
/*   conversations) card design — project groups (.panel-conv-group)   */
/*   with cards (button.session-item: chat icon + title + sub). Host   */
/*   class names are reused on purpose so the look (including theme   */
/*   handling and the active purple highlight) stays identical.        */
/* ------------------------------------------------------------------ */
const VIEW_CSS = `
.st-view { display:flex; flex-direction:column; gap:10px; height:100%; min-height:200px; font-size:13px; padding:2px 12px 6px; }
.st-view.st-sec { gap:0; height:auto; min-height:0; overflow:visible; }
.st-top { display:flex; align-items:center; gap:8px; flex:none; }
.st-top .st-count { color:var(--text-dim,#888); font-size:12px; flex:1; }
.st-refresh { flex:none; display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0; border:none; border-radius:6px; background:transparent; color:var(--text-faint,#999); cursor:pointer; }
.st-refresh:hover:not(:disabled) { color:var(--text,#e6e8ef); background:var(--bg-elev2,rgba(127,127,127,.15)); }
.st-refresh:disabled { opacity:.5; cursor:default; }
.st-refresh svg { width:14px; height:14px; }
.st-days { flex:none; font-size:12px; padding:3px 6px; border:1px solid var(--border,#333); border-radius:6px; background:var(--bg-input,transparent); color:inherit; cursor:pointer; }
.st-filter { flex:none; width:100%; box-sizing:border-box; padding:6px 10px; font-size:13px; border:1px solid var(--border,#333); border-radius:6px; background:var(--bg-input,transparent); color:inherit; }
.st-filter:focus { outline:1px solid var(--accent,#5b9dff); }
.st-list { flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:2px; padding-right:2px; }
.st-sep { flex:none; display:flex; align-items:center; gap:4px; margin:8px 2px 3px; font-size:11px; letter-spacing:.4px; color:var(--text-dim,#888); user-select:none; }
.st-sep svg { flex:none; color:var(--text-faint,#999); }
.st-sep:first-child { margin-top:0; }
.st-row { flex:none; display:flex; align-items:baseline; gap:8px; padding:5px 8px; border-radius:6px; cursor:pointer; }
.st-row:hover { background:var(--bg-hover,rgba(127,127,127,.12)); }
.st-title { flex:1; min-width:0; text-align:left; border:none; background:none; color:inherit; font-size:13px; padding:0; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.st-title:hover { color:var(--accent,#5b9dff); text-decoration:underline; }
.st-title:disabled { opacity:.5; cursor:wait; }
.st-meta { flex:none; font-size:11px; color:var(--text-dim,#888); white-space:nowrap; }
.st-meta .st-cur { color:var(--accent,#5b9dff); }
.st-dot { flex:none; align-self:center; width:8px; height:8px; border-radius:50%; background:var(--green,#22c55e); animation:st-breathe 1.8s ease-in-out infinite; }
@keyframes st-breathe {
	0%,100% { opacity:1; transform:scale(1); box-shadow:0 0 0 0 rgba(34,197,94,.4); }
	50% { opacity:.45; transform:scale(.68); box-shadow:0 0 0 4px rgba(34,197,94,0); }
}
.st-status { flex:none; font-size:12px; color:var(--text-dim,#888); min-height:14px; display:none; }
.st-status.err { color:var(--red,#e5534b); }
.st-empty { padding:24px 8px; text-align:center; color:var(--text-dim,#888); font-size:12px; }
.st-sec-list { display:flex; flex-direction:column; }
.st-card { width:100%; border:none; cursor:pointer; font:inherit; }
.st-time { flex:none; white-space:nowrap; margin-left:4px; }
.st-run { animation:st-breathe 1.8s ease-in-out infinite; }
/* modal chrome (host-rendered, scoped to our modal via :has) */
.plugin-modal:has(.st-view) .modal-head { padding-top:24px; }
.plugin-modal .modal-head-icon.st-patched svg { width:16px; height:16px; }
`;

// Global listeners registered per mount (window hashchange in section
// mode) — torn down when their container leaves the DOM.
const teardowns = [];
function registerTeardown(container, fn) {
	for (let i = teardowns.length - 1; i >= 0; i--) {
		if (!teardowns[i].container.isConnected) {
			try {
				teardowns[i].fn();
			} catch {
				/* already gone */
			}
			teardowns.splice(i, 1);
		}
	}
	teardowns.push({ container, fn });
}

/** The session UUID the client has open right now (URL hash #s=<uuid>). */
function openSessionId() {
	const h = location.hash || "";
	if (h.startsWith("#s=")) return h.slice(3).split("&")[0];
	return null;
}

/** Chat-bubble icon, same markup as the host's .session-icon (lucide). */
function makeChatIcon() {
	const NS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("width", "1em");
	svg.setAttribute("height", "1em");
	svg.classList.add("session-icon");
	const p = document.createElementNS(NS, "path");
	p.setAttribute("d", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
	svg.appendChild(p);
	return svg;
}

/** Generic line-style (lucide) svg builder for the modal chrome patches. */
function makeLineSvg(cls, children) {
	const NS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("width", "1em");
	svg.setAttribute("height", "1em");
	if (cls) svg.classList.add(cls);
	for (const [tag, attrs] of children) {
		const el = document.createElementNS(NS, tag);
		for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
		svg.appendChild(el);
	}
	return svg;
}

// Same lucide clock the host uses for its own topbar icon (manifest iconSvg).
function makeClockIcon() {
	return makeLineSvg("st-line-icon", [
		["circle", { cx: "12", cy: "12", r: "10" }],
		["polyline", { points: "12 6 12 12 16 14" }],
	]);
}

// Folder path = the host's own 最近项目 project icon.
function makeFolderIcon() {
	return makeLineSvg("st-line-icon", [
		["path", { d: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" }],
	]);
}

// lucide rotate-cw for the refresh button.
function makeRefreshIcon() {
	return makeLineSvg("st-line-icon", [
		["path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" }],
		["path", { d: "M21 3v5h-5" }],
	]);
}

export default {
	mount(container, _ctx) {
		container.innerHTML = "";

		const style = document.createElement("style");
		style.textContent = VIEW_CSS;
		container.appendChild(style);

		// Left-panel section: the host mounts us into its PluginPage
		// (.lp-plugin-page). Modal: the container is the modal content div.
		const isSection = !!(
			container.classList?.contains("lp-plugin-page") ||
			container.closest?.(".lp-plugin-page")
		);

		const root = document.createElement("div");
		root.className = isSection ? "st-view st-sec" : "st-view";
		container.appendChild(root);

		const status = document.createElement("div");
		status.className = "st-status";

		let items = [];
		let loading = false;
		let haveData = false;
		let closed = false;
		let refreshBtn = null;
		let filter = null;
		let count = null;
		let list = null;
		let secList = null;
		let secCountEl = null;
		let daysSel = null;

		if (isSection) {
			secList = document.createElement("div");
			secList.className = "st-sec-list";
			root.append(secList, status);
			// The host's plugin section header has no count channel (native
			// sections render `label (n)`; plugin sections only `label`).
			// Append our own count span to the title text — React manages the
			// text nodes only, so the extra span survives header re-renders
		// (collapse toggles); a full panel remount re-runs mount(). Collapse
		// unmounts the body (→ re-mount on expand), so strip a leftover span
		// first to avoid doubling.
			const secWrap = container.closest(".lp-section-plugin");
			const titleSpan = secWrap?.querySelector(".lp-section-title-text");
			if (titleSpan) {
				titleSpan.querySelector(".st-sec-count")?.remove();
				const sp = document.createElement("span");
				sp.className = "st-sec-count";
				sp.textContent = "";
				titleSpan.appendChild(sp);
				secCountEl = sp;
			}
		} else {
			// modal surface: meta row + filter + scrolling list (original design)
			const top = document.createElement("div");
			top.className = "st-top";
			count = document.createElement("span");
			count.className = "st-count";
			count.textContent = "";
			refreshBtn = document.createElement("button");
			refreshBtn.type = "button";
			refreshBtn.className = "st-refresh";
			refreshBtn.title = "重新扫描会话文件";
			refreshBtn.append(makeRefreshIcon());
			// modal only: period select (180/30/7/1 days; last choice persisted)
			daysSel = document.createElement("select");
			daysSel.className = "st-days";
			for (const v of DAYS_OPTIONS) {
				const o = document.createElement("option");
				o.value = v;
				o.textContent = `${v} 天`;
				daysSel.appendChild(o);
			}
			daysSel.value = readDays();
			daysSel.title = "只显示最近 N 天内有活动的会话";
			top.append(count, daysSel, refreshBtn);

			filter = document.createElement("input");
			filter.className = "st-filter";
			filter.type = "text";
			filter.placeholder = "过滤标题 / 项目名…";

			list = document.createElement("div");
			list.className = "st-list";

			root.append(top, filter, list, status);
			// The host renders the modal title icon as a text glyph (the
			// manifest emoji); patch it to the line-style clock so the modal
			// header matches the topbar button (0.104.4's generic modal has no
			// iconSvg channel).
			const headIcon = container.closest(".modal")?.querySelector(".modal-head-icon");
			if (headIcon) {
				headIcon.textContent = "";
				headIcon.classList.add("st-patched");
				headIcon.append(makeClockIcon());
			}
		}

		const clientSessions = () => {
			const b = bridge();
			if (!b || typeof b.sessions?.list !== "function") return [];
			try {
				const l = b.sessions.list();
				return Array.isArray(l) ? l : [];
			} catch {
				return [];
			}
		};

		// "In progress" = a running conversation for this row that is either
		// streaming right now or whose session file was written to within
		// ACTIVE_WINDOW_MS (open-but-parked conversations do not get the dot).
		function runningInfo() {
			const client = clientSessions();
			const openable = new Set(client.map((s) => s.id));
			const running = client.filter((s) => s && s.kind === "running" && s.cwd && s.title);
			const nowMs = Date.now();
			const isRunning = (it) =>
				running.some(
					(s) =>
						s.cwd === it.cwd &&
						titleMatches(s.title, it.title) &&
						(s.isStreaming === true || nowMs - it.mtime <= ACTIVE_WINDOW_MS),
				);
			return { openable, isRunning };
		}

		/* ---- modal design (original: rows with 当前 badge + meta) ---- */
		function renderList() {
			list.innerHTML = "";
			const q = filter.value.trim().toLowerCase();
			// A session path that is in the client's own sessions.list()
			// belongs to the current project (history ids are file paths) →
			// opens directly.
			const { openable, isRunning } = runningInfo();
			let lastCwd = null;
			let shown = 0;
			for (const it of items) {
				if (
					q &&
					!(
						it.title.toLowerCase().includes(q) ||
						(it.cwdName || "").toLowerCase().includes(q) ||
						(it.cwd || "").toLowerCase().includes(q)
					)
				)
					continue;
				if (it.cwd !== lastCwd) {
					lastCwd = it.cwd;
					const sep = document.createElement("div");
					sep.className = "st-sep";
					// line-style folder, same as the host's 最近项目 rows
					sep.append(makeFolderIcon(), document.createTextNode(it.cwdName || "(未知项目)"));
					list.appendChild(sep);
				}
				const row = document.createElement("div");
				row.className = "st-row";
				const isCurrent = openable.has(it.path);
				if (isRunning(it)) {
					const dot = document.createElement("span");
					dot.className = "st-dot";
					dot.title = "正在进行中（正在生成，或 5 分钟内有活动）";
					row.appendChild(dot);
				}
				const titleBtn = document.createElement("button");
				titleBtn.type = "button";
				titleBtn.className = "st-title";
				titleBtn.textContent = it.title;
				titleBtn.title = `${it.title}\n${it.path}`;
				const meta = document.createElement("span");
				meta.className = "st-meta";
				if (isCurrent) {
					const cur = document.createElement("span");
					cur.className = "st-cur";
					cur.textContent = "当前 · ";
					meta.appendChild(cur);
				}
				meta.appendChild(document.createTextNode(relTime(it.mtime)));
				const doJump = () => {
					if (titleBtn.disabled) return;
					titleBtn.disabled = true;
					jumpTo(it, status, () => {
						if (!closed) renderList(); // refresh 当前 badge / running dots after the jump
					})
						.catch(() => {})
						.finally(() => {
							if (!closed) titleBtn.disabled = false;
						});
				};
				titleBtn.addEventListener("click", doJump);
				row.addEventListener("click", (e) => {
					if (e.target === row) doJump();
				});
				row.append(titleBtn, meta);
				list.appendChild(row);
				shown++;
			}
			if (shown === 0) {
				const empty = document.createElement("div");
				empty.className = "st-empty";
				empty.textContent = q ? "没有匹配的会话" : items.length ? "没有匹配的会话" : "未找到任何会话";
				list.appendChild(empty);
			}
			count.textContent = items.length
				? `${shown} / ${items.length} 条会话${getDays() ? ` · 最近 ${getDays()} 天` : ""} · 按修改时间由新到旧`
				: "";
		}

		/* ---- left-panel section design (matches 运行的对话 cards) ---- */
		function makeCard(it, { isRunning, openId }) {
			const row = document.createElement("div");
			row.className = "lp-row";
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "session-item st-card" + (openId && it.id === openId ? " active" : "");
			btn.title = `${it.title}\n${it.cwdName || it.cwd}\n${relTime(it.mtime)}\n${it.path}`;
			const info = document.createElement("span");
			info.className = "session-info";
			const title = document.createElement("span");
			title.className = "session-title";
			title.textContent = it.title;
			// sublabel = project name (like 运行的对话's elsewhere cards)
			const sub = document.createElement("span");
			sub.className = "session-sub";
			sub.textContent = it.cwdName || "(未知项目)";
			info.append(title, sub);
			// time on the right (session-info's flex:1 pushes it over)
			const time = document.createElement("span");
			time.className = "session-sub st-time";
			time.textContent = relTime(it.mtime);
			btn.append(makeChatIcon(), info, time);
			if (isRunning(it)) {
				const dot = document.createElement("span");
				dot.className = "conv-streaming st-run";
				dot.title = "正在进行中（正在生成，或 5 分钟内有活动）";
				btn.appendChild(dot);
			}
			const doJump = () => {
				if (btn.disabled) return;
				btn.disabled = true;
				jumpTo(it, status, () => {
					if (!closed) renderSection();
				})
					.catch(() => {})
					.finally(() => {
						if (!closed) btn.disabled = false;
					});
			};
			btn.addEventListener("click", doJump);
			row.appendChild(btn);
			return row;
		}

		function renderSection() {
			secList.innerHTML = "";
			const { isRunning } = runningInfo();
			const openId = openSessionId();
			if (secCountEl && haveData) secCountEl.textContent = ` (${items.length})`;
			// Flat card list, newest first (no project grouping).
			for (const it of items) secList.appendChild(makeCard(it, { isRunning, openId }));
			if (!items.length) {
				const empty = document.createElement("div");
				empty.className = "st-empty";
				empty.textContent = "未找到任何会话";
				secList.appendChild(empty);
			}
		}

		const render = () => (isSection ? renderSection() : renderList());

		const getDays = () => (isSection ? SECTION_DAYS : Number(daysSel?.value ?? DAYS_DEFAULT) || 0);

		async function load(force) {
			if (loading) return;
			loading = true;
			if (refreshBtn) refreshBtn.disabled = true;
			setStatus(status, "扫描会话文件中…");
			try {
				const params = new URLSearchParams();
				if (force) params.set("refresh", "1");
				const days = getDays();
				if (days) params.set("days", days);
				const qs = params.toString();
				const r = await fetch(qs ? `${API_BASE}/list?${qs}` : `${API_BASE}/list`, { credentials: "same-origin" });
				const data = await r.json().catch(() => null);
				if (!r.ok || !data || data.ok !== true) throw new Error((data && data.error) || `HTTP ${r.status}`);
				items = Array.isArray(data.sessions) ? data.sessions : [];
				haveData = true;
				render();
				setStatus(status, items.length ? "" : "会话目录为空");
			} catch (e) {
				items = [];
				render();
				status.classList.add("err");
				setStatus(status, `加载失败：${e.message ?? e}`);
			} finally {
				loading = false;
				if (refreshBtn) refreshBtn.disabled = false;
			}
		}

		if (daysSel) {
			daysSel.addEventListener("change", () => {
				saveDays(daysSel.value);
				void load(); // server cache key includes days → fresh scan
			});
		}
		if (refreshBtn) refreshBtn.addEventListener("click", () => load(true));
		if (filter) filter.addEventListener("input", renderList);
		if (isSection) {
			// Keep the active-card highlight in sync with the session the
			// user opens from anywhere (history list, running list, …).
			const onHash = () => {
				if (container.isConnected) renderSection();
			};
			window.addEventListener("hashchange", onHash);
			registerTeardown(container, () => window.removeEventListener("hashchange", onHash));
		}
		void load();
	},

	cleanup() {
		// The host tears a surface down (modal close / section collapse).
		// Drop global listeners whose container left the DOM; registerTeardown
		// self-heals the same set on the next mount for ordering edge cases.
		for (let i = teardowns.length - 1; i >= 0; i--) {
			if (!teardowns[i].container.isConnected) {
				try {
					teardowns[i].fn();
				} catch {
					/* already removed */
				}
				teardowns.splice(i, 1);
			}
		}
	},
};
