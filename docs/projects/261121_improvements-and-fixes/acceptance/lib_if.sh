# source me after `activate`, "$ZBUI_LIB", "$ZBUI_LIB_UP". This kit's helpers (and
# ../../261115_quit-pins-reorder/acceptance/lib_qp.sh, reused unchanged: modal, click_button, inv, prefs_file):
#   row_rect <sid>          the session's first list row, its rect (page px)
#   right_click_row <sid>   a real right-click on that row; waits for the profile menu
#   pmenu                   the open profile menu: [{kind, label, disabled, icon}]
#   pmenu_click <label>     a real click on that profile-menu item
#   status_text             the status line's text
#   editor_rect             the open profile dialog's rect, or null
source "$UB_REPO/docs/projects/261115_quit-pins-reorder/acceptance/lib_qp.sh"
row_rect() {
  sty ".session-row[data-session-id=\"$1\"]" | jq -c '.rect'
}
_if_menu_open() { state | jq -e '.sessionMenu != null' >/dev/null; }
right_click_row() {
  local r x y
  r="$(row_rect "$1")"
  x="$(jq -r '(.left + 40) | floor' <<<"$r")"; y="$(jq -r '(.top + .height / 2) | floor' <<<"$r")"
  mouse_to "$x" "$y"; xdo click 3
  wait_until 10 _if_menu_open
}
pmenu() { state | jq -c '[.sessionMenu[] | {kind, label, disabled, icon}]'; }
pmenu_click() {
  local i
  i="$(state | jq --arg l "$1" '[.sessionMenu[] | .label] | index($l)')"
  [ "$i" != null ] || { echo "pmenu_click: no item '$1' in $(pmenu)" >&2; return 1; }
  click_rect "$(state | jq -c --argjson i "$i" '.sessionMenu[$i].rect')"
}
status_text() { sstate | jq -r ".statusText // \"\""; }
editor_rect() { sty '.session-editor' | jq -c '.rect // null'; }
