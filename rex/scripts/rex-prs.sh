#!/usr/bin/env zsh
# Pull requests list for a Rex tab (the Rex take on Herdr's t3-prs panel).
# Shows your open pull requests (Ready, then Draft) and your last 20 merged ones, newest first.
# One `gh api graphql` call every 60 s. Keys: r refreshes now, q quits.
# Cmd+click a pull request to open it (OSC 8 links). Bright green = ready to merge: not a draft,
# approved, MERGEABLE, and mergeStateStatus CLEAN or HAS_HOOKS (the orchestrator's PR-ready rule).
# Needs gh (logged in) and jq. Ctrl+space g in Rex opens it in the orchestrator session.
emulate -L zsh
setopt no_unset pipe_fail

EVERY=60
QUERY='{ viewer { open: pullRequests(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
  nodes { number title isDraft url reviewDecision mergeable mergeStateStatus
    repository { nameWithOwner } comments { totalCount }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }
  merged: pullRequests(states: MERGED, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number title url mergedAt repository { nameWithOwner } } } } }'

# Turns gh's JSON into the screen. Merge times are Eastern, 12-hour.
RENDER='
def link($url; $text): "\($e)]8;;\($url)\($e)\\\($text)\($e)]8;;\($e)\\";
def cut($n): if length > $n then .[0:$n-1] + "…" else . end;
def ci: (.commits.nodes[0].commit.statusCheckRollup.state // "NONE") as $s
  | {SUCCESS: "\($e)[32m✓ CI\($e)[0m", FAILURE: "\($e)[31m✗ CI\($e)[0m", ERROR: "\($e)[31m✗ CI\($e)[0m",
     PENDING: "\($e)[33m● CI\($e)[0m", EXPECTED: "\($e)[33m● CI\($e)[0m", NONE: "\($e)[2m· no CI\($e)[0m"}[$s];
def review: {APPROVED: "\($e)[32mapproved\($e)[0m", CHANGES_REQUESTED: "\($e)[31mchanges requested\($e)[0m",
     REVIEW_REQUIRED: "\($e)[33mreview required\($e)[0m"}[.reviewDecision // ""] // "\($e)[2mno review\($e)[0m";
def ready: (.isDraft | not) and .reviewDecision == "APPROVED" and .mergeable == "MERGEABLE"
  and (.mergeStateStatus == "CLEAN" or .mergeStateStatus == "HAS_HOOKS");
def name: "\(.repository.nameWithOwner)#\(.number)";
# The title, cut so the row fits the terminal: $rest is the room the rest of the row takes.
def title($rest): (name | length) as $l | .title | cut([$cols - $l - $rest, 10] | max);
def row: if ready
  then "  \($e)[1;92m● \(link(.url; name)) \(title(40))  ready to merge\($e)[0m  \(ci)  💬 \(.comments.totalCount)"
  else "  ○ \(link(.url; "\($e)[1m\(name)\($e)[0m")) \(title(42))  \(ci)  \(review)  💬 \(.comments.totalCount)" end;
def group($title; $list): "\($e)[1;4m\($title) (\($list | length))\($e)[0m",
  (if ($list | length) == 0 then "  \($e)[2mnone\($e)[0m" else ($list[] | row) end), "";
.data.viewer as $v
| ($v.open.nodes | map(select(.isDraft | not))) as $ready
| ($v.open.nodes | map(select(.isDraft))) as $draft
| group("Ready"; $ready), group("Draft"; $draft),
  "\($e)[1;4mMerged (\($v.merged.nodes | length))\($e)[0m",
  ($v.merged.nodes | sort_by(.mergedAt) | reverse | .[]
    | "  \($e)[35m✔\($e)[0m \(link(.url; name)) \(title(25))  \($e)[2m\(.mergedAt | fromdateiso8601 | strflocaltime("%b %-d, %-I:%M %p"))\($e)[0m")
'

ESC=$'\e'
cleanup() { print -n "${ESC}[?25h"; }
trap cleanup EXIT
trap 'exit 0' INT TERM HUP
print -n "${ESC}[?25l" # hide the cursor while the list shows

draw() {
  local out err cols=${$(stty size 2>/dev/null)[2]:-100}
  if out=$(gh api graphql -f query="$QUERY" 2>&1); then
    err=""
    out=$(TZ=America/New_York jq -r --arg e "$ESC" --argjson cols "$cols" "$RENDER" <<<"$out" 2>&1) || err=$out
  else
    err=$out
  fi
  print -n "${ESC}[H${ESC}[2J"
  print -r -- "${ESC}[1mPull requests${ESC}[0m  ${ESC}[2mupdated $(TZ=America/New_York date '+%-I:%M %p %Z') · r refresh · q quit${ESC}[0m"
  print
  if [[ -n $err ]]; then
    print -r -- "${ESC}[31mCould not load pull requests:${ESC}[0m"
    print -r -- "$err"
  else
    print -r -- "$out"
  fi
}

while true; do
  draw
  key=""
  read -s -k 1 -t $EVERY key
  case $key in
    q|Q) exit 0 ;;
  esac # r, any other key, or the timeout: draw again
done
