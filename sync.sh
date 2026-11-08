#!/bin/sh
# Copies my Herdr config from ~/.config into this repo, then commits and pushes any change.
#   ./sync.sh            save: ~/.config -> repo, commit, push
#   ./sync.sh --restore  restore: repo -> ~/.config (no git; Herdr reloads keys, layouts and mods live)
# Copies, not symlinks: Herdr writes files atomically, which replaces a symlink with a plain file.
set -eu
cd "$(dirname "$0")"

# Only what I made. Herdr's shipped mods/layouts/themes, run-time state (shared.json, view.json,
# window.json, data/, sockets, logs) and generated files (*.d.ts, jsconfig.json) stay out.
APP_MODS="t3-agents t3-chrome t3-inbox t3-menu t3-new-menu t3-pane t3-prs t3-spaces t3-tabs tmux-keys"
APP_FILES="keys.json settings.json spaces.json layouts/herdr-t3.json layouts/herdr-t3.svg themes/ghostty.json scripts peon"
TUI_FILES="config.toml scripts"
EXCLUDE="--exclude=*.d.ts --exclude=jsconfig.json --exclude=.DS_Store --exclude=*.bak*"

copy() { # copy <from-dir> <to-dir> <paths...>
  from=$1 to=$2; shift 2
  for p in "$@"; do
    mkdir -p "$to/$(dirname "$p")"
    # shellcheck disable=SC2086
    rsync -a --delete $EXCLUDE "$from/$p" "$to/$(dirname "$p")/"
  done
}

if [ "${1:-}" = "--restore" ]; then
  copy herdr "$HOME/.config/herdr" $TUI_FILES
  copy herdr-app "$HOME/.config/herdr-app" $APP_FILES $(for m in $APP_MODS; do echo "mods/$m"; done)
  echo "Restored. For the terminal app, run: herdr server reload-config"
  exit 0
fi

copy "$HOME/.config/herdr" herdr $TUI_FILES
copy "$HOME/.config/herdr-app" herdr-app $APP_FILES $(for m in $APP_MODS; do echo "mods/$m"; done)

git add -A
if git diff --cached --quiet; then
  echo "No changes."
  exit 0
fi
git commit -q -m "chore: sync herdr config" -m "Co-authored-by: Claude <noreply@anthropic.com>"
git push -q -u origin HEAD
