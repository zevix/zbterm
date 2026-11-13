#!/usr/bin/env bash
# R13 reorder_guard — proves R13: whenever the left pane's session rows change position, clicks on them are blocked with a no-entry cursor until the list has been still for 500 ms.
# Asserts: three sessions r13-a/b/c, r13-a selected; a background loop pins and unpins the plain list's last session every 250 ms (each a reorder) for about 3 s; during it: .sessions.guard.on == true, the list's cursor is not-allowed, every row's pointer-events is none, and a real click on another row's centre selects nothing (.selectedId unchanged) and is counted as blocked (.guard.blockedClicks grows); after the last change the guard turns off on its own, releasedAt - lastChangeAt between 500 and 800 ms, the cursor is back (not not-allowed) and rows take pointer events; then a real click on that row selects it; a search that promotes a row (a buffer match moving it out of 'Other - unmatched sessions') also turns the guard on.
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
sa="$(seed_session r13-a 'echo R13""A' R13A)"
sb="$(seed_session r13-b 'echo R13""B' R13B)"
sc="$(seed_session r13-c 'echo R13""C' R13C)"
select_session "$sa"
wait_until 5 guard_off
plain="$(sstate | jq -c '[.sessions.rows[] | .id]')"
echo "plain: $plain"
last="$(jq -r '.[-1]' <<<"$plain")"
# The row to click: not selected, not the one moving.
target="$(jq -r --arg a "$sa" --arg l "$last" '[.[] | select(. != $a and . != $l)][0]' <<<"$plain")"
b0="$(sstate | jq '.sessions.guard.blockedClicks')"
# Pin and unpin the last session every 250 ms: each toggle moves it to the top or back.
toggler() {
  local i
  for i in $(seq 12); do
    cmd "$(jq -nc --arg s "$last" '{command: "click", selector: (".session-row[data-session-id=\"" + $s + "\"] .session-action[data-action=\"pin\"]")}')" >/dev/null
    sleep 0.25
  done
}
toggler &
tp=$!
sleep 1
s="$(sstate)"
jq '.sessions.guard' <<<"$s"
jq -e '.sessions.guard.on == true and .sessions.guard.cursor == "not-allowed" and all(.sessions.guard.rowPointerEvents[]; . == "none")' <<<"$s"
r="$(sty ".session-row[data-session-id=\"$target\"]" | jq -c .rect)"
click_rect "$r"
s="$(sstate)"
jq '{selectedId, guard: .sessions.guard}' <<<"$s"
jq -e --arg a "$sa" '.selectedId == $a' <<<"$s"
jq -e --argjson b "$b0" '.sessions.guard.blockedClicks > $b' <<<"$s"
wait "$tp"
# Released on its own, 500 ms after the last change.
wait_until 5 guard_off
s="$(sstate)"
jq '.sessions.guard' <<<"$s"
jq -e '(.sessions.guard.releasedAt - .sessions.guard.lastChangeAt) as $d | $d >= 500 and $d <= 800' <<<"$s"
jq -e '.sessions.guard.cursor != "not-allowed" and all(.sessions.guard.rowPointerEvents[]; . != "none")' <<<"$s"
# Now a real click selects.
sleep 0.3
r="$(sty ".session-row[data-session-id=\"$target\"]" | jq -c .rect)"
click_rect "$r"
shows_target() { sstate | jq -e --arg t "$target" '.selectedId == $t' >/dev/null; }
wait_until 10 shows_target
# A search promotes a late buffer match out of "Other": the guard turns on.
wait_until 5 guard_off
c0="$(sstate | jq '.sessions.guard.changes')"
type_box R13Q
wait_search
wait_until 5 guard_off
c1="$(sstate | jq '.sessions.guard.changes')"
sinput "$sc" 'p=R13; echo "${p}Q late"'
sl="$(seed_session r13-late 'p=R13; echo "${p}Q late2"' 'R13Q late2' false)"
in_buffer() { sstate | jq -e --arg l "$sl" 'any(.sessions.rows[]; .id == $l and .section == "buffer")' >/dev/null; }
wait_until 30 in_buffer
c2="$(sstate | jq '.sessions.guard.changes')"
echo "guard changes: before search $c0, after the search $c1, after the late match $c2"
[ "$c1" -gt "$c0" ]
[ "$c2" -gt "$c1" ]
