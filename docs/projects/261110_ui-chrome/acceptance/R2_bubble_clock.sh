#!/usr/bin/env bash
# R2 bubble_clock — proves R2: a live seek and a hover in a session recorded now show 'HH:MM:SS' beside the elapsed time; the renderer's formatter (debug command bubble-format with tsMs and nowMs) gives 'Ddd HH:MM:SS' for 3 days ago, 'YYYY-MM-DD HH:MM:SS' for 10 days ago, across midnight and a DST change.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
# Body: written in P1 from this header; start_app, then drive with cmd/state, assert with jq -e / grep -F.
echo "not written yet" >&2; exit 1
