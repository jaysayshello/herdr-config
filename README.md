# herdr-config

My Herdr setup: the terminal app (`herdr`, `~/.config/herdr`) and the desktop app (`Herdr.app`, `~/.config/herdr-app`) on my Mac, and the desktop app on Windows (`windows/`), whose terminals and omp run in WSL.

Project notes, the keyboard-first rules and the bindings table: `~/Projects/ricing-herdr-2026-11-03/README.md`.

## Save and restore

```sh
./sync.sh            # live files -> repo, then commit and push
./sync.sh --restore  # repo -> live files
```

On the Mac it syncs `herdr/`, `herdr-app/` and the LaunchAgent. Run from WSL, it syncs `windows/` instead. For this panel, `./sync.sh` copies the live `%USERPROFILE%\.config\herdr-app\mods\t3-usage\` directory into the backup at `windows/herdr-app/mods/t3-usage/`; `./sync.sh --restore` copies that backup to the same live Windows path. Restore also links `herdr-app` into `~/.local/bin`, makes `~/.bashrc` source `omp-resume.bash`, and turns on the update timer. Both platforms sync the other common mods, `omp/extensions/` and `orchestrator/`; Mac sync never references the Windows-only panel.

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
| `herdr-app/scripts/herdr-focus.sh` | Opens a `herdr-focus://<space-id>/<terminal>` link: shows that terminal and pulses its pane border bright green for about 6 s. Herdr draws the focus border only on the focused pane, so the script switches the layout's focus colour, then puts the layout file back. `herdr-focus.applescript` is the macOS handler for the scheme; `herdr-focus-install.sh` builds it as `~/Applications/Herdr Focus.app` (`sync.sh --restore` runs it) |
| `herdr-app/mods/tmux-keys/` | Keys that need logic: vim-aware swap, balance, new space in `~/Projects`, PR list navigation |
| `herdr-app/mods/t3-prs/` | Pull requests panel: CI state, code owner approval, comment count, bright green frame when ready to merge, right-click copy (`slackpr`) and close |
| `herdr-app/mods/t3-spaces/` | Spaces list: wizard avatars, working spinner, done glow, pinned spaces and sections, orchestrator frame |
| `herdr-app/mods/t3-chrome/` | Sidebar chrome, tab bar toggle (`cmd-shift-h`) |
| `herdr-app/mods/t3-*` | Other cloned mods the layout uses (tabs, pane header, inbox, new menu, agents) |
| `omp/extensions/herdr-resume.ts` | Each Herdr terminal keeps its own omp session; after a reboot the shell opens it again. The `omp` zsh function that reads it lives in my dotfiles repo. Restores to `~/.omp/agent/extensions/` |
| `omp/launchagents/com.jay.omp-update.plist` | Runs `omp update` at login and each hour. Restores to `~/Library/LaunchAgents/` |
| `orchestrator/.omp/` | The orchestrator space: `APPEND_SYSTEM.md` (its prompt), `tools/herdr.ts` (`herdr_spaces`, `herdr_send`, `herdr_new_agent`, `herdr_new_space`, `herdr_wait`, `herdr_read`, `herdr_close_space`), `extensions/herdr-watch.ts` (`herdr_watch`: watches a worker without a model and pushes its final reply into the orchestrator about 1 s after it stops; its Workers panel shows `t7 in demo-service: <prompt>`), and `agents/herdr-watcher.md`, the fallback subagent. Each report box ends in a `More:` link (`herdr-focus://`) to the worker's terminal. The tools also work from WSL, where `herdr-app ls` names terminals `wsl/t8` and `hc` knows them as `t8`. Restores to `~/Projects/herdr-orchestrator-2026-11-08/.omp/` |
| `windows/herdr-app/` | The Windows desktop app (`C:\Users\<me>\.config\herdr-app`): Windows variants of the layout and common mods, plus Windows-only additions, with Windows keys (`ctrl`/`alt` for `cmd`; new spaces open in WSL), `balance-panes.ps1`, macOS-style window buttons at the top left (`t3-chrome/lights.js`, copied into `t3-tabs`), and one Spaces list: WSL's spaces, then this computer's, with no machine headers |
| `windows/herdr-app/mods/t3-usage/` | Windows-only AI usage panel and PowerShell collector: today's local Claude Code and OpenAI token activity plus supported live provider quota windows. Hide or show it with `ctrl-shift-u` or the sidebar footer's `Hide/Show AI usage` row (Windows `t3-chrome` footer) |
| `windows/wsl/omp-resume.bash` | The bash side of omp session resume (the zsh one is in my dotfiles repo). Restores to `~/.config/herdr-wsl/` |
| `windows/wsl/systemd/` | `omp-update.service` and `.timer`: `omp update` a minute after start and each hour, as the LaunchAgent does. Restores to `~/.config/systemd/user/` |

## AI usage panel

The Windows layout has a fixed compact `AI usage` block between the sidebar lists and footer. Each provider card always shows `Today local` token activity when local records exist. That activity covers the Windows calendar day from local midnight and resets at the next local midnight. It is activity, not quota: tokens are never converted into a quota percentage.

Neither provider offers a documented 24-hour plan window. The panel therefore does not invent a daily limit. Instead it combines today's local activity with the provider's real current rolling windows: the shortest available window as a progress bar with percent used and left, its reset time and `5h` label, plus the `7d` window when supplied. The bar is the theme accent below 75% used, amber from 75%, red from 90%, and grey when the data is stale. A percentage bar appears only for provider quota data, never for token counts. Cards also show the model and plan when safely available; unavailable quota says so, and stale data is clearly labeled with the time it was last observed.

The two token totals follow each provider's local usage shape:

- **Claude:** input + cache creation (cache write) + cache read + output. Those cache fields are additive API usage.
- **OpenAI:** input + output. Cached input is a subset of input and reasoning output is a subset of output, so neither is added again.

Local collection is read-only and uses only Windows PowerShell 5.1 and Herdr built-ins. Its source allowlist is `%USERPROFILE%\.claude\projects\**\*.jsonl` and `%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl`. Claude assistant usage is deduplicated globally by `(sessionId, message.id)`, keeping the most complete usage and earliest duplicate timestamp. OpenAI response usage is deduplicated by `response_id`, with a metadata-only fallback key when that ID is absent. Records are then filtered to the current Windows local day. Missing source directories are `unavailable`, existing directories with no usable records are `empty`, malformed lines are ignored unless no source can be read, and one provider's failure never blocks the other.

OpenAI quota comes from the authenticated Codex installation already managed by the official app. The collector starts the user plugin `codex.exe`, falling back to the packaged OpenAI Codex executable, speaks the experimental [`codex app-server` API](https://developers.openai.com/codex/app-server) over stdio, and requests `account/rateLimits/read`. It projects only plan type, normal model slug, ordinary-usage availability, and each window's used percentage, duration, and reset timestamp. The interaction is bounded and failures affect only OpenAI; no separate credentials are requested or stored.

When that live read fails, OpenAI falls back to the latest `rate_limits` snapshot Codex already wrote to `%USERPROFILE%\.codex\sessions` in the last seven days, an approach taken from [Alevsk/herdr-agent-usage](https://github.com/Alevsk/herdr-agent-usage) (MIT). That snapshot is a past observation, so it is always shown as stale with its time, and windows that have already reset are dropped. The same project's Claude status-line hook is the model for the capture script below, including its `<model> · <usage>` status text. Its other sources don't apply here: it is a terminal-Herdr plugin, and `claude -p "/usage"` needs a standalone `claude` CLI, which this machine doesn't have.

Claude has no equivalent active fetch in this panel. After a normal Claude Code or Desktop response, the official [status-line API](https://code.claude.com/docs/en/statusline) sends its status payload to `capture-claude-quota.ps1`. The script retains only the safe model identifier/version, observation time, and the `five_hour` and `seven_day` used percentages and reset timestamps, atomically writes `%USERPROFILE%\.config\herdr-app\data\t3-usage\claude-quota.json`, and prints one concise status-line string. Configure Claude's `settings.json` with this exact command:

```json
{
  "statusLine": {
    "type": "command",
    "command": "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"$HOME/.config/herdr-app/mods/t3-usage/capture-claude-quota.ps1\""
  }
}
```

The command alone is:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$HOME/.config/herdr-app/mods/t3-usage/capture-claude-quota.ps1"
```

A Claude snapshot is current only for 60 minutes and while its reset is still in the future; older snapshots are stale, and absent or expired snapshots are unavailable. Until the status line has observed a normal response, Claude quota is therefore unavailable. See also [Claude costs](https://code.claude.com/docs/en/costs) and [Codex pricing](https://developers.openai.com/codex/pricing).

The schema-2 collector output contains only timestamps, local token counts, safe model/plan labels, quota state, and validated window percentages and resets. It never exposes authentication tokens, cookies, account IDs, prompts, tool data, raw transcript records, paths, stderr, or raw broker/protocol responses. Provider collection is isolated so a timeout, malformed source, or unavailable quota for one does not suppress the other.

The panel refreshes every five minutes without overlapping collector runs and keeps only sanitized last-successful data in local storage. Its initial refresh runs from a zero-delay timer after the first render, so `herdr-app check` can render and exit without contacting a live broker. Manual refresh is the heading's refresh icon, or `herdr-app do t3-usage.refresh` (bindable in `keys.json`).

### Hide and show

- **Hide:** click the `×` next to the refresh icon in the panel's heading, click **Hide AI usage** in the sidebar footer, or press `ctrl-shift-u`.
- **Show again:** click **Show AI usage** in the sidebar footer (it stays there while the panel is hidden), or press `ctrl-shift-u`. From a script: `herdr-app do layout.show --id usage` (`layout.hide` / `layout.toggle` likewise).

All of these use Herdr's own `layout.hide`/`layout.toggle` on the panel's layout node, `usage`. A hidden node takes no space, so the sidebar lists grow into it. Herdr keeps the choice across restarts in `%USERPROFILE%\.config\herdr-app\layouts\.state\herdr-t3.json` (`nodes.usage.hidden`). If that file is ever reset, the panel shows again. Herdr keeps a hidden block's mod alive, so the panel checks on every timer tick and skips the collector while hidden: no PowerShell, Codex app-server or file scans run. Showing it again refreshes at once.

### Checks

For the deterministic narrow collector check from Windows (it always runs the collector with live quota skipped):

```powershell
powershell -NoProfile -File .\windows\herdr-app\mods\t3-usage\check-usage.ps1
```

The check fixes the collection time and local-day boundary, exercises schema 2, the Claude capture's privacy projection and fresh/stale states, the Codex rollout fallback, and provider isolation, and never calls a network service or real broker. Normal integration and visual verification remain `herdr-app check` and `herdr-app shot`. To restore the checked-in panel to the live Windows app, run `./sync.sh --restore` from WSL; Herdr reloads layouts and mods live.


Left out on purpose: Herdr's shipped mods, layouts and themes (it replaces them at start), run-time state (`shared.json`, `view.json`, `window.json`, `data/`, sockets, logs), generated files (`*.d.ts`, `jsconfig.json`) and `spaces.json` (pinned spaces and sections: it holds work space names, and `.gitignore` lists it).

Space colours and wizards live in `shared.json`, keyed by space id, so they don't carry over. New spaces get new ones.

Sprites in `herdr-app/mods/t3-spaces/wizards/` are Dungeon Crawl Stone Soup tiles (CC0); see the `LICENSE.txt` there.
