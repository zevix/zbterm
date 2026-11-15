#!/usr/bin/env bash
# U2 old peer — proves U2: against a core that sends no stream positions (as before this project) the app works as today.
# Asserts: the app is started with ZBTERM_NO_STREAM_POS=1 (the core leaves out end/through/position); the renderer says it is untracked (counts.untracked > 0, no gap, no resync); switching to a printing session shows its output (end marker on screen), the terminal is never blank after a switch; plus the unit tests test/live-stream.test.js (old-core cases) and test/rpc-schema.test.js (a body without end decodes) pass.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/activate"
source "$ZBUI_LIB"
source "$ZBUI_LIB_UP"
source "$here/lib_lo.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
( cd "$UB_REPO" && timeout 120 npx brittle-node test/live-stream.test.js test/rpc-schema.test.js )
ZBUI_APP_ENV=(ZBTERM_NO_STREAM_POS=1)
start_app
win_size 1280 800
a="$(seed_session u2-a 'echo A""READY' AREADY)"
b="$(seed_session u2-b 'echo B""READY' BREADY)"
for k in 1 2 3; do
  select_session "$b"
  flood "$a" "O${k}O" 300
  sleep 0.5
  select_session "$a"
  wait_end "$a" "O${k}O"
  sleep 1
  term_has "ENDO${k}O"
done
s="$(lstream)"; jq -c . <<<"$s"
jq -e '.stream.counts.untracked > 0 and .stream.counts.gaps == 0 and .resyncs == 0 and .stream.tracked == false' <<<"$s"
