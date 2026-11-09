# herdr-config

My Herdr setup: the terminal app (`herdr`, `~/.config/herdr`) and the desktop app (`Herdr.app`, `~/.config/herdr-app`).

Project notes, the keyboard-first rules and the bindings table: `~/Projects/ricing-herdr-2026-11-03/README.md`.

## Save and restore

```sh
./sync.sh            # live files -> repo, then commit and push
./sync.sh --restore  # repo -> live files
```

The script copies files. It doesn't symlink them, because Herdr writes its files atomically and that turns a symlink back into a plain file.

## What's here

| Path | What it is |
|---|---|
| `herdr/config.toml` | Terminal app keys (prefix `ctrl+space`, tmux-style), UI settings |
| `herdr/scripts/` | `balance-panes.sh` (`ctrl+r`), `swap-or-vim.sh` (`ctrl+h/j/k/l`) |
| `herdr-app/keys.json` | Desktop app keys; `layout:herdr-t3` mirrors the terminal keys |
| `herdr-app/settings.json` | Zoom, sounds |
| `herdr-app/layouts/herdr-t3.json` | The layout: sidebar (Spaces, Pull requests), work area, hidden tab bar |
| `herdr-app/themes/ghostty.json` | Theme matched to Ghostty |
| `herdr-app/scripts/balance-panes.sh` | Equal pane sizes for `ctrl-r` |
| `herdr-app/mods/tmux-keys/` | Keys that need logic: vim-aware swap, balance, new space in `~/Projects`, PR list navigation |
| `herdr-app/mods/t3-prs/` | Pull requests panel: CI state, code owner approval, comment count, bright green frame when ready to merge, right-click copy (`slackpr`) and close |
| `herdr-app/mods/t3-spaces/` | Spaces list: wizard avatars, working spinner, done glow, pinned spaces and sections, orchestrator frame |
| `herdr-app/mods/t3-chrome/` | Sidebar chrome, tab bar toggle (`cmd-shift-h`) |
| `herdr-app/mods/t3-*` | Other cloned mods the layout uses (tabs, pane header, inbox, new menu, agents) |
| `omp/extensions/herdr-resume.ts` | Each Herdr terminal keeps its own omp session; after a reboot the shell opens it again. The `omp` zsh function that reads it lives in my dotfiles repo. Restores to `~/.omp/agent/extensions/` |
| `omp/launchagents/com.jay.omp-update.plist` | Runs `omp update` at login and each hour. Restores to `~/Library/LaunchAgents/` |
| `orchestrator/.omp/` | The orchestrator space: `APPEND_SYSTEM.md` (its prompt), `agents/herdr-watcher.md`, `tools/herdr.ts` (`herdr_spaces`, `herdr_send`, `herdr_new_agent`, `herdr_new_space`, `herdr_wait`, `herdr_read`, `herdr_close_space`). Restores to `~/Projects/herdr-orchestrator-2026-11-08/.omp/` |

Left out on purpose: Herdr's shipped mods, layouts and themes (it replaces them at start), run-time state (`shared.json`, `view.json`, `window.json`, `data/`, sockets, logs), generated files (`*.d.ts`, `jsconfig.json`) and `spaces.json` (pinned spaces and sections: it holds work space names, and `.gitignore` lists it).

Space colours and wizards live in `shared.json`, keyed by space id, so they don't carry over. New spaces get new ones.

Sprites in `herdr-app/mods/t3-spaces/wizards/` are Dungeon Crawl Stone Soup tiles (CC0); see the `LICENSE.txt` there.
