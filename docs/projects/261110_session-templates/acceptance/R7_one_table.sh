#!/usr/bin/env bash
# R7 one_table — proves R7: NEW_SESSION_TRIGGERS in renderer/app.js is the only place trigger ids, labels and key matches are listed (grep -c per trigger id outside the table is 0), and a test build that appends a fourth entry (Ctrl+Shift + "+ New", via the debug command triggers-add) shows it in the Advanced dropdown and the settings menu with no other change.
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
