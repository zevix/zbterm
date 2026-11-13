#!/usr/bin/env bash
# R2 icon — proves R2: a magnifying glass sits at the search box's right end, the in-session count just left of it, and a click on it focuses the box.
# Asserts: #searchIcon is drawn with class fa-magnifying-glass, inside the box's rect, its right edge within 16 px of the box's right edge; with a session holding R2MARK and the box holding R2MARK, the count text is 'N/M' and its right edge <= the icon's left edge (they never overlap); a real click on the icon (box not focused before) leaves .box.focused == true; the same in a narrow window (700 px).
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
sid="$(seed_session r2-alpha 'p=R2; echo "${p}MARK here"' 'R2MARK here')"
select_session "$sid"
check_icon() {
  local i s
  i="$(sty '#searchIcon')"; s="$(sstate)"
  jq -c '{visible, className, rect}' <<<"$i"; jq -c '.box' <<<"$s"
  jq -e '.visible == true and (.className | test("fa-magnifying-glass"))' <<<"$i"
  jq -e -n --argjson i "$i" --argjson s "$s" '$i.rect.left >= $s.box.rect.left and $i.rect.right <= $s.box.rect.right
    and ($s.box.rect.right - $i.rect.right) <= 16 and $i.rect.top >= $s.box.rect.top - 1 and $i.rect.bottom <= $s.box.rect.bottom + 1'
}
check_icon
type_box R2MARK
sleep 1
c="$(sty '#searchCount')"; i="$(sty '#searchIcon')"
jq -c '{text, rect}' <<<"$c"
jq -e '.visible == true and (.text | test("^[0-9]+/[0-9]+$"))' <<<"$c"
jq -e -n --argjson c "$c" --argjson i "$i" '$c.rect.right <= $i.rect.left'
# A click on the icon focuses the box.
focus_terminal
sstate | jq -e '.box.focused == false'
click_sel '#searchIcon'
sstate | jq -e '.box.focused == true'
# Narrow layout: the same.
key Escape
win_size 700 800
check_icon
