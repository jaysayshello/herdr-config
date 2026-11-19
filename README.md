# herdr-config

My Herdr setup: the terminal app (`herdr`, `~/.config/herdr`) and the desktop app (`Herdr.app`, `~/.config/herdr-app`) on my Mac, and the desktop app on Windows (`windows/`), whose terminals and omp run in WSL. `rex/` makes the Rex app work the same way on the Mac.

Project notes, the keyboard-first rules and the bindings table: `~/Projects/ricing-herdr-2026-11-03/README.md`.

## Save and restore

```sh
./sync.sh            # live files -> repo, then commit and push
./sync.sh --restore  # repo -> live files
```

On the Mac it syncs `herdr/`, `herdr-app/` and the LaunchAgent. Run from WSL, it syncs `windows/` instead. For this panel, `./sync.sh` copies the live `%USERPROFILE%\.config\herdr-app\mods\t3-usage\` directory into the backup at `windows/herdr-app/mods/t3-usage/`; `./sync.sh --restore` copies that backup to the same live Windows path. Restore also links `herdr-app` into `~/.local/bin`, makes `~/.bashrc` source `omp-resume.bash`, turns on the update timer, and points the Startup shortcut `Herdr WSL keepalive` at `scripts/start-wsl.ps1` (see [WSL starts with Herdr](#wsl-starts-with-herdr)). Both platforms sync the other common mods, `omp/extensions/` and `orchestrator/`; Mac sync never references the Windows-only panel.

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
| `herdr-app/mods/t3-prs/` | Pull requests panel: CI state, code owner approval, comment count, bright green frame when ready to merge, right-click copy (`slackpr`), Move to Ready or Move to Draft (`gh pr ready`, `--undo`), Merge (only when approved, mergeable and clean; asks first; the repo's first permitted method, pinned to the head commit) and close; a foldable Merged section with the last 20 merged PRs, newest first, merge time in Eastern time. PRs in archived repos do not show, because GitHub permits no change to them. `node herdr-app/mods/t3-prs/check-prs.cjs` checks the header folds and Merge |
| `herdr-app/mods/t3-spaces/` | Spaces list: wizard avatars, working spinner, done glow, pinned spaces and sections, orchestrator frame |
| `herdr-app/mods/t3-chrome/` | Sidebar chrome, tab bar toggle (`cmd-shift-h`) |
| `herdr-app/mods/t3-*` | Other cloned mods the layout uses (tabs, pane header, inbox, new menu, agents) |
| `omp/extensions/herdr-resume.ts` | Each Herdr terminal keeps its own omp session; after a reboot the shell opens it again. The `omp` zsh function that reads it lives in my dotfiles repo. Restores to `~/.omp/agent/extensions/` |
| `omp/launchagents/com.jay.omp-update.plist` | Runs `omp update` at login and each hour. Restores to `~/Library/LaunchAgents/` |
| `orchestrator/.omp/` | The orchestrator space: `APPEND_SYSTEM.md` (its prompt), `tools/herdr.ts` (`herdr_spaces`, `herdr_send`, `herdr_new_agent`, `herdr_new_space`, `herdr_wait`, `herdr_read`, `herdr_close_space`; `herdr_new_agent` hands omp its task through a file, because a Mac security rule can kill `sh -lc` with a long argument), `extensions/herdr-watch.ts` (`herdr_watch`: watches a worker without a model and pushes its final reply into the orchestrator about 1 s after it stops; its Workers panel shows `demo-service: <prompt>`, or `demo-service, <task title>: <prompt>` when a space has two watched workers, and no terminal id), `extensions/herdr-spaces.ts` (puts the `herdr_spaces` list before each user prompt in a hidden `<herdr-spaces>` message, so the orchestrator routes in its first model call; it adds nothing if the list fails or takes more than 2 s), `extensions/herdr-pr-ready.ts` (one `gh` GraphQL query each minute; when one of your open PRs becomes approved, clean and mergeable, the orchestrator gets a `<herdr-pr-ready>` message and posts a box with its link, once per head commit; when one is merged, it gets a `<herdr-pr-merged>` message, with its own sound), `extensions/herdr-pr-autofix.ts` (each PR that moves from draft to ready in that poll gets its own agent, in its own pane of the one tab of the `reviewers` space, side by side with equal widths, so 4 moves give 4 agents at once and all show; it fixes the Compass and Semgrep findings with the fix skill until none are left, posts `/compass-review` when Compass did not review the head commit, stops after `MAX_ROUNDS` (10) rounds or when one finding comes back after `MAX_REPEATS` (2) fixes, and posts one short `🤖 Not fixed:` comment for the findings it could not fix; each agent works in its own clone in `/tmp/herdr-pr-autofix/<owner>-<repo>-<number>-<head>/repo`, so two agents never share a working tree, and starts in the folder that logs the PR link in `MERGED-PRS.md`, `TODO.md` or `README.md`, else in its clone; the pane closes and the clone is deleted when the agent is done or the PR is merged or closed, but both stay while the agent is blocked or has an error; once per PR and head commit, and never while the PR's pane is open; each poll saves the drafts, so a move during a `/reload` still starts an agent, but a first poll with no drafts saved in the last 10 minutes starts none; `ENABLED` turns it off; the orchestrator gets a `<herdr-pr-autofix>` message with the folder and watches the agent, then a `<herdr-pr-autofix-closed>` message; `tests/autofix.test.ts` checks it on a test Herdr), `extensions/herdr-reload.ts` (`/reload`: restarts every idle or done omp session in every space, each on its own session file in the same place, the orchestrator last; `/reload <space>` does one space), and `agents/herdr-watcher.md`, the fallback subagent. Each report box ends in a `More:` link (`herdr-focus://`) to the worker's terminal. The tools also work from WSL, where `herdr-app ls` names terminals `wsl/t8` and `hc` knows them as `t8`. Restores to `~/Projects/herdr-orchestrator-2026-11-08/.omp/` |
| `windows/herdr-app/` | The Windows desktop app (`C:\Users\<me>\.config\herdr-app`): Windows variants of the layout and common mods, plus Windows-only additions, with Windows keys (`ctrl`/`alt` for `cmd`; new spaces open in WSL), `balance-panes.ps1`, macOS-style window buttons at the top left (`t3-chrome/lights.js`, copied into `t3-tabs`), and one Spaces list: WSL's spaces, then this computer's, with no machine headers |
| `windows/herdr-app/mods/t3-usage/` | Windows-only AI usage panel and PowerShell collector: today's local Claude Code and OpenAI token activity plus supported live provider quota windows. Hide or show it with `ctrl-shift-u` or the sidebar footer's `Hide/Show AI usage` row (Windows `t3-chrome` footer) |
| `windows/wsl/omp-resume.bash` | The bash side of omp session resume (the zsh one is in my dotfiles repo). Restores to `~/.config/herdr-wsl/` |
| `windows/wsl/systemd/` | `omp-update.service` and `.timer`: `omp update` a minute after start and each hour, as the LaunchAgent does. Restores to `~/.config/systemd/user/` |
| `bench/` | Performance suite: `./bench/run.sh` times Herdr's start, omp's start in a new pane, the orchestrator tools, the Pull requests panel, the PR polls and their GitHub cost, and CPU and memory, in a sandbox with a test window and core, and writes a JSON file; `bun bench/compare.ts a.json b.json` compares two runs. See `bench/README.md` |
| `rex/` | The Rex app set up like Herdr: the same keys (`rex/config/init.lua`, listed in `rex/KEYS.md`), a Pull requests tab, `rex-focus://` links, omp session resume, and a Rex orchestrator with `rex_*` tools, `rex_watch`, PR notices, PR fix agents and `/reload`. Mac only. See `rex/README.md` |
| `orchestrator/.omp/extensions/herdr-switch.ts`, `orchestrator/.omp/lib/handoff.ts` | `/claude` and `/omp` (see below) and the handoff file builder they use. omp does not load `lib/` as an extension |
| `claude/hooks/herdr-claude.sh` | Claude Code hook: reports Claude's state to Herdr and keeps a resume breadcrumb for each terminal. Restores to `~/.claude/hooks/`; `settings.json` is never synced |
| `tests/` | `tests/run.sh` runs `bun test tests/` in a sandbox (own HOME, test core `herdrtest`, test window), with fake `omp` and `claude` programs (`tests/fakes/fake-agent.ts`) |

## WSL starts with Herdr

On Windows, Herdr reaches its `wsl` machine over ssh (`Host wsl` in `%USERPROFILE%\.ssh\config`: `127.0.0.1:2222`, sshd under systemd in Ubuntu). ssh can't start WSL, and WSL stops a distro once no `wsl.exe` session is left. Before this change, the only thing starting it was a login shortcut, so after `wsl --shutdown` or a WSL crash Herdr just showed `WSL disconnected` until WSL was started by hand.

`windows/herdr-app/scripts/start-wsl.ps1` starts Ubuntu if it isn't running and keeps it running, with a hidden `wsl.exe -d Ubuntu --exec sleep infinity` started through WMI so it outlives whoever ran the script. It then waits for sshd on 2222. It does nothing when that keepalive already exists, and a mutex stops parallel runs from racing. Two things run it:

- **Herdr itself:** the Windows Spaces mod (`t3-spaces`) checks `hc machine ls` every 15 s. Whenever the `wsl` machine isn't connected, it runs the script, at most once a minute. That covers every way Herdr opens (Start menu, taskbar, an update restart) and WSL stopping while Herdr is open. herdr-core reconnects by itself within seconds of sshd answering. There's no wrapper launcher, and no extra Herdr window is ever started.
- **Login:** the Startup shortcut `Herdr WSL keepalive` runs the same script, so WSL is ready before Herdr opens.

While Herdr is open, `wsl --shutdown` is followed by WSL starting again within about a minute. To keep WSL stopped, close Herdr first.

To test it, save your work in WSL first: `wsl --shutdown` ends every WSL terminal and agent. With Herdr open, run `wsl --shutdown` from PowerShell. Within about a minute, `wsl -l --running` lists Ubuntu again and the Spaces list shows the WSL spaces instead of `WSL disconnected`.

## /claude and /omp

Type `/claude` in the orchestrator to switch each idle or done omp terminal to Claude Code, in the same pane and cwd. `/omp` switches each Claude Code terminal back. `/claude <space name>` and `/omp <space name>` switch one space. The command ends with one report: switched, skipped (with the reason), failed. New workers start in the current mode.

- The context moves with a handoff file in `~/.local/state/herdr-switch/handoffs/` (mode 600, deleted after 24 h): the summary, the user prompts, the last answers, the open task and the project state. No tool output goes across. The shell reads the file into the first prompt of the new tool, so the handoff stays in the new session and Claude asks no question about the handoff folder.
- A switch back resumes the tool's own old session, with a handoff of only the part after the last switch away. If that session moved on in the meantime, Claude gets a fork of it (`--fork-session`) and omp gets a new session with a full handoff.
- The title keeps its text; the `π` at the start becomes `✳` for Claude.
- Claude asks once per folder if it can trust it. Before `/claude` starts Claude in a terminal, it marks that terminal's cwd, and only that folder, as trusted in the Claude config (`projects["<real path>"].hasTrustDialogAccepted` in `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`), so Claude starts with no question. It takes Claude's own lock on the file, changes only that key and replaces the file with a temporary copy. Before its first change it keeps a copy in `~/.local/state/herdr-switch/claude.json.backup`. If the config does not parse, the terminal is skipped and the old tool keeps running.
- Skipped: the orchestrator and its space, the `reviewers` space, terminals that are working, blocked, in error or have no state, Claude with a background job, and terminals with no session file.
- A Claude terminal can report the Herdr app `claude` (the hook) or `claude-code` (Claude Code itself). Both count as Claude.
- A terminal where omp or Claude stopped without a quit (for example, killed) runs only a shell. If its breadcrumb holds a session with no `quit` mark, the report shows it as skipped: `no agent runs; its omp session stopped` (or `Claude session`). The command does not change this terminal. Type `omp` or `claude` there to resume the session.

The Claude hook is required, so both commands refuse to run without it. Claude Code 2.1.326 and later report their own state (`claude-code`), but older versions do not, and only the hook writes the resume breadcrumb of each terminal. The hook reports `claude-code` too, and it does nothing for a `claude` that runs inside another omp or Claude. Copy `claude/hooks/herdr-claude.sh` to `~/.claude/hooks/`, then add it to `~/.claude/settings.json` for the events listed at the top of the script (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PermissionRequest`, `Stop`, `StopFailure`, `SessionEnd`), next to any hooks already there. Restart each Claude session to load it.

Limits:

- A terminal that runs omp as its program, with no shell after it, gets a new pane in the same place, so its terminal id changes. The report shows `old -> new`.
- A Claude terminal needs the hook. One started before the hook has no state, and `/omp` skips it.
- The handoff is a summary, not a full conversion of the session.

## Claude Code workers

The orchestrator routes work to omp and Claude Code terminals (Herdr app `omp` or `claude`) the same way: `herdr_send`, `herdr_watch` and the PR fix agents' folder search take both. `herdr_new_agent` and `herdr_new_space` start the current mode, from `~/.local/state/herdr-switch/mode` (`omp` or `claude`, written by `/omp` and `/claude`; no file means omp): omp as before, or `claude` itself (not a shell alias). The final answer of a Claude worker comes from its transcript, found by the breadcrumb of the Claude hook in `~/.local/state/claude-herdr-resume/`. PR fix agents always start as omp. `~/.bun/bin/bun test tests/route.test.ts` checks this with fake `hc` and `herdr-app` programs and a temporary home.

## AI usage panel

The Windows layout has a fixed compact `AI usage` block between the sidebar lists and footer. Each provider card always shows `Today local` token activity when local records exist. That activity covers the Windows calendar day from local midnight and resets at the next local midnight. It is activity, not quota: tokens are never converted into a quota percentage.

Neither provider offers a documented 24-hour plan window. The panel therefore does not invent a daily limit. Instead it combines today's local activity with the provider's real current rolling windows: the shortest available window as a progress bar with percent used and left, its reset time and `5h` label, plus the `7d` window when supplied. The bar is the theme accent below 75% used, amber from 75%, red from 90%, and grey when the data is stale. A percentage bar appears only for provider quota data, never for token counts. Cards also show the model and plan when safely available; unavailable quota says so, and stale data is clearly labeled with the time it was last observed.

The two token totals follow each provider's local usage shape:

- **Claude:** input + cache creation (cache write) + cache read + output. Those cache fields are additive API usage.
- **OpenAI:** input + output. Cached input is a subset of input and reasoning output is a subset of output, so neither is added again.

Local collection is read-only and uses only Windows PowerShell 5.1 and Herdr built-ins. Its source allowlist is `%USERPROFILE%\.claude\projects\**\*.jsonl` and `%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl`. Claude assistant usage is deduplicated globally by `(sessionId, message.id)`, keeping the most complete usage and earliest duplicate timestamp. OpenAI response usage is deduplicated by `response_id`, with a metadata-only fallback key when that ID is absent. Records are then filtered to the current Windows local day. Missing source directories are `unavailable`, existing directories with no usable records are `empty`, malformed lines are ignored unless no source can be read, and one provider's failure never blocks the other.

OpenAI quota comes from the authenticated Codex installation already managed by the official app. The collector starts the user plugin `codex.exe`, falling back to the packaged OpenAI Codex executable, speaks the experimental [`codex app-server` API](https://developers.openai.com/codex/app-server) over stdio, and requests `account/rateLimits/read`. It projects only plan type, normal model slug, ordinary-usage availability, and each window's used percentage, duration, and reset timestamp. The interaction is bounded and failures affect only OpenAI; no separate credentials are requested or stored.

When that live read fails, OpenAI falls back to the latest `rate_limits` snapshot Codex already wrote to `%USERPROFILE%\.codex\sessions` in the last seven days, an approach taken from [Alevsk/herdr-agent-usage](https://github.com/Alevsk/herdr-agent-usage) (MIT). That snapshot is a past observation, so it is always shown as stale with its time, and windows that have already reset are dropped. The same project's Claude status-line hook is the model for the capture script below, including its `<model> · <usage>` status text. Its other sources don't apply here: it is a terminal-Herdr plugin, and `claude -p "/usage"` needs a standalone `claude` CLI, which this machine doesn't have.

**Claude subscription quota, live:** the panel asks the standalone [Claude Code CLI](https://code.claude.com/docs/en/setup) for `/usage`, the way the Agent SDK does (`claude -p --input-format stream-json --output-format stream-json`). It reads the structured `usage_report.rate_limits` from the reply. That's a local command: no model turn, no tokens, about 1–2 s. It runs quietly (`--no-session-persistence --strict-mcp-config --setting-sources project`, from `data\t3-usage\claude-cli`), so no session is saved, no MCP servers start and no hooks run. The card shows the general windows: weekly, and a session window when your plan reports one. Limits scoped to one model, like "Fable", are left out. Setup, once:

1. Install the native CLI: `irm https://claude.ai/install.ps1 | iex` in PowerShell (no admin). It goes to `%USERPROFILE%\.local\bin\claude.exe`, updates itself, and that folder needs to be on your user PATH.
2. In a new PowerShell window, `claude auth login`, and pick your **Claude.ai account (Pro/Max)**. A token reused from elsewhere doesn't carry the plan, and `/usage` then returns no limits; `claude auth status` should show `"authMethod": "claude.ai"` and your `subscriptionType`.

Without the CLI, or when it reports no limits, the panel falls back to the status-line snapshot below, then says `Subscription quota unavailable`. **The Claude desktop app doesn't run status lines**, so with Desktop alone that snapshot never appears.

**Status-line fallback:** after a Claude Code **terminal** response, the official [status-line API](https://code.claude.com/docs/en/statusline) sends its status payload to `capture-claude-quota.ps1`. The script retains only the safe model identifier/version, observation time, and the `five_hour` and `seven_day` used percentages and reset timestamps, atomically writes `%USERPROFILE%\.config\herdr-app\data\t3-usage\claude-quota.json`, and prints one concise status-line string. Configure Claude's `settings.json` with this exact command:

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

The panel asks every minute, without overlapping collector runs, and keeps only sanitized last-successful data in local storage. Each source then has its own pace, so the faster tick doesn't hit rate limits:

| Source | How often | Why |
|---|---|---|
| Claude subscription (`/usage`), OpenAI quota (Codex app-server) | every **2 min** | Both endpoints are rate-limited. Claude Code itself shares one read per minute and community trackers cache it for about 3 min; Codex's docs suggest 2–5 min. |
| …after a failed read (rate limit, timeout, signed out) | 4, 8, then every **15 min** | Backs off and serves the last good value meanwhile; that value keeps its old time, so after an hour it shows as stale. State: `data\t3-usage\claude-cli-quota.json`, `openai-quota.json`. |
| Claude API cost | every **15 min** | The data only refreshes every few hours. |
| Today's local tokens | every minute | Local files only. |

Its initial refresh runs from a zero-delay timer after the first render, so `herdr-app check` can render and exit without contacting a live broker. Manual refresh is the heading's refresh icon, or `herdr-app do t3-usage.refresh` (bindable in `keys.json`). A manual refresh re-reads what's due but doesn't skip the 2-minute pace of the live quotas.

### Expand and collapse

The chevron in the heading (`›` collapsed, `⌄` expanded) switches between two views. **Collapsed**, the default, shows each provider's main quota line, its bar and the reset time. **Expanded** adds the second window (OpenAI's weekly one), today's local tokens, and the Claude API cost. The block resizes with Herdr's `layout.resize` (246 px or 340 px) so the sidebar reflows. The choice is kept in the mod's local storage and re-applied on start. From a script, or bound to a key in `keys.json`: `herdr-app do t3-usage.expand` toggles it.

### Claude API cost

The Claude card can add one line from Anthropic's [Usage and Cost Analytics API](https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api): `API cost today $X · month $Y · through 3:00 PM`. That's what your **Claude Console (API) organization** spent: API calls, the Console, and Claude Code signed in with a Console account. It is **not** a Pro/Max subscription, whose limits stay on the quota bar above it. The API is in beta, needs an Admin API credential, and isn't available to claude.ai Team plans or individual Console accounts without an organization.

The data lags: usually under 4 hours, at most 24. The "through" time is the API's `data_refreshed_at`; anything after it is missing or partial. So the collector asks at most every 15 minutes (cached in `data\t3-usage\claude-api-cost.json`). "Today" starts at local midnight and "month" at the 1st; costs are after discounts, in US dollars.

It goes through [`ant`](https://github.com/anthropics/anthropic-cli), Anthropic's CLI, which the collector finds at `%LOCALAPPDATA%\Programs\ant\ant.exe` or on `PATH`. To install it, download `ant_<version>_windows_amd64.zip` from the releases, check it against `ant_<version>_checksums.txt`, and put `ant.exe` in that folder. Then pick one way to sign in:

- **Browser sign-in (recommended, no long-lived key):** `& "$env:LOCALAPPDATA\Programs\ant\ant.exe" auth login --admin` in PowerShell, as an organization admin. `ant` stores and refreshes the token itself.
- **Admin API key:** create one at [platform.claude.com/settings/admin-keys](https://platform.claude.com/settings/admin-keys), ideally with an expiry, then run `powershell -NoProfile -File "$env:USERPROFILE\.config\herdr-app\mods\t3-usage\set-claude-admin-key.ps1"` and paste it into the hidden prompt. It's saved with Windows DPAPI (this Windows user only) as `data\t3-usage\claude-admin-key.dpapi`, which is never synced, and handed to `ant` on stdin, never on its command line. `-Remove` deletes it. A stored key wins over the browser sign-in.

The line says `not set up` until one of those exists, `sign-in or Admin key rejected` on a 401, `needs a Console organization` when the sign-in works but the organization can't use the Admin API, `no data yet` before the API has any for the range, and `unavailable` on other errors. The key, tokens and `ant`'s messages never reach the panel or its output.

**Individual Console accounts** (named like "Jay's Individual Org") get the "needs a Console organization" state: the basic Admin endpoints answer `permission_error` ("Missing permissions"), and the analytics endpoints answer 404, even with `org:admin`. Set up an organization on [platform.claude.com/settings/organization](https://platform.claude.com/settings/organization), sign in again (`ant auth login --admin`), and refresh.

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
