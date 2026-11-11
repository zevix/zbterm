#!/usr/bin/env bash
# U3 responsive — proves U3: typing and output in the terminal stay responsive while a cross-session search runs over several full buffers.
# Asserts: five sessions filled to 5000 lines of 200 columns; while a search for a 1-character query (most matches) runs, a key typed in the selected session echoes within 150 ms (time from POST input to the byte in GET /sessions/:id/stats's frame, median of 10), and the same measure without a search is recorded beside it in the log; buffer-search-log shows every search finished (no request left unanswered).
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
# > FILL (P1): start_app; seed five sessions; start the search (type in the box, side pane shown); loop 10x: POST /sessions/current/input one char, poll stats until it shows; compute the median; compare with the no-search median.
echo "body not written yet (P1)" >&2
exit 1
