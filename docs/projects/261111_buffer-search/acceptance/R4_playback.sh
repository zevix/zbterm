#!/usr/bin/env bash
# R4 playback — proves R4: in playback the box searches the frame on screen, and searches again when the frame changes.
# Asserts: for an ended recorded session opened in playback: a word on screen at the end of the recording gives total >= 1 and .inSession.mode == "playback"; after a seek to the start (where the word was not yet printed) total == 0 without retyping; after seeking back, total >= 1 again.
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
# > FILL (P1): start_app; create a session, print 'early-marker', wait, print 'late-marker', end it (exit); open playback; search late-marker; seek start/end via POST /sessions/:id/playback/seek; read search-state after each frame.
echo "body not written yet (P1)" >&2
exit 1
