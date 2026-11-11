#!/usr/bin/env bash
# R6 order_and_count — proves R6: buffer-match rows are ordered by match count, most first, and show 'N matches' in cyan instead of 'live · …'.
# Asserts: sessions with 2, 9 and 5 occurrences of the query: rows in order 9, 5, 2; each .sub == "<n> matches" ("1 match" for one, checked with a fourth session); .subColor is_cyan (jq colour helper; hue 170–200°, saturation > 0.4) in both the dark and the light theme, and its contrast ratio against .rowBg is >= 4.5; the same session's row in the name section (if any) still reads 'live · …'.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
# > FILL (P1): start_app; create the sessions with printf counts; type the query in the box; wait_until pending == 0; read search-state; toggle theme (#themeToggle click); read again. Add is_cyan to a colour.jq of this kit (or ui-chrome's color.jq copy).
echo "body not written yet (P1)" >&2
exit 1
