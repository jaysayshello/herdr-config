#!/bin/sh
# Shows one Herdr notification outside the app: peon-ping's notify.sh draws it with the Herdr
# overlay (mac-overlay-herdr.js), in the strip above the Herdr window. The toast mod runs this.
# Usage: herdr-alert.sh <title> <body> <level> <icon_path> <action_json> <theme_json>
#   level: info | success | warning | error (notify()'s levels)
#   action_json: {"name": "...", "args": {...}} or "" ; a click runs it in Herdr
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
title=$1 body=$2 level=$3 icon=$4 action=$5 theme=$6
here="$(cd "$(dirname "$0")" && pwd)"

notify=""
for p in "$HOME/.claude/hooks/peon-ping/scripts/notify.sh" "$(brew --prefix 2>/dev/null)/opt/peon-ping/libexec/scripts/notify.sh"; do
  [ -f "$p" ] && { notify=$p; break; }
done
[ -n "$notify" ] || { echo "peon-ping notify.sh not found" >&2; exit 1; }

case "$level" in
  success) type=complete color=blue ;;
  warning) type=permission color=red ;;
  error) type=error color=red ;;
  *) type=info color=blue ;;
esac

# A click brings Herdr forward, then runs the toast's action (for example agent.focus).
click="open -b dev.herdr.app"
if [ -n "$action" ]; then
  name=$(printf '%s' "$action" | jq -r '.name // empty')
  args=$(printf '%s' "$action" | jq -c '.args // {}')
  [ -n "$name" ] && click="$click; herdr-app do $(printf '%q' "$name") $(printf '%q' "$args")"
fi

# The overlay stays alive in the background for its dismiss time; with the output detached, the
# caller (the toast mod's exec) gets the exit code at once and closes the in-app toast.
exec env PEON_DIR="$here/../peon" PEON_NOTIF_STYLE=overlay PEON_NOTIF_POSITION=herdr \
  PEON_NOTIFY_TYPE="$type" PEON_NOTIF_DISMISS="${HERDR_ALERT_DISMISS:-11}" PEON_NOTIF_ALL_SCREENS=false \
  PEON_CLICK_COMMAND="$click" HERDR_ALERT_TITLE="$title" HERDR_ALERT_THEME="$theme" \
  PEON_MSG_SUBTITLE="" bash "$notify" "$body" "$title" "$color" "$icon" >/dev/null 2>&1 </dev/null
