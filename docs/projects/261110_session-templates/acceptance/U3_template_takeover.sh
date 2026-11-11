#!/usr/bin/env bash
# U3 template_takeover — proves U3: choosing a trigger held by profile A in profile B's dialog asks, naming A; Cancel leaves A as the template; OK moves it to B.
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
