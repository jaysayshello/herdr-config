# herdr-config

This repo contains my configuration for [Herdr](https://herdr.dev), an app that runs AI agents in terminals. It has the configuration for macOS, for Windows with WSL, and for the Rex app.

## Install

You must have Herdr and `jq` on the computer. To get `jq`, use `brew install jq` on macOS or `sudo apt install jq` in WSL.

Do these steps in a terminal. On Windows, use a WSL terminal. Run only the script for your system.

```sh
git clone https://github.com/jaysayshello/herdr-config
cd herdr-config
./install-macos.sh      # on macOS
./install-windows.sh    # on Windows, in WSL
```

Each script stops if you use it on the wrong system. The scripts do not delete live files. Before a script replaces a file, it keeps a copy of the old file in `~/.local/state/herdr-config/backup-<time>/`. After the first install, start each Claude Code session again to load the Herdr hook.

- Add `--files-only` to copy only the files, without changes to launchd, systemd or the Focus apps.
- Set `HERDR_ORCHESTRATOR=<folder>` to use a different orchestrator folder. On macOS, `REX_ORCHESTRATOR=<folder>` does the same for Rex.
- Set `HERDR_APP_HOME=<folder>` to use a different Herdr app folder.

## Where the files go

| Repo folder | Live folder |
|---|---|
| `herdr-app/` (macOS desktop app) | `~/.config/herdr-app/` |
| `herdr/` (terminal app) | `~/.config/herdr/` |
| `windows/herdr-app/` (Windows desktop app, read `windows/README.md`) | `C:\Users\<me>\.config\herdr-app` |
| `windows/wsl/` | `~/.config/herdr-wsl/` and `~/.config/systemd/user/` in WSL |
| `omp/extensions/`, `omp/launchagents/` | `~/.omp/agent/extensions/`, `~/Library/LaunchAgents/` |
| `orchestrator/.omp/` | `~/Projects/herdr-orchestrator-2026-11-08/.omp/` |
| `claude/hooks/` | `~/.claude/hooks/` (the script also adds the hook to `~/.claude/settings.json`) |

## Features

- Pull requests panel (`t3-prs`): shows the CI state, approvals and comments of each PR. Right-click a PR to merge, close or change it to Ready or Draft.
- Beads panel (`t3-beads`, macOS): shows the [beads](https://github.com/gastownhall/beads) progress of the space. Press `cmd-alt-b` to show or hide it.
- Spaces list (`t3-spaces`): shows each space with a picture and the status of its agents.
- Orchestrator (`orchestrator/.omp/`): an omp session that sends tasks to the other terminals and reports the results.
- `/claude` and `/omp`: orchestrator commands that change idle and done terminals from omp to Claude Code, and back.
- `/reload`: an orchestrator command that starts each idle or done omp session again.
- PR fix agents: when a PR changes from draft to ready, an agent fixes its Compass and Semgrep findings.
- Focus links: `Herdr Focus.app` opens a `herdr-focus://` link and shows its terminal (macOS).
- AI usage panel (`t3-usage`, Windows): shows the Claude and OpenAI token use and limits. Press `ctrl-shift-u` to show or hide it.
- Rex (`rex/`, macOS): the same keys and orchestrator for the Rex app. Read `rex/README.md`.

## Make a change

CAUTION: Do not edit the live files. The next install replaces them with the repo files.

1. Change the files in the repo on a new branch.
2. Run `./install-macos.sh`, or run `./install-windows.sh` in WSL.
3. Make sure that Herdr shows the change. Herdr loads changes to mods, layouts and `keys.json` in approximately 1 second.
4. Run `tests/run.sh`, then open a pull request.

This repo is public. Do not put work names, tokens, internal URLs, account IDs or email addresses in it. For the performance tests, read `bench/README.md`. The pictures in `herdr-app/mods/t3-spaces/wizards/` are Dungeon Crawl Stone Soup tiles (CC0).
