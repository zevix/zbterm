#!/usr/bin/env bash
# R8 search mode — proves R8 and R9: in search mode the empty box reads "Search (Esc to exit)" and the blue "x" stands where the magnifying glass was, closing the search.
# Asserts: focused box → .app.searching, that placeholder, icon fa-circle-xmark in --accent-blue-border with a pointer cursor and no native cancel button; unfocused and empty → "Search (Ctrl+Shift+F)" and the magnifying glass; a click on the "x" with an empty focused box, and with text, empties the box and leaves search mode (focus not in the box); Esc does the same.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/activate"
source "$ZBUI_LIB"
source "$ZBUI_LIB_UP"
source "$here/lib_lo.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
a="$(seed_session r8-a 'echo A""READY' AREADY)"
select_session "$a"
sm() { cmd '{"command":"search-mode"}'; }
off() {
  local s; s="$(sm)"; jq -c '{on, focused, value, placeholder, iconClass}' <<<"$s"
  jq -e '.on == false and .focused == false and .value == "" and .placeholder == "Search (Ctrl+Shift+F)" and (.iconClass | test("fa-magnifying-glass")) and (.iconClass | test("fa-circle-xmark") | not)' <<<"$s"
}
focus_terminal
off
click_box
s="$(sm)"; jq -c . <<<"$s"
jq -e '.on == true and .focused == true and .placeholder == "Search (Esc to exit)" and (.iconClass | test("fa-circle-xmark")) and (.iconClass | test("fa-magnifying-glass") | not)' <<<"$s"
jq -e '.iconColor == .blue and .cancelButtonHidden == true and .iconTitle == "Close search (Esc)"' <<<"$s"
sty '#searchIcon' | jq -e '.cursor == "pointer" and .visible == true'
# The "x" with the box empty and focused: the click closes, it does not refocus.
click_sel '#searchIcon'
off
# With text, the box keeps its placeholder rule (text shown) and the "x" closes and empties it.
type_box R8TEXT
s="$(sm)"; jq -e '.on == true and .value == "R8TEXT" and (.iconClass | test("fa-circle-xmark"))' <<<"$s"
click_sel '#searchIcon'
off
# Esc does the same.
type_box R8TEXT
key Escape
off
