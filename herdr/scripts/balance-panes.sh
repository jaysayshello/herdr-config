#!/bin/sh
# Ctrl+r: give every pane in the active tab an equal share of its row or column,
# the closest match to tmux's select-layout even-horizontal without rebuilding panes.
PATH="/opt/homebrew/bin:$PATH"
tab=${HERDR_ACTIVE_TAB_ID:?}
sock=${HERDR_SOCKET_PATH:?}

printf '{"id":"balance:export","method":"layout.export","params":{"tab_id":"%s"}}\n' "$tab" \
  | nc -U -w 2 "$sock" \
  | jq -c --arg tab "$tab" '
      def weight($d): if .type == "split" and .direction == $d
        then (.first | weight($d)) + (.second | weight($d)) else 1 end;
      def splits($path):
        if .type == "split" then
          .direction as $d
          | {path: $path, ratio: ((.first | weight($d)) / weight($d))},
            (.first | splits($path + [false])),
            (.second | splits($path + [true]))
        else empty end;
      .result.layout.root | splits([])
      | {id: "balance:set", method: "layout.set_split_ratio",
         params: {tab_id: $tab, path: .path, ratio: .ratio}}' \
  | while read -r req; do
      printf '%s\n' "$req" | nc -U -w 2 "$sock" >/dev/null
    done
