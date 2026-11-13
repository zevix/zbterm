#!/usr/bin/env bash
# R4 bubble — proves R4: the timeline bubble shows two centred lines, the clock time, then the time since the start; its content is today's (one line '<clock> · <elapsed>' before R4).
# Asserts: a live recorded session with output over 4 s; a real hover over the scrubber's middle shows the bubble (.bubble.hidden == false) with .bubble.lines of length 2: lines[0] ^[0-9]{2}:[0-9]{2}:[0-9]{2}$ (today's clock), lines[1] ^[0-9]+:[0-9]{2}( ([0-9:]+))?$; both textAlign center, each line's centre within 1.5 px of the bubble's centre, line 1 above line 2 (lines[0].rect.bottom <= lines[1].rect.top + 1), the bubble taller than one line (> 1.6 x line 1's height); .bubble.text == lines joined by ' · '; the same while the playhead is dragged (a real mousedown/move/up).
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_up.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
sid="$(seed_session r4-clock 'echo R4""A' R4A)"
for i in 1 2 3 4; do sinput "$sid" "echo r4-line-$i"; sleep 1; done
two_lines() {
  local s="$1"
  jq '.bubble' <<<"$s"
  jq -e '.bubble.hidden == false and (.bubble.lines | length == 2)' <<<"$s"
  jq -e '.bubble.lines[0].text | test("^[0-9]{2}:[0-9]{2}:[0-9]{2}$")' <<<"$s"
  jq -e '.bubble.lines[1].text | test("^[0-9]+(d [0-9]+)?:[0-9]{2}(:[0-9]{2})?( \\([0-9d :]+\\))?$")' <<<"$s"
  jq -e 'all(.bubble.lines[]; .textAlign == "center")' <<<"$s"
  jq -e '(.bubble.rect.left + .bubble.rect.width / 2) as $c | all(.bubble.lines[]; ((.rect.left + .rect.width / 2) - $c | fabs) <= 1.5)' <<<"$s"
  jq -e '.bubble.lines[0].rect.bottom <= .bubble.lines[1].rect.top + 1' <<<"$s"
  jq -e '.bubble.rect.height > 1.6 * .bubble.lines[0].rect.height' <<<"$s"
  jq -e '.bubble.text == (.bubble.lines | map(.text) | join(" · "))' <<<"$s"
}
s="$(state)"
read -r x y < <(jq -r '.bubble.scrubber | "\((.left + .width * 0.5) | floor) \((.top + .height / 2) | floor)"' <<<"$s")
mouse_to "$x" "$y"
two_lines "$(state)"
# While dragging.
mouse_to "$(jq -r '.bubble.scrubber | (.left + .width * 0.3) | floor' <<<"$s")" "$y"
xdo mousedown 1
mouse_to "$(jq -r '.bubble.scrubber | (.left + .width * 0.4) | floor' <<<"$s")" "$y"
d="$(state)"
xdo mouseup 1
two_lines "$d"
