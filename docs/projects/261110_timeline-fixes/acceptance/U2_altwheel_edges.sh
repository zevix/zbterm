#!/usr/bin/env bash
# U2 altwheel_edges — proves U2: Alt+wheel forward at the end of an ended session stays on the last frame with no error; Alt+wheel back from live enters playback
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
api POST /window/bounds '{"x":0,"y":0,"width":1280,"height":800}' >/dev/null
# An ended session: three recorded lines a second apart, then the command exits.
sid="$(seed_ended_session u2end 'printf "u2-a\n"; sleep 1; printf "u2-b\n"; sleep 1; printf "u2-c\n"')"
test -n "$sid"
wait_until 30 sh -c "curl -s http://127.0.0.1:$ZBUI_PORT/renderer/command -H 'content-type: application/json' -d '{\"command\":\"playback-state\"}' | jq -e '.mode == \"playback\" and (.active | not) and .playerReady' >/dev/null"
for i in 1 2 3 4 5 6; do cmd '{"command":"click","selector":"#stepForward"}' >/dev/null; sleep 0.3; done
p="$(pstate)"; jq -c 'del(.timeline)' <<<"$p"
jq -e '.mode == "playback" and .seq == .lastSeq' <<<"$p"
# Alt+wheel forward at the end of the ended session: stays on the last frame, no error.
status_before="$(api GET /renderer/layout | jq -r '.app.status // ""')"
alt_wheel forward
alt_wheel forward
p="$(pstate)"; jq -c 'del(.timeline)' <<<"$p"
status_after="$(api GET /renderer/layout | jq -r '.app.status // ""')"
echo "status: '$status_before' -> '$status_after'"
jq -e '.mode == "playback" and .seq == .lastSeq and (.active | not)' <<<"$p"
jq -e -n --arg s "$status_after" '$s | test("error|fail"; "i") | not'
term_has u2-c
# Alt+wheel back from live on a running session: enters playback.
api POST /sessions '{"name":"u2 run","cols":80,"rows":24}' | jq -e '.sessionId'
sleep 2
api POST /sessions/current/input '{"text":"clear; for i in 1 2 3 4; do echo u2-line-$i; sleep 1; done","enter":true}' >/dev/null
wait_until 20 term_has u2-line-4
sleep 2
jq -e '.mode == "live"' < <(pstate)
alt_wheel back
p="$(pstate)"; jq -c 'del(.timeline)' <<<"$p"
jq -e '.mode == "playback" and .seq < .lastSeq' <<<"$p"
# Kit correction 2026-11-11 (builder P1): a positive control. The first check passes
# whether or not a forward step at the last frame can ever go live, so U2 also
# asserts that on this running session it does (R6's rule): only then does the
# ended-session check prove the go-live is refused there, not merely absent.
until jq -e '.seq == .lastSeq' < <(pstate) >/dev/null; do alt_wheel forward; jq -e '.mode == "playback"' < <(pstate) >/dev/null; done
alt_wheel forward
sleep 1
p="$(pstate)"; jq -c 'del(.timeline)' <<<"$p"
jq -e '.mode == "live"' <<<"$p"
