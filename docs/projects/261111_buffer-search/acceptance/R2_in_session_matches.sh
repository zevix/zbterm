#!/usr/bin/env bash
# R2 in_session_matches — proves R2: typing in the box highlights every match in the selected session, scrollback included, shows the count, and Enter / Shift+Enter step through them, scrolling each into view.
# Asserts: with 3000 seeded lines and NEEDLE on every 7th (429 matches, most in scrollback): .inSession.total == 429 and .box.countText == "1/429" right after typing; the first current match is the newest (largest row); Enter moves .current.row up (older) and .index to 2; the current row is inside the viewport (viewportY <= row < viewportY+rows) after each step, including one far back in scrollback; Shift+Enter returns to the previous; decorations > 0; a match split across a soft wrap (one long line wider than the terminal) is counted; a case-different NEEDLE (needle) is counted; a match right after CJK text (e.g. '漢字NEEDLE') has .current.col == 4; stepping while 'yes NEEDLE | head -n 20000' runs never lands .current on a row whose text lacks NEEDLE.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_bs.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
total_is() { sstate | jq -e --argjson n "$1" '.inSession.total == $n' >/dev/null; }
in_view() { jq -e '.inSession as $i | $i.current != null and $i.viewportY <= $i.current.row and $i.current.row < ($i.viewportY + $i.rows)' <<<"$1"; }
# 3000 lines, NEEDLE on every 7th (lines 0, 7, … 2996: 429), most of them in scrollback.
# The command line never holds NEEDLE itself (n=NEE … ${n}DLE).
sid="$(seed_session r2-needles 'n=NEE; for i in $(seq 0 2999); do if [ $((i % 7)) = 0 ]; then echo "line $i ${n}DLE"; else echo "line $i"; fi; done; echo R2""DONE' R2DONE)"
wait_until 10 term_has R2DONE
type_box NEEDLE
wait_until 10 total_is 429 || true
s="$(sstate)"
jq '{box, inSession}' <<<"$s"
jq -e '.inSession.total == 429' <<<"$s"
jq -e '.box.countText == "1/429"' <<<"$s"
jq -e '.inSession.decorations > 0' <<<"$s"
# The first current match is the newest: line 2996, near the bottom.
jq -e '.inSession.current.text | contains("line 2996 NEEDLE")' <<<"$s"
jq -e '.inSession.current.row >= (.inSession.length - 8)' <<<"$s"
in_view "$s"
row1="$(jq '.inSession.current.row' <<<"$s")"
# Enter: the next older match.
key Return
s="$(sstate)"
jq '.inSession | {index, current, viewportY, rows}' <<<"$s"
jq -e --argjson r "$row1" '.inSession.index == 2 and .inSession.current.row < $r' <<<"$s"
jq -e '.inSession.current.text | contains("line 2989 NEEDLE")' <<<"$s"
in_view "$s"
key Return
s="$(sstate)"
jq -e '.inSession.index == 3 and (.inSession.current.text | contains("line 2982 NEEDLE"))' <<<"$s"
in_view "$s"
# Shift+Enter: back to the newer one.
key shift+Return
s="$(sstate)"
jq -e '.inSession.index == 2 and (.inSession.current.text | contains("line 2989 NEEDLE"))' <<<"$s"
in_view "$s"
# A match far back in scrollback (~2500 lines up) is scrolled into view.
clear_box
xdo type --delay 30 'line 497 N'
wait_until 10 total_is 1 || true
s="$(sstate)"
jq '.inSession' <<<"$s"
jq -e '.inSession.total == 1 and (.inSession.current.text | contains("line 497 NEEDLE"))' <<<"$s"
in_view "$s"
# The case is ignored: "needle" counts the same 429.
clear_box
xdo type --delay 30 needle
wait_until 10 total_is 429 || true
jq -e '.inSession.total == 429' <<<"$(sstate)"
# A match across a soft wrap: QWRAPZ split over the row end.
cols="$(api GET /renderer/layout | jq '.terminal.cols')"
sinput "$sid" "clear; printf '%*s' $((cols - 3)) '' | tr ' ' x; printf '%s%s\n' QW RAPZ"
wait_until 10 term_has APZ
clear_box
xdo type --delay 30 QWRAPZ
wait_until 10 total_is 1 || true
s="$(sstate)"
jq '.inSession' <<<"$s"
jq -e '.inSession.total == 1' <<<"$s"
# After wide (CJK) characters: 漢字 fills cells 0-3, the match starts at cell 4.
sinput "$sid" "clear; printf '%s%s\n' '漢字QC' 'JKZ'"
wait_until 10 term_has JKZ
clear_box
xdo type --delay 30 QCJKZ
wait_until 10 total_is 1 || true
s="$(sstate)"
jq '.inSession' <<<"$s"
jq -e '.inSession.total == 1 and .inSession.current.col == 4' <<<"$s"
# Stepping while output scrolls the buffer: the current match is always a NEEDLE row.
# (20 000 NEEDLE lines over ~10 s, so the steps land while it runs.)
clear_box
xdo type --delay 30 NEEDLE
sinput "$sid" 'n=NEE; for i in $(seq 100); do yes "${n}DLE" | head -n 200; sleep 0.1; done; echo R2""FLOOD'
sleep 1
for i in 1 2 3 4 5 6; do
  key Return
  s="$(sstate)"
  jq -c '.inSession | {index, total, current}' <<<"$s"
  jq -e '.inSession.current != null and (.inSession.current.text | ascii_downcase | contains("needle"))' <<<"$s"
  sleep 0.5
done
