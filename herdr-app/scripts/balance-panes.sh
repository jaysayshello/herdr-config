#!/bin/sh
# Ctrl+r in Herdr.app: give every pane in a tab an equal share of its row or column,
# like ~/.config/herdr/scripts/balance-panes.sh does for the herdr TUI.
# Rewrites the pane weights in herdr-core's "herdr-app" doc; the window follows the doc.
# Usage: balance-panes.sh <tab-id> [machine]   (machine: the tab's space lives there)
PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
tab=${1:?usage: balance-panes.sh <tab-id> [machine]}
on=$(jq -cn --arg m "${2:-}" 'if $m == "" then {} else {on: $m} end')

rpc() {
  printf '{"jsonrpc":"2.0","id":0,"method":"hello","params":{}}\n%s\n' "$1" \
    | hc connect | jq -c 'select(.id == 1)'
}

# doc.set fails on a stale version (the app wrote in between): read again and retry.
for _ in 1 2 3; do
  req=$(rpc "$(jq -cn --argjson on "$on" '{jsonrpc: "2.0", id: 1, method: "doc.get", params: ({name: "herdr-app"} + $on)}')" \
    | jq -ce --arg tab "$tab" --argjson on "$on" '
        def even: if has("children")
          then .children |= (length as $n | map(.size = {weight: (1 / $n)} | even))
          else . end;
        .result
        | select(any(.value.spaces[]?.tabs[]?; .id == $tab))
        | {jsonrpc: "2.0", id: 1, method: "doc.set",
           params: ({name: "herdr-app", version: .version,
                     value: (.value | .spaces[].tabs[] |= (if .id == $tab then .root |= even else . end))} + $on)}') \
    || exit 1
  rpc "$req" | jq -e '.result' >/dev/null && exit 0
done
exit 1
