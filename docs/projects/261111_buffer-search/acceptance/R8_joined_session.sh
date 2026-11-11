#!/usr/bin/env bash
# R8 joined_session — proves R8: a joined live session is searched too, through the copy this app holds.
# Asserts: app A hosts a session printing JOINMARK; app B joins it (POST /join + approve on A); in B, typing JOINMARK in the box lists the joined session under 'Session buffer matches' with '1 match' or more; in B, with the joined session selected, the same box shows .inSession.total >= 1.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
need "$UB_REPO/test/debug-server-e2e.js" "the join flow the second app copies"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
# > FILL (P1): lib_bs.sh::start_second_app (own HOME, storage, port, uisolate session); A: POST /sessions, share link (POST /sessions/:id/share); B: POST /join, A approves; wait until B lists the session active; then search in B. Needs the network the pear backend uses; a failed join is exit 75 with the reason, not a pass.
echo "body not written yet (P1)" >&2
exit 1
