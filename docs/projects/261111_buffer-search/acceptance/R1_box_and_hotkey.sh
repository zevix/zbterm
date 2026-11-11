#!/usr/bin/env bash
# R1 box_and_hotkey — proves R1: there is one search box, the former 'Search sessions' box (#search), first in the bottom bar at the window's bottom left with the status text to its right, and Ctrl+Shift+F focuses it.
# Asserts: search-state .box.id == "search" and .box.inSidebar == false; exactly one text input in the window has a search placeholder (no second search box; the side pane's .tools holds no input); .bottomCells starts ["search","status"]; .box.rect.left <= 1 and the box's bottom edge is the window's (±2 px); .statusRect.left >= .box.rect.right; after a real Ctrl+Shift+F with the terminal focused, .box.focused == true and the box's text is selected (type 'abc', press it again, the selection covers 'abc'); typing a session's name still filters the list (name rows == that session); the status text is still shown (non-empty, not overlapped); at 700x600 (narrow) the box is visible, full-width in the bar's first row, and Ctrl+Shift+F focuses it.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
# > FILL (P1): start_app; create two live sessions; focus_terminal; key ctrl+shift+f; read search-state; xdo type a name; read again; resize to 700x600; read again.
echo "body not written yet (P1)" >&2
exit 1
