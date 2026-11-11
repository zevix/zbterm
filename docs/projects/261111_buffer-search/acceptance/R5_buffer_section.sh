#!/usr/bin/env bash
# R5 buffer_section — proves R5: while the box holds text and the side pane is shown, the name matches come first, then a 'Session buffer matches' heading with each live session whose buffer contains the text.
# Asserts: three live sessions: 'alpha' (buffer has ZQX), 'beta' (no ZQX), 'zqx-named' (name matches, buffer has ZQX too); typing ZQX in the box gives: name rows == [zqx-named]; .sessions.heading == "Session buffer matches" and comes after the name rows in DOM order; buffer rows == {alpha, zqx-named}, never beta; a fourth session 'pager' printed ZQX and then runs less on another file (alternate screen), and is listed with its count; with no name match at all (query only in buffers), the heading still follows 'No matching sessions'; with an ended session named 'zqx-old', clicking the pane's 'All' toggle (Active only) drops it from the name rows while the buffer rows stay; clearing the box removes the heading and the buffer rows.
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
# > FILL (P1): start_app; create the sessions and print text; click_at the box (bottom left); xdo type ZQX; wait_until .sessions.pending == 0; read search-state; click #activeOnly; read; select-all + BackSpace; read again.
echo "body not written yet (P1)" >&2
exit 1
