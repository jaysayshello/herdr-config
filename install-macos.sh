#!/bin/sh
# Installs the Mac Herdr setup into the live config folders. One way only: repo -> live.
#   ./install-macos.sh               copy the files, then set up the parts that need it
#   ./install-macos.sh --files-only  copy the files only: no launchctl, app builds or reloads
# It installs herdr/ (the terminal app), herdr-app/ (the desktop app), the omp-update
# LaunchAgent, omp/, orchestrator/ and claude/, and rex/ when Rex is installed.
# It never deletes a live file, and it saves each file it replaces under
# ~/.local/state/herdr-config/backup-<time>/. For Windows, run install-windows.sh in WSL.
set -eu
REPO=$(cd "$(dirname "$0")" && pwd)
[ "$(uname -s)" = Darwin ] || { echo "install-macos.sh is for macOS. In WSL, run ./install-windows.sh." >&2; exit 1; }
# shellcheck source=install-common.sh
. "$REPO/install-common.sh"

REX_ORCHESTRATOR=${REX_ORCHESTRATOR:-$HOME/Projects/rex-orchestrator-2026-11-15}
APP=${HERDR_APP_HOME:-$HOME/.config/herdr-app}

put "$REPO/herdr" "$HOME/.config/herdr" config.toml scripts
put_herdr_app "$REPO/herdr-app" "$APP"
# omp: the hourly `omp update` LaunchAgent (the `omp` zsh function for resume is in my dotfiles repo).
put "$REPO/omp/launchagents" "$HOME/Library/LaunchAgents" com.jay.omp-update.plist
# Rex (rex/): only when Rex is installed. See rex/README.md.
REX=$(command -v rex || true)
if [ -n "$REX" ]; then
  put "$REPO/rex/config" "$HOME/.config/rex" init.lua
  put "$REPO/rex" "$HOME/.config/rex" scripts
  put "$REPO/rex/omp" "$HOME/.omp/agent" extensions/rex-resume.ts
  put "$REPO/rex/orchestrator/.omp" "$REX_ORCHESTRATOR/.omp" APPEND_SYSTEM.md agents tools extensions
fi
put_shared
report_files

# herdr-focus:// links (the orchestrator's More rows) open with the Herdr Focus applet.
"$APP/scripts/herdr-focus-install.sh"
# Load the LaunchAgent again each run, so launchd always has the installed plist.
domain=gui/$(id -u)
agent="$HOME/Library/LaunchAgents/com.jay.omp-update.plist"
launchctl bootout "$domain/com.jay.omp-update" 2>/dev/null || true
# launchd can take a moment to let go of the old job.
launchctl bootstrap "$domain" "$agent" 2>/dev/null || { sleep 1; launchctl bootstrap "$domain" "$agent"; }
echo "Loaded the omp-update LaunchAgent."
# The terminal app reads config.toml again; this fails harmlessly when its server is not running.
if command -v herdr >/dev/null && herdr server reload-config >/dev/null 2>&1; then echo "Reloaded the herdr terminal app's config."; fi
if [ -n "$REX" ]; then
  # rex-focus:// links (the Rex orchestrator's More rows) open with the Rex Focus applet.
  "$HOME/.config/rex/scripts/rex-focus-install.sh"
  rex config reload && echo "Reloaded Rex's config."
fi
check_herdr_app
