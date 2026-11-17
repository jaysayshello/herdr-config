#!/bin/sh
# Runs the tests in tests/ (bun test) in a sandbox, the same way bench/run.sh runs the suite.
#   tests/run.sh [bun test args]
# HOME, the herdr-core session and the Herdr app home all point into /tmp/hb-<pid> (short: macOS caps
# socket paths at 103 bytes) before Bun starts (Bun reads HOME once), so no test can reach the real
# window, core or state (bench/lib/guard.ts checks it). The core session is herdrtest, not the bench's
# herdrbench, so a test run and a bench run never share a core. switch.test.ts opens a test Herdr window.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
[ -x "$BUN" ] || { echo "tests: bun not found" >&2; exit 1; }
ROOT=/tmp/hb-$$
mkdir -p "$ROOT/h"
export BENCH_ROOT="$ROOT" BENCH_REAL_PATH="$PATH" BENCH_REAL_HOME="$HOME"
export HOME="$ROOT/h" HC_SESSION=herdrtest HERDR_APP_HOME="$ROOT/h/.config/herdr-app" HERDR_APP_NO_SOUND=1
export PATH="$HOME/.local/bin:$PATH"
# The terminal this runs in belongs to the real core: its id must not reach the code under test.
# The tests set their own Claude config folder.
unset HC_TERMINAL_ID HC_TERMINAL_SOCKET HC_SCOPE CLAUDE_CONFIG_DIR
cd "$here/.."
# caffeinate keeps the Mac and its display awake: Herdr does not draw while the display sleeps.
status=0
/usr/bin/caffeinate -di "$BUN" test tests/ "$@" || status=$?
[ -n "${TESTS_KEEP:-}" ] && echo "tests: sandbox kept in $ROOT" || rm -rf "$ROOT"
exit "$status"
