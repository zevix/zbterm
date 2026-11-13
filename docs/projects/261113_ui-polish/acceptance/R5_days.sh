#!/usr/bin/env bash
# R5 days — proves R5: durations (not clock times) of 24 h or more read 'Nd h:mm:ss' (54:32:10 is '2d 6:32:10'); under 24 h they are unchanged.
# Asserts: the renderer's one duration formatter (debug command duration-format, the function every duration label uses: #currentTime, #totalTime, the bubble's second line, the 'Uncompressed' tip, R1's duration) gives 0 -> 0:00, 42 s -> 0:42, 3:05:09 -> 3:05:09, 23:59:59 -> 23:59:59, 24:00:00 -> 1d 0:00:00, 54:32:10 -> 2d 6:32:10, 48:00:05 -> 2d 0:00:05, 10d 11:07:00 -> 10d 11:07:00; a live session's #totalTime and #currentTime read as durations under 24 h (^[0-9]+:[0-9]{2}$).
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
check() {
  local got
  got="$(cmd "{\"command\":\"duration-format\",\"ms\":$1}" | jq -r .text)"
  echo "duration-format $1 -> $got (want $2)"
  [ "$got" = "$2" ]
}
check 0 '0:00'
check 42000 '0:42'
check $(((3 * 3600 + 5 * 60 + 9) * 1000)) '3:05:09'
check $(((24 * 3600 - 1) * 1000)) '23:59:59'
check $((24 * 3600 * 1000)) '1d 0:00:00'
check $(((54 * 3600 + 32 * 60 + 10) * 1000)) '2d 6:32:10'
check $(((48 * 3600 + 5) * 1000)) '2d 0:00:05'
check $(((10 * 86400 + 11 * 3600 + 7 * 60) * 1000)) '10d 11:07:00'
sid="$(seed_session r5-live 'echo R5""A' R5A)"
sinput "$sid" 'echo r5-more'
sleep 2
sty '#totalTime' | jq -e '.text | test("^[0-9]+:[0-9]{2}$")'
sty '#currentTime' | jq -e '.text | test("^[0-9]+:[0-9]{2}$")'
