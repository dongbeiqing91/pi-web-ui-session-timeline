# pi-web-ui session-timeline

A [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) plugin: a **global, cross-project session timeline** — both as a left-sidebar section and a top-bar modal.

- **Left sidebar section "会话时间线"** (below History, collapsible like the native sections, resizable/hideable in 界面布局): a flat card list of your most recent sessions across **every** project (newest first), styled like the native 运行的对话 cards — chat icon, title, project name as the sublabel, time on the right; the currently open session gets the purple "active" highlight; in-progress sessions get the breathing green dot. **Limited to the last 7 days.** The section title shows the count, e.g. `会话时间线 (35)`.
- **Topbar clock button** (line-style icon, matching the other topbar buttons) opens the timeline modal with the original row-list design — filter box, **period select (180/30/7/1 天, default 180, last choice remembered in localStorage)**, refresh, 当前 badge (on hosts without the left-panel section feature this is the only surface).
- Each row shows the session title, project, and relative time ("just now", "37 min ago", "2 days ago").
- **Click a title to jump to that session.** Same-project sessions open directly; other projects switch the workspace first (through the host's native directory-authorization flow) and then open the session.
- **Running sessions get a breathing green dot** — but only when they are *actively in progress*: the conversation is streaming right now, or its session file was written to within the last 5 minutes. Conversations that are open in your client but parked (idle for a while) do **not** get the dot.

```
┌──────────────────────────────────────────────┐
│ 🕘 Session Timeline                 53 · ✕   │
│   ↻ Refresh          [ filter title / project ]
├──────────────────────────────────────────────┤
│ 📁 Everything                                  │
│   ● Pi-Web-UI Session History Plugin   just now│
│   Compress ~/.agents to ~/Downloads   4 min ago│
│                                               │
│ 📁 managedci                                 │
│   Debug Go toolchain SDDZ proxy EOF   current · 37 min ago│
└──────────────────────────────────────────────┘
```

## Why (what exists natively, what was missing)

pi-web-ui's left panel already has a **History** section per project: that project's sessions, newest first (cap 200), click-to-open. What did **not** exist:

- a **cross-project** timeline (history is partitioned per working directory), and
- a single on-demand list of "what did I do most recently, across all my projects".

This plugin fills both: it scans `~/.pi/agent/sessions/` (all project directories) server-side and exposes the result through a top-bar button + modal, reusing the host's native jump mechanics.

## Requirements

- pi-web-ui **0.104+** (tested against v0.104.4, host bridge API v11; uses `openModal`, `sessions`, `openSession`, `onUiAction`).
- macOS/Linux (scans the local session store; no other dependencies).

## Install

```bash
git clone <this repo>
cd pi-web-ui-session-timeline
./install.sh        # copies plugins/session-timeline → ~/.pi-web/plugins/
```

Then (re)start the pi-web-ui server (`pi-web-ui server restart`) and open the web UI. The 🕘 button appears in the top bar (right-aligned, order 60).

## Usage

- **Left sidebar → "会话时间线" section** — always-available flat timeline below History, styled like the 运行的对话 card list (title + project sublabel + time on the right). Click the section title to collapse/expand (same as the native sections); the 界面布局 settings page can hide it or reorder it. The body unmounts while collapsed.
- **Top bar → clock button** opens the timeline modal with the original row-list design (falls back to a full plugin page on hosts without modal support).
- **Filter box / period select / ↻ Refresh** — modal only. Filter: case-insensitive match on title / project / cwd. Period: 180 / 30 / 7 / 1 天 (default 180; persisted per browser profile via `localStorage["stModalDays"]`). Refresh: forces a rescan (bypasses the 10 s cache via `?refresh=1`). The left-panel section always uses 7 days (no controls).
- **Click a card (section) / a title (modal)** — jumps to that session:
  - same project → `sessions.open(path)` directly;
  - other project → `openSession({cwd, newChat:false})` (the host's native "open project" flow, including its directory authorization) → waits for the new project's session list to arrive → `sessions.open(path)`.
  - **Heavy sessions**: the host's `sessions.open()` can report "切换会话超时" while the switch is actually still completing; the plugin then verifies via the active-session URL hash (`#s=<session-uuid>`) and reports success once it lands ("已跳转 ✓（会话较大，加载稍慢）") instead of a false failure.
- **Esc / backdrop / ✕** closes the modal (the section, of course, stays).

## Settings

Configurable in the host's **Settings → Plugins**:

| Key | Default | Range | Description |
|-----|---------|-------|-------------|
| `limit` | 300 | 20–2000 | Max sessions listed per scan. Only the newest N file headers are parsed, so keeping this modest is what makes the scan cheap. |

## How it works

### Server (`plugins/session-timeline/index.mjs`)

Runs in the pi-web-ui host process; reads the session store with plain `node:fs` (precedent: the official `session-migrate` plugin does the same) — no per-call authorization prompts, since listing sessions is the plugin's core purpose.

- Session store: `~/.pi/agent/sessions/--<cwd with non-alphanumerics → ->--/*.jsonl` (one directory per project). Agent dir resolution mirrors the SDK: `$PI_CODING_AGENT_DIR` (with `~` expansion), else `~/.pi/agent`.
- **Two-pass scan**: pass 1 stats every `.jsonl` (mtime desc, keep top `limit`); pass 2 parses only those headers.
- **Title parse** — one sequential pass over the whole file (the same "last rename wins" semantics as the host's own full-file parse; a head+tail window is *not* enough, because active sessions append far more than any fixed tail budget after their last rename). Lines are prefiltered by substring before `JSON.parse`, so a multi-MB file costs ~one read (10–30 ms). Extracted: header (line 1) → `id`/`cwd`, first `user` message → title fallback, last `session_info` → latest name.
- **Caching**: in-memory scan cache (10 s TTL; the list refreshes on its own) + per-file mtime/size header cache (up to 1024 entries; old sessions are immutable, so steady-state scans cost only `stat`s).
- HTTP: `GET /plugins-api/session-timeline/list?refresh=1&days=7` → `{ok, count, days, sessions[]}`. `?refresh=1` (used by the ↻ button) bypasses the 10 s scan cache; `?days=N` (1–365) limits to sessions modified within the last N days — applied at the stat pass (no parsing of old files); the scan cache key includes both limit and days.

### Client (`plugins/session-timeline/client/entry.mjs`)

- The top-bar action handler (`onUiAction`) is registered at **module top level**, because the host lazy-loads the bundle on first click and dispatches the action ~1.5 s later (contract observed from the bundled `feature-board` plugin).
- **Left sidebar section** — the manifest also contributes a `leftpanel.sections` entry:

```json
{
  "id": "timeline-section",
  "slot": "leftpanel.sections",
  "label": "会话时间线",
  "kind": "view",
  "order": 40
}
```

This is the host's P4 "plugin custom left-panel section": `kind:"view"` entries in `leftpanel.sections` render a native collapsible section (same header/collapse/weight-drag as 最近项目/运行的对话/历史对话); the body is mounted from the plugin's client bundle via the host's `PluginPage` — the same `mount(container)`/`cleanup()` default export the modal uses (one view, two surfaces). Collapsing unmounts the body. `order: 40` places it after History (host entries: projects 10, running 20, history 30); the 界面布局 page can hide or reorder it. The view uses the same body padding as the native sections (`2px 12px 6px`), and the host's sash between History and the section resizes it vertically (drag the 6 px strip, double-click to reset; the sash is absent while the neighboring section is collapsed — host behavior). Note: the host's own docs still describe this slot as host-only — the code (verified in 0.104.4) accepts plugin `view` entries.

**Two visual variants, one data pipeline.** `mount()` detects its surface: the left-panel container is the host's `.lp-plugin-page` (PluginPage) → **section mode** renders a flat card list in the 运行的对话 style by deliberately reusing the host's own classes (`.lp-row`, `button.session-item[.active]`, `.session-icon`, `.session-info`, `.session-title`, `.session-sub`, `.conv-streaming`) so theming, the purple active highlight, and spacing stay pixel-identical to the native section: title + project name as the sublabel + relative time on the right (`.session-info{flex:1}` pushes it over). Modal containers → the **original row-list design** (meta row, filter, refresh, `.st-row`). The active card is the session the client has open right now (URL hash `#s=<uuid>`), kept in sync via a `hashchange` listener (registered per mount, torn down through a container-keyed teardown registry so modal and section instances can coexist).
- Modal via `openModal("session-timeline:timeline")`; if it returns `false` (older host), falls back to the full plugin view (`setView`).
- DOM is built with `createElement`/`textContent`/`createTextNode` only — no unescaped `innerHTML` interpolation (pi-lens lint).
- Jump flow (see Usage). The fast path tries `sessions.open(path)` first — for the *current* project this opens immediately. Only on failure (and when the row carries a `cwd`) does the cross-project `openSession` path run, polling `sessions.list()` for up to 10 s for the target to appear in the new project's list. If `sessions.open()` fails with a *timeout* on a heavy session (the host's confirmation window expires while the switch is still landing), the plugin verifies via the active-session URL hash (`#s=<session-uuid>`) for up to 8 s and reports success once it lands.
- The "current · " badge marks sessions that are in the current project's native list (i.e. openable directly right now); the list re-renders after each jump so badges and running-dots stay accurate.
- **Running-session dot**: `sessions.list()` entries with `kind:"running"` are the conversations open in *this* browser client — note this includes **parked** conversations (opened, then idle for hours; pi-web-ui keeps them in the list until closed). Their `id` is a client-local conv id (not the session UUID), so rows are matched by `cwd` + title (prefix-safe, since the timeline truncates titles at 120 chars). The dot only renders when the match is also *active*: `isStreaming === true` or the row's file mtime is within the last 5 minutes (`ACTIVE_WINDOW_MS`). Matched rows get an 8 px green dot with a 1.8 s breathing animation (scale + opacity + fading glow).

## Files

```
plugins/session-timeline/
├── manifest.json          # topbar action + modal entry + "limit" setting
├── index.mjs              # server: scan/parse/cache + /list route
├── client/entry.mjs       # client: topbar handler + modal view + jump logic
install.sh                 # copy into ~/.pi-web/plugins/
README.md
AGENTS.md                  # agent contribution guide
```

## Known limitations

- **Jumping to another project switches your workspace** — that is the host's native session-open semantics (same as clicking a project). The old conversation is not lost (it stays in running chats / history).
- The host caps each project's native history list at 200 sessions (by message count). Sessions beyond that cap cannot be opened through the bridge and are reported as such.
- Titles are parsed with the host's exact "last rename wins" semantics (full-file scan), so they match the native left panel. (Cost: one sequential read per file, ~10–30 ms for multi-MB files, cached by mtime+size.)
- mtime ordering reflects file modification time (pi updates the file on activity), not message timestamps.

## Development

```bash
node -e "import('./plugins/session-timeline/index.mjs').then(async m => {
  const r = m.scanAll(10);
  console.log(r.length, 'sessions, first:', r[0]?.title);
})"
```

- `index.mjs` exports `scanAll`, `parseSessionFile`, `SESSIONS_ROOT` for direct testing.
- Client changes need only a browser refresh; **server (`index.mjs`) changes require a `pi-web-ui server restart`** (the host keeps the loaded module in memory; `plugins_reload` is only reachable from the Settings UI).
- Browser test loop: `agent-browser open http://127.0.0.1:8787`, then `snapshot -i` → `click @ref` (or `eval` for deterministic clicks). The test tab is a separate client — jumping there does not disturb other open conversations.

## License

MIT (matching the pi-web-ui project).
