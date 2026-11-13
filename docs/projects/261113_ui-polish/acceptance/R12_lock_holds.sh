#!/usr/bin/env bash
# R12 lock_holds — proves R12: while locked, the session keeps its rows and columns whatever the window or the font does.
# Asserts: a live own session locked at 32 x 120 through the lock menu (real clicks); window 1280x800 -> 1000x640 -> 1500x900: the grid stays 32 x 120 and the shell's stty says '32 120' each time, while the drawn font size changes with the window (the font follows, not the grid); the Font +/- buttons are disabled with the title 'Terminal size is locked'; a real Ctrl+= (CTRL -/+ font mode, on by default) leaves the grid at 32 x 120 and liveFontSize unchanged; after a restart of the app (same HOME and storage) the session, selected again, is still locked at 32 x 120 (stty '32 120').
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
sid="$(seed_session r12-lock 'echo R12""A' R12A)"
select_session "$sid"
sleep 1
click_rect "$(lstate | jq -c '.button.rect')"
click_rect "$(lstate | jq -c '[.menu[] | select(.label == "32 x 120")][0].rect')"
sleep 1
held() {
  local l
  l="$(lstate)"
  jq -c '{lock, term, fontSize, liveFontSize, fontButtons}' <<<"$l"
  jq -e '.lock.rows == 32 and .lock.cols == 120 and .term.rows == 32 and .term.cols == 120' <<<"$l"
  [ "$(stty_size "$sid")" = "32 120" ]
}
held
f1="$(lstate | jq .fontSize)"
win_size 1000 640
sleep 1
held
f2="$(lstate | jq .fontSize)"
win_size 1500 900
sleep 1
held
f3="$(lstate | jq .fontSize)"
echo "font sizes: $f1 $f2 $f3"
jq -e -n --argjson a "$f2" --argjson b "$f3" '$a != $b'
lstate | jq -e '.fontButtons.increase.disabled and .fontButtons.decrease.disabled
  and .fontButtons.increase.title == "Terminal size is locked" and .fontButtons.decrease.title == "Terminal size is locked"'
lf="$(lstate | jq .liveFontSize)"
focus_terminal
key ctrl+equal
key ctrl+minus
sleep 1
held
lstate | jq -e --argjson f "$lf" '.liveFontSize == $f'
# Kept across a restart.
restart_app
win_size 1280 800
select_session "$sid"
sleep 2
held
