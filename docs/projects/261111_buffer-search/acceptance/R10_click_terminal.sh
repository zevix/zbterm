#!/usr/bin/env bash
# R10 click_terminal — proves R10: a click in the terminal ends the search as Esc does (highlights, filter and buffer section gone, terminal focused, typing reaches the program at once) but keeps the text, and the box's next focus (a click or Ctrl+Shift+F) brings it back selected, so typing replaces it.
# Asserts: session 'r10-alpha' (its name does not match the query, so the name filter hides it: the case the user hit) runs od -c with ZTEN in its buffer; after typing ZTEN (name rows == [], a buffer row for alpha, inSession.total > 0), a real click in the terminal gives .box.value == "", .inSession.total == 0, .inSession.decorations == 0, .sessions.heading == null, both sessions listed, .terminalFocused == true, .remembered == "ZTEN"; a real key x right after it reaches od -c (od shows x) and .inputBlockedFlashes did not grow (no "Local" flash); a real click on the box gives .box.value == "ZTEN", selStart 0, selEnd 4, focused, and the search runs again (inSession.total > 0, the heading); a real typed Q replaces it (.box.value == "Q"); the same restore with Ctrl+Shift+F after another terminal click; after Esc the text is not brought back (Esc forgets).
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_bs.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
# Two sessions; alpha's buffer has ZTEN (never on a command line: p=ZT … ${p}EN), beta's not.
sb="$(seed_session r10-beta 'echo R10B""READY' R10BREADY)"
sa="$(seed_session r10-alpha 'p=ZT; echo "${p}EN here"' 'ZTEN here')"
select_session "$sa"
# alpha runs od -c, so the next byte typed in the terminal shows in its output.
sinput "$sa" 'od -c'
sleep 1
searching() {
  local s
  s="$(sstate)"
  jq '{box, inSession, sessions}' <<<"$s"
  jq -e '.box.value == "ZTEN"' <<<"$s"
  jq -e '[.sessions.rows[] | select(.section == "name")] == []' <<<"$s"
  jq -e --arg a "$sa" '[.sessions.rows[] | select(.section == "buffer") | .id] | index($a) != null' <<<"$s"
  jq -e '.inSession.total > 0 and .sessions.heading == "Session buffer matches"' <<<"$s"
  # Kit correction 2026-11-13 (builder 261113_ui-polish R3): beta (no ZTEN) is under the fourth section,
  # "Other - unmatched sessions"; the checks above are unchanged.
  jq -e --arg b "$sb" '[.sessions.rows[] | select(.section == "other") | .id] == [$b]' <<<"$s"
}
# ended <remembered>: the state a terminal click (or Esc) leaves.
ended() {
  local s
  s="$(sstate)"
  jq '{box, inSession, sessions, terminalFocused, activeElement, remembered}' <<<"$s"
  jq -e '.box.value == ""' <<<"$s"
  jq -e '.inSession.total == 0 and .inSession.decorations == 0' <<<"$s"
  jq -e '.sessions.heading == null' <<<"$s"
  # Kit correction 2026-11-13 (builder fix round F2), R11: the plain list, no section heading.
  jq -e '.sessions.headings == []' <<<"$s"
  jq -e --arg a "$sa" --arg b "$sb" '[.sessions.rows[] | .id] | (index($a) != null and index($b) != null)' <<<"$s"
  jq -e '.box.focused == false and .terminalFocused == true' <<<"$s"
  jq -e --arg r "$1" '.remembered == $r' <<<"$s"
}
type_box ZTEN
wait_search
searching
f0="$(sstate | jq '.inputBlockedFlashes')"
# A real click in the terminal ends the search, keeping the text.
focus_terminal
ended ZTEN
# The next real key reaches the program, and nothing flashed "input blocked".
key x
f1="$(sstate | jq '.inputBlockedFlashes')"
cmd '{"command":"style-of","selector":"#inputMode"}' | jq -c '{className}'
[ "$f1" = "$f0" ]
api POST "/sessions/$sa/input" '{"data":"\r\u0004"}' >/dev/null
sleep 1
out="$(term_text)"
printf '%s\n' "$out"
grep -E '^0000000 +x ' <<<"$out"
# A real click on the box brings the text back, all selected, and searches again.
click_box
s="$(sstate)"
jq '.box' <<<"$s"
jq -e '.box.focused == true and .box.value == "ZTEN" and .box.selStart == 0 and .box.selEnd == 4' <<<"$s"
wait_search
searching
# Typing replaces it.
xdo type --delay 30 Q
sleep 0.5
jq -e '.box.value == "Q"' <<<"$(sstate)"
# Ctrl+Shift+F restores the same way.
key ctrl+a
xdo type --delay 30 ZTEN
wait_search
searching
focus_terminal
ended ZTEN
key ctrl+shift+f
s="$(sstate)"
jq '.box' <<<"$s"
jq -e '.box.focused == true and .box.value == "ZTEN" and .box.selStart == 0 and .box.selEnd == 4' <<<"$s"
wait_search
searching
# Esc ends the search and forgets the text: the next focus leaves the box empty.
key Escape
ended ""
click_box
s="$(sstate)"
jq '.box' <<<"$s"
jq -e '.box.focused == true and .box.value == ""' <<<"$s"
