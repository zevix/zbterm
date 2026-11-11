#!/usr/bin/env bash
# R5 compressed_end_time — proves R5: an ended session recorded with fixed sleeps: the compressed total equals the constant written here; toggling off, on, off, on gives the same total each time
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
# Kit correction 2026-11-11 (builder P1): the ended session below passes today;
# P1 reproduced R5 only in a running session (design.md *Causes*, R5), so a
# second part checks one: output every second, no gap above the 2 s threshold,
# so the compressed total must equal the real one, before and after toggling.
secs() { jq -R 'split(":") | map(tonumber) | reduce .[] as $p (0; . * 60 + $p)'; }
# Part 1, ended: output at 0 s, 5 s and 10 s, then the command exits. Real total
# 0:10; each 5 s gap collapses to the 2 s threshold, so the compressed total is
# 2 + 2 s = 0:04 (constants, not the app's own rule).
sid="$(seed_ended_session r5end 'printf "r5-a\n"; sleep 5; printf "r5-b\n"; sleep 5; printf "r5-c\n"')"
test -n "$sid"
wait_until 30 sh -c "curl -s http://127.0.0.1:$ZBUI_PORT/renderer/command -H 'content-type: application/json' -d '{\"command\":\"playback-state\"}' | jq -e '.mode == \"playback\" and (.active | not) and .playerReady' >/dev/null"
pstate | jq -c '.timeline'
set_collapse false
labels | jq -c '{current, total, title, collapse}'
jq -e '.total == "0:10"' < <(labels)
for want in true false true false true; do
  set_collapse "$want"
  l="$(labels)"; jq -c '{current, total, title, collapse}' <<<"$l"
  if [ "$want" = true ]; then jq -e '.total == "0:04"' <<<"$l"; else jq -e '.total == "0:10"' <<<"$l"; fi
done
# The same at the end of the recording.
for i in 1 2 3 4 5 6; do cmd '{"command":"click","selector":"#stepForward"}' >/dev/null; sleep 0.3; done
for want in false true false true; do
  set_collapse "$want"
  l="$(labels)"; jq -c '{current, total, title, collapse}' <<<"$l"
  if [ "$want" = true ]; then jq -e '.total == "0:04"' <<<"$l"; else jq -e '.total == "0:10"' <<<"$l"; fi
done
# Part 2, running: a line every second for 14 s, live, collapse toggled while it runs.
api POST /sessions '{"name":"r5 run","cols":80,"rows":24}' | jq -e '.sessionId'
sleep 2
api POST /sessions/current/input '{"text":"clear; for i in $(seq 1 14); do echo r5-tick-$i; sleep 1; done","enter":true}' >/dev/null
sleep 6
for want in true false true false true; do
  set_collapse "$want"
  sleep 1.5
  l="$(labels)"; p="$(pstate)"
  jq -c '{current, total, title, collapse}' <<<"$l"
  jq -c '{mode, startTs, endTs, timeline: (.timeline | length)}' <<<"$p"
  real_total=$(( ($(jq -r .endTs <<<"$p" | cut -d. -f1) - $(jq -r .startTs <<<"$p" | cut -d. -f1)) / 1000 ))
  shown=$(jq -r .total <<<"$l" | secs)
  echo "running: collapse=$want shown total ${shown}s, real total ${real_total}s"
  jq -e --argjson shown "$shown" --argjson real "$real_total" -n '($shown - $real) | fabs <= 1'
done
