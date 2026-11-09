# herdr-config

My Herdr setup: the terminal app (`herdr`, `~/.config/herdr`) and the desktop app (`Herdr.app`, `~/.config/herdr-app`) on my Mac, and the desktop app on Windows (`windows/`), whose terminals and omp run in WSL.

Project notes, the keyboard-first rules and the bindings table: `~/Projects/ricing-herdr-2026-11-03/README.md`.

## Save and restore

```sh
./sync.sh            # live files -> repo, then commit and push
./sync.sh --restore  # repo -> live files
```

On the Mac it syncs `herdr/`, `herdr-app/` and the LaunchAgent. Run from WSL, it syncs `windows/` instead; `--restore` there also links `herdr-app` into `~/.local/bin`, makes `~/.bashrc` source `omp-resume.bash`, and turns on the update timer. Both sync `omp/extensions/` and `orchestrator/`.

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
| `orchestrator/.omp/` | The orchestrator space: `APPEND_SYSTEM.md` (its prompt), `agents/herdr-watcher.md`, `tools/herdr.ts` (`herdr_spaces`, `herdr_send`, `herdr_new_agent`, `herdr_new_space`, `herdr_wait`, `herdr_read`, `herdr_close_space`). The tools also work from WSL, where `herdr-app ls` names terminals `wsl/t8` and `hc` knows them as `t8`. Restores to `~/Projects/herdr-orchestrator-2026-11-08/.omp/` |
| `windows/herdr-app/` | The Windows desktop app (`C:\Users\<me>\.config\herdr-app`): the same layout and mods, with Windows keys (`ctrl`/`alt` for `cmd`; new spaces open in WSL), `balance-panes.ps1`, macOS-style window buttons at the top left (`t3-chrome/lights.js`, copied into `t3-tabs`), and one Spaces list: WSL's spaces, then this computer's, with no machine headers |
| `windows/wsl/omp-resume.bash` | The bash side of omp session resume (the zsh one is in my dotfiles repo). Restores to `~/.config/herdr-wsl/` |
| `windows/wsl/systemd/` | `omp-update.service` and `.timer`: `omp update` a minute after start and each hour, as the LaunchAgent does. Restores to `~/.config/systemd/user/` |

Left out on purpose: Herdr's shipped mods, layouts and themes (it replaces them at start), run-time state (`shared.json`, `view.json`, `window.json`, `data/`, sockets, logs), generated files (`*.d.ts`, `jsconfig.json`) and `spaces.json` (pinned spaces and sections: it holds work space names, and `.gitignore` lists it).

Space colours and wizards live in `shared.json`, keyed by space id, so they don't carry over. New spaces get new ones.

Sprites in `herdr-app/mods/t3-spaces/wizards/` are Dungeon Crawl Stone Soup tiles (CC0); see the `LICENSE.txt` there.
