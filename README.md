# pi-web-ui session-timeline

A [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) plugin: a **global, cross-project session timeline** in the top bar.

- The 🕘 button opens a modal listing your most recent sessions across **every** project (sorted by modification time, newest first).
- Each row shows the session title, project, and relative time ("just now", "37 min ago", "2 days ago").
- **Click a title to jump to that session.** Same-project sessions open directly; other projects switch the workspace first (through the host's native directory-authorization flow) and then open the session.

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

- **Top bar → 🕘** opens the timeline modal (falls back to a full plugin page on hosts without modal support).
- **Filter box** — case-insensitive match on title / project name / cwd.
- **↻ Refresh** — forces a rescan (bypasses the 10 s cache).
- **Click a row** — jumps to that session:
  - same project → `sessions.open(path)` directly;
  - other project → `openSession({cwd, newChat:false})` (the host's native "open project" flow, including its directory authorization) → waits for the new project's session list to arrive → `sessions.open(path)`.
- **Esc / backdrop / ✕** closes the modal.

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
- **Header parse** (first 512 KB / up to 300 lines, byte-exact newline splitting): line 1 is `{"type":"session","id","cwd","timestamp"}`; first `session_info` name; first `user` message (title fallback). A 512 KB head is needed because system prompts before the first user message can exceed 100 KB.
- **Tail scan** (last 256 KB): the *latest* rename wins and can sit far beyond the head window in long sessions — so the tail window is scanned for the last `session_info` with a `name`, same "last name wins" semantics as the host's own full-file parse.
- **Caching**: in-memory scan cache (10 s TTL; the list refreshes on its own) + per-file mtime/size header cache (up to 1024 entries; old sessions are immutable, so steady-state scans cost only `stat`s).
- HTTP: `GET /plugins-api/session-timeline/list?refresh=1` → `{ok, count, limit, ms, sessions[]}`. `ms` is the scan duration for display.

### Client (`plugins/session-timeline/client/entry.mjs`)

- The top-bar action handler (`onUiAction`) is registered at **module top level**, because the host lazy-loads the bundle on first click and dispatches the action ~1.5 s later (contract observed from the bundled `feature-board` plugin).
- Modal via `openModal("session-timeline:timeline")`; if it returns `false` (older host), falls back to the full plugin view (`setView`).
- DOM is built with `createElement`/`textContent`/`createTextNode` only — no unescaped `innerHTML` interpolation (pi-lens lint).
- Jump flow (see Usage). The fast path tries `sessions.open(path)` first — for the *current* project this opens immediately. Only on failure (and when the row carries a `cwd`) does the cross-project `openSession` path run, polling `sessions.list()` for up to 10 s for the target to appear in the new project's list.
- The "current · " badge marks sessions that are in the current project's native list (i.e. openable directly right now).

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
- Titles are parsed from file head+tail only. A session renamed in the *middle* of a very long file may show an older name (rare: the last rename is normally near the tail).
- mtime ordering reflects file modification time (pi updates the file on activity), not message timestamps.

## Development

```bash
node -e "import('./plugins/session-timeline/index.mjs').then(async m => {
  const r = m.scanAll(10);
  console.log(r.length, 'sessions, first:', r[0]?.title);
})"
```

- `index.mjs` exports `scanAll`, `parseSessionHead`, `SESSIONS_ROOT` for direct testing.
- Client changes need only a browser refresh; **server (`index.mjs`) changes require a `pi-web-ui server restart`** (the host keeps the loaded module in memory; `plugins_reload` is only reachable from the Settings UI).
- Browser test loop: `agent-browser open http://127.0.0.1:8787`, then `snapshot -i` → `click @ref` (or `eval` for deterministic clicks). The test tab is a separate client — jumping there does not disturb other open conversations.

## License

MIT (matching the pi-web-ui project).
