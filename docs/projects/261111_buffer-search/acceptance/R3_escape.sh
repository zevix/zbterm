#!/usr/bin/env bash
# R3 escape — proves R3: Esc in the box clears its text, the highlights and the session-list filter, and gives the focus back to the terminal.
# Asserts: two sessions 'alpha' (buffer has NEEDLE) and 'beta'; after typing NEEDLE (list filtered: name rows == [] and a buffer row for alpha; inSession.total > 0), a real Escape gives .box.value == "", .inSession.total == 0, .inSession.decorations == 0, .sessions.heading == null, the list shows both sessions again, .box.focused == false, and a following real key x reaches the shell (od -c shows x); the box is still shown; Esc on an empty box only moves the focus to the terminal; with no session selected, Esc in the box leaves no error in the app log and the box empty.
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
# > FILL (P1): start_app; seed; click_at the box; xdo type NEEDLE; wait pending == 0; key Escape; read search-state; run od -c in the shell, key x, check term_text; then deselect and repeat.
echo "body not written yet (P1)" >&2
exit 1
