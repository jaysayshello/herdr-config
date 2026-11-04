#!/bin/sh
# Ctrl+h/j/k/l: hand the key to (n)vim like tmux's is_vim check, else swap the pane.
# Usage: swap-or-vim.sh <left|down|up|right> <key>
PATH="/opt/homebrew/bin:$PATH"
dir=$1
key=$2
pane=${HERDR_ACTIVE_PANE_ID:?}
herdr=${HERDR_BIN_PATH:-herdr}

if "$herdr" pane process-info --pane "$pane" \
  | jq -e 'any(.result.process_info.foreground_processes[].name; test("^g?(view|n?vim?x?)(diff)?$"; "i"))' >/dev/null; then
  "$herdr" pane send-keys "$pane" "$key"
else
  "$herdr" pane swap --direction "$dir" --pane "$pane" >/dev/null
fi
