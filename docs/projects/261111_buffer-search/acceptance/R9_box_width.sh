#!/usr/bin/env bash
# R9 box_width — proves R9: the box is as wide as the side pane and aligned under it while the pane is shown, and as wide as the collapsed top bar's left group while it is collapsed, searching then the selected session only.
# Asserts: at 1280x800, expanded: |box.rect.left - sidebarRect.left| <= 1 and |box.rect.right - sidebarRect.right| <= 1, and the box is below the pane (box.rect.top >= sidebarRect.bottom - 1); after dragging the resizer +120 px, the same holds at the new width; after a real Ctrl+Shift+B (collapsed): .sideCollapsed == true, box.rect.left <= 1 and |box.rect.width - topbarBrandRect.width| <= 1, the box still visible at the window's bottom left with the status to its right; the same after resizing the window to 1000x700; while collapsed, typing a query that is in two live sessions gives .inSession.total > 0 for the selected one, .crossSession == false, and buffer-search-log has no session.searchBuffer request; Ctrl+Shift+B again (expanded, text still in the box) gives one request per live session and the heading; after expanding, the widths match the pane again.
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
# > FILL (P1): start_app; seed two sessions with the query; read search-state; lib_bs.sh::drag_resizer 120; read; key ctrl+shift+b; read; POST /window/bounds 1000x700; read; xdo type the query; wait; read search-state and buffer-search-log; key ctrl+shift+b; wait pending == 0; read both again.
echo "body not written yet (P1)" >&2
exit 1
