# Rex

This folder makes the Rex app (Rex Beta, a terminal multiplexer) work like my Herdr setup: the same keys, an orchestrator that routes work to omp sessions, pull request notices and fix agents, `/reload`, and omp session resume. Herdr keeps working as before; nothing outside `rex/` changes it.

In Rex, a Herdr space is a session, a tab is a tab (Rex calls it a window), and a terminal is a terminal block. The orchestrator names a terminal by the last 6 characters of its block id, for example `d17538`.

## Set up

1. Run `./sync.sh --restore`. On the Mac it copies the files below to their live places and builds `~/Applications/Rex Focus.app`.
2. Run `rex config reload`.
3. In Rex, open Settings > Server > Client Info and turn on Remote Control. The `rex-focus://` links need it to switch sessions. Keys work without it.
4. Make a Rex session named `orchestrator` in `~/Projects/rex-orchestrator-2026-11-15` and start `omp` there. `Ctrl+F` shows it.
5. Pull the `omp` zsh functions from the dotfiles repo. They resume each Rex terminal's omp session when Rex restores its sessions.

## What's here

| Path | Live place | What it is |
|---|---|---|
| `config/init.lua` | `~/.config/rex/init.lua` | The Herdr keys and the actions behind them. `KEYS.md` lists each key, and the Herdr keys Rex can't do |
| `scripts/rex-prs.sh` | `~/.config/rex/scripts/` | The Pull requests list: ready, draft and the last 20 merged, one `gh` query each minute. `Ctrl+Space` `g` opens it as a tab of the orchestrator session |
| `scripts/rex-focus.sh` | `~/.config/rex/scripts/` | Opens a `rex-focus://<session uuid>/<block uuid>` link: focuses that terminal, brings Rex forward and shows the session. `rex-focus.applescript` and `rex-focus-install.sh` build the `Rex Focus.app` handler |
| `omp/extensions/rex-resume.ts` | `~/.omp/agent/extensions/` | Writes `~/.local/state/omp-rex-resume/<block uuid>`: the terminal's omp session file, and `quit` after a normal quit. The zsh `omp` functions read it |
| `orchestrator/.omp/` | `~/Projects/rex-orchestrator-2026-11-15/.omp/` | The orchestrator: `APPEND_SYSTEM.md` (its prompt), `tools/rex.ts` (`rex_spaces`, `rex_send`, `rex_new_agent`, `rex_new_space`, `rex_wait`, `rex_read`, `rex_close_space`), `extensions/rex-watch.ts` (`rex_watch`), `rex-pr-ready.ts`, `rex-pr-autofix.ts`, `rex-reload.ts`, and `agents/rex-watcher.md` |

## How the orchestrator talks to Rex

- All calls go through the `rex` command. One Lua script (`rex do -e`) reads every session, tab and terminal in about 50 ms.
- omp tells Rex its state itself (idle, working, blocked, done or error), so no extra hook is needed.
- Rex has no turn counter. A terminal's `turn` is the time of the newest prompt in its omp session file.
- A task is typed into omp as one paste, then Enter. A correction first presses Esc and waits for the turn to stop.
- A new agent or space runs `sh -c '<start omp with the task file>; exec $SHELL -li'`. The shell stays after omp ends.
- When Rex restores its sessions (after a reboot, an update or a server restart), it keeps each block id but starts a plain shell, without the first command. The shell's first prompt then resumes omp from the breadcrumb, unless omp was quit.

## When Herdr also runs

While the Herdr app runs, its orchestrator posts the pull request boxes and starts the fix agents. The Rex orchestrator then stays quiet about pull requests, so you never get two fix agents for one pull request. It still closes the fix agent tabs it started.

## Not like Herdr

- The Rex sidebar can't show custom panels, so the Pull requests list is a tab, without the Move to Ready, Merge and close buttons.
- A `rex-focus://` link can't pulse the pane border green.
- Rex has no pinned sessions or sidebar sections.

`KEYS.md` has the full list.
