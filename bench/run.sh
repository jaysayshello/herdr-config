#!/bin/sh
# Runs the Herdr performance suite in a sandbox and writes a JSON result file.
#   bench/run.sh [--runs 5] [--only case,case] [--skip case] [--label name] [--out file.json] [--keep]
#   bun bench/compare.ts before.json after.json
# HOME, the herdr-core session and the Herdr app home all point into /tmp/hb-<pid> (short: macOS caps socket paths at 103 bytes)
# before Bun starts (Bun reads HOME once), so no test can reach the real window, core or state.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
[ -x "$BUN" ] || { echo "bench: bun not found" >&2; exit 1; }
ROOT=/tmp/hb-$$
mkdir -p "$ROOT/h"
export BENCH_ROOT="$ROOT" BENCH_REAL_PATH="$PATH" BENCH_REAL_HOME="$HOME"
export HOME="$ROOT/h" HC_SESSION=herdrbench HERDR_APP_HOME="$ROOT/h/.config/herdr-app" HERDR_APP_NO_SOUND=1
export PATH="$HOME/.local/bin:$PATH"
# The terminal this runs in belongs to the real core: its id must not reach the tools under test.
unset HC_TERMINAL_ID HC_TERMINAL_SOCKET HC_SCOPE
# caffeinate keeps the Mac and its display awake for the run: a sleep stops the clocks the cases
# compare, and Herdr does not draw while the display sleeps.
exec /usr/bin/caffeinate -di "$BUN" "$here/run.ts" "$@"
