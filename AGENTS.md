# AGENTS.md — agent contribution guide

Guidance for AI agents (and humans) working in this repository. Read this before making changes.

## What this repo is

`pi-web-ui-session-timeline` is a single-plugin project for [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui). The plugin adds a **global cross-project session timeline**: a top-bar 🕘 button opens a modal listing the newest sessions across all projects (scanned from `~/.pi/agent/sessions/`), and clicking a title jumps to that session — switching projects first when needed.

There is one plugin: `plugins/session-timeline/`. Everything else in the repo is install tooling and docs.

## Layout

```
plugins/session-timeline/
├── manifest.json          # id, view:true, permissions, topbar action, modal entry, "limit" setting
├── index.mjs              # SERVER (runs in the pi-web-ui host process): scan/parse/cache + HTTP /list route
└── client/entry.mjs       # CLIENT (browser): topbar action handler + modal view + jump logic
install.sh                 # copies the plugin into ~/.pi-web/plugins/ (the installed location)
README.md                  # user-facing docs (English)
AGENTS.md                  # this file
```

**Server/client split is load-bearing.** `index.mjs` runs in Node (has `fs`); `client/entry.mjs` runs in the browser (no Node APIs). Never import `index.mjs` from the client or use `node:` modules in the client.

## Host contracts (verified against pi-web-ui 0.104.4 / bridge API v11)

These facts cost real debugging time — do not regress them:

1. **The public browser bridge `window.__piWebUiHost` has NO `getCwd` and no raw message send.** Available: `version`, `setView`, `startChat`, `models`, `compose`, `openModal`, `closeModal`, `openSession`, `sessions` (`list`/`open`/`close`), `reloadCatalog`, `onUiAction`, `onTopbarAction`, `pageCall`, `dom`, `dialogs`, `notifyAction`, `shortcuts`, `searchProviders`, `composerProviders`, `onTheme`, `onLocale`, `onViewChange`, cost formatters. Never assume more exists; probe before use.
2. **Topbar action handlers must be registered at module top level in `client/entry.mjs`.** The host lazy-loads the client bundle when the button is first clicked, then polls for the action registration for ~1.5 s. Registering inside `mount()` is too late (the modal opens with an empty container and the action never fires). This mirrors the bundled `feature-board` plugin.
3. **Modal flow**: `ui.modal` entry with `kind: "view"` → `host.openModal("session-timeline:timeline")` → the host mounts `export default { mount(container), cleanup() }` from the client entry into `.plugin-modal-body .plugin-view` (720 px wide, `min(80vh, 700px)` tall). `openModal` returns `false` on hosts without the slot (older versions) — always keep the `setView("plugin:session-timeline")` fallback.
4. **Session jump is two-level** (see `jumpTo` in `client/entry.mjs`):
   - Fast path: `sessions.open(path)` — works when the target is in the **current** project's native list.
   - Cross-project: `openSession({ cwd, newChat: false })` (host's native project-open; triggers its directory-authorization dialog for unknown dirs) → poll `sessions.list()` (10 s budget) until the target path appears in the list → `sessions.open(path)` again.
   - `sessions.list()` ids: running conversations use the conversation id (with `cwd` = that conversation's cwd); history entries use the **file path** as id. **Verified: the running conv id is a client-local id (e.g. `c2`), NOT the session UUID from the file header** — to correlate a running conversation with a timeline row, match on `cwd` + title (prefix-safe; timeline titles are truncated to 120 chars). Running entries also carry `isStreaming`.
   - **Pitfall that caused a real bug**: `kind:"running"` means "open in this client's conversation list" — pi-web-ui keeps a conversation there after it is opened, even when the agent has been **idle for hours** (parked tabs, abandoned subagent convs like `sa-*`). "In progress" therefore must be `isStreaming === true` OR the session file's mtime within ~5 minutes (`ACTIVE_WINDOW_MS` in the client). Marking every running conversation as active was reported by the user as wrong.
5. **Server-side `switchSession` accepts any path inside the sessions directory** (`isInsideSessionsDir`) — no project restriction. The 200-session-per-project cap lives in the *client list building* (running + history), which is why cross-project jumps must wait for the list to arrive.
6. **`sessions.open()` can report "切换会话超时" on heavy sessions even though the switch completes** — the host's confirmation window expires while a large transcript is still loading. Ground truth for "did it land": the active-session URL hash becomes `#s=<session-uuid>` (the session UUID from the file header). The plugin verifies the hash for up to 8 s before declaring failure (see `jumpTo` in `client/entry.mjs`).
7. **Left-panel custom section (P4)** — a manifest `ui` entry in slot `leftpanel.sections` with `kind:"view"` renders a native collapsible section (same `sectionHeader` as 最近项目/运行的对话/历史对话; collapse/expand state is persisted; 界面布局 can hide/reorder). The section body is the host's `PluginPage` mounting the plugin's **client default export** (`mount(container)`/`cleanup()`) — i.e. the *same* view code as the modal; collapsing unmounts the body. Section key = `plugin:<entryId>`; host entries: projects order 10, running 20, history 30 (our section: order 40). **Caveat: the host's docs/architecture-plugins.md still claims this slot is host-only ("插件不能往里放条目") — stale; the code in 0.104.4+ accepts plugin `view` entries (verified in the shipped bundle: `source.startsWith("plugin:") && kind==="view"`).**
8. **Section sash resize** — in 0.104.4 the section heights are resized via `.lp-sash` strips between *adjacent visible* sections (`zi(Pe,je)`: a sash pair exists only when neither neighbor is filtered out; the `je` exclusion for plugin sections is `G.has(id)`). **A collapsed neighbor removes the sash** (host behavior, user-discovered) — that's why the timeline section can't be drag-resized while 历史对话 is collapsed. The sash is 6 px (`cursor:row-resize`, `margin:-3px 0`, z-index 5); double-click resets. Panel *width* uses `.resize-handle.resize-left` (col-resize).
9. **Section-mode card design reuses host classes on purpose** — to match 运行的对话 exactly (theme-aware), the section surface renders with the host's own classes: `.panel-conv-group` / `.panel-conv-group-title` (10px/600 group label) / `.lp-row` / `button.session-item[.active]` (8 px radius, 8px gap, active = purple `rgba(139,92,246,.14)` tint) / `.session-icon` (lucide chat bubble, 1em) / `.session-info` > `.session-title` + `.session-sub` (11px) / `.conv-streaming` (7 px green dot). The chat-icon SVG markup is duplicated in `makeChatIcon()` (stable lucide path). The active card = the session in the URL hash (`#s=<uuid>`), refreshed on `hashchange` (per-mount `window` listener, container-keyed teardown registry in `cleanup()` — modal + section instances coexist, so only tear down detached containers). Modal surface keeps the original `.st-row` design (meta/filter/refresh).
6. **Client bundle caching**: the host serves `client/*.mjs` with `Cache-Control: no-cache` and the service worker never caches `/plugins/*`. A plain page refresh picks up client changes. **Server changes need `pi-web-ui server restart`** (module stays in memory; the WS `plugins_reload` message is only triggered from the Settings UI). **Manifest changes also need the restart** (ui contributions are parsed at activation); verify a new left-panel section by checking `.lp-section.lp-section-plugin` in the left panel DOM.

## Session file format (`~/.pi/agent/sessions/`)

- One directory per project: `--<cwd with every non-alphanumeric char → ->--/` (e.g. `--Users-bedong-managedci--`). **Do not reverse-map dir names back to cwds** (`-` substitution is ambiguous) — read `cwd` from the file header instead.
- Files are JSONL; first line: `{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/abs/path"}`.
- Renames: `{"type":"session_info","name":"..."}` — **the LAST such record wins**, and in long sessions it can be megabytes into the file, with MORE than any fixed tail window appended after it (active sessions keep growing). Head+tail windows both failed in practice (stale titles) — `index.mjs` therefore does a **single sequential full-file pass** per candidate (substring-prefiltered before `JSON.parse`), exactly matching the host's semantics. Total store is small (tens of MB) and results are cached by mtime+size, so the cost is one cold read of the top-N files.
- Non-session files to ignore: `.touches.json`, `.lease`, anything not `*.jsonl`.
- `firstMessage` = first `user` message (`message.content` is a string or an array of `{type:"text",text}` parts); it is the title fallback when no rename exists.

## Implementation invariants (keep these)

- **Two-pass scan**: stat all `.jsonl` → mtime desc → keep top `limit` → parse only those. Parsing is the expensive part; never parse before selecting.
- **Caches**: 10 s in-memory scan cache + per-file `{mtime, size}` header cache (LRU, max 1024). Old sessions are immutable (pi appends to the active one), so mtime+size is a sound cache key.
- **Raw `node:fs` on the server** is intentional (official `session-migrate` plugin precedent) — it avoids per-call `host.fs` authorization prompts. Do not "fix" this to `host.fs` without re-reading the README's rationale.
- **Manifest permissions** `["ui", "fs", "http"]`: `http` gates `host.route`; `fs` documents intent (raw fs usage does not consume it); keep all three.
- **Client DOM**: `createElement` / `textContent` / `createTextNode` only — no `innerHTML`/`outerHTML` interpolation (pi-lens lint blocks it).

## Test & iteration workflow

1. `node --check plugins/session-timeline/index.mjs` — syntax gate (pi-lens requires it before editing).
2. Direct server test (no browser):
   ```bash
   node -e "import('/Users/bedong/Workspaces/pi-web-ui-session-timeline/plugins/session-timeline/index.mjs').then(m => { const r = m.scanAll(10); console.log(r.length, r[0]?.title, r[0]?.cwd); })"
   ```
   `scanAll`, `parseSessionFile`, `SESSIONS_ROOT` are exported for this.
3. `./install.sh` → copies into `~/.pi-web/plugins/session-timeline` (diffs are overwritten; client files are replaced).
4. Server change? → `pi-web-ui server restart`. Client-only change? → refresh the browser tab.
5. Browser E2E with `agent-browser` (the test tab is a separate client, so it doesn't disturb the user's open conversations):
   - `agent-browser open http://127.0.0.1:8787` → `agent-browser snapshot -i` → click the "Session Timeline" topbar ref.
   - **CDP click coordinates go stale after any re-render** (e.g. a project switch); re-snapshot before each click, or drive via `eval` (`document.querySelector(...).click()`).
   - Verify: modal renders N sessions; rows carry real titles (not filename stems); clicking a *current-project* row jumps instantly; clicking an *other-project* row switches the workspace and opens the session; modal closes; status line shows the result.
6. Title correctness spot-check: compare against the native left panel's History titles for the same files (native parses the whole file; the plugin must match, since last-rename-wins).

## Environment gotchas (this machine)

- **`pi-web-ui server restart` kills the calling shell's process tree** — a bash tool invocation running the restart will not return (the harness synthesizes a result). After a restart, re-check `pi-web-ui server status` in a *new* command.
- **Inline `agent-browser eval "<js>"` gets mangled by the terminal wrapper** (e.g. an inserted `exit` breaks `document.…`). Always write JS to a file and run `agent-browser eval "$(cat /tmp/probe.js)"`.
- The pi-web-ui clone used for API research lives at `/Users/bedong/Workspaces/pi-web-ui` (shallow, main). The installed runtime is `/opt/homebrew/lib/node_modules/pi-web-ui` (version lags the clone — verify against the installed `dist/` when bridge behavior matters).
- The server runs under launchd as `com.xingshuyin.pi-web-ui` (loopback only, no token auth).

## Conventions

- All code comments in English; docs in English.
- Tab indentation, ESM (`.mjs`), no external runtime dependencies (Node 18+ builtins only).
- Keep the plugin self-contained: one directory, copy-in-place install. No build step for the client (the host imports `client/entry.mjs` as-is).
- If you add a setting, declare it in `manifest.json` `settings` AND read it through `host.settings.get` with a default fallback.
