#!/usr/bin/env bash
# R3 escape — proves R3: Esc in the box clears its text, the highlights and the session-list filter, and gives the focus back to the terminal.
# Asserts: two sessions 'alpha' (buffer has NEEDLE) and 'beta'; after typing NEEDLE (list filtered: name rows == [] and a buffer row for alpha; inSession.total > 0), a real Escape gives .box.value == "", .inSession.total == 0, .inSession.decorations == 0, .sessions.heading == null, the list shows both sessions again, .box.focused == false, and a following real key x reaches the shell (od -c shows x); the box is still shown; Esc on an empty box only moves the focus to the terminal; with no session selected, Esc in the box leaves no error in the app log and the box empty.
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
applog_errors() { grep -c -E 'Uncaught|TypeError|ReferenceError' "$ZBUI_APP_LOG" || true; }
# No session selected: Esc in the box leaves no error and the box empty.
jq -e '.selectedId == null' <<<"$(sstate)"
e0="$(applog_errors)"
type_box xyz
key Escape
s="$(sstate)"
jq '.box' <<<"$s"
jq -e '.box.value == ""' <<<"$s"
[ "$(applog_errors)" = "$e0" ]
# Two sessions; alpha's buffer has NEEDLE, beta's does not.
sa="$(seed_session r3-alpha 'n=NEE; echo "${n}DLE here"' 'NEEDLE here')"
sb="$(seed_session r3-beta 'echo R3B""READY' R3BREADY)"
select_session "$sa"
type_box NEEDLE
wait_search
s="$(sstate)"
jq '{box, inSession, sessions}' <<<"$s"
jq -e '[.sessions.rows[] | select(.section == "name")] == []' <<<"$s"
jq -e --arg a "$sa" '[.sessions.rows[] | select(.section == "buffer") | .id] == [$a]' <<<"$s"
jq -e '.inSession.total > 0' <<<"$s"
# A real Escape clears everything the box drives and focuses the terminal.
key Escape
s="$(sstate)"
jq '{box, inSession, sessions, terminalFocused, activeElement}' <<<"$s"
jq -e '.box.value == ""' <<<"$s"
jq -e '.inSession.total == 0 and .inSession.decorations == 0' <<<"$s"
jq -e '.sessions.heading == null' <<<"$s"
jq -e --arg a "$sa" --arg b "$sb" '[.sessions.rows[] | .id] | (index($a) != null and index($b) != null)' <<<"$s"
jq -e '.box.focused == false and .terminalFocused == true' <<<"$s"
jq -e '.box.visible == true' <<<"$s"
# The next real key reaches the shell.
sinput "$sa" 'clear; od -c'
sleep 1
key x
api POST "/sessions/$sa/input" '{"data":"\r\u0004"}' >/dev/null
sleep 1
out="$(term_text)"
printf '%s\n' "$out"
grep -E '^0000000 +x ' <<<"$out"
# Esc on an empty box only moves the focus to the terminal.
click_box
key Escape
s="$(sstate)"
jq -e '.box.value == "" and .box.focused == false and .terminalFocused == true' <<<"$s"
