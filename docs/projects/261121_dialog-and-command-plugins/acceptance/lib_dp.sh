# source me after `activate`, "$ZBUI_LIB", "$ZBUI_LIB_UP". This kit's helpers (and
# ../../261115_quit-pins-reorder/acceptance/lib_qp.sh, reused unchanged: modal, click_button, inv):
#   editor               the open profile dialog: {heading, rect, gripRect, headingRect, overlay bg}
#   pstate               the command plugins: files, choice, registered, the Plugins dialog's rows
#   drag_xy x1 y1 x2 y2  a real left-button drag between page points, in steps
#   center <rect-json>   "x y" of a rect's centre (page px)
#   plugins_dir          the scratch app's plugins directory
source "$UB_REPO/docs/projects/261115_quit-pins-reorder/acceptance/lib_qp.sh"
editor() {
  local e t g h o
  e="$(sty '.session-editor')"; t="$(sty '.session-editor-title')"
  g="$(sty '.session-editor-grip')"; h="$(sty '.session-editor-heading')"
  o="$(sty '.session-editor-overlay')"
  jq -nc --argjson e "$e" --argjson t "$t" --argjson g "$g" --argjson h "$h" --argjson o "$o" \
    '{open: ($e.visible // false), rect: $e.rect, titleRect: $t.rect, gripRect: $g.rect,
      gripVisible: ($g.visible // false), heading: $h.text, headingRect: $h.rect, overlay: $o}'
}
pstate() { cmd '{"command":"plugins-state"}'; }
center() { jq -r '"\((.left + .width / 2) | floor) \((.top + .height / 2) | floor)"' <<<"$1"; }
drag_xy() {
  local i n=8 x y
  mouse_to "$1" "$2"; xdo mousedown 1; sleep 0.2
  for i in $(seq 1 $n); do
    x=$(( $1 + ($3 - $1) * i / n )); y=$(( $2 + ($4 - $2) * i / n ))
    # shellcheck disable=SC2046
    xdo mousemove --sync $(_zbui_screen_xy "$x" "$y"); sleep 0.05
  done
  sleep 0.2; xdo mouseup 1; sleep 0.4
}
plugins_dir() { echo "$ZBUI_APP_HOME/.config/ZBTerm/plugins/commands"; }
