#!/usr/bin/env bash
# R28 nav scroll, F2 edit — proves R28, R29, R30: Ctrl+PgDn/PgUp through a list longer than its pane scroll the list so the selected row is always fully in view; "Map F2 to edit profile" sits two below "Copy on select" (the Ctrl+N setting between, R39), on by default; F2 then opens the selected session's edit dialog (from the terminal and from the search box); turned off, F2 goes to the terminal and the choice survives a restart.
# Asserts: the list overflows (a row below the pane); after each of 7 Ctrl+PgDn and 7 Ctrl+PgUp (round the 7-row list) the selection moved and the selected row's rect lies inside the list's rect (1 px slack); menu labels have "Map F2 to edit profile" two after "Copy on select", checked; F2 in the terminal and in the box: .session-editor-overlay found, gone after Escape; after unchecking: checked false, F2 opens no editor and the cat -v session's mirror gains "^[OQ"; after a restart still unchecked (session-order f2Edit false); checking it again: checked true.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R28_nav_scroll_f2
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_qp.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display"
need "$UB_PY" "python-xlib for a bare F2 (xdotool adds Alt to F2 on this display)"
# xdotool sends F2 with Alt_L held here (it picks a level of keycode 68 that
# needs Mod1); xkey_raw.py presses keycode 68 alone.
key_f2() { uisolate run --name "$ZBUI_SESSION" -t 30 -- "$UB_PY" -I "$here/xkey_raw.py" 68; }
set -x
start_app
win_size 1280 420
for i in 0 1 2 3 4 5; do seed_session "r28-$i" "echo R28$i""READY" "R28${i}READY" >/dev/null; done
f="$(seed_session r28-f 'stty -icanon; echo F""READY; cat -v' FREADY)"
select_session "$f"
guard_wait
# The list is longer than its pane.
order | jq -e '.list.bottom as $b | [.rows[] | select(.rect.bottom > $b + 1)] | length > 0'
in_view() {
  order | jq -e --arg was "$1" '. as $o | .selectedId != $was
    and ([.rows[] | select(.id == $o.selectedId)][0].rect as $r
      | $r.height > 0 and $r.top >= $o.list.top - 1 and $r.bottom <= $o.list.bottom + 1)'
}
# R28: down through the whole list and round, then back up.
focus_terminal
for k in Next Prior; do
  for i in $(seq 1 7); do
    was="$(order | jq -r .selectedId)"
    key "ctrl+$k"; sleep 0.7
    in_view "$was"
  done
done
select_session "$f"; guard_wait
# R29: the setting, right below Copy on select, on by default.
labels="$(menu)"
# 2026-11-16 (R39): "Map Ctrl+1 to Ctrl+9 to pinned profiles" now sits between them.
jq -e '[.[] | .label] | index("Copy on select") as $i | $i != null and .[$i + 2] == "Map F2 to edit profile"' <<<"$labels"
jq -e '.[] | select(.label == "Map F2 to edit profile") | .checked == true' <<<"$labels"
close_menu
editor() { sty .session-editor-overlay | jq -r .found; }
test "$(editor)" = false
focus_terminal; key_f2; sleep 0.8
test "$(editor)" = true
xdo key Escape; sleep 0.5; test "$(editor)" = false
click_box; key_f2; sleep 0.8
test "$(editor)" = true
xdo key Escape; sleep 0.5; test "$(editor)" = false
# Off: F2 is the terminal's (cat -v shows ^[OQ).
menu >/dev/null
cmd '{"command":"settings-click","label":"Map F2 to edit profile"}' | jq -e '.clicked'
menu | jq -e '.[] | select(.label == "Map F2 to edit profile") | .checked == false'
close_menu
fq() { api GET "/sessions/$f" | jq -r '(.opened.frame.data // "") | [scan("\\^\\[OQ")] | length'; }
q0="$(fq)"
focus_terminal; key_f2; sleep 1
test "$(editor)" = false
[ "$(fq)" -gt "$q0" ]
restart_app
guard_wait
order | jq -e '.f2Edit == false'
menu | jq -e '.[] | select(.label == "Map F2 to edit profile") | .checked == false'
cmd '{"command":"settings-click","label":"Map F2 to edit profile"}' | jq -e '.clicked'
menu | jq -e '.[] | select(.label == "Map F2 to edit profile") | .checked == true'
close_menu
order | jq -e '.f2Edit == true'
