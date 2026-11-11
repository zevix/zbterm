#!/usr/bin/env bash
# R2 in_session_matches — proves R2: typing in the box highlights every match in the selected session, scrollback included, shows the count, and Enter / Shift+Enter step through them, scrolling each into view.
# Asserts: with 3000 seeded lines and NEEDLE on every 7th (429 matches, most in scrollback): .inSession.total == 429 and .box.countText == "1/429" right after typing; the first current match is the newest (largest row); Enter moves .current.row up (older) and .index to 2; the current row is inside the viewport (viewportY <= row < viewportY+rows) after each step, including one far back in scrollback; Shift+Enter returns to the previous; decorations > 0; a match split across a soft wrap (one long line wider than the terminal) is counted; a case-different NEEDLE (needle) is counted; a match right after CJK text (e.g. '漢字NEEDLE') has .current.col == 4; stepping while 'yes NEEDLE | head -n 20000' runs never lands .current on a row whose text lacks NEEDLE.
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
# > FILL (P1): start_app; seed a live session with a printf loop; wait_until the last line is on screen; key ctrl+shift+f; xdo type NEEDLE; read search-state; key Return (x2), shift+Return; read search-state after each; also step to a match ~2500 lines back by searching a unique marker and check viewportY.
echo "body not written yet (P1)" >&2
exit 1
