#!/usr/bin/env bash
# R5 drag reorder — proves R5, R6, R7, R8, U2, R23-R27 and R31: the drag handle over a row's left icon (near-white dark, near-black light); a real mouse drag lifts the row out of the list into a ghost on a top layer that follows the pointer anywhere in the window, the hand cursor held throughout; a bold dashed line marks the gap (the row's own old place included); the line shows wherever the pointer is (above the list, beside it, below it, a row alone in its group) and the release drops into the gap shown; the release flies the ghost into the gap; sortAt is the neighbours' midpoint or first + 42 min / last − 42 min, kept across a restart; among pinned rows the pin order changes instead; drops in the row's own gap, Escape and searching change nothing.
# Asserts: hovering s3's handle: grip visible, icon hidden, grip colour each channel >= 225 (dark) and <= 40 (light); lifted s1: row lifted (out of the list), ghost z-index 10000 with the pointer inside it, body and element-under-pointer cursor "grab"; over the gap above s4: at 0, line dashed >= 3 px between the list top and s4's top; over s1's own gap: atHome true, line shown; at 900,400 (outside the list, below the rows): ghost to the right of the list, inside the window, line shown at the last gap (s1's own); at y 3 (above the list): at 0, line inside the list's box; dropped above s4: flight moved, 180 ms, ends on s1's new row (within 3 px), order s1,s4,s3,s2, s1.sortAt = sortTime(s4) + 2520000; s4 between s3 and s2: sortAt = floor((t(s3)+t(s2))/2); s3 to the bottom: sortAt = t(last) − 2520000; after a restart the same order; pinned s2,s3 swapped: pinned order [s3,s2], no sortAt written for them; a pinned row alone in its group: line at its own place wherever the pointer goes; a pinned row dropped among the unpinned (its group's nearest gap: its own), a drop in the row's own gap, a drop outside the list beside the bottom row (its own gap) and Escape change nothing (flight not moved); while the box holds text no row is draggable.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R5_drag_reorder
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_qp.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real mouse presses on the private display"
set -x
start_app
win_size 1280 900
s1="$(seed_session r5-1 'echo 1""READY' 1READY)"; sleep 1
s2="$(seed_session r5-2 'echo 2""READY' 2READY)"; sleep 1
s3="$(seed_session r5-3 'echo 3""READY' 3READY)"; sleep 1
s4="$(seed_session r5-4 'echo 4""READY' 4READY)"
guard_wait
ids() { order | jq -c '[.rows[].id]'; }
test "$(ids)" = "$(jq -nc --arg a "$s4" --arg b "$s3" --arg c "$s2" --arg d "$s1" '[$a,$b,$c,$d]')"
row() { order | jq -c --arg s "$1" '.rows[] | select(.id == $s)'; }
t_of() { row "$1" | jq '.sortTime'; }
# R5: the handle on hover, by theme.
theme_is() { order | jq -r '.theme // "dark"'; }
hover_check() { # dark|light
  read -r x y < <(handle_xy "$s3")
  mouse_to "$x" "$y"; sleep 0.4
  if [ "$1" = dark ]; then
    row "$s3" | jq -e '.grip.visible and (.iconVisible | not) and (.grip.color | [scan("[0-9]+")][0:3] | map(tonumber) | all(. >= 225))'
  else
    row "$s3" | jq -e '.grip.visible and (.iconVisible | not) and (.grip.color | [scan("[0-9]+")][0:3] | map(tonumber) | all(. <= 40))'
  fi
  mouse_to 600 20
}
first_theme="$(theme_is)"
[ "$first_theme" = light ] || first_theme=dark
hover_check "$first_theme"
cmd '{"command":"click","selector":"#themeToggle"}' >/dev/null; sleep 0.5
[ "$first_theme" = dark ] && hover_check light || hover_check dark
cmd '{"command":"click","selector":"#themeToggle"}' >/dev/null; sleep 0.5
fl() { order | jq -c '.lastFlight'; }
# R23-R26 live: lift s1 (the bottom row).
t4="$(t_of "$s4")"
drag_lift "$s1"
o="$(order)"; jq -c '.drag' <<<"$o"
jq -e --arg s "$s1" --argjson py "$_qp_py" '.drag.lifted and (.rows[] | select(.id == $s) | .lifted)
  and .drag.ghost.zIndex == "10000" and .drag.ghost.top <= $py and .drag.ghost.bottom >= $py
  and .drag.bodyCursor == "grab"' <<<"$o"
drag_move "$_qp_px" "$(gap_y "$s4" before)"
jq -c '.drag' <<<"$DRAG_SEEN"
jq -e --arg s "$s4" '(.rows[] | select(.id == $s) | .rect.top) as $t
  | .drag.at == 0 and .drag.atHome == false and .drag.cursorUnder == "grab" and .drag.bodyCursor == "grab"
  and .drag.line.style == "dashed" and .drag.line.width >= 3
  and .drag.line.top <= $t and .drag.line.bottom >= .list.top and .drag.line.top >= .list.top - 4
  and (.drag.ghost.top <= '"$_qp_py"') and (.drag.ghost.bottom >= '"$_qp_py"')' <<<"$DRAG_SEEN"
# R26: its own old place (below s2, the last of the others) is a gap too.
drag_move "$_qp_px" "$(gap_y "$s2" after)"
jq -e '.drag.at == 3 and .drag.atHome == true and .drag.line.style == "dashed"' <<<"$DRAG_SEEN"
# R24, R31: free in the window, outside the list too; the line still shows,
# at the gap nearest the pointer (below the rows: the last one, s1's own).
drag_move 900 400
jq -e '.drag.ghost.left > .list.right and .drag.ghost.left >= 0 and .drag.at == 3 and .drag.atHome == true
  and .drag.line.style == "dashed" and .drag.line.top >= .list.top and .drag.line.bottom <= .list.bottom
  and .drag.cursorUnder == "grab"' <<<"$DRAG_SEEN"
# R31: above the list (the window's top): the first gap, the line inside the list.
drag_move "$_qp_px" 3
jq -e '.drag.at == 0 and .drag.line.style == "dashed" and .drag.line.top >= .list.top - 1
  and .drag.line.bottom <= .list.bottom + 1' <<<"$DRAG_SEEN"
# R27: back over the top gap, and let go: it flies there.
drag_move "$(handle_xy "$s4" | cut -d' ' -f1)" "$(gap_y "$s4" before)"
jq -e '.drag.at == 0' <<<"$DRAG_SEEN"
drag_drop
f="$(fl)"; echo "$f"
guard_wait
test "$(ids)" = "$(jq -nc --arg a "$s1" --arg b "$s4" --arg c "$s3" --arg d "$s2" '[$a,$b,$c,$d]')"
order | jq -e --arg s "$s1" --argjson f "$f" '(.rows[] | select(.id == $s) | .rect) as $r
  | $f.id == $s and $f.moved and $f.ms == 180 and ($f.to.left - $r.left | fabs) <= 3 and ($f.to.top - $r.top | fabs) <= 3
  and ($f.from.top != $f.to.top or $f.from.left != $f.to.left) and .dragging == null'
row "$s1" | jq -e --argjson t "$t4" '.sortAt == ($t + 2520000)'
# s4 between s3 and s2: the midpoint.
t3="$(t_of "$s3")"; t2="$(t_of "$s2")"
drag_row "$s4" "$s2" before
guard_wait
test "$(ids)" = "$(jq -nc --arg a "$s1" --arg b "$s3" --arg c "$s4" --arg d "$s2" '[$a,$b,$c,$d]')"
row "$s4" | jq -e --argjson a "$t3" --argjson b "$t2" '.sortAt == ((($a + $b) / 2) | floor)'
# s3 to the bottom: last − 42 min.
drag_row "$s3" "$s2" after
guard_wait
test "$(ids)" = "$(jq -nc --arg a "$s1" --arg b "$s4" --arg c "$s2" --arg d "$s3" '[$a,$b,$c,$d]')"
row "$s3" | jq -e --argjson t "$t2" '.sortAt == ($t - 2520000)'
before_restart="$(ids)"
restart_app
guard_wait
test "$(ids)" = "$before_restart"
# R31: s2 pinned alone: its own place is its group's one gap, shown
# wherever the pointer goes; the drop changes nothing.
row_action "$s2" pin >/dev/null; sleep 1
guard_wait
drag_lift "$s2"
for xy in "900 400" "$_qp_px 3" "$_qp_px 850"; do
  drag_move $xy
  jq -e '.drag.at == 0 and .drag.atHome == true and .drag.line.style == "dashed"
    and .drag.line.top >= .list.top - 1 and .drag.line.bottom <= .list.bottom + 1' <<<"$DRAG_SEEN"
done
drag_drop; guard_wait
fl | jq -e --arg s "$s2" '.id == $s and .moved == false'
# R8: pin s3 too; drag s3 above s2 among the pinned rows.
row_action "$s3" pin >/dev/null; sleep 1
guard_wait
order | jq -e --arg p "$s2" --arg q "$s3" '.pinned == [$p, $q]'
sa2="$(row "$s2" | jq -c .sortAt)"; sa3="$(row "$s3" | jq -c .sortAt)"
drag_row "$s3" "$s2" before
guard_wait
order | jq -e --arg p "$s2" --arg q "$s3" '.pinned == [$q, $p] and ([.rows[].id][0:2] == [$q, $p])'
test "$(row "$s2" | jq -c .sortAt)" = "$sa2"; test "$(row "$s3" | jq -c .sortAt)" = "$sa3"
# U2: a pinned row dropped among the unpinned ones, a drop in its own gap, a drop outside the list, Escape.
was="$(ids)"; pins="$(order | jq -c .pinned)"
not_moved() { fl | jq -e --arg s "$1" '.id == $s and .moved == false'; }
drag_row "$s2" "$s4" after; guard_wait
test "$(ids)" = "$was"; test "$(order | jq -c .pinned)" = "$pins"; not_moved "$s2"
drag_lift "$s1"; drag_move "$_qp_px" "$(gap_y "$s4" before)"
jq -e '.drag.atHome == true and .drag.line != null' <<<"$DRAG_SEEN"
drag_drop; guard_wait
test "$(ids)" = "$was"; not_moved "$s1"
drag_row_xy "$s4" 900 400; guard_wait
test "$(ids)" = "$was"; not_moved "$s4"
drag_lift "$s4"; drag_move "$_qp_px" "$(gap_y "$s1" before)"
jq -e '.drag.at == 0 and .drag.atHome == false' <<<"$DRAG_SEEN"
xdo key Escape; sleep 0.8; xdo mouseup 1; guard_wait
test "$(ids)" = "$was"; not_moved "$s4"
order | jq -e '.dragging == null'
row "$s1" | jq -e --argjson t "$t4" '.sortAt == ($t + 2520000)'
# U2: no drag while searching.
type_box r5
wait_search
order | jq -e '[.rows[].draggable] | any | not'
clear_box
