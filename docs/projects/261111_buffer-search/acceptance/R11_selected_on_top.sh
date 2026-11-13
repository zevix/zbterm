#!/usr/bin/env bash
# R11 selected_on_top — proves R11 (the user's layout of 2026-11-13): while the box holds text the list shows, in order, a "Current session" heading and the selected session's row (in its selected colour, whether it matches or not), a "Session name matches" heading and the other name matches in the list's own order (only when there are some), and the "Session buffer matches" section as before; with the box empty, after Esc and after a click in the terminal, the plain list.
# Asserts: sessions qelv-a (2 matches of QELV), qelv-b (3), r11-nine (9), r11-five (5), r11-one (1), r11-none (0); the query QELV.
#   qelv-a selected: headings == ["Current session", "Session name matches", "Session buffer matches"] in that DOM order; current rows == [qelv-a], selected, its .rowBg unlike every other row's; name rows == [qelv-b] (the current session is not repeated there); buffer rows == [nine, five, qelv-b, qelv-a, one] with subs 9, 5, 3, 2, 1 (count order, the current session in its place); no row of another session selected. Both themes.
#   r11-five selected by a real click on its buffer row: current == [five]; name rows == [qelv-b, qelv-a] (the plain list's order); buffer rows unchanged.
#   r11-none selected (matches nothing): current == [none]; name rows == [qelv-b, qelv-a]; buffer rows unchanged.
#   query "QELV 9" (no name matches): headings == ["Current session", "Session buffer matches"], no name rows, current == [none], buffer == [nine].
#   Esc: headings == [], all six sessions in the plain list; a click in the terminal after retyping: the same.
# Kit correction 2026-11-13 (builder fix round F2): rewritten for the user's layout, replacing F1's "selected row first in each section"; the row's id stays R11.
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
# n occurrences of QELV, never on the command line (p=QE … ${p}LV).
seed_n() { seed_session "$1" "p=QE; for i in \$(seq $2); do echo \"\${p}LV \$i\"; done" "QELV $2"; }
s0="$(seed_session r11-none 'echo R11N""READY' R11NREADY)"
s1="$(seed_n r11-one 1)"
s5="$(seed_n r11-five 5)"
s9="$(seed_n r11-nine 9)"
qa="$(seed_n qelv-a 2)"
qb="$(seed_n qelv-b 3)"
buffer="[\"$s9\",\"$s5\",\"$qb\",\"$qa\",\"$s1\"]"
subs='["9 matches","5 matches","3 matches","2 matches","1 match"]'
three='["Current session","Session name matches","Session buffer matches"]'
# check <state> <current id> <headings json> <name ids json> <buffer ids json> <buffer subs json>
check() {
  local s="$1" cur="$2"
  jq '.sessions' <<<"$s"
  jq -e --arg c "$cur" '.selectedId == $c' <<<"$s"
  jq -e --argjson h "$3" '[.sessions.headings[].text] == $h and ([.sessions.headings[].index] | . == sort)' <<<"$s"
  # Rows sit under their own heading, in DOM order.
  jq -e '[.sessions.rows[] | .section] as $s | ($s | map({current: 0, name: 1, buffer: 2}[.])) | . == sort' <<<"$s"
  jq -e --arg c "$cur" '[.sessions.rows[] | select(.section == "current") | .id] == [$c]' <<<"$s"
  jq -e --argjson n "$4" '[.sessions.rows[] | select(.section == "name") | .id] == $n' <<<"$s"
  jq -e --argjson b "$5" '[.sessions.rows[] | select(.section == "buffer") | .id] == $b' <<<"$s"
  jq -e --argjson u "$6" '[.sessions.rows[] | select(.section == "buffer") | .sub] == $u' <<<"$s"
  # The current row is selected and drawn in the selected colour; no other session's row is.
  jq -e --arg c "$cur" '[.sessions.rows[] | select(.selected) | .id] | unique == [$c]' <<<"$s"
  jq -e '[.sessions.rows[] | select(.section == "current")][0] as $c
    | all(.sessions.rows[] | select(.selected | not); .rowBg != $c.rowBg)' <<<"$s"
}
both_themes() {
  check "$(sstate)" "$@"
  cmd '{"command":"click","selector":"#themeToggle"}' >/dev/null
  sleep 1
  check "$(sstate)" "$@"
}
select_session "$qa"
type_box QELV
wait_search
both_themes "$qa" "$three" "[\"$qb\"]" "$buffer" "$subs"
# A real click on r11-five's buffer row makes it the current session; the box keeps its text.
r="$(cmd "{\"command\":\"style-of\",\"selector\":\".session-row[data-session-id=\\\"$s5\\\"]\"}")"
jq -c '.rect' <<<"$r"
click_at "$(jq '(.rect.left + 40) | floor' <<<"$r")" "$(jq '(.rect.top + .rect.height / 2) | floor' <<<"$r")"
wait_until 15 _bs_shows "$s5"
# The pointer off the list, so no row is drawn hovered.
mouse_to 700 300
wait_search
jq -e '.box.value == "QELV"' <<<"$(sstate)"
both_themes "$s5" "$three" "[\"$qb\",\"$qa\"]" "$buffer" "$subs"
# A current session that matches nothing is still shown under its heading. (The debug
# server's switch picks from the list as shown, which the name filter narrows: switch with
# the box empty.)
clear_box
select_session "$s0"
type_box QELV
wait_search
check "$(sstate)" "$s0" "$three" "[\"$qb\",\"$qa\"]" "$buffer" "$subs"
# No name match: no "Session name matches" heading.
clear_box
xdo type --delay 30 'QELV 9'
wait_search
check "$(sstate)" "$s0" '["Current session","Session buffer matches"]' '[]' "[\"$s9\"]" '["1 match"]'
# Esc: the plain list.
key Escape
s="$(sstate)"
jq '.sessions' <<<"$s"
jq -e '.sessions.headings == []' <<<"$s"
jq -e --argjson all "[\"$s0\",\"$s1\",\"$s5\",\"$s9\",\"$qa\",\"$qb\"]" '[.sessions.rows[] | select(.section == "name") | .id] | sort == ($all | sort)' <<<"$s"
# A click in the terminal: the plain list too.
type_box QELV
wait_search
jq -e '.sessions.headings | length == 3' <<<"$(sstate)"
focus_terminal
s="$(sstate)"
jq -e '.box.value == "" and .sessions.headings == []' <<<"$s"
jq -e '[.sessions.rows[] | select(.section == "name")] | length == 6' <<<"$s"
