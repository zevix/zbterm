#!/usr/bin/env bash
# U1 click_no_pause — proves U1: a plain click on the terminal, and a drag from the scrubber into the terminal, during playback leave it playing with no selection-paused class
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
seed_gap_session "u1 click" 20 >/dev/null
alt_wheel back
s="$(state)"
read -r x y < <(jq -r '.controls.scrubber.rect | "\((.left + 1) | floor) \((.top + .height / 2) | floor)"' <<<"$s")
click_at "$x" "$y"
sleep 1.5
# Play from the start; the lines tf-a1..5 are on screen within a few seconds, then
# the 20 s gap keeps the frame still while the clock plays on.
cmd '{"command":"click","selector":"#playPause"}' >/dev/null
wait_until 15 term_has tf-a5
jq -e '.mode == "playback" and .playing' < <(pstate)
# A plain click on the terminal (no drag): still playing, no mark.
read -r cx cy < <(cell_xy 8 20)
click_at "$cx" "$cy"
sleep 0.5
p="$(pstate)"; jq -c 'del(.timeline)' <<<"$p"
jq -e '.playing and .pauseReason == null' <<<"$p"
jq -e '(.className | split(" ") | index("selection-paused")) == null' < <(style_of '#playPause')
# A drag that starts on the scrubber and ends in the terminal: a seek, not a
# selection; playback resumes and no mark appears.
s="$(state)"
read -r sx sy < <(jq -r '.controls.scrubber.rect | "\((.left + .width * 0.1) | floor) \((.top + .height / 2) | floor)"' <<<"$s")
mouse_to "$sx" "$sy"
xdo mousedown 1
mouse_to "$sx" "$((sy - 120))"
mouse_to "$cx" "$cy"
xdo mouseup 1
sleep 1.5
p="$(pstate)"; jq -c 'del(.timeline)' <<<"$p"
jq -e '.playing and .pauseReason == null' <<<"$p"
jq -e '(.className | split(" ") | index("selection-paused")) == null' < <(style_of '#playPause')
# Kit correction 2026-11-11 (builder P1): a positive control. The checks above
# pass whether or not a drag pauses at all, so U1 also asserts that a real drag
# in the terminal does pause (R2's rule): only then do they prove a click and a
# scrubber drag are told apart from a selection.
wait_until 15 term_has tf-a3
row="$(row_of '^tf-a3 *$')"
drag_cells "$row" 0 5
p="$(pstate)"; jq -c 'del(.timeline)' <<<"$p"
jq -e '(.playing | not) and .pauseReason == "selection"' <<<"$p"
