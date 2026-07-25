#!/bin/bash
#
# reap-tracked.test.sh - deterministic regression test for the macOS window-reaping
# logic in scripts/wdio.sh (`reap_tracked_stalagmight`).
#
# This is safety-critical: a regression could SIGKILL a real `stalagmight` the user
# has open (e.g. via ./scripts/dev.sh) instead of only the windows the test run
# spawned. The function is sourced verbatim from wdio.sh, and `ps`/`kill` are
# mocked so we can assert EXACTLY which PIDs it decides to kill - no live
# processes, no races.
#
# Run:  bash scripts/reap-tracked.test.sh   (exits 0 on pass, 1 on failure)
#
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WDIO_SH="$SCRIPT_DIR/wdio.sh"

TEST=$(mktemp -d)
trap 'rm -rf "$TEST"' EXIT
export TMPDIR="$TEST"
KILLED_LOG="$TEST/killed"; : > "$KILLED_LOG"

# warn() is defined in wdio.sh; stub it for the isolated function.
warn() { :; }

# Mock kill: -0 = real liveness (for owner-shell checks); -9 = record, don't kill.
kill() {
  if [[ "$1" == "-0" ]]; then command kill -0 "$2" 2>/dev/null; return $?; fi
  if [[ "$1" == "-9" ]]; then echo "$2" >> "$KILLED_LOG"; return 0; fi
  command kill "$@"
}
# Mock ps: designate which PIDs look like a live `stalagmight` process.
ps() {
  case "$2" in
    1001|1002|1003|1004|1005) echo "/Users/x/.cargo_build/debug/stalagmight" ;;
    *) : ;;  # any other pid (dead / reused / non-stalagmight) -> empty comm
  esac
}

# Source the REAL function under test (via a temp file - process substitution +
# `source` is unreliable on macOS's bash 3.2).
sed -n '/^reap_tracked_stalagmight() {/,/^}/p' "$WDIO_SH" > "$TEST/fn.sh"
source "$TEST/fn.sh"
type reap_tracked_stalagmight >/dev/null 2>&1 || { echo "FAIL: could not load reap_tracked_stalagmight from $WDIO_SH"; exit 1; }

# --- scenario ---------------------------------------------------------------
export STALAGMIGHT_TEST_PIDFILE="$TEST/stalagmight-wdio-pids.ourrun"
printf '1001\n999999\n' > "$STALAGMIGHT_TEST_PIDFILE"        # ours -> reap 1001; dead/reused 999999 skipped
printf '1003\n'         > "$TEST/stalagmight-wdio-pids.999998"  # dead owner -> reap 1003
printf '1004\n'         > "$TEST/stalagmight-wdio-pids.$$"      # live owner, FRESH -> keep 1004
printf '1005\n'         > "$TEST/stalagmight-wdio-pids.$PPID"   # live owner, STALE -> reap 1005
touch -t "$(date -v-3H +%Y%m%d%H%M 2>/dev/null || date -d '3 hours ago' +%Y%m%d%H%M)" \
  "$TEST/stalagmight-wdio-pids.$PPID"
# 1002 = an untracked dev instance the user has open (in NO pidfile) -> must be spared.

reap_tracked_stalagmight

# --- assertions -------------------------------------------------------------
killed=$(sort -n "$KILLED_LOG" | tr '\n' ' ' | sed 's/ $//')
PASS=1
check() { if eval "$2"; then echo "  ok  - $1"; else echo "  FAIL- $1"; PASS=0; fi; }

check "kills exactly ours + dead-owner orphan + STALE live-owner orphan" '[[ "$killed" == "1001 1003 1005" ]]'
check "spares an untracked user dev instance (1002, in no pidfile)"       '! grep -q "^1002$" "$KILLED_LOG"'
check "spares a FRESH live-owner orphan (1004, concurrent run)"           '! grep -q "^1004$" "$KILLED_LOG"'
check "skips a dead/reused PID via verify-then-kill (999999)"             '! grep -q "^999999$" "$KILLED_LOG"'
check "removes our pidfile"                                               '[[ ! -f "$STALAGMIGHT_TEST_PIDFILE" ]]'
check "removes the dead-owner orphan pidfile"                            '[[ ! -f "$TEST/stalagmight-wdio-pids.999998" ]]'
check "removes the stale live-owner orphan pidfile"                      '[[ ! -f "$TEST/stalagmight-wdio-pids.$PPID" ]]'
check "keeps the FRESH live-owner pidfile (active concurrent run)"        '[[ -f "$TEST/stalagmight-wdio-pids.$$" ]]'

echo
if [[ $PASS == 1 ]]; then echo "reap-tracked.test.sh: PASS"; exit 0; else echo "reap-tracked.test.sh: FAIL"; exit 1; fi
