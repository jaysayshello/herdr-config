#!/bin/sh
# Installs the Windows Herdr setup. Run it in WSL: Herdr's terminals and omp run there.
# One way only: repo -> live.
#   ./install-windows.sh               copy the files, then set up the parts that need it
#   ./install-windows.sh --files-only  copy the files only: no systemd or Startup shortcut
# It installs windows/herdr-app/ into the Windows app folder (%USERPROFILE%\.config\herdr-app),
# windows/wsl/ (omp session resume for bash, the omp-update timer), omp/, orchestrator/ and claude/.
# It never deletes a live file, and it saves each file it replaces under
# ~/.local/state/herdr-config/backup-<time>/. For the Mac, run install-macos.sh.
set -eu
REPO=$(cd "$(dirname "$0")" && pwd)
grep -qi microsoft /proc/version 2>/dev/null || { echo "install-windows.sh runs in WSL. On a Mac, run ./install-macos.sh." >&2; exit 1; }
# shellcheck source=install-common.sh
. "$REPO/install-common.sh"

WIN_HOME=$(wslpath "$(cd /mnt/c && /mnt/c/Windows/System32/cmd.exe /c 'echo %USERPROFILE%' | tr -d '\r')")
APP=${HERDR_APP_HOME:-$WIN_HOME/.config/herdr-app}

put_herdr_app "$REPO/windows/herdr-app" "$APP"
# omp: per-terminal session resume (the bash side; ~/.bashrc sources it) and the hourly `omp update`.
put "$REPO/windows/wsl" "$HOME/.config/herdr-wsl" omp-resume.bash
put "$REPO/windows/wsl/systemd" "$HOME/.config/systemd/user" omp-update.service omp-update.timer
# The orchestrator's tools and the `project` function call herdr-app from WSL.
link=$(mktemp -d)
ln -s "$WIN_HOME/AppData/Local/Programs/herdr-app/herdr-app.exe" "$link/herdr-app"
write "$HOME/.local/bin/herdr-app" "$link/herdr-app"
rm -rf "$link"
SOURCE='[ -f ~/.config/herdr-wsl/omp-resume.bash ] && . ~/.config/herdr-wsl/omp-resume.bash'
if ! grep -qxF "$SOURCE" "$HOME/.bashrc" 2>/dev/null; then
  [ ! -f "$HOME/.bashrc" ] || { mkdir -p "$BACKUP$HOME"; cp -p "$HOME/.bashrc" "$BACKUP$HOME/.bashrc"; }
  printf '\n# Herdr: per-terminal omp session resume (herdr-config windows/wsl/omp-resume.bash)\n%s\n' "$SOURCE" >> "$HOME/.bashrc"
  echo "updated ~/.bashrc"
  UPDATED=$((UPDATED + 1))
fi
put_shared
report_files

systemctl --user daemon-reload && systemctl --user enable --now omp-update.timer
# Windows login: start WSL and keep it running (scripts/start-wsl.ps1, the script the Spaces
# mod also runs whenever Herdr finds WSL down).
# shellcheck disable=SC2016 # PowerShell expands these, not sh.
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -Command '
  $l = (New-Object -ComObject WScript.Shell).CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Herdr WSL keepalive.lnk")
  $l.TargetPath = "$env:SystemRoot\System32\conhost.exe"
  $l.Arguments = "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$env:USERPROFILE\.config\herdr-app\scripts\start-wsl.ps1`""
  $l.WorkingDirectory = $env:USERPROFILE
  $l.WindowStyle = 7
  $l.Save()'
echo "Set up the omp-update timer and the Herdr WSL keepalive shortcut."
check_herdr_app
