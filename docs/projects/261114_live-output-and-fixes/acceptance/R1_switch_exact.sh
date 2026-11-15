#!/usr/bin/env bash
# R1 switch exact — proves R1: selecting an own live session while it prints shows every output line exactly once.
# Asserts: 8 trials: session A prints 1200 numbered lines (~2 ms apart) while B is shown; after a random 0.3-1.1 s, A is selected (the real switch path); once the engine's mirror has A's end marker, the renderer's buffer holds every line 1..1200 of that trial once (live-seam: no duplicate, none missing).
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
start_app
win_size 1280 800
a="$(seed_session r1-a 'echo A""READY' AREADY)"
b="$(seed_session r1-b 'echo B""READY' BREADY)"
bad=0
for k in $(seq 1 8); do
  select_session "$b"
  flood "$a" "Z${k}Z"
  sleep "0.$((RANDOM % 9 + 3))"
  select_session "$a"
  wait_end "$a" "Z${k}Z"
  sleep 1
  seam_ok "Z${k}Z" || { echo "trial $k: SEAM BROKEN"; bad=$((bad + 1)); }
done
lstream | jq -c '.stream.counts, .resyncs'
[ "$bad" = 0 ]
