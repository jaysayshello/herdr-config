# Windows

`windows/herdr-app/` is the Windows desktop app's folder (`C:\Users\<me>\.config\herdr-app`). It has Windows versions of the layout and mods, and some mods only for Windows:

- Windows keys: `ctrl` or `alt` in place of `cmd`. New spaces open in WSL.
- `balance-panes.ps1` in place of the shell script.
- macOS-style window buttons at the top left (`t3-chrome/lights.js`, also copied into `t3-tabs`).
- One Spaces list: the WSL spaces first, then this computer's, with no machine headings.
- The AI usage panel, `mods/t3-usage/` (see [AI usage panel](#ai-usage-panel)).

Install it with `./install-windows.sh` in WSL. See the [main README](../README.md).

## WSL starts with Herdr

On Windows, Herdr connects to its `wsl` machine over ssh: `Host wsl` in `%USERPROFILE%\.ssh\config` points at `127.0.0.1:2222`, where sshd runs under systemd in Ubuntu. ssh cannot start WSL, and WSL stops when no `wsl.exe` session is left. So after `wsl --shutdown` or a WSL crash, Herdr used to show `WSL disconnected` until you started WSL by hand.

`windows/herdr-app/scripts/start-wsl.ps1` fixes this:

- It starts Ubuntu if it is not running. It keeps Ubuntu running with a hidden `wsl.exe -d Ubuntu --exec sleep infinity`, started through WMI so that it keeps running after the script ends. It then waits until sshd answers on port 2222.
- It does nothing when that hidden `wsl.exe` is already there. A lock (a mutex) stops two copies of the script from running at the same time.

Two things run it:

- Herdr itself. The Windows Spaces mod (`t3-spaces`) checks `hc machine ls` every 15 seconds. When the `wsl` machine is not connected, it runs the script, at most once a minute. This works however Herdr opens (Start menu, taskbar, a restart after an update), and also when WSL stops while Herdr is open. herdr-core connects again by itself a few seconds after sshd answers. No extra Herdr window ever opens.
- Windows login. The Startup shortcut `Herdr WSL keepalive` runs the same script, so WSL is ready before Herdr opens. `install-windows.sh` makes this shortcut.

While Herdr is open, WSL starts again within about a minute after `wsl --shutdown`. To keep WSL stopped, close Herdr first.

To test it, save your work in WSL first, because `wsl --shutdown` ends every WSL terminal and agent. With Herdr open, run `wsl --shutdown` in PowerShell. Within about a minute, `wsl -l --running` lists Ubuntu again, and the Spaces list shows the WSL spaces in place of `WSL disconnected`.

## AI usage panel

The Windows layout has an `AI usage` block between the sidebar lists and the footer. It has one card for Claude and one for OpenAI.

What each card shows:

- `Today local`: the tokens used today, counted from the local records. The day starts at local midnight. This is activity only. It is never turned into a percentage of a limit.
- The provider's real limit windows, when the provider reports them. Neither provider has a 24-hour limit, so the panel does not make one up. The shortest window shows as a bar with the percent used and left, its reset time and a `5h` label. The `7d` (weekly) window shows too when the provider gives it.
- The bar uses the theme's accent colour below 75% used, amber from 75%, red from 90%, and grey when the data is old.
- The model and plan, when they are known. When a limit is not available, the card says so. Old data shows the time it was last seen.

How the tokens are counted:

- Claude: input + cache write + cache read + output. Each of these is separate API usage, so they all add up.
- OpenAI: input + output. Cached input is part of input, and reasoning output is part of output, so they are not added again.

Where the local numbers come from:

- The collector only reads. It uses only Windows PowerShell 5.1 and Herdr's own functions.
- It reads only `%USERPROFILE%\.claude\projects\**\*.jsonl` and `%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl`.
- A Claude reply is counted once, by `(sessionId, message.id)`. When the same reply shows up twice, it keeps the most complete usage and the earliest time. An OpenAI reply is counted once by `response_id`, or by other details when that id is missing.
- Then it keeps only today's records.
- A missing folder shows as `unavailable`. A folder with no usable records shows as `empty`. Broken lines are skipped, unless no source can be read at all. A failure for one provider never stops the other.

OpenAI limits:

- The collector asks the Codex program that the OpenAI app already signed in. It starts the user's `codex.exe` (or the packaged OpenAI Codex program if that is missing), talks to it through the [`codex app-server` API](https://developers.openai.com/codex/app-server), and asks for `account/rateLimits/read`.
- It keeps only the plan type, the model name, whether normal use is available, and each window's percent used, length and reset time. It has a time limit, and a failure affects only OpenAI. It asks for no extra sign-in and stores no credentials.
- When that fails, it uses the last `rate_limits` record that Codex wrote to `%USERPROFILE%\.codex\sessions` in the last 7 days. This idea comes from [Alevsk/herdr-agent-usage](https://github.com/Alevsk/herdr-agent-usage) (MIT). That record is from the past, so it always shows as old, with its time. Windows that have already reset are dropped.

Claude limits, live:

- The panel asks the [Claude Code CLI](https://code.claude.com/docs/en/setup) for `/usage`, the way the Agent SDK does (`claude -p --input-format stream-json --output-format stream-json`). It reads `usage_report.rate_limits` from the answer.
- This runs on your computer. It uses no model and no tokens, and takes about 1 to 2 seconds.
- It runs with `--no-session-persistence --strict-mcp-config --setting-sources project`, from `data\t3-usage\claude-cli`. So it saves no session, starts no MCP servers and runs no hooks.
- The card shows the weekly window, and a session window when your plan has one. Limits for only one model, like "Fable", are left out.

To set up the Claude CLI, once:

1. Install the CLI: run `irm https://claude.ai/install.ps1 | iex` in PowerShell (no admin needed). It goes to `%USERPROFILE%\.local\bin\claude.exe` and updates itself. That folder must be on your user PATH.
2. In a new PowerShell window, run `claude auth login` and choose your Claude.ai account (Pro or Max). A token from somewhere else does not carry the plan, and `/usage` then returns no limits. `claude auth status` should show `"authMethod": "claude.ai"` and your `subscriptionType`.

Without the CLI, or when it reports no limits, the panel uses the status-line record below. When there is none, it says `Subscription quota unavailable`. The Claude desktop app does not run status lines, so with only the desktop app that record never shows.

Claude limits, from the status line:

- After each Claude Code reply in a terminal, Claude's [status-line feature](https://code.claude.com/docs/en/statusline) sends its status to `capture-claude-quota.ps1`.
- The script keeps only the model name and version, the time, and the `five_hour` and `seven_day` percent used and reset times. It writes them to `%USERPROFILE%\.config\herdr-app\data\t3-usage\claude-quota.json` and prints one short status line.
- A record counts as current for 60 minutes, and only while its reset time is still ahead. Older records show as old. Until the status line has seen one normal reply, the Claude limit is unavailable.

Put this in Claude's `settings.json`:

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

See also [Claude costs](https://code.claude.com/docs/en/costs) and [Codex pricing](https://developers.openai.com/codex/pricing).

What the panel never shows or keeps: sign-in tokens, cookies, account IDs, prompts, tool data, raw transcript lines, file paths, error output, or raw answers from Codex or Claude. The collector's output (version 2 of its format) has only times, local token counts, model and plan names, the limit state, and checked window percents and reset times.

How often it checks:

The panel runs the collector every minute, never two at a time, and keeps only the last good, cleaned data. Each source then has its own pace, so that the panel does not hit rate limits:

| Source | How often | Why |
|---|---|---|
| Claude limits (`/usage`) and OpenAI limits (Codex app-server) | every 2 minutes | Both have rate limits. Claude Code itself shares one read a minute, and other trackers keep the value for about 3 minutes. Codex's docs suggest 2 to 5 minutes. |
| After a failed read (rate limit, time limit, signed out) | after 4, then 8, then every 15 minutes | It waits longer each time and shows the last good value. That value keeps its old time, so after an hour it shows as old. The state is in `data\t3-usage\claude-cli-quota.json` and `openai-quota.json`. |
| Claude API cost | every 15 minutes | The data changes only every few hours. |
| Today's local tokens | every minute | Local files only. |

The first refresh runs just after the panel first draws. So `herdr-app check` can draw the panel and stop without a live call. To refresh by hand, click the refresh icon in the heading, or run `herdr-app do t3-usage.refresh` (you can bind it in `keys.json`). A manual refresh reads what is due, but it still waits the 2 minutes between live limit reads.

### Expand and collapse

The arrow in the heading (`›` closed, `⌄` open) switches between two views:

- Closed (the default): each provider's main limit line, its bar and the reset time.
- Open: also the second window (OpenAI's weekly one), today's local tokens and the Claude API cost.

The block changes its height with Herdr's `layout.resize` (246 px or 340 px), so the sidebar fits around it. The panel remembers your choice and uses it again when it starts. `herdr-app do t3-usage.expand` switches it from a script or a key in `keys.json`.

### Claude API cost

The Claude card can show one more line from Anthropic's [Usage and Cost Analytics API](https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api): `API cost today $X · month $Y · through 3:00 PM`.

- This is what your Claude Console (API) organization spent: API calls, the Console, and Claude Code signed in with a Console account. It is not your Pro or Max plan. That plan's limits stay on the bar above.
- The API is in beta. It needs an Admin API credential, and claude.ai Team plans and single-person Console accounts without an organization cannot use it.
- The data is late, usually by less than 4 hours and at most by 24. The "through" time is the API's `data_refreshed_at`. Anything after that time is missing or partial. So the collector asks at most every 15 minutes, and keeps the answer in `data\t3-usage\claude-api-cost.json`.
- "Today" starts at local midnight, and "month" on the 1st. Costs are after discounts, in US dollars.

It uses [`ant`](https://github.com/anthropics/anthropic-cli), Anthropic's command-line tool. The collector looks for it at `%LOCALAPPDATA%\Programs\ant\ant.exe` or on the PATH. To install it, download `ant_<version>_windows_amd64.zip` from the releases, check it against `ant_<version>_checksums.txt`, and put `ant.exe` in that folder. Then choose one way to sign in:

- Browser sign-in (the better choice, because no key stays on disk for a long time): run `& "$env:LOCALAPPDATA\Programs\ant\ant.exe" auth login --admin` in PowerShell, as an organization admin. `ant` keeps and renews the token itself.
- Admin API key: make one at [platform.claude.com/settings/admin-keys](https://platform.claude.com/settings/admin-keys), with an end date if you can. Then run `powershell -NoProfile -File "$env:USERPROFILE\.config\herdr-app\mods\t3-usage\set-claude-admin-key.ps1"` and paste the key at the hidden prompt. Windows DPAPI locks it to this Windows user, in `data\t3-usage\claude-admin-key.dpapi`. This file is never put in the repo. The key goes to `ant` through its input, never on its command line. `-Remove` deletes it. A saved key is used before the browser sign-in.

What the line says:

- `not set up` until you sign in or save a key.
- `sign-in or Admin key rejected` when the API answers 401.
- `needs a Console organization` when the sign-in works but the organization cannot use the Admin API.
- `no data yet` before the API has data for the dates.
- `unavailable` for other errors.

The key, the tokens and `ant`'s messages never reach the panel or its output.

Single-person Console accounts (with names like "<name>'s Individual Org") show `needs a Console organization`. Their basic Admin calls answer `permission_error` ("Missing permissions"), and the cost calls answer 404, even with `org:admin`. Make an organization at [platform.claude.com/settings/organization](https://platform.claude.com/settings/organization), sign in again (`ant auth login --admin`) and refresh.

### Hide and show

- To hide the panel, click the `×` next to the refresh icon, click Hide AI usage in the sidebar footer, or press `ctrl-shift-u`.
- To show it again, click Show AI usage in the sidebar footer (it stays there while the panel is hidden), or press `ctrl-shift-u`. From a script: `herdr-app do layout.show --id usage` (and `layout.hide` or `layout.toggle`).

These all use Herdr's own `layout.hide` and `layout.toggle` on the panel's layout block, `usage`. A hidden block takes no space, so the sidebar lists grow into it. Herdr remembers the choice after a restart, in `%USERPROFILE%\.config\herdr-app\layouts\.state\herdr-t3.json` (`nodes.usage.hidden`). If that file is reset, the panel shows again. Herdr keeps a hidden panel's mod running, so the panel checks on each timer tick and does not run the collector while hidden: no PowerShell, no Codex app-server and no file reads. When you show it again, it refreshes at once.

### Check

To check the collector from Windows (it always skips the live limits):

```powershell
powershell -NoProfile -File .\windows\herdr-app\mods\t3-usage\check-usage.ps1
```

The check sets a fixed time and day. It checks the version 2 output, what the Claude status-line script keeps, current and old records, the Codex fallback, and that one provider's failure does not stop the other. It never calls a network service or a real Codex or Claude. To check the panel in the app, use `herdr-app check` and `herdr-app shot`. To put the repo's panel into the live Windows app, run `./install-windows.sh` in WSL. Herdr loads layouts and mods by itself.
