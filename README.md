# herdr-config

This repo holds my setup for [Herdr](https://herdr.dev), a program for running many coding agents in terminals. It covers:

- the Herdr desktop app on my Mac (`herdr-app/`)
- the Herdr terminal app on my Mac (`herdr/`)
- the Herdr desktop app on Windows, where the terminals and omp run in WSL (`windows/`)
- the orchestrator: an omp session that hands work to the other terminals (`orchestrator/`)
- the Rex app, set up to work the same way as Herdr on the Mac (`rex/`)

My project notes, the keyboard rules and the full table of keys are in `~/Projects/ricing-herdr-2026-11-03/README.md`.

## Install

There is one install script for each system. Both need Herdr and `jq`. If `jq --version` fails, install it with `brew install jq` on the Mac, or `sudo apt install jq` in WSL.

| System | Run this | Where to run it |
|---|---|---|
| macOS | `./install-macos.sh` | a Mac terminal |
| Windows | `./install-windows.sh` | a WSL terminal (Herdr's terminals and omp run in WSL) |

Each script stops with a message if you run it on the other system. The code that both scripts use is in `install-common.sh`, which you do not run yourself.

### macOS

```sh
git clone https://github.com/jaysayshello/herdr-config
cd herdr-config
./install-macos.sh
```

It copies `herdr/`, `herdr-app/`, the LaunchAgent, and the shared files (see below) to the places in the [What's here](#whats-here) table. Then it:

- builds `~/Applications/Herdr Focus.app`, which opens `herdr-focus://` links
- loads the LaunchAgent that runs `omp update` each hour
- tells the Herdr terminal app to read its config again
- installs the Rex files, builds `Rex Focus.app` and tells Rex to read its config again, when Rex is installed (the `rex` command exists). Otherwise it skips Rex.

### Windows

Run this in WSL:

```sh
git clone https://github.com/jaysayshello/herdr-config
cd herdr-config
./install-windows.sh
```

It copies `windows/herdr-app/` into the Windows app folder (`C:\Users\<me>\.config\herdr-app`), `windows/wsl/` into WSL, and the shared files. Then it:

- links `herdr-app` into `~/.local/bin`, so WSL can call the Windows app
- makes `~/.bashrc` load `omp-resume.bash`
- turns on the `omp update` timer
- makes the Windows login shortcut that starts WSL (see [WSL starts with Herdr](#wsl-starts-with-herdr))

### What both scripts do

- They install the shared files: omp session resume, the orchestrator and the Claude Code hook.
- They add the Herdr hook to `~/.claude/settings.json` for each Claude Code event that does not have it yet. Your other hooks and settings stay as they are.
- When the Herdr app is open, they switch it to the `herdr-t3` layout and print any file that the app could not load. The app loads changed files by itself, so you do not need to restart it.

Both scripts are safe to run again:

- They never delete a file in your live folders. A file that is only on your computer, like an extra omp extension, stays.
- Before they replace a file that is different, they save the old one in `~/.local/state/herdr-config/backup-<date and time>/`, under the file's full path. To undo a run, copy the files back from there.
- They write each file to a hidden temporary file first, then move it into place, so Herdr never reads a half-written file.
- When a live file is a symlink (for example, `~/.claude/settings.json` linked to a dotfiles repo), the link stays and the file it points to gets the change.
- When nothing changed, they print `All files were already up to date.`

Options (the same for both):

- `--files-only` copies the files and does nothing else: no LaunchAgent, timer, shortcut, app builds or reloads.
- `HERDR_ORCHESTRATOR=<folder>` sets the orchestrator's folder. The default is `~/Projects/herdr-orchestrator-2026-11-08`. On the Mac, `REX_ORCHESTRATOR` does the same for Rex (default `~/Projects/rex-orchestrator-2026-11-15`).
- `HERDR_APP_HOME=<folder>` installs the Herdr app files into another app folder, the same setting the Herdr app uses.

The scripts copy files instead of making symlinks (links to the repo copy). Herdr saves its files by writing a new file over the old one, which turns a symlink back into a plain file. Herdr also does not load a mod's own images through a symlink.

## Make a change

1. Change the file in this repo, on a new branch.
2. Run `./install-macos.sh` (or `./install-windows.sh` in WSL) to try it. Herdr shows a change in a mod, a layout or `keys.json` within about a second.
3. Run `tests/run.sh` (see [Tests](#tests)), then open a pull request.

Do not edit the live files and copy them back. The install only goes one way, from the repo to the live folders.

The repo is public. Keep work names, tokens, internal web addresses, account IDs and email addresses out of every file.

## How the Herdr app files are laid out

`herdr-app/` has the same shape as the Herdr app's own config folder, `~/.config/herdr-app`. It is also the shape that Herdr's [gallery](https://herdr.dev/gallery/) uses to share a layout:

- `layouts/herdr-t3.json`: the window (what goes where and how it looks). `layouts/herdr-t3.svg` is its picture in the settings screen.
- `mods/<name>/`: the panels. A mod is a small JavaScript program that draws one part of the window, for example the Spaces list or the Pull requests panel.
- `themes/ghostty.json`: the colours.
- `keys.json`: the keys.
- `settings.json`: zoom and sounds.

The `~/.config/herdr-app/AGENTS.md` file, which Herdr writes, explains each of these files.

These are left out on purpose:

- the layouts, mods and themes that come with Herdr (Herdr puts them back each time it starts)
- the files Herdr writes while it runs (`shared.json`, `view.json`, `window.json`, `data/`, sockets, logs)
- files that Herdr makes from other files (`*.d.ts`, `jsconfig.json`)
- `spaces.json`, the pinned spaces and sections, because it holds the names of work spaces (`.gitignore` lists it)

Space colours and wizard pictures are kept by space id in `shared.json`, so they do not move to a new computer. New spaces get new ones.

## What's here

| Path | What it is | Installed to |
|---|---|---|
| `herdr/config.toml` | The terminal app's keys (prefix `ctrl+space`, like tmux) and screen settings | `~/.config/herdr/` |
| `herdr/scripts/` | `balance-panes.sh` (`ctrl+r`) and `swap-or-vim.sh` (`ctrl+h/j/k/l`) | `~/.config/herdr/scripts/` |
| `herdr-app/keys.json` | The desktop app's keys. The `layout:herdr-t3` part copies the terminal app's keys | `~/.config/herdr-app/` |
| `herdr-app/settings.json` | Zoom and sounds | `~/.config/herdr-app/` |
| `herdr-app/layouts/herdr-t3.json` | The layout: a sidebar with Spaces and Pull requests, the work area, and a hidden tab bar | `~/.config/herdr-app/layouts/` |
| `herdr-app/themes/ghostty.json` | Colours that match Ghostty | `~/.config/herdr-app/themes/` |
| `herdr-app/scripts/balance-panes.sh` | Makes all panes the same size (`ctrl-r`) | `~/.config/herdr-app/scripts/` |
| `herdr-app/scripts/herdr-focus.sh` | Opens a `herdr-focus://<space-id>/<terminal>` link. It shows that terminal and makes its border flash bright green for about 6 seconds (see [Focus links](#focus-links)) | `~/.config/herdr-app/scripts/` |
| `herdr-app/mods/tmux-keys/` | Keys that need some logic: swap panes unless vim is open, balance panes, a new space in `~/Projects`, move through the PR list | `~/.config/herdr-app/mods/` |
| `herdr-app/mods/t3-prs/` | The Pull requests panel (see [Pull requests panel](#pull-requests-panel)) | `~/.config/herdr-app/mods/` |
| `herdr-app/mods/t3-spaces/` | The Spaces list: a wizard picture for each space, a spinner while an agent works, a glow when it is done, pinned spaces and sections, and a frame around the orchestrator | `~/.config/herdr-app/mods/` |
| `herdr-app/mods/t3-chrome/` | The sidebar's top and bottom bars, and the key that shows or hides the tab bar (`cmd-shift-h`) | `~/.config/herdr-app/mods/` |
| `herdr-app/mods/t3-*` | The other mods the layout uses: tabs, pane header, inbox, new menu, agents | `~/.config/herdr-app/mods/` |
| `herdr-app/peon/` | Settings and the banner script for peon-ping, the sound and banner tool for agents | `~/.config/herdr-app/peon/` |
| `omp/extensions/herdr-resume.ts` | Each Herdr terminal keeps its own omp session. After a reboot, the shell opens that session again. The `omp` zsh function that reads it is in my dotfiles repo | `~/.omp/agent/extensions/` |
| `omp/launchagents/com.jay.omp-update.plist` | Runs `omp update` when you log in and each hour | `~/Library/LaunchAgents/` |
| `orchestrator/.omp/` | The orchestrator (see [The orchestrator](#the-orchestrator)) | `~/Projects/herdr-orchestrator-2026-11-08/.omp/` |
| `claude/hooks/herdr-claude.sh` | A Claude Code hook. It tells Herdr what Claude is doing and keeps a note of each terminal's session, so that the session can start again | `~/.claude/hooks/` |
| `windows/herdr-app/` | The Windows desktop app (see [Windows](#windows)) | `C:\Users\<me>\.config\herdr-app` |
| `windows/wsl/omp-resume.bash` | The bash side of omp session resume (the zsh side is in my dotfiles repo) | `~/.config/herdr-wsl/` in WSL |
| `windows/wsl/systemd/` | `omp-update.service` and `omp-update.timer`: run `omp update` a minute after WSL starts and each hour, like the Mac LaunchAgent | `~/.config/systemd/user/` in WSL |
| `rex/` | The Rex app with the same keys as Herdr, a Pull requests tab, `rex-focus://` links, omp session resume and its own orchestrator. Mac only. See `rex/README.md` | see `rex/README.md` |
| `bench/` | The performance tests. See [Performance tests](#performance-tests) | not installed |
| `tests/` | The tests. See [Tests](#tests) | not installed |
| `install-macos.sh`, `install-windows.sh` | The install scripts, one for each system. `install-common.sh` holds the code they share | not installed |

## Pull requests panel

The `t3-prs` mod shows my open pull requests (PRs) in the sidebar.

- Each PR shows its CI state, whether a code owner approved it, and its number of comments.
- A PR that is ready to merge gets a bright green frame.
- Right-click a PR to copy it as a `slackpr` line, move it to Ready or back to Draft (`gh pr ready`, `gh pr ready --undo`), merge it or close it.
- Merge shows only when the PR is approved, mergeable and has no conflicts. It asks first. It uses the first merge method the repo allows, and it merges only the commit you saw.
- A Merged section, which you can fold, lists the last 20 merged PRs, newest first, with the merge time in Eastern time.
- PRs in archived repos do not show, because GitHub does not let you change them.
- `node herdr-app/mods/t3-prs/check-prs.cjs` checks the section folds and Merge.

The Windows copy, `windows/herdr-app/mods/t3-prs/`, runs `gh` in WSL. It also lists the open PRs of each other account that `gh` is signed in to:

- To add an account, run `gh auth login` again. `gh auth status` then shows both accounts.
- For another account, it lists PRs in any repo that account can see, organizations too. For the active account, it lists only the repos that account owns.
- The accounts come from `gh auth status`, so no account names are in this repo.
- Each action on a PR (merge, ready, close, approvals, comments) runs as the account that found the PR. That account's token goes from `gh auth token` straight into that one `gh` command, so the active account never changes.

## Focus links

A `herdr-focus://<space-id>/<terminal>` link shows one terminal. The orchestrator puts one at the end of each report as `More:`.

- Herdr draws the focus border only on the focused pane. So `herdr-focus.sh` changes the layout's focus colour to bright green for about 6 seconds, then puts the layout file back.
- `herdr-focus.applescript` is the macOS program that opens these links. `herdr-focus-install.sh` builds it as `~/Applications/Herdr Focus.app` and tells macOS to use it for `herdr-focus://`. `install-macos.sh` runs it.

## The orchestrator

The orchestrator is an omp session in its own Herdr space. You tell it what you want, and it sends the work to the right terminal and reports back. Its files are in `orchestrator/.omp/`:

- `APPEND_SYSTEM.md` is its prompt.
- `tools/herdr.ts` gives it the `herdr_spaces`, `herdr_send`, `herdr_new_agent`, `herdr_new_space`, `herdr_wait`, `herdr_read` and `herdr_close_space` tools. `herdr_new_agent` gives omp its task in a file, because a Mac security rule can stop `sh -lc` when it gets a long argument.
- `extensions/herdr-watch.ts` adds `herdr_watch`. It watches a worker without a model and sends the worker's last answer to the orchestrator about 1 second after the worker stops. Its Workers panel shows `demo-service: <prompt>`, or `demo-service, <task title>: <prompt>` when a space has two watched workers. It does not show terminal ids.
- `extensions/herdr-spaces.ts` puts the `herdr_spaces` list in a hidden `<herdr-spaces>` message before each of your prompts. That way, the orchestrator can choose the terminal in its first model call. If the list fails or takes more than 2 seconds, it adds nothing.
- `extensions/herdr-pr-ready.ts` asks GitHub about your open PRs once a minute, in one `gh` GraphQL query. When a PR becomes approved, clean and mergeable, the orchestrator gets a `<herdr-pr-ready>` message and shows a box with the link, once for each new commit. When a PR is merged, it gets a `<herdr-pr-merged>` message, with its own sound.
- `extensions/herdr-pr-autofix.ts` starts a fix agent for each PR that moves from draft to ready. See [PR fix agents](#pr-fix-agents).
- `extensions/herdr-reload.ts` adds `/reload`. It restarts each idle or done omp session in every space, each with its own session file and in the same place, and the orchestrator last. `/reload <space>` does one space.
- `extensions/herdr-switch.ts` adds `/claude` and `/omp` (see [/claude and /omp](#claude-and-omp)). It uses `lib/handoff.ts` to write the handoff file. omp does not load `lib/` as an extension.
- `agents/herdr-watcher.md` is the backup subagent.

The tools also work from WSL. There, `herdr-app ls` names terminals like `wsl/t8`, and `hc` knows the same terminal as `t8`.

### PR fix agents

- Each PR that moves from draft to ready gets its own agent, in its own pane of the `reviewers` space. The panes sit side by side with equal widths, so 4 PRs give 4 agents at once.
- The agent fixes the Compass and Semgrep findings with the fix skill until none are left. It posts `/compass-review` when Compass did not review the newest commit.
- It stops after 10 rounds (`MAX_ROUNDS`), or when a finding comes back after 2 fixes (`MAX_REPEATS`). It then posts one short `🤖 Not fixed:` comment that lists what it could not fix.
- Each agent works in its own copy of the repo, in `/tmp/herdr-pr-autofix/<owner>-<repo>-<number>-<commit>/repo`, so two agents never share files. It starts in the project folder whose `MERGED-PRS.md`, `TODO.md` or `README.md` has the PR link, or else in its copy.
- The pane closes and the copy is deleted when the agent is done, or when the PR is merged or closed. Both stay while the agent is blocked or has an error.
- It runs once for each PR and commit, and never while that PR's pane is open.
- Each poll saves the list of drafts, so a PR that moves during a `/reload` still gets an agent. A first poll with no saved list from the last 10 minutes starts no agent.
- `ENABLED` turns the feature off.
- The orchestrator gets a `<herdr-pr-autofix>` message with the folder and watches the agent. It gets a `<herdr-pr-autofix-closed>` message when the pane closes.
- `tests/autofix.test.ts` checks this on a test Herdr.

## /claude and /omp

Type `/claude` in the orchestrator to switch each idle or done omp terminal to Claude Code, in the same pane and folder. `/omp` switches each Claude Code terminal back. `/claude <space name>` and `/omp <space name>` switch one space. At the end you get one report: what switched, what was skipped and why, and what failed. New workers start in the tool you switched to.

- The context moves in a handoff file in `~/.local/state/herdr-switch/handoffs/`. Only you can read it (mode 600), and it is deleted after 24 hours. It holds the summary, your prompts, the last answers, the open task and the project state. Tool output does not go across. The shell puts the file into the first prompt of the new tool, so Claude does not ask about the handoff folder.
- When you switch back, the tool opens its own old session again, with a handoff of only what happened after the last switch. If that session changed in the meantime, Claude gets a copy of it (`--fork-session`), and omp gets a new session with a full handoff.
- The title keeps its text. The `π` at the start becomes `✳` for Claude.
- Claude asks once for each folder whether you trust it. Before `/claude` starts Claude, it marks that terminal's folder, and only that folder, as trusted in the Claude config. That is `projects["<real path>"].hasTrustDialogAccepted` in `$CLAUDE_CONFIG_DIR/.claude.json`, or else `~/.claude.json`. It takes Claude's own lock on the file, changes only that one setting, and replaces the file with a new copy. Before its first change, it saves a copy in `~/.local/state/herdr-switch/claude.json.backup`. If the config cannot be read, it skips the terminal and the old tool keeps running.
- It skips the orchestrator and its space, the `reviewers` space, terminals that are working, blocked, in error or have no state, Claude with a background job, and terminals with no session file.
- A Claude terminal can report itself to Herdr as `claude` (from the hook) or `claude-code` (from Claude Code itself). Both count as Claude.
- A terminal where omp or Claude stopped without a quit (for example, it was killed) runs only a shell. If its note holds a session with no `quit` mark, the report says `no agent runs; its omp session stopped` (or `Claude session`), and the terminal is not changed. Type `omp` or `claude` there to open the session again.

Both commands need the Claude hook and refuse to run without it. Claude Code 2.1.326 and later report their own state (`claude-code`), but older versions do not, and only the hook writes each terminal's session note. The hook reports `claude-code` too. It does nothing for a `claude` that runs inside another omp or Claude. Both install scripts copy the hook and add it to `~/.claude/settings.json`. Restart each Claude session so that it loads the hook.

Limits:

- A terminal that runs omp as its program, with no shell after it, gets a new pane in the same place, so its terminal id changes. The report shows `old -> new`.
- A Claude terminal needs the hook. A terminal that started before the hook has no state, and `/omp` skips it.
- The handoff is a summary. It does not convert the whole session.

## Claude Code workers

The orchestrator sends work to omp and Claude Code terminals (Herdr app `omp` or `claude`) the same way. `herdr_send`, `herdr_watch` and the PR fix agents' folder search take both.

- `herdr_new_agent` and `herdr_new_space` start the tool that `~/.local/state/herdr-switch/mode` names: `omp` or `claude`. `/omp` and `/claude` write that file. With no file, they start omp.
- For Claude, they run `claude` itself, not a shell alias.
- The last answer of a Claude worker comes from its transcript. The hook's note in `~/.local/state/claude-herdr-resume/` tells it where the transcript is.
- PR fix agents always start as omp.
- `~/.bun/bin/bun test tests/route.test.ts` checks this with fake `hc` and `herdr-app` programs and a temporary home folder.

## Windows

`windows/herdr-app/` is the Windows desktop app's folder (`C:\Users\<me>\.config\herdr-app`). It has Windows versions of the layout and mods, and some mods only for Windows:

- Windows keys: `ctrl` or `alt` in place of `cmd`. New spaces open in WSL.
- `balance-panes.ps1` in place of the shell script.
- macOS-style window buttons at the top left (`t3-chrome/lights.js`, also copied into `t3-tabs`).
- One Spaces list: the WSL spaces first, then this computer's, with no machine headings.
- The AI usage panel, `mods/t3-usage/` (see [AI usage panel](#ai-usage-panel)).

### WSL starts with Herdr

On Windows, Herdr connects to its `wsl` machine over ssh: `Host wsl` in `%USERPROFILE%\.ssh\config` points at `127.0.0.1:2222`, where sshd runs under systemd in Ubuntu. ssh cannot start WSL, and WSL stops when no `wsl.exe` session is left. So after `wsl --shutdown` or a WSL crash, Herdr used to show `WSL disconnected` until you started WSL by hand.

`windows/herdr-app/scripts/start-wsl.ps1` fixes this:

- It starts Ubuntu if it is not running. It keeps Ubuntu running with a hidden `wsl.exe -d Ubuntu --exec sleep infinity`, started through WMI so that it keeps running after the script ends. It then waits until sshd answers on port 2222.
- It does nothing when that hidden `wsl.exe` is already there. A lock (a mutex) stops two copies of the script from running at the same time.

Two things run it:

- Herdr itself. The Windows Spaces mod (`t3-spaces`) checks `hc machine ls` every 15 seconds. When the `wsl` machine is not connected, it runs the script, at most once a minute. This works however Herdr opens (Start menu, taskbar, a restart after an update), and also when WSL stops while Herdr is open. herdr-core connects again by itself a few seconds after sshd answers. No extra Herdr window ever opens.
- Windows login. The Startup shortcut `Herdr WSL keepalive` runs the same script, so WSL is ready before Herdr opens. `install-windows.sh` makes this shortcut.

While Herdr is open, WSL starts again within about a minute after `wsl --shutdown`. To keep WSL stopped, close Herdr first.

To test it, save your work in WSL first, because `wsl --shutdown` ends every WSL terminal and agent. With Herdr open, run `wsl --shutdown` in PowerShell. Within about a minute, `wsl -l --running` lists Ubuntu again, and the Spaces list shows the WSL spaces in place of `WSL disconnected`.

### AI usage panel

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

#### Expand and collapse

The arrow in the heading (`›` closed, `⌄` open) switches between two views:

- Closed (the default): each provider's main limit line, its bar and the reset time.
- Open: also the second window (OpenAI's weekly one), today's local tokens and the Claude API cost.

The block changes its height with Herdr's `layout.resize` (246 px or 340 px), so the sidebar fits around it. The panel remembers your choice and uses it again when it starts. `herdr-app do t3-usage.expand` switches it from a script or a key in `keys.json`.

#### Claude API cost

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

Single-person Console accounts (with names like "Jay's Individual Org") show `needs a Console organization`. Their basic Admin calls answer `permission_error` ("Missing permissions"), and the cost calls answer 404, even with `org:admin`. Make an organization at [platform.claude.com/settings/organization](https://platform.claude.com/settings/organization), sign in again (`ant auth login --admin`) and refresh.

#### Hide and show

- To hide the panel, click the `×` next to the refresh icon, click Hide AI usage in the sidebar footer, or press `ctrl-shift-u`.
- To show it again, click Show AI usage in the sidebar footer (it stays there while the panel is hidden), or press `ctrl-shift-u`. From a script: `herdr-app do layout.show --id usage` (and `layout.hide` or `layout.toggle`).

These all use Herdr's own `layout.hide` and `layout.toggle` on the panel's layout block, `usage`. A hidden block takes no space, so the sidebar lists grow into it. Herdr remembers the choice after a restart, in `%USERPROFILE%\.config\herdr-app\layouts\.state\herdr-t3.json` (`nodes.usage.hidden`). If that file is reset, the panel shows again. Herdr keeps a hidden panel's mod running, so the panel checks on each timer tick and does not run the collector while hidden: no PowerShell, no Codex app-server and no file reads. When you show it again, it refreshes at once.

#### Check

To check the collector from Windows (it always skips the live limits):

```powershell
powershell -NoProfile -File .\windows\herdr-app\mods\t3-usage\check-usage.ps1
```

The check sets a fixed time and day. It checks the version 2 output, what the Claude status-line script keeps, current and old records, the Codex fallback, and that one provider's failure does not stop the other. It never calls a network service or a real Codex or Claude. To check the panel in the app, use `herdr-app check` and `herdr-app shot`. To put the repo's panel into the live Windows app, run `./install-windows.sh` in WSL. Herdr loads layouts and mods by itself.

## Tests

`tests/run.sh` runs `bun test tests/` in a sandbox: its own home folder, a test herdr-core session (`herdrtest`) and a test Herdr window. It uses fake `omp` and `claude` programs (`tests/fakes/fake-agent.ts`), so no test reaches your real window, terminals or state. `tests/install.test.ts` runs `install-macos.sh --files-only` into a temporary home folder, and checks that `install-windows.sh` refuses to run on a Mac.

## Performance tests

`./bench/run.sh` times how fast Herdr starts, how fast omp starts in a new pane, the orchestrator tools, the Pull requests panel, the PR polls and their GitHub cost, and CPU and memory use. It runs in a sandbox with a test window and a test herdr-core, and writes a JSON file. `bun bench/compare.ts a.json b.json` compares two runs. See `bench/README.md`.

## Credits

The pictures in `herdr-app/mods/t3-spaces/wizards/` are Dungeon Crawl Stone Soup tiles (CC0). See the `LICENSE.txt` in that folder.
