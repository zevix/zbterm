#!/usr/bin/env bash
# U2 live_only — proves U2: text only in an ended session, or only in recorded history, is never listed and no history is read from disk.
# Asserts: session 'gone' prints ENDMARK then exits (ended); session 'live' is running and cleared its screen and scrollback after printing OLDMARK (printf '\033[3J\033[H\033[2J'), so OLDMARK is only in its recording: typing ENDMARK or OLDMARK in #search shows the heading with .sessions.empty == true and no buffer rows; buffer-search-log has no request for the ended session; GET /events shows no player/session open for either while the search runs.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
# > FILL (P1): start_app; create both; end one; clear the other; search both markers; read search-state, buffer-search-log, GET /events.
echo "body not written yet (P1)" >&2
exit 1
