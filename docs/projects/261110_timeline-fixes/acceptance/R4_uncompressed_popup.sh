#!/usr/bin/env bash
# R4 uncompressed_popup — proves R4: collapse on, playing, hovering the time label for 3 s: the popup stays shown, its rect is constant and inside the viewport, no hide/show and only text-change mutations, the text reads Uncompressed:
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
seed_gap_session "r4 popup" 20 >/dev/null
alt_wheel back
s="$(state)"
read -r x y < <(jq -r '.controls.scrubber.rect | "\((.left + 1) | floor) \((.top + .height / 2) | floor)"' <<<"$s")
click_at "$x" "$y"
sleep 1.5
set_collapse true
cmd '{"command":"click","selector":"#playPause"}' >/dev/null
sleep 0.5
jq -e '.playing and .collapse' < <(pstate)
# Hover the current/total label with the real pointer, then watch it for 3 s.
l="$(labels)"; jq -c . <<<"$l"
read -r lx ly < <(jq -r '.labelRect | "\((.left + .width / 2) | floor) \((.top + .height / 2) | floor)"' <<<"$l")
mouse_to "$lx" "$ly"
sleep 0.7
cmd '{"command":"popup-shows"}' | jq -c '{present, first}'
a="$(labels)"; sleep 1.5; b="$(labels)"; sleep 1.5; c="$(labels)"
shows="$(cmd '{"command":"popup-shows"}')"
jq -c . <<<"$a"; jq -c . <<<"$b"; jq -c . <<<"$c"
jq -c '{present, shows, titleWrites, mutations: (.mutations | group_by(.type + ":" + (.attributeName // "")) | map({(.[0].type + ":" + (.[0].attributeName // "")): length}) | add)}' <<<"$shows"
jq -e '.labelHover and .collapse' <<<"$a"
# Shown the whole time, in the same place, inside the window.
jq -e '.popupShown' <<<"$a"
jq -e '.popupShown' <<<"$b"
jq -e '.popupShown' <<<"$c"
jq -e --argjson a "$a" --argjson c "$c" -n '$a.popupRect == $c.popupRect'
jq -e '.popupRect as $r | $r.left >= 0 and $r.top >= 0 and $r.right <= .window.innerWidth and $r.bottom <= .window.innerHeight' <<<"$c"
jq -e '.popupText | test("^Uncompressed: [0-9:]+ / [0-9:]+$")' <<<"$c"
# No hide/show while hovered; the only mutations are text changes.
jq -e '.present and .shows == 0 and ([.mutations[] | select(.type == "attributes")] | length) == 0' <<<"$shows"
