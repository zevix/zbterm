#!/usr/bin/env bash
# R1 quit popup — proves R1, R2, R3, U1: Ctrl+Q away from the terminal opens one popup (Cancel, "Send ^Q to the terminal", Quit) and does not quit; Esc and Cancel close it, nothing else changes; a second Ctrl+Q while it is open adds no popup; Send writes 0x11 to the live session and focuses the terminal; Ctrl+Q in the terminal is 0x11 with no popup; Send is disabled with no live session selected; Quit quits.
# Asserts: modal title "Quit ZBTerm?", actions [Cancel, Send ^Q to the terminal, Quit], one overlay after two Ctrl+Q; app PID alive after Esc/Cancel; the session's mirror gains "^Q" (cat -v, ixon off) after Send and again after Ctrl+Q in the terminal, with terminalFocused true and no modal; Send disabled on an ended session; the app exits after Quit.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R1_quit_popup
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_qp.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display"
set -x
start_app
win_size 1280 800
a="$(seed_session r1-a 'stty -ixon -icanon; echo R1""READY; cat -v' R1READY)"
select_session "$a"
pid="$(_zbui_app_pid)"; test -n "$pid"
qcount() { api GET "/sessions/$a" | jq -r '(.opened.frame.data // "") | [scan("\\^Q")] | length'; }
q0="$(qcount)"
# R1 + U1: away from the terminal (the search box), Ctrl+Q asks; twice is still one popup.
click_box
key ctrl+q; sleep 0.5
modal | jq -e '.title == "Quit ZBTerm?" and ([.actions[].text] == ["Cancel", "Send ^Q to the terminal", "Quit"])'
modal | jq -e '.actions[1].disabled == false'
key ctrl+q; sleep 0.5
order | jq -e '.overlays == 1'
kill -0 "$pid"
# R2: Esc closes it, nothing else.
key Escape; sleep 0.5
test "$(modal)" = null
kill -0 "$pid"
# R2: Cancel closes it.
click_box; key ctrl+q; sleep 0.5
click_button Cancel; sleep 0.5
test "$(modal)" = null
kill -0 "$pid"
test "$(qcount)" = "$q0"
# R2: Send ^Q writes 0x11 and focuses the terminal.
click_box; key ctrl+q; sleep 0.5
click_button "Send ^Q to the terminal"; sleep 1
test "$(modal)" = null
q1="$(qcount)"; [ "$q1" -gt "$q0" ]
order | jq -e '.terminalFocused == true'
# R3: in the terminal Ctrl+Q is 0x11, no popup, no quit.
focus_terminal
key ctrl+q; sleep 1
test "$(modal)" = null
q2="$(qcount)"; [ "$q2" -gt "$q1" ]
kill -0 "$pid"
# U1: with an ended session selected, Send is disabled.
b="$(api POST /sessions "$(jq -nc --arg h "$ZBUI_APP_HOME" '{name: "r1-b", cols: 80, rows: 24, cwd: $h, command: "sh -c \"exit 0\""}')" | jq -r .sessionId)"
b_ended() { api GET "/sessions/$b" | jq -e '.entry.active == false' >/dev/null; }
wait_until 30 b_ended
sleep 1; wait_until 30 b_ended
click_box; key ctrl+q; sleep 0.5
modal | jq -e '.actions[1].text == "Send ^Q to the terminal" and .actions[1].disabled == true'
# R2: Quit quits.
click_button Quit
wait_gone 30
