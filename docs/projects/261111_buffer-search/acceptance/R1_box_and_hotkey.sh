#!/usr/bin/env bash
# R1 box_and_hotkey — proves R1: there is one search box, the former 'Search sessions' box (#search), first in the bottom bar at the window's bottom left with the status text to its right, and Ctrl+Shift+F focuses it.
# Asserts: search-state .box.id == "search" and .box.inSidebar == false; exactly one text input in the window has a search placeholder (no second search box; the side pane's .tools holds no input); .bottomCells starts ["search","status"]; .box.rect.left <= 1 and the box's bottom edge is the window's (±2 px); .statusRect.left >= .box.rect.right; after a real Ctrl+Shift+F with the terminal focused, .box.focused == true and the box's text is selected (type 'abc', press it again, the selection covers 'abc'); typing a session's name still filters the list (name rows == that session); the status text is still shown (non-empty, not overlapped); at 700x600 (narrow) the box is visible, full-width in the bar's first row, and Ctrl+Shift+F focuses it.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_bs.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
sa="$(seed_session r1-alpha 'echo R1A""READY' R1AREADY)"
sb="$(seed_session r1-beta 'echo R1B""READY' R1BREADY)"
# Ctrl+Shift+F, a real key press, with the terminal focused.
focus_terminal
key ctrl+shift+f
s="$(sstate)"
jq . <<<"$s"
jq -e '.box.id == "search"' <<<"$s"
jq -e '.box.inSidebar == false' <<<"$s"
# One box: the only search input in the window, none left in the pane's .tools.
jq -e '.searchInputs == ["search"]' <<<"$s"
jq -e '.toolsInputs == 0' <<<"$s"
jq -e '.bottomCells[0:2] == ["search", "status"]' <<<"$s"
jq -e '.box.rect.left <= 1' <<<"$s"
jq -e '(.window.innerHeight - .box.rect.bottom) | fabs <= 2' <<<"$s"
jq -e '.statusRect.left >= .box.rect.right' <<<"$s"
jq -e '.box.focused == true' <<<"$s"
# A second press with text in the box selects all of it.
xdo type --delay 30 abc
key ctrl+shift+f
s="$(sstate)"
jq '.box' <<<"$s"
jq -e '.box.focused == true and .box.value == "abc" and .box.selStart == 0 and .box.selEnd == 3' <<<"$s"
# It still filters the list by name.
key ctrl+a
key BackSpace
xdo type --delay 30 r1-alpha
sleep 1
s="$(sstate)"
jq '.sessions' <<<"$s"
jq -e --arg a "$sa" '[.sessions.rows[] | select(.section == "name") | .id] == [$a]' <<<"$s"
# The status text is still shown, right of the box.
jq -e '(.statusText | length) > 0 and .statusRect.width > 0 and .statusRect.left >= .box.rect.right' <<<"$s"
key ctrl+a
key BackSpace
# Narrow (700x600): the box is the bar's first row at full width; the hotkey focuses it.
win_size 700 600
focus_terminal
key ctrl+shift+f
s="$(sstate)"
jq '{box, bottomRect, narrow, window}' <<<"$s"
jq -e '.narrow == true' <<<"$s"
jq -e '.box.visible == true and .box.inBottom == true' <<<"$s"
jq -e '.box.rect.width >= .window.innerWidth - 32' <<<"$s"
jq -e '(.box.rect.top - .bottomRect.top) <= 8' <<<"$s"
jq -e '.box.focused == true' <<<"$s"
