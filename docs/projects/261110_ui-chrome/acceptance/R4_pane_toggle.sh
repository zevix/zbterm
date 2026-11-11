#!/usr/bin/env bash
# R4 pane_toggle — proves R4: hovering the logo shows the hamburger; clicking it and Ctrl+Shift+B each toggle the pane; the tooltip names Ctrl+Shift+B; the state survives a restart.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
logo_center() { jq -r '.brandMark.rect | "\((.left + .width / 2) | floor) \((.top + .height / 2) | floor)"'; }
s="$(state)"
jq -e '.sideCollapsed == false' <<<"$s"
read -r x y < <(logo_center <<<"$s")
# Hover: the real pointer on the logo swaps it for the hamburger.
mouse_to "$x" "$y"
s="$(state)"
jq '.brandMark' <<<"$s"
jq -e '.brandMark.hover == true' <<<"$s"
jq -e '.brandMark.hamburger == true' <<<"$s"
jq -e '.brandMark.title | test("^Hide side pane \\(Ctrl\\+Shift\\+B\\)$")' <<<"$s"
# A real click collapses the pane, and again expands it.
click_at "$x" "$y"
s="$(state)"
jq -e '.sideCollapsed == true' <<<"$s"
jq -e '.brandMark.title | test("^Show side pane \\(Ctrl\\+Shift\\+B\\)$")' <<<"$s"
read -r x y < <(logo_center <<<"$s")
click_at "$x" "$y"
jq -e '.sideCollapsed == false' <<<"$(state)"
# Ctrl+Shift+B, a real key press, toggles it too.
key ctrl+shift+b
jq -e '.sideCollapsed == true' <<<"$(state)"
# The state survives a restart.
restart_app
jq -e '.sideCollapsed == true' <<<"$(state)"
key ctrl+shift+b
jq -e '.sideCollapsed == false' <<<"$(state)"
restart_app
jq -e '.sideCollapsed == false' <<<"$(state)"
