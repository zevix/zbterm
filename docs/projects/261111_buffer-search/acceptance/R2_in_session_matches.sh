#!/usr/bin/env bash
# R2 in_session_matches — proves R2: typing in the box highlights every match in the selected session, scrollback included, shows the count, and Enter / Shift+Enter step through them, scrolling each into view.
# Asserts: with 3000 seeded lines and NEEDLE on every 7th (429 matches, most in scrollback): .inSession.total == 429 and .box.countText == "1/429" right after typing; the first current match is the newest (largest row); Enter moves .current.row up (older) and .index to 2; the current row is inside the viewport (viewportY <= row < viewportY+rows) after each step, including one far back in scrollback; Shift+Enter returns to the previous; decorations > 0; a match split across a soft wrap (one long line wider than the terminal) is counted; a case-different NEEDLE (needle) is counted; a match right after CJK text (e.g. '漢字NEEDLE') has .current.col == 4; stepping while 'yes NEEDLE | head -n 20000' runs never lands .current on a row whose text lacks NEEDLE.
# Kit correction 2026-11-13 (F3): report 2026-11-13 finding 2: "every match highlighted … scrollback
# included" was checked through the count, not the highlights. Also asserted now: after typing,
# after Shift+Enter wraps to the oldest match (line 0, ~3000 lines back) and after jumping to
# 'line 497 N', the highlights drawn on screen (.inSession.drawn: each decoration's element shown,
# as viewport cells) are exactly one per visible match, on its row and columns as read from the
# visible rows' text, the current match among them; at the oldest match a screenshot of the private
# display shows each drawn highlight's cells in the highlight colour (.inSession.colors: the
# current one in its own colour) and a row without a match not in it.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_bs.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
need convert "reads the highlight colours off a screenshot of the private display (ImageMagick; F3)"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
total_is() { sstate | jq -e --argjson n "$1" '.inSession.total == $n' >/dev/null; }
in_view() { jq -e '.inSession as $i | $i.current != null and $i.viewportY <= $i.current.row and $i.current.row < ($i.viewportY + $i.rows)' <<<"$1"; }
# Kit correction 2026-11-13 (F3): the highlights as drawn, against the matches the visible rows
# hold. visible_marks <query>: [{row, col, width}] of each visible row holding <query> (ignoring
# case, once per row here); drawn_is <query>: the drawn highlights are exactly those.
visible_marks() {
  api GET /renderer/terminal-display | jq -c --arg q "$1" '($q | ascii_downcase) as $q
    | [((.terminal // .renderer).visibleRows // []) | to_entries[]
       | (.value.text | ascii_downcase) as $t | select($t | contains($q))
       | {row: .key, col: ($t | index($q)), width: ($q | length)}]'
}
drawn_is() {
  local want
  want="$(visible_marks "$1")"
  sstate | jq -e --argjson w "$want" '.inSession.drawn == $w and ($w | length) > 0' >/dev/null
}
# drawn_check <query>: waits for xterm to draw, then asserts (logged) drawn == visible matches,
# the current match among them.
drawn_check() {
  wait_until 10 drawn_is "$1" || true
  local want s
  want="$(visible_marks "$1")"
  s="$(sstate)"
  jq -c '.inSession | {viewportY, rows, drawn}' <<<"$s"
  jq -c . <<<"$want"
  jq -e --argjson w "$want" '.inSession.drawn == $w and ($w | length) > 0' <<<"$s"
  jq -e '.inSession as $i | any($i.drawn[]; .row == ($i.current.row - $i.viewportY) and .col == $i.current.col)' <<<"$s"
}
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
drawn_check NEEDLE
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
# Kit correction 2026-11-13 (F3): ~2500 lines back, the one match is drawn on its row, nothing else.
drawn_check 'line 497 N'
jq -e '.inSession.drawn | length == 1' <<<"$(sstate)"
# Kit correction 2026-11-13 (F3): the oldest match, ~3000 lines back: Shift+Enter from the newest
# wraps to it. Every NEEDLE on screen there is drawn, and painted: a screenshot of the private
# display, each drawn highlight's cells (a 2 px inset) mostly in the highlight colour, the current
# one in the current colour, and the same columns of a row without a match not in it.
clear_box
xdo type --delay 30 NEEDLE
wait_until 10 total_is 429 || true
key shift+Return
s="$(sstate)"
jq '.inSession | {index, current, viewportY, rows}' <<<"$s"
jq -e '.inSession.index == 429 and (.inSession.current.text | contains("line 0 NEEDLE"))' <<<"$s"
jq -e '.inSession.viewportY <= 10' <<<"$s"
in_view "$s"
drawn_check NEEDLE
sleep 0.5
s="$(sstate)"
shot="$ACCEPT_LOG_DIR/R2_oldest.png"
uisolate screenshot "$ZBUI_SESSION" "$shot" >/dev/null
screen="$(cmd '{"command":"style-of","selector":"#terminal .xterm-screen"}')"
cols="$(api GET /renderer/layout | jq '.renderer.terminal.cols')"
# hex_dist <#rrggbb> <#rrggbb>: the largest channel difference.
hex_dist() {
  local a="${1#\#}" b="${2#\#}" i m=0 x y
  for i in 0 2 4; do
    x=$((16#${a:$i:2})); y=$((16#${b:$i:2}))
    [ $((x > y ? x - y : y - x)) -gt "$m" ] && m=$((x > y ? x - y : y - x))
  done
  echo "$m"
}
# cell_colour <row> <col> <width>: the most common colour of those viewport cells on the screenshot.
cell_colour() {
  local box x y
  box="$(jq -r -n --argjson c "$screen" --argjson s "$s" --argjson cols "$cols" \
    --argjson r "$1" --argjson k "$2" --argjson w "$3" '
    ($c.rect.width / $cols) as $cw | ($c.rect.height / $s.inSession.rows) as $ch
    | "\((($w * $cw) - 4) | floor) \(($ch - 4) | floor) \(($c.rect.left + $k * $cw + 2) | floor) \(($c.rect.top + $r * $ch + 2) | floor)"')"
  read -r bw bh x y <<<"$box"
  read -r x y < <(_zbui_screen_xy "$x" "$y")
  convert "$shot" -crop "${bw}x${bh}+${x}+${y}" +repage -format %c histogram:info:- \
    | sort -rn | head -n1 | grep -oE '#[0-9A-Fa-f]{6}' | head -n1
}
match_hex="$(jq -r '.inSession.colors.match' <<<"$s")"
current_hex="$(jq -r '.inSession.colors.current' <<<"$s")"
crow="$(jq '.inSession.current.row - .inSession.viewportY' <<<"$s")"
while read -r row col width; do
  got="$(cell_colour "$row" "$col" "$width")"
  if [ "$row" = "$crow" ]; then want="$current_hex"; else want="$match_hex"; fi
  echo "row $row col $col: drawn $got, highlight $want"
  [ "$(hex_dist "$got" "$want")" -le 8 ]
done < <(jq -r '.inSession.drawn[] | "\(.row) \(.col) \(.width)"' <<<"$s")
# The control: the row below the oldest match ("line 1") at the same columns is not highlighted.
got="$(cell_colour "$((crow + 1))" "$(jq '.inSession.current.col' <<<"$s")" 6)"
echo "row $((crow + 1)) (no match): $got"
[ "$(hex_dist "$got" "$match_hex")" -gt 8 ] && [ "$(hex_dist "$got" "$current_hex")" -gt 8 ]
# The case is ignored: "needle" counts the same 429.
clear_box
xdo type --delay 30 needle
wait_until 10 total_is 429 || true
jq -e '.inSession.total == 429' <<<"$(sstate)"
# A match across a soft wrap: QWRAPZ split over the row end.
cols="$(api GET /renderer/layout | jq '.renderer.terminal.cols')"
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
# Kit correction 2026-11-11 (builder P5): R2 (hard) says every match is highlighted, but
# xterm draws no decorations on the alternate screen (vim, less) and this script never
# looked there, so a pager's matches went unhighlighted unseen. Strengthened (nothing
# above changed): in `less`, every match on screen is highlighted, the current one over
# its own cells on the terminal's grid.
wait_until 40 term_has R2FLOOD || true
sinput "$sid" 'p=QAL; printf "alt %s 1\nalt %s 2\n  three %s\n" "${p}TZ" "${p}TZ" "${p}TZ" > "$HOME/r2alt.txt"; clear; less "$HOME/r2alt.txt"'
alt_on() { sstate | jq -e '.inSession.buffer == "alternate"' >/dev/null; }
wait_until 15 alt_on || true
sleep 0.5
clear_box
xdo type --delay 30 QALTZ
wait_until 10 total_is 3 || true
sleep 0.5
s="$(sstate)"
jq '.inSession' <<<"$s"
jq -e '.inSession.buffer == "alternate" and .inSession.total == 3' <<<"$s"
jq -e '.inSession.decorations == 3' <<<"$s"
jq -e '.inSession.current.text | contains("three QALTZ")' <<<"$s"
# Changed 2026-11-16 (261115_quit-pins-reorder R34-R36): the alternate screen's highlights are
# xterm decorations now, not boxes over the screen; xterm hides decoration elements there (the
# renderer paints the cells), so the current one is read from the highlighter's records
# (.inSession.drawnTop, viewport cells): on the current match's row, column and length.
jq -e '.inSession as $i | $i.drawnTop == [{row: ($i.current.row - $i.viewportY), col: $i.current.col, width: $i.current.len}]' <<<"$s"
key q
