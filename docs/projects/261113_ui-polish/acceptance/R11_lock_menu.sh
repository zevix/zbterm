#!/usr/bin/env bash
# R11 lock_menu — proves R11: a size lock button whose menu is 'Unlocked - set by terminal and font sizes', 'Current size: R x C', '32 x 120', '25 x 80', with lock icons and separators as drawn.
# Asserts: a live own session; the lock button is shown in the top bar, its left-most button (R15) (fa-lock-open, 'Terminal size: unlocked'); a real click opens the menu: kinds [check, separator, check, separator, check, check]; labels ['Unlocked - set by terminal and font sizes', 'Current size: <rows> x <cols>' (the grid as it is), '32 x 120', '25 x 80']; icons [fa-lock-open, fa-lock, fa-lock, fa-lock]; only Unlocked ticked; a real click on '25 x 80' locks: the button shows fa-lock and 'Terminal size locked: 25 x 80', the grid is 25 x 80 and the shell's stty says '25 80'; reopened, the menu reads 'Current size: 25 x 80' with '25 x 80' ticked; 'Current size' locks the grid as it is (after Unlocked); 'Unlocked' unlocks (fa-lock-open) and the grid follows the window again (not 25 x 80 at 1280 x 800).
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
sid="$(seed_session r11-lock 'echo R11""A' R11A)"
select_session "$sid"
sleep 1
l="$(lstate)"
jq '.' <<<"$l"
jq -e '.button.hidden == false and .button.disabled == false and .button.icon == "fa-lock-open" and .button.title == "Terminal size: unlocked"' <<<"$l"
# R15: the left-most button of the top bar.
jq -e '.button.first' <<<"$l"
open_lock_menu() {
  click_rect "$(lstate | jq -c '.button.rect')"
  lstate | jq -e '.menuOpen' >/dev/null
}
pick() { # pick <label>: a real click on that item
  click_rect "$(lstate | jq -c --arg l "$1" '[.menu[] | select(.label == $l)][0].rect')"
  sleep 1
}
open_lock_menu
l="$(lstate)"
jq -c '.menu[] | {kind, label, icon, checked, checkMark}' <<<"$l"
rows="$(jq .term.rows <<<"$l")"; cols="$(jq .term.cols <<<"$l")"
jq -e '[.menu[].kind] == ["check", "separator", "check", "separator", "check", "check"]' <<<"$l"
jq -e --arg c "Current size: $rows x $cols" '[.menu[] | select(.kind != "separator") | .label] == ["Unlocked - set by terminal and font sizes", $c, "32 x 120", "25 x 80"]' <<<"$l"
jq -e '[.menu[] | select(.kind != "separator") | .icon] == ["fa-lock-open", "fa-lock", "fa-lock", "fa-lock"]' <<<"$l"
jq -e '[.menu[] | select(.kind != "separator") | .checked] == [true, false, false, false]' <<<"$l"
jq -e '[.menu[] | select(.kind != "separator") | .checkMark] == [true, false, false, false]' <<<"$l"
pick '25 x 80'
l="$(lstate)"
jq '{button, lock, term, menuOpen}' <<<"$l"
jq -e '.menuOpen == false and .button.icon == "fa-lock" and .button.title == "Terminal size locked: 25 x 80"' <<<"$l"
jq -e '.lock.rows == 25 and .lock.cols == 80 and .term.rows == 25 and .term.cols == 80' <<<"$l"
[ "$(stty_size "$sid")" = "25 80" ]
open_lock_menu
l="$(lstate)"
jq -e '[.menu[] | select(.kind != "separator") | .label][1] == "Current size: 25 x 80"' <<<"$l"
jq -e '[.menu[] | select(.kind != "separator") | .checked] == [false, false, false, true]' <<<"$l"
# Unlocked: the grid follows the window again.
pick 'Unlocked - set by terminal and font sizes'
l="$(lstate)"
jq '{button, lock, term}' <<<"$l"
jq -e '.lock == null and .button.icon == "fa-lock-open" and .button.title == "Terminal size: unlocked"' <<<"$l"
jq -e '(.term.rows == 25 and .term.cols == 80) | not' <<<"$l"
# Current size: the grid as it is, locked.
r0="$(jq .term.rows <<<"$l")"; c0="$(jq .term.cols <<<"$l")"
open_lock_menu
pick "Current size: $r0 x $c0"
l="$(lstate)"
jq -e --argjson r "$r0" --argjson c "$c0" '.lock.rows == $r and .lock.cols == $c and .button.icon == "fa-lock"' <<<"$l"
open_lock_menu
lstate | jq -e '[.menu[] | select(.kind != "separator") | .checked] == [false, true, false, false]'
key Escape
