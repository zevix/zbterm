#!/usr/bin/env bash
# R2 select_pauses — proves R2: a real drag starting in the terminal during playback pauses it; the play button has selection-paused, fa-i-cursor, the selection colour and a running blink animation (style-of); Play, or an Alt+wheel step, removes it
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
seed_gap_session "r2 pause" 20 >/dev/null
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
row="$(row_of '^tf-a3 *$')"
test -n "$row"
sel_log >/dev/null
# A real drag that starts in the terminal, while playing.
drag_cells "$row" 0 5
sel_log | jq -c '.events[]'
p="$(pstate)"; jq -c 'del(.timeline)' <<<"$p"
sel | jq -c .
jq -e '(.playing | not) and .pauseReason == "selection"' <<<"$p"
jq -e '.has and .text == "tf-a3"' < <(sel)
# The play button: the selection-paused mark, a caret in the selection colour, blinking.
b="$(style_of '#playPause')"; jq -c . <<<"$b"
jq -e '(.className | split(" ") | index("selection-paused")) != null' <<<"$b"
jq -e '.iconClass | split(" ") | index("fa-i-cursor") != null' <<<"$b"
jq -e '.iconColor == .selectionColor' <<<"$b"
jq -e '.animationName != "none" and .runningAnimations > 0' <<<"$b"
# Play removes it.
cmd '{"command":"click","selector":"#playPause"}' >/dev/null
sleep 0.5
b="$(style_of '#playPause')"; jq -c . <<<"$b"
jq -e '(.className | split(" ") | index("selection-paused")) == null and .runningAnimations == 0' <<<"$b"
jq -e '.playing and .pauseReason == null' < <(pstate)
# Again, and this time an Alt+wheel step removes it.
row="$(row_of '^tf-a2 *$')"
drag_cells "$row" 0 5
jq -e '(.playing | not) and .pauseReason == "selection"' < <(pstate)
jq -e '(.className | split(" ") | index("selection-paused")) != null' < <(style_of '#playPause')
alt_wheel back
b="$(style_of '#playPause')"; jq -c . <<<"$b"
jq -e '(.className | split(" ") | index("selection-paused")) == null and .runningAnimations == 0' <<<"$b"
