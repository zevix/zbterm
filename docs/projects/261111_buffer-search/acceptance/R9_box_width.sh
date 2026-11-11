#!/usr/bin/env bash
# R9 box_width — proves R9: the box is as wide as the side pane and aligned under it while the pane is shown, and as wide as the collapsed top bar's left group while it is collapsed, searching then the selected session only.
# Asserts: at 1280x800, expanded: |box.rect.left - sidebarRect.left| <= 1 and |box.rect.right - sidebarRect.right| <= 1, and the box is below the pane (box.rect.top >= sidebarRect.bottom - 1); after dragging the resizer +120 px, the same holds at the new width; after a real Ctrl+Shift+B (collapsed): .sideCollapsed == true, box.rect.left <= 1 and |box.rect.width - topbarBrandRect.width| <= 1, the box still visible at the window's bottom left with the status to its right; the same after resizing the window to 1000x700; while collapsed, typing a query that is in two live sessions gives .inSession.total > 0 for the selected one, .crossSession == false, and buffer-search-log has no session.searchBuffer request; Ctrl+Shift+B again (expanded, text still in the box) gives one request per live session and the heading; after expanding, the widths match the pane again.
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
sa="$(seed_session r9-alpha 'p=QNI; echo "${p}NE a"' 'QNINE a')"
sb="$(seed_session r9-beta 'p=QNI; echo "${p}NE b"' 'QNINE b')"
under_pane() {
  jq '{box: .box.rect, sidebarRect}' <<<"$1"
  jq -e '(.box.rect.left - .sidebarRect.left | fabs) <= 1 and (.box.rect.right - .sidebarRect.right | fabs) <= 1' <<<"$1"
  jq -e '.box.rect.top >= .sidebarRect.bottom - 1' <<<"$1"
}
collapsed_ok() {
  jq '{box: .box.rect, topbarBrandRect, statusRect, sideCollapsed}' <<<"$1"
  jq -e '.sideCollapsed == true and .box.visible == true' <<<"$1"
  jq -e '.box.rect.left <= 1 and ((.box.rect.width - .topbarBrandRect.width) | fabs) <= 1' <<<"$1"
  jq -e '(.window.innerHeight - .box.rect.bottom) <= 8 and .statusRect.left >= .box.rect.right' <<<"$1"
}
s="$(sstate)"
under_pane "$s"
w0="$(jq '.sidebarRect.width' <<<"$s")"
# A real drag of the resizer: the box follows the pane's new width.
drag_resizer 120
s="$(sstate)"
jq -e --argjson w "$w0" '.sidebarRect.width > $w + 60' <<<"$s"
under_pane "$s"
# Collapsed (a real Ctrl+Shift+B): as wide as the top bar's left group.
key ctrl+shift+b
s="$(sstate)"
collapsed_ok "$s"
win_size 1000 700
collapsed_ok "$(sstate)"
# Collapsed: the box searches the selected session only.
bslog >/dev/null
type_box QNINE
sleep 2
s="$(sstate)"
log="$(bslog)"
jq '{crossSession, inSession, sessions}' <<<"$s"
jq . <<<"$log"
jq -e '.inSession.total > 0' <<<"$s"
jq -e '.crossSession == false' <<<"$s"
jq -e '.entries | length == 0' <<<"$log"
# Expanded again with text in the box: one request per live session, and the heading.
key ctrl+shift+b
wait_search
s="$(sstate)"
log="$(bslog)"
jq . <<<"$log"
jq -e '.sideCollapsed == false and .sessions.heading == "Session buffer matches"' <<<"$s"
jq -e --arg a "$sa" --arg b "$sb" '.entries | map(.sessionId) | sort == ([$a, $b] | sort)' <<<"$log"
under_pane "$s"
