#!/usr/bin/env bash
# R7 stream_and_cancel — proves R7: live sessions are searched concurrently, each row appears when its session finishes, and stale results are dropped when the text changes.
# Asserts: buffer-search-log shows one request per live session for a query, all sent before the first answer arrives (request times precede the first answer); with one session flooded to 5000 long lines and others small, small sessions' rows appear in search-state before the big one's (rows grow over two reads); typing a second query while the first runs: every answer for the old seq is cancelled or ignored, no row carries the old query's count, and the final rows equal a fresh search for the new query; a session created while the query is in the box (POST /sessions printing the query) gets its row without retyping.
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
# > FILL (P1): start_app; create 4 sessions, one with 5000 x 200-col lines; click the box; xdo type --delay 40 a long query then change it; poll search-state every 50 ms; read buffer-search-log.
echo "body not written yet (P1)" >&2
exit 1
