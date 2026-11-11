#!/usr/bin/env bash
# R1 history_selection — proves R1: in paused playback a real drag selects text; the exact text is still selected after 3 s and a window resize, in a plain shell and in less --mouse, with copy-on-select on and off; a step forward clears it (A-1)
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/../../261110_ui-chrome/acceptance/lib.sh"
need uisolate "the app runs only on a private display"
need xdotool "real mouse and keys on the private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
# Body: written in P1 from this header; start_app, then drive with cmd/state and xdotool, assert with jq -e.
echo "not written yet" >&2; exit 1
