#!/usr/bin/env bash
# R3 unmatched — proves R3: while searching, the sessions that match neither by name nor by buffer are listed last, dimmed, under a small 'Other - unmatched sessions' heading; a late buffer match moves its row up.
# Asserts: sessions u3-beta and u3-gamma (no AQZ), u3-alpha (AQZ in its buffer), aqz-named (name matches, buffer not); u3-gamma selected; typing AQZ gives headings == [Current session, Session name matches, Session buffer matches, Other - unmatched sessions] in DOM order, the Other heading last with rows only after it; current == [gamma], name == [aqz-named], buffer == [alpha], other == [beta]; every other-row's opacity is 0.5 (at most 0.6), every other row's 1; the Other heading has the other headings' font size; the other rows are in the plain list's order (read before the search, the shown sessions left out); a session started during the search that prints AQZ (u3-late) ends up in the buffer rows and not in the other rows; with beta ended, 'All' lists it under Other and 'Active only' drops it; the box emptied: no Other heading and no dimmed row.
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
sb="$(seed_session u3-beta 'echo U3B""READY' U3BREADY)"
sg="$(seed_session u3-gamma 'echo U3G""READY' U3GREADY)"
sa="$(seed_session u3-alpha 'p=AQ; echo "${p}Z here"' 'AQZ here')"
sn="$(seed_session aqz-named 'echo U3N""READY' U3NREADY)"
select_session "$sg"
sleep 1
plain="$(sstate | jq -c '[.sessions.rows[] | .id]')"
echo "plain list: $plain"
type_box AQZ
wait_search
sleep 1
s="$(sstate)"
jq '.sessions | {headings, headingStyles, rows: [.rows[] | {id, name, section, opacity}]}' <<<"$s"
jq -e '[.sessions.headings[].text] == ["Current session", "Session name matches", "Session buffer matches", "Other - unmatched sessions"]' <<<"$s"
jq -e '[.sessions.headings[].index] | . == sort' <<<"$s"
jq -e '(.sessions.headings[-1].index) as $h | all(.sessions.rows[] | select(.section == "other"); .index > $h)
  and ([.sessions.rows[] | select(.section == "other") | .index] | min) > ([.sessions.rows[] | select(.section != "other") | .index] | max)' <<<"$s"
sec() { jq -c --arg s "$1" '[.sessions.rows[] | select(.section == $s) | .id]' <<<"$2"; }
[ "$(sec current "$s")" = "[\"$sg\"]" ]
[ "$(sec name "$s")" = "[\"$sn\"]" ]
[ "$(sec buffer "$s")" = "[\"$sa\"]" ]
[ "$(sec other "$s")" = "[\"$sb\"]" ]
# Dimmed: only the other rows (the pointer off the list, so none is hovered).
mouse_to 700 300
s="$(sstate)"
jq -e 'all(.sessions.rows[] | select(.section == "other"); .opacity >= 0.4 and .opacity <= 0.6)' <<<"$s"
jq -e 'all(.sessions.rows[] | select(.section != "other"); .opacity == 1)' <<<"$s"
# Small, like the other headings.
jq -e '[.sessions.headingStyles[].fontSize] | unique | length == 1' <<<"$s"
# The plain list's order.
jq -e --argjson p "$plain" '[.sessions.rows[] | select(.section != "other") | .id] as $shown
  | [$p[] | select(. as $id | $shown | index($id) | not)] == [.sessions.rows[] | select(.section == "other") | .id]' <<<"$s"
# A session started during the search with AQZ in its buffer: a buffer row, not an other row.
sl="$(seed_session u3-late 'p=AQ; echo "${p}Z late"' 'AQZ late' false)"
late_in_buffer() { sstate | jq -e --arg l "$sl" 'any(.sessions.rows[]; .id == $l and .section == "buffer") and (any(.sessions.rows[]; .id == $l and .section == "other") | not)' >/dev/null; }
wait_until 30 late_in_buffer
sstate | jq -c '[.sessions.rows[] | {name, section}]'
# All lists an ended session under Other; Active only drops it.
sinput "$sb" exit
is_ended() { api GET /sessions | jq -e --arg s "$sb" 'any(.[]; .sessionId == $s and (.active | not))' >/dev/null; }
wait_until 30 is_ended
in_other() { sstate | jq -e --arg b "$sb" 'any(.sessions.rows[]; .id == $b and .section == "other")' >/dev/null; }
wait_until 10 in_other
wait_until 10 guard_off || true
click_sel '#activeOnly'
not_in_other() { ! in_other; }
wait_until 10 not_in_other
click_sel '#activeOnly'
# The box emptied: the plain list, nothing dimmed.
clear_box
sleep 1
s="$(sstate)"
jq -e '.sessions.headings == [] and all(.sessions.rows[]; .section != "other" and .opacity == 1)' <<<"$s"
