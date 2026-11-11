#!/bin/sh
# Copies my Herdr config (and the omp parts it uses) into this repo, then commits and pushes any change.
#   ./sync.sh            save: live files -> repo, commit, push
#   ./sync.sh --restore  restore: repo -> live files (no git; Herdr reloads keys, layouts and mods live)
# On a Mac it syncs herdr/ and herdr-app/. In WSL it syncs windows/: the Windows Herdr app, whose
# terminals and omp run in WSL. omp/extensions/ and orchestrator/ are the same on both.
# Copies, not symlinks: Herdr writes files atomically, which replaces a symlink with a plain file.
# The repo is public: keep work names, tokens and internal URLs out of every file listed here.
set -eu
cd "$(dirname "$0")"

# Only what I made. Herdr's shipped mods/layouts/themes, run-time state (shared.json, view.json,
# window.json, data/, sockets, logs) and generated files (*.d.ts, jsconfig.json) stay out.
# spaces.json (pinned spaces and sections) stays out too: it holds the names of work spaces.
# The shared Mac/Windows mod set stays separate from Windows-only additions.
MODS=$(for m in t3-agents t3-chrome t3-inbox t3-menu t3-new-menu t3-pane t3-prs t3-spaces t3-tabs tmux-keys; do echo "mods/$m"; done)
WINDOWS_MODS="$MODS mods/t3-usage"
ORCHESTRATOR="$HOME/Projects/herdr-orchestrator-2026-11-08/.omp"
EXCLUDE="--exclude=*.d.ts --exclude=jsconfig.json --exclude=.DS_Store --exclude=*.bak*"
WSL=$(grep -qi microsoft /proc/version 2>/dev/null && echo 1 || true)
# Files on the Windows drive all read as mode 777: give everything plain modes instead.
PERMS=${WSL:+--chmod=D755,F644}
RESTORE=$([ "${1:-}" = "--restore" ] && echo 1 || true)

copy() { # copy <from-dir> <to-dir> <paths...>
  from=$1 to=$2; shift 2
  for p in "$@"; do
    mkdir -p "$to/$(dirname "$p")"
    # shellcheck disable=SC2086
    rsync -a --delete $PERMS $EXCLUDE "$from/$p" "$to/$(dirname "$p")/"
  done
}

sync() { # sync <live-dir> <repo-dir> <paths...>: one way or the other
  live=$1 repo=$2; shift 2
  if [ -n "$RESTORE" ]; then copy "$repo" "$live" "$@"; else copy "$live" "$repo" "$@"; fi
}

if [ -n "$WSL" ]; then
  WIN_HOME=$(wslpath "$(cd /mnt/c && /mnt/c/Windows/System32/cmd.exe /c 'echo %USERPROFILE%' | tr -d '\r')")
  # shellcheck disable=SC2086
  sync "$WIN_HOME/.config/herdr-app" windows/herdr-app \
    keys.json settings.json layouts/herdr-t3.json layouts/herdr-t3.svg themes/ghostty.json scripts $WINDOWS_MODS
  # omp: per-terminal session resume (the bash side; ~/.bashrc sources it) and the hourly `omp update`.
  sync "$HOME/.config/herdr-wsl" windows/wsl omp-resume.bash
  sync "$HOME/.config/systemd/user" windows/wsl/systemd omp-update.service omp-update.timer
else
  sync "$HOME/.config/herdr" herdr config.toml scripts
  # shellcheck disable=SC2086
  sync "$HOME/.config/herdr-app" herdr-app \
    keys.json settings.json layouts/herdr-t3.json layouts/herdr-t3.svg themes/ghostty.json scripts peon $MODS
  # omp: the hourly `omp update` LaunchAgent (the `omp` zsh function for resume is in my dotfiles repo).
  sync "$HOME/Library/LaunchAgents" omp/launchagents com.jay.omp-update.plist
fi
# omp: per-terminal session resume, and the orchestrator space's prompt, agents and herdr_* tools.
sync "$HOME/.omp/agent" omp extensions/herdr-resume.ts
sync "$ORCHESTRATOR" orchestrator/.omp APPEND_SYSTEM.md agents tools

if [ -n "$RESTORE" ]; then
  if [ -n "$WSL" ]; then
    # The orchestrator's tools and the `project` function call herdr-app from WSL.
    mkdir -p "$HOME/.local/bin"
    ln -sf "$WIN_HOME/AppData/Local/Programs/herdr-app/herdr-app.exe" "$HOME/.local/bin/herdr-app"
    SOURCE='[ -f ~/.config/herdr-wsl/omp-resume.bash ] && . ~/.config/herdr-wsl/omp-resume.bash'
    grep -qxF "$SOURCE" "$HOME/.bashrc" 2>/dev/null ||
      printf '\n# Herdr: per-terminal omp session resume (herdr-config windows/wsl/omp-resume.bash)\n%s\n' "$SOURCE" >> "$HOME/.bashrc"
    systemctl --user daemon-reload && systemctl --user enable --now omp-update.timer
    echo "Restored. Herdr reloads keys, layouts and mods by itself."
  else
    echo "Restored. For the terminal app, run: herdr server reload-config"
    echo "For omp updates, run: launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.jay.omp-update.plist"
  fi
  exit 0
fi

git add -A
if git diff --cached --quiet; then
  echo "No changes."
  exit 0
fi
git commit -q -m "chore: sync herdr config" -m "Co-authored-by: Claude <noreply@anthropic.com>"
git push -q -u origin HEAD
