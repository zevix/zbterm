#!/usr/bin/env bash
# U2 narrow_and_modal — proves U2: at 700x600 (single-column layout) Ctrl+Shift+B and the logo still toggle the side pane and the top bar keeps New/Join/Settings reachable; with the settings menu open the toggle closes it first; with a dialog open the toggle does nothing and the dialog stays on top.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
# Body: written in P1 from this header; start_app, then drive with cmd/state, assert with jq -e / grep -F.
echo "not written yet" >&2; exit 1
