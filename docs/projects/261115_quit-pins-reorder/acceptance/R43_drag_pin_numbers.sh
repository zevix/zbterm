#!/usr/bin/env bash
# R43 drag pin numbers, R44 bigger handle — proves R43 and R44: while a pinned row is dragged, every pin's Ctrl+N number (the dragged row's ghost too) is the one it would have if let go at the gap shown; Escape puts the old numbers back; the drop keeps the shown ones; the ghost's pin and number are white in dark mode, black in light; the drag handle's hit area reaches over the row's left padding, so a press there starts a drag.
# Asserts: s1, s2, s3 pinned in that order: numbers 1, 2, 3; handle rect >= 28 px wide, its left within 2 px of its row's left; a real press 3 px inside the row's left edge (outside the old 16 px handle) and a move lift s1 (drag.lifted); with s1 held over the gap below s3: s2 "1", s3 "2", ghost "3"; over the gap above s3: s2 "1", ghost "2", s3 "3"; the hovered row's marks stay visible; Escape: s1 "1", s2 "2", s3 "3", pins unchanged; ghost pin and number colour each channel >= 225 (dark) and <= 40 (light); dropped below s3: pins [s2, s3, s1], numbers 1, 2, 3 in that order. Screenshots in the log dir.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R43_drag_pin_numbers
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_qp.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real mouse presses on the private display"
set -x
start_app
win_size 1280 900
s1="$(seed_session r43-1 'echo 1""READY' 1READY)"; sleep 1
s2="$(seed_session r43-2 'echo 2""READY' 2READY)"; sleep 1
s3="$(seed_session r43-3 'echo 3""READY' 3READY)"; sleep 1
s4="$(seed_session r43-4 'echo 4""READY' 4READY)"
guard_wait
row() { order | jq -c --arg s "$1" '.rows[] | select(.id == $s)'; }
num_in() { jq -r --arg s "$2" '.rows[] | select(.id == $s) | .pinNumber.text // "none"' <<<"$1"; }
for s in "$s1" "$s2" "$s3"; do row_action "$s" pin >/dev/null; sleep 1; done
guard_wait
order | jq -e --arg a "$s1" --arg b "$s2" --arg c "$s3" '.pinned == [$a, $b, $c]'
o="$(order)"
test "$(num_in "$o" "$s1")$(num_in "$o" "$s2")$(num_in "$o" "$s3")" = 123
# R44: the handle covers the row's left padding.
row "$s1" | jq -e '.handle.width >= 28 and ((.handle.left - .rect.left) | fabs) <= 2'
# R44: a press 3 px inside the row's left edge, outside the old handle, starts a drag.
read -r rl ry < <(row "$s1" | jq -r '"\(.rect.left | floor) \((.rect.top + .rect.height / 2) | floor)"')
_qp_px=$((rl + 3)); _qp_py="$ry"
mouse_to "$_qp_px" "$_qp_py"; xdo mousedown 1; sleep 0.2
_qp_py=$((_qp_py + 12)); mouse_to "$_qp_px" "$_qp_py"; sleep 0.3
order | jq -e --arg s "$s1" '.drag.lifted and .drag.id == $s'
# R43: below s3 (the last pinned gap): s1 would be third.
drag_move "$_qp_px" "$(gap_y "$s3" after)"
jq -c '.drag' <<<"$DRAG_SEEN"
test "$(num_in "$DRAG_SEEN" "$s2")$(num_in "$DRAG_SEEN" "$s3")" = 12
jq -e '.drag.ghost.pinNumber.text == "3"' <<<"$DRAG_SEEN"
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R43_drag_below_s3.png" >/dev/null
# Above s3: s1 would be second; s3 (under the pointer) keeps its marks shown.
drag_move "$_qp_px" "$(gap_y "$s3" before)"
test "$(num_in "$DRAG_SEEN" "$s2")$(num_in "$DRAG_SEEN" "$s3")" = 13
jq -e '.drag.ghost.pinNumber.text == "2"' <<<"$DRAG_SEEN"
vis="$(cmd "$(jq -nc --arg s "$s3" '{command: "style-of", selector: (".session-row[data-session-id=\"" + $s + "\"] .session-marks")}')")"
jq -e '.visibility == "visible"' <<<"$vis"
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R43_drag_above_s3.png" >/dev/null
# Escape: the old numbers.
xdo key Escape; sleep 0.8; xdo mouseup 1; guard_wait
o="$(order)"
jq -e --arg a "$s1" --arg b "$s2" --arg c "$s3" '.pinned == [$a, $b, $c] and .dragging == null' <<<"$o"
test "$(num_in "$o" "$s1")$(num_in "$o" "$s2")$(num_in "$o" "$s3")" = 123
# R43: the ghost's pin and number colours, by theme.
theme_is() { order | jq -r '.theme // "dark"'; }
ghost_check() { # dark|light
  drag_lift "$s2"
  drag_move "$_qp_px" "$(gap_y "$s3" after)"
  jq -c '.drag.ghost | {pinNumber, pinColor}' <<<"$DRAG_SEEN"
  if [ "$1" = dark ]; then
    jq -e '[.drag.ghost.pinColor, .drag.ghost.pinNumber.color] | map([scan("[0-9]+")][0:3] | map(tonumber) | all(. >= 225)) | all' <<<"$DRAG_SEEN"
  else
    jq -e '[.drag.ghost.pinColor, .drag.ghost.pinNumber.color] | map([scan("[0-9]+")][0:3] | map(tonumber) | all(. <= 40)) | all' <<<"$DRAG_SEEN"
  fi
  uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R43_ghost_$1.png" >/dev/null
  xdo key Escape; sleep 0.8; xdo mouseup 1; guard_wait
}
first_theme="$(theme_is)"
[ "$first_theme" = light ] || first_theme=dark
ghost_check "$first_theme"
cmd '{"command":"click","selector":"#themeToggle"}' >/dev/null; sleep 0.5
[ "$first_theme" = dark ] && ghost_check light || ghost_check dark
cmd '{"command":"click","selector":"#themeToggle"}' >/dev/null; sleep 0.5
order | jq -e --arg a "$s1" --arg b "$s2" --arg c "$s3" '.pinned == [$a, $b, $c]'
# R43: the drop keeps the numbers shown.
drag_row "$s1" "$s3" after; guard_wait
o="$(order)"
jq -e --arg a "$s1" --arg b "$s2" --arg c "$s3" '.pinned == [$b, $c, $a]' <<<"$o"
test "$(num_in "$o" "$s2")$(num_in "$o" "$s3")$(num_in "$o" "$s1")" = 123
test "$(num_in "$o" "$s4")" = none
