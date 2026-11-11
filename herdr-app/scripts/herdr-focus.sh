#!/bin/sh
# Opens a herdr-focus:// link: shows that terminal in Herdr.app and pulses its pane's border green.
#   herdr-focus.sh herdr-focus://<space-id>/<terminal>     e.g. herdr-focus://sp0123abcd/t40
# "Herdr Focus.app" (herdr-focus.applescript, built by herdr-focus-install.sh) runs this when a link
# is clicked, for example the More row of an orchestrator report box.
# Space ids change after a restart, so the terminal decides: a stale space id still finds it.
# The pulse: Herdr draws the focus border only on the focused pane, so for a few seconds this
# switches the layout's focus color between bright and dim green, then puts the file back as it was.
# It edits the layout file, not layout.set: that would also drop the layout's clicks (sizes).
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
GREEN="#4ade80" # the t3-prs "ready to merge" frame
DIM="#4ade8033"
STEPS=10        # 10 x 0.6 s: about 6 s
STATE="${TMPDIR:-/tmp}/herdr-focus"

fail() {
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Herdr focus"' -e 'end run' "$1" >/dev/null 2>&1
  echo "herdr-focus: $1" >&2
  exit 1
}

# The link is untrusted (an agent writes it): take only ids.
link=${1:-}
rest=${link#herdr-focus://}
[ "$rest" != "$link" ] || fail "Not a herdr-focus:// link: $link"
rest=${rest%/}
space=${rest%%/*}
terminal=${rest#*/}
printf '%s\n' "$space" | grep -Eq '^sp[0-9a-f]+$' || fail "Bad space id in $link"
printf '%s\n' "$terminal" | grep -Eq '^t[0-9a-z]+$' || fail "Bad terminal in $link"

# Where the terminal is now: its space, tab and pane.
where=$(herdr-app ls | jq -r --arg t "$terminal" '
  first(.spaces[] as $s | $s.tabs[] as $tab | $tab.terminals[] | select(.terminal == $t)
    | "\($s.id) \($tab.id) \(.pane)")') || fail "herdr-app ls failed: is Herdr open?"
[ -n "$where" ] || fail "Terminal $terminal is not open in Herdr"
set -- $where
herdr-app do space.select "{\"id\":\"$1\"}" >/dev/null &&
  herdr-app do tab.select "{\"id\":\"$2\"}" >/dev/null &&
  herdr-app do pane.focus "{\"pane\":\"$3\"}" >/dev/null || fail "Could not show $terminal"
open -b dev.herdr.app

# Pulse only a personal layout: Herdr replaces an edited shipped one (main, terminals, win98) at start.
name=$(herdr-app status | jq -r '.layout // empty')
dir="$HOME/.config/herdr-app/layouts"
file="$dir/$name.json"
case "$name" in "" | main | terminals | win98 | */* | .*) exit 0 ;; esac
[ -f "$file" ] || exit 0

mkdir -p "$STATE"
pidfile="$STATE/pulse.pid"
saved="$STATE/$name.json"
put() { # put <file>: replace the layout atomically, as Herdr does (a dot file it ignores, then mv)
  cp "$1" "$dir/.$name.focus-tmp" && mv "$dir/.$name.focus-tmp" "$file"
}
restore() {
  put "$saved" && rm -f "$saved" "$STATE/pulse.json"
  [ "$(cat "$pidfile" 2>/dev/null)" = $$ ] && rm -f "$pidfile"
}

# One pulse at a time. A new click stops the running pulse, which puts the file back first.
# Only a pid that is still this script: a reused pid belongs to something else.
old=$(cat "$pidfile" 2>/dev/null)
if [ -n "$old" ] && ps -p "$old" -o command= 2>/dev/null | grep -q herdr-focus.sh && kill "$old" 2>/dev/null; then
  while kill -0 "$old" 2>/dev/null; do sleep 0.05; done
fi
# A pulse that died without its cleanup left its copy: that copy is the real file.
[ -f "$saved" ] && put "$saved"
cp "$file" "$saved"
echo $$ > "$pidfile"
trap 'restore; exit 0' INT TERM HUP

i=0
while [ $i -lt $STEPS ]; do
  color=$([ $((i % 2)) -eq 0 ] && echo "$GREEN" || echo "$DIM")
  jq --arg c "$color" '(.. | objects | select(.content.tab? == "active" and .content.pane? != null)
    | .content.pane.focus) |= ((. // {width: 2}) + {color: $c})' "$saved" > "$STATE/pulse.json" && put "$STATE/pulse.json"
  sleep 0.6
  i=$((i + 1))
done
restore
