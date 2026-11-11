#!/usr/bin/env bash
# R2 unrecorded_live — proves R2: an unrecorded session echoes typed text on screen; its Share and Playback controls are disabled; share.createLink, player.open and copyHistoryFrom return E_NOT_RECORDED; Extend relaunches it unrecorded.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/../../261110_ui-chrome/acceptance/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
# Body: written in P1 from this header; start_app, then drive with cmd/state, assert with jq -e / grep -F.
echo "not written yet" >&2; exit 1
