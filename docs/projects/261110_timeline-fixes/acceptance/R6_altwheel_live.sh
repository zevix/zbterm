#!/usr/bin/env bash
# R6 altwheel_live — proves R6: on a running session: Alt+wheel back 3 frames, forward onto the last frame stays in playback, one more forward returns to live (as the plain wheel does)
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/../../261110_ui-chrome/acceptance/lib.sh"
need uisolate "the app runs only on a private display"
need xdotool "real mouse and keys on the private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
source "$(cd "$(dirname "$0")" && pwd)/tf.sh"
start_app
# A running session with one recorded frame per second.
api POST /window/bounds '{"x":0,"y":0,"width":1280,"height":800}' >/dev/null
api POST /sessions '{"name":"r6 wheel","cols":80,"rows":24}' | jq -e '.sessionId'
sleep 2
api POST /sessions/current/input '{"text":"clear; for i in 1 2 3 4 5 6; do echo r6-line-$i; sleep 1; done","enter":true}' >/dev/null
wait_until 20 term_has r6-line-6
sleep 2
pstate | jq -c 'del(.timeline)'
jq -e '.mode == "live"' < <(pstate)
# Back 3 frames from live: the first notch enters playback.
for i in 1 2 3; do alt_wheel back; done
s="$(pstate)"; jq -c 'del(.timeline)' <<<"$s"
jq -e '.mode == "playback" and .seq == .lastSeq - 3' <<<"$s"
# Forward onto the last frame: still playback, resting on it.
for i in 1 2 3; do alt_wheel forward; done
s="$(pstate)"; jq -c 'del(.timeline)' <<<"$s"
jq -e '.mode == "playback" and .seq == .lastSeq' <<<"$s"
# One more forward, asked for at the last frame: back to live, as the plain wheel does.
alt_wheel forward
sleep 1
s="$(pstate)"; jq -c 'del(.timeline)' <<<"$s"
jq -e '.mode == "live"' <<<"$s"
