#!/usr/bin/env bash
# R14 app_zoom_kept — proves R14: leaving "Zoom whole app with CTRL -/+" for "Change font size with CTRL -/+" keeps the app's zoom.
# Asserts: the app starts at zoom level 0 in font mode; a real click on 'Zoom whole app with CTRL -/+' in the settings menu turns app mode on; two real Ctrl+= raise the window's zoom level to 1 (Electron's own getZoomLevel, /renderer/layout); a real click on 'Change font size with CTRL -/+' turns font mode back on and the level stays 1; a real Ctrl+= now changes the font, not the app zoom (level still 1); after a restart of the app (same HOME and storage) the level is still 1 in font mode.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_up.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
sid="$(seed_session r14-zoom 'echo R14""A' R14A)"
select_session "$sid"
sleep 1
zl() { api GET /renderer/layout | jq '.zoomLevel'; }
pick_mode() { # a real click on that settings-menu item
  local r
  r="$(cmd '{"command":"settings-open"}' | jq -c --arg l "$1" '[.menu[] | select(.label == $l)][0].rect')"
  click_rect "$r"
  sleep 0.5
  close_menu
}
lstate | jq -c '.appZoom'
[ "$(zl)" = 0 ]
pick_mode 'Zoom whole app with CTRL -/+'
lstate | jq -e '.appZoom.on'
focus_terminal
key ctrl+equal
key ctrl+equal
sleep 0.5
[ "$(zl)" = 1 ]
pick_mode 'Change font size with CTRL -/+'
lstate | jq -e '.appZoom.on == false and .appZoom.level == 1'
[ "$(zl)" = 1 ]
lf="$(lstate | jq .liveFontSize)"
focus_terminal
key ctrl+equal
sleep 0.5
[ "$(zl)" = 1 ]
lstate | jq -e --argjson f "$lf" '.liveFontSize == $f + 1'
# Kept across a restart.
restart_app
sleep 1
lstate | jq -c '.appZoom'
[ "$(zl)" = 1 ]
lstate | jq -e '.appZoom.on == false'
