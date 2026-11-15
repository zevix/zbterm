#!/usr/bin/env bash
# R5 hidden matches — proves R5: while searching, a session whose history is behind a full-screen program shows the cyan count split into shown and hidden.
# Asserts: session r5-a prints 10 lines holding R5NEEDLE, then enters the alternate screen and prints 2 more; with R5NEEDLE in the box, its buffer-match row reads '12 matches (2 + 10 hidden history matches)'; session r5-b (no alternate screen, 3 lines) reads '3 matches'.
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
a="$(seed_session r5-a 'n=R5NEE; for i in $(seq 1 10); do echo "${n}DLE $i"; done; printf "\033[?1049h\033[H${n}DLE alt 1\r\n${n}DLE alt 2\r\n"; echo A""READY' AREADY)"
b="$(seed_session r5-b 'n=R5NEE; for i in 1 2 3; do echo "${n}DLE $i"; done' 'R5NEEDLE 3')"
select_session "$b"
type_box R5NEEDLE
wait_search
sleep 1
rows="$(sstate | jq -c '.sessions')"; echo "$rows"
sub() { sty ".session-row[data-session-id=\"$1\"] .session-sub.match-count" | jq -r '.text'; }
ta="$(sub "$a")"; tb="$(sub "$b")"
echo "a: $ta"; echo "b: $tb"
[ "$ta" = "12 matches (2 + 10 hidden history matches)" ]
[ "$tb" = "3 matches" ]
