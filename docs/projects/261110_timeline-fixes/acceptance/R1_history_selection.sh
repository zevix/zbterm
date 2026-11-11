#!/usr/bin/env bash
# R1 history_selection — proves R1: in paused playback a real drag selects text; the exact text is still selected after 3 s and a window resize, in a plain shell and in less --mouse, with copy-on-select on and off; a step forward clears it (A-1)
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
# A running session: five plain lines, 20 s idle, then less with the mouse on (a
# program that owns the mouse). Its playback has a plain frame that lasts 20 s and,
# last, the less frame.
api POST /sessions '{"name":"r1 history","cols":80,"rows":24}' | jq -e '.sessionId'
sleep 2
api POST /sessions/current/input '{"text":"clear; for i in 1 2 3 4 5; do echo r1-line-$i; done; sleep 20; seq -f \"r1-less-%g\" 1 40 > ~/r1.txt; less --mouse ~/r1.txt","enter":true}' >/dev/null
wait_until 40 term_has r1-less-3
sleep 2
plain_frame() { term_has r1-line-3 && ! term_has r1-less-3; }
less_frame() { term_has r1-less-3; }
# Into playback (paused), then onto the plain frame.
alt_wheel back
for i in 1 2 3 4 5 6; do plain_frame && break; alt_wheel back; done
plain_frame
# kept <text>: the selection is exactly <text>.
kept() { local s; s="$(sel)"; jq -c . <<<"$s"; jq -e --arg w "$1" '.has and .text == $w' <<<"$s"; }
hold_and_resize() {
  sleep 3
  kept "$1"
  api POST /window/bounds '{"x":0,"y":0,"width":1180,"height":760}' >/dev/null
  sleep 1.5
  kept "$1"
  api POST /window/bounds '{"x":0,"y":0,"width":1280,"height":800}' >/dev/null
  sleep 1.5
  kept "$1"
}
for copy in true false; do
  set_copy_on_select "$copy"
  # The plain frame: select, hold 3 s, resize; a step forward (a new frame) clears it.
  jq -e '.mode == "playback" and (.playing | not)' < <(pstate)
  row="$(row_of '^r1-line-3 *$')"
  sel_log >/dev/null
  drag_cells "$row" 0 9
  sel_log | jq -c '.events[]'
  kept r1-line-3
  hold_and_resize r1-line-3
  # Kit correction 2026-11-11 (builder P1): the steps above pass today; P1
  # reproduced R1 only by scrolling the timeline (design.md *Causes*, R1). One
  # horizontal wheel notch moves the clock inside the 20 s gap, so the frame
  # (seq) stays the same and the selection must stay too.
  seq_before="$(pstate | jq .seq)"
  read -r wx wy < <(cell_xy 10 30)
  mouse_to "$wx" "$wy"
  xdo click 7
  sleep 1.5
  sel_log | jq -c '.events[]'
  pstate | jq -c 'del(.timeline)'
  jq -e --argjson s "$seq_before" '.mode == "playback" and (.playing | not) and .seq == $s' < <(pstate)
  kept r1-line-3
  alt_wheel forward
  pstate | jq -c 'del(.timeline)'
  jq -e '.has | not' < <(sel)
  # The less frame (the last one): the same; a step back clears it.
  for i in 1 2 3 4 5 6; do less_frame && break; alt_wheel forward; done
  less_frame
  jq -e '.mode == "playback" and (.playing | not) and .mouseTracking != "none"' < <(jq -s '.[0] * .[1]' <(pstate) <(sel))
  row="$(row_of '^r1-less-3 *$')"
  sel_log >/dev/null
  drag_cells "$row" 0 9
  sel_log | jq -c '.events[]'
  kept r1-less-3
  hold_and_resize r1-less-3
  sel_log | jq -c '.events[]'
  alt_wheel back
  jq -e '.has | not' < <(sel)
  for i in 1 2 3 4 5 6; do plain_frame && break; alt_wheel back; done
  plain_frame
done
