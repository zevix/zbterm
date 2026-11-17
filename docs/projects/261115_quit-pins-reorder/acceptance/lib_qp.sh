# source me after `activate`, "$ZBUI_LIB" and "$ZBUI_LIB_UP". This kit's helpers:
#   prefs_file             the profile's preferences.json under this script's storage
#   pinned_ids             the pins the app holds now (debug command session-order)
#   order                  cmd session-order: rows (ids, top to bottom), pinned ids, sort keys, drag state
#   app_gone               true once this script's app has exited (no PID)
#   wait_gone [secs]       waits until the app has exited
order() { cmd '{"command":"session-order"}'; }
pinned_ids() { order | jq -c '.pinned'; }
prefs_file() { find "$ZBUI_APP_STORAGE" -name preferences.json -print -quit; }
app_gone() { [ -z "$(_zbui_app_pid)" ]; }
wait_gone() { wait_until "${1:-30}" app_gone; }
#   modal                  ui-state .modal (title, text, actions [{text, disabled}]) or null
#   click_button <text>    a real click on the top dialog's action button with that text
#   inv <method> [args]    POST /invoke: an engine call
#   handle_xy <sid>        the centre of that row's drag handle (page px)
#   drag_lift <sid>        presses that row's handle and moves 12 px: the row is lifted
#   drag_move <x> <y>      moves the pressed pointer to x,y in 4 steps; DRAG_SEEN = order then
#   drag_drop              lets go; waits for the flight to end
#   gap_y <sid> before|after  during a drag: a y in that row's upper / lower quarter
#   drag_row <sid> <ref> before|after   lift, move to that gap, drop
#   drag_row_xy <sid> <x> <y>           lift, move to x,y, drop
#   guard_wait             waits until the R13 reorder guard is off (rows clickable)
modal() { state | jq -c '.modal'; }
click_button() {
  local i
  i="$(modal | jq --arg t "$1" '[.actions[].text] | index($t)')"
  [ "$i" != null ] || { echo "click_button: no button '$1' in $(modal)" >&2; return 1; }
  click_sel ".modal-overlay:last-of-type .modal-actions button:nth-child($((i + 1)))"
}
inv() { api POST /invoke "$(jq -nc --arg m "$1" --argjson a "${2:-{\}}" '{method: $m, args: $a}')"; }
handle_xy() {
  order | jq -r --arg s "$1" '.rows[] | select(.id == $s) | .handle
    | "\((.left + .width / 2) | floor) \((.top + .height / 2) | floor)"'
}
_qp_px=0; _qp_py=0
drag_lift() {
  read -r _qp_px _qp_py < <(handle_xy "$1")
  mouse_to "$_qp_px" "$_qp_py"
  xdo mousedown 1; sleep 0.2
  _qp_py=$((_qp_py + 12)); mouse_to "$_qp_px" "$_qp_py"; sleep 0.3
}
drag_move() {
  local i x0="$_qp_px" y0="$_qp_py"
  for i in 1 2 3 4; do
    mouse_to "$((x0 + ($1 - x0) * i / 4))" "$((y0 + ($2 - y0) * i / 4))"
  done
  _qp_px="$1"; _qp_py="$2"; sleep 0.2
  DRAG_SEEN="$(order)"
}
drag_drop() { xdo mouseup 1; sleep 0.8; }
gap_y() {
  order | jq -r --arg s "$1" --arg e "$2" '.rows[] | select(.id == $s) | .rect
    | if $e == "before" then .top + .height / 4 else .bottom - .height / 4 end | floor'
}
drag_row() {
  local y
  drag_lift "$1"
  y="$(gap_y "$2" "$3")"
  drag_move "$_qp_px" "$y"
  drag_drop
}
drag_row_xy() { drag_lift "$1"; drag_move "$2" "$3"; drag_drop; }
guard_wait() { sleep 1.2; wait_until 10 guard_off || true; }
