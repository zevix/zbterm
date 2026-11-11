#!/usr/bin/env bash
# R4 trigger_creates — proves R4: + New, Ctrl+Shift+T and Shift+New each create from their template (cwd, command, record, share choice copied; name '<template> #N'); skip-dialog opens directly, else the dialog opens prefilled; after editing the template the next creation uses the new values.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/../../261110_ui-chrome/acceptance/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
# Body: written in P1 from this header; start_app, then drive with cmd/state, assert with jq -e / grep -F.
echo "not written yet" >&2; exit 1
