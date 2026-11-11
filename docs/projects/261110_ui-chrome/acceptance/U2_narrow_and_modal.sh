#!/usr/bin/env bash
# U2 narrow_and_modal — proves U2: at 700x600 (single-column layout) Ctrl+Shift+B and the logo still toggle the side pane and the top bar keeps New/Join/Settings reachable; with the settings menu open the toggle closes it first; with a dialog open the toggle does nothing and the dialog stays on top.
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
api POST /window/bounds '{"x":0,"y":0,"width":700,"height":600}' >/dev/null
sleep 0.5
s="$(state)"
# Single-column layout (the 780px media query).
jq -e '.window.innerWidth < 780' <<<"$s"
read -r x y < <(jq -r '.titleBox.title | "\((.left + .width / 2) | floor) \((.top + .height / 2) | floor)"' <<<"$s")
mouse_to "$x" "$y"
key ctrl+shift+b
s="$(state)"
jq '{sideCollapsed, topbarLeft, titleBox, window}' <<<"$s"
jq -e '.sideCollapsed == true' <<<"$s"
# New, Join and Settings stay reachable in the top bar, inside the window.
jq -e '.topbarLeft | index("newSession") != null and index("joinLink") != null and index("settingsToggle") != null' <<<"$s"
jq -e '.titleBox.topbarBrand != null and .titleBox.topbarBrand.right <= .window.innerWidth and .titleBox.topbarBrand.bottom <= .window.innerHeight' <<<"$s"
jq -e '[.controls.newSession, .controls.joinLink] | all(.hidden == false and .rect.right <= 700)' <<<"$s"
s="$(cmd '{"command":"click","selector":"#brandMark, .brand-mark"}')"
jq -e '.sideCollapsed == false' <<<"$s"
# With the settings menu open, the toggle closes it first.
s="$(cmd '{"command":"settings-open"}')"
jq -e '.menuOpen == true' <<<"$s"
key ctrl+shift+b
s="$(state)"
jq -e '.menuOpen == false and .sideCollapsed == true' <<<"$s"
# With a dialog open (Join, then the New dialog) the toggle does nothing; the dialog stays on top.
for open in '{"command":"join-open"}' '{"command":"click","selector":"#newSession"}'; do
  before="$(open_dialog "$open")"
  jq -e '.modal != null or .title != null' <<<"$before"
  key ctrl+shift+b
  s="$(state)"
  jq '{sideCollapsed, modal: (.modal | {kind, title, onTop})}' <<<"$s"
  jq -e '.sideCollapsed == true and .modal != null and .modal.onTop == true' <<<"$s"
  cmd '{"command":"dialog-cancel"}' >/dev/null
done
