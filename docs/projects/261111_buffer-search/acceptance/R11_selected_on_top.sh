#!/usr/bin/env bash
# R11 selected_on_top — proves R11: while searching with the side pane shown, the selected session's row, in its selected colour, leads each section it is in (the name rows, the buffer-match rows); the other rows keep their order.
# Asserts: sessions qelv-a (2 matches of QELV), qelv-b (3), r11-nine (9), r11-five (5), r11-one (1), r11-none (0); the query QELV.
#   qelv-a selected: name rows == [qelv-a, qelv-b] (qelv-b, the newer, leads without the rule); buffer rows == [qelv-a, nine, five, qelv-b, one] with subs ["2 matches","9 matches","5 matches","3 matches","1 match"]; the first row of each section has .selected == true and a .rowBg unlike the other rows', no other row is selected.
#   r11-five selected by a real click on its buffer row: name rows == [qelv-b, qelv-a]; buffer rows == [five, nine, qelv-b, qelv-a, one]; five's row selected.
#   r11-none selected (matches nothing): name rows == [qelv-b, qelv-a]; buffer rows == [nine, five, qelv-b, qelv-a, one] (by count, R6), none selected.
#   Both themes for the colour check.
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
ids() { jq -c --arg sec "$1" '[.sessions.rows[] | select(.section == $sec) | .id]'; }
# check <selected id or ""> <name ids json> <buffer ids json> <buffer subs json>
check() {
  local s="$1" sel="$2"
  jq '.sessions' <<<"$s"
  jq -e --argjson n "$3" '[.sessions.rows[] | select(.section == "name") | .id] == $n' <<<"$s"
  jq -e --argjson b "$4" '[.sessions.rows[] | select(.section == "buffer") | .id] == $b' <<<"$s"
  jq -e --argjson u "$5" '[.sessions.rows[] | select(.section == "buffer") | .sub] == $u' <<<"$s"
  if [ -z "$sel" ]; then
    jq -e '[.sessions.rows[] | select(.selected)] == []' <<<"$s"
    return 0
  fi
  jq -e --arg x "$sel" '.selectedId == $x' <<<"$s"
  # In each section it is in, the selected row comes first, in its own colour; no other row is selected.
  jq -e --arg x "$sel" '
    [.sessions.rows[] | select(.selected) | .id] | unique == [$x]' <<<"$s"
  for sec in name buffer; do
    jq -e --arg x "$sel" --arg sec "$sec" '
      [.sessions.rows[] | select(.section == $sec)] as $r
      | ($r | map(.id) | index($x)) as $i
      | $i == null or ($i == 0 and $r[0].selected and all($r[1:][]; .rowBg != $r[0].rowBg and (.selected | not)))' <<<"$s"
  done
}
select_session "$qa"
type_box QELV
wait_search
both_themes() {
  check "$(sstate)" "$@"
  cmd '{"command":"click","selector":"#themeToggle"}' >/dev/null
  sleep 1
  check "$(sstate)" "$@"
}
both_themes "$qa" "[\"$qa\",\"$qb\"]" "[\"$qa\",\"$s9\",\"$s5\",\"$qb\",\"$s1\"]" \
  '["2 matches","9 matches","5 matches","3 matches","1 match"]'
# A real click on r11-five's buffer row selects it; it moves to the top, the box keeps its text.
r="$(cmd "{\"command\":\"style-of\",\"selector\":\".session-row[data-session-id=\\\"$s5\\\"]\"}")"
jq -c '.rect' <<<"$r"
click_at "$(jq '(.rect.left + 40) | floor' <<<"$r")" "$(jq '(.rect.top + .rect.height / 2) | floor' <<<"$r")"
wait_until 15 _bs_shows "$s5"
# The pointer off the list, so no row is drawn hovered.
mouse_to 700 300
wait_search
jq -e '.box.value == "QELV"' <<<"$(sstate)"
both_themes "$s5" "[\"$qb\",\"$qa\"]" "[\"$s5\",\"$s9\",\"$qb\",\"$qa\",\"$s1\"]" \
  '["5 matches","9 matches","3 matches","2 matches","1 match"]'
# A selected session that matches nothing: every row in its R6 order. (The debug server's
# switch picks from the list as shown, which the name filter narrows: switch with the box empty.)
clear_box
select_session "$s0"
type_box QELV
wait_search
check "$(sstate)" "" "[\"$qb\",\"$qa\"]" "[\"$s9\",\"$s5\",\"$qb\",\"$qa\",\"$s1\"]" \
  '["9 matches","5 matches","3 matches","2 matches","1 match"]'
