#!/bin/sh
# Opens a rex-focus:// link: shows that terminal in Rex Beta.
#   rex-focus.sh rex-focus://<session uuid>/<block uuid>
# "Rex Focus.app" (rex-focus.applescript, built by rex-focus-install.sh) runs this when a link is
# clicked, for example the More row of an orchestrator report box (rex.ts focusLink).
# 1. `rex focus` makes the block the focused one of its session (works without the app's consent).
# 2. The app is asked to show that session and the block's tab. The app only takes actions from
#    the CLI with Settings > Server > Client Info > Remote Control on; without it, a notification
#    says so and the app still comes to the front.
# Herdr's green border pulse has no Rex equivalent (see rex/KEYS.md).
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
REX_DEFAULT="$HOME/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex"
if [ -n "${REX_BIN_DIR:-}" ] && [ -x "$REX_BIN_DIR/rex" ]; then rex="$REX_BIN_DIR/rex"
elif [ -x "$REX_DEFAULT" ]; then rex="$REX_DEFAULT"
else rex=rex; fi

notify() {
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Rex focus"' -e 'end run' "$1" >/dev/null 2>&1
  echo "rex-focus: $1" >&2
}
fail() {
  notify "$1"
  open -a 'Rex Beta' >/dev/null 2>&1
  exit 1
}

# The link is untrusted (an agent writes it): take only ids.
link=${1:-}
rest=${link#rex-focus://}
[ "$rest" != "$link" ] || fail "Not a rex-focus:// link: $link"
rest=${rest%/}
session=${rest%%/*}
block=${rest#*/}
UUID='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
printf '%s\n' "$session" | grep -Eq "$UUID" || fail "Bad session id in $link"
printf '%s\n' "$block" | grep -Eq "$UUID" || fail "Bad block id in $link"
session="session:$session"
block="block:$block"

out=$("$rex" focus -s "$session" "$block" 2>&1) || fail "Could not focus the terminal: $out"
window=$("$rex" block inspect -s "$session" "$block" --json 2>/dev/null | jq -r '.block.window_id // empty')
[ -n "$window" ] || fail "The terminal is not placed in a tab of its session"
client=$("$rex" client ls --json 2>/dev/null | jq -r 'first(.clients[] | select(.info.kind? == "app") | .client_id) // empty')
[ -n "$client" ] || fail "Rex Beta is not running"

open -a 'Rex Beta' >/dev/null 2>&1
if ! out=$("$rex" -C "$client" do session.select "session_id=$session" "window_id=$window" 2>&1); then
  case $out in
    *"not accepting actions"*)
      fail "Turn on Settings > Server > Client Info > Remote Control in Rex to jump to the terminal." ;;
    *) fail "Could not show the terminal: $out" ;;
  esac
fi
