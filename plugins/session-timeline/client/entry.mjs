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
 * progress / error text.
 */
async function jumpTo(item, statusEl) {
	const b = bridge();
	if (!b) {
		setStatus(statusEl, "宿主桥不可用（页面可能尚未加载完），稍后重试");
		return;
	}
	if (!b.sessions || typeof b.sessions.open !== "function") {
		setStatus(statusEl, "当前宿主版本过低（需要插件 API v6+ 的 sessions 接口）");
		return;
	}
setStatus(statusEl, `正在跳转到「${item.title}」…`);
	try {
		// Fast path: the session is already in this client's list (current
		// project's history, or any running conversation) → open directly.
		let r2 = await b.sessions.open(item.path);
		if (!r2 || r2.ok !== true) {
			if (!item.cwd) throw new Error((r2 && r2.error) || "打开会话失败");
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
			r2 = await b.sessions.open(item.path);
			if (!r2 || r2.ok !== true) throw new Error((r2 && r2.error) || "打开会话失败");
		}
		// Give the switch a beat to visually land, then close the modal.
		setStatus(statusEl, "已跳转 ✓");
		setTimeout(() => {
			if (typeof b.closeModal === "function") b.closeModal();
		}, 250);
	} catch (e) {
		setStatus(statusEl, `跳转失败：${e.message ?? e}`);
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
/* the modal view                                                      */
/* ------------------------------------------------------------------ */
const VIEW_CSS = `
.st-view { display:flex; flex-direction:column; gap:10px; height:100%; min-height:200px; font-size:13px; }
.st-top { display:flex; align-items:center; gap:8px; flex:none; }
.st-top .st-count { color:var(--text-dim,#888); font-size:12px; flex:1; }
.st-refresh { flex:none; }
.st-filter { flex:none; width:100%; box-sizing:border-box; padding:6px 10px; font-size:13px; border:1px solid var(--border,#333); border-radius:6px; background:var(--bg-input,transparent); color:inherit; }
.st-filter:focus { outline:1px solid var(--accent,#5b9dff); }
.st-list { flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:2px; padding-right:2px; }
.st-sep { flex:none; margin:8px 2px 3px; font-size:11px; letter-spacing:.4px; color:var(--text-dim,#888); user-select:none; }
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
`;

export default {
	mount(container, _ctx) {
		container.innerHTML = "";

		const style = document.createElement("style");
		style.textContent = VIEW_CSS;
		container.appendChild(style);

		const root = document.createElement("div");
		root.className = "st-view";

		const top = document.createElement("div");
		top.className = "st-top";
		const count = document.createElement("span");
		count.className = "st-count";
		count.textContent = "";
		const refreshBtn = document.createElement("button");
		refreshBtn.type = "button";
		refreshBtn.className = "st-refresh";
		refreshBtn.textContent = "↻ 刷新";
		refreshBtn.title = "重新扫描会话文件";
		top.append(count, refreshBtn);

		const filter = document.createElement("input");
		filter.className = "st-filter";
		filter.type = "text";
		filter.placeholder = "过滤标题 / 项目名…";

		const list = document.createElement("div");
		list.className = "st-list";

		const status = document.createElement("div");
		status.className = "st-status";

		root.append(top, filter, list, status);
		container.appendChild(root);

		let items = [];
		let loading = false;
		let closed = false;

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

		function renderList() {
			list.innerHTML = "";
			const q = filter.value.trim().toLowerCase();
			// A session path that is in the client's own sessions.list() belongs to
			// the current project (history ids are file paths) → opens directly.
			// Running conversations (kind:"running") carry a client-local conv id
			// (not the session UUID), so "in progress" is matched by cwd+title.
			const client = clientSessions();
			const openableIds = new Set(client.map((s) => s.id));
			const runningByCwd = new Map();
			for (const s of client) {
				if (s && s.kind === "running" && s.cwd && s.title) {
					const arr = runningByCwd.get(s.cwd);
					if (arr) arr.push(s.title);
					runningByCwd.set(s.cwd, arr ?? [s.title]);
				}
			}
			const isRunning = (it) => {
				const titles = it.cwd ? runningByCwd.get(it.cwd) : undefined;
				return !!titles && titles.some((t) => titleMatches(t, it.title));
			};
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
					sep.textContent = it.cwdName ? `📁 ${it.cwdName}` : "📁 (未知项目)";
					list.appendChild(sep);
				}
				const row = document.createElement("div");
				row.className = "st-row";
				const isCurrent = openableIds.has(it.path);
				if (isRunning(it)) {
					const dot = document.createElement("span");
					dot.className = "st-dot";
					dot.title = "正在进行中";
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
					jumpTo(it, status)
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
			count.textContent = items.length ? `${shown} / ${items.length} 条会话 · 按修改时间由新到旧` : "";
		}

		async function load() {
			if (loading) return;
			loading = true;
			refreshBtn.disabled = true;
			setStatus(status, "扫描会话文件中…");
			try {
				const r = await fetch(`${API_BASE}/list`, { credentials: "same-origin" });
				const data = await r.json().catch(() => null);
				if (!r.ok || !data || data.ok !== true) throw new Error((data && data.error) || `HTTP ${r.status}`);
				items = Array.isArray(data.sessions) ? data.sessions : [];
				renderList();
				setStatus(status, items.length ? "" : "会话目录为空");
			} catch (e) {
				items = [];
				renderList();
				status.classList.add("err");
				setStatus(status, `加载失败：${e.message ?? e}`);
			} finally {
				loading = false;
				refreshBtn.disabled = false;
			}
		}

		refreshBtn.addEventListener("click", load);
		filter.addEventListener("input", renderList);
		void load();
	},

	cleanup() {
		// The modal container is removed by the host; event listeners live on
		// its children and are garbage-collected with it. Nothing global to
		// tear down here (the onUiAction registration is module-level).
	},
};
