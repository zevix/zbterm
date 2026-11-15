#!/usr/bin/env bash
# R10 search arrows — proves R10 and U3: in search mode Up/Down move the selected session through the list as drawn, the row under the cursor with a 2px logo-green border, the focus and caret staying in the box.
# Asserts: query "r10" with c selected lists current c, name a and b, buffer a (a in two sections); the cursor starts on the top row (2px border in --logo-green); Down/Down/Down walk name a, name b, buffer a (selectedId follows, the section order and rows unchanged, caret [3,3], box focused); Down at the end and Up at the top stay; Ctrl+Down is ignored; the walk is undone by Esc (no cursor).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/activate"
source "$ZBUI_LIB"
source "$ZBUI_LIB_UP"
source "$here/lib_lo.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
a="$(seed_session r10-a 'echo r""10 inbuffer' 'r10 inbuffer')"
b="$(seed_session r10-b 'echo B""READY' BREADY)"
c="$(seed_session r10-c 'echo C""READY' CREADY)"
select_session "$c"
type_box r10
wait_search
sleep 1
sm() { cmd '{"command":"search-mode"}'; }
s="$(sm)"; jq -c '{rows, cursorRow, selectedId, caret}' <<<"$s"
rows0="$(jq -c '.rows' <<<"$s")"
jq -e --arg a "$a" --arg b "$b" --arg c "$c" '.rows | map("\(.section):\(.id)") as $r
  | ($r | index("current:" + $c)) == 0 and ($r | index("name:" + $a)) != null
  and ($r | index("name:" + $b)) != null and ($r | index("buffer:" + $a)) != null' <<<"$s"
jq -e '.cursorRow.index == 0 and .focused == true and .caret == [3, 3]' <<<"$s"
border_ok() {
  local i="$1" st s2
  s2="$(sm)"
  st="$(sty ".session-row.search-cursor")"; jq -c '{borderWidth, borderColor, rect: .rect.height}' <<<"$st"
  jq -e -n --argjson st "$st" --argjson s "$s2" --argjson i "$i" \
    '$st.borderWidth == "2px" and $st.borderColor == $s.logoGreen and $s.cursorRow.index == $i'
}
border_ok 0
n="$(jq '.rows | length' <<<"$s")"
step_to() { # key, expected index
  key "$1"; sleep 1.2
  local s2 want_id; s2="$(sm)"; jq -c '{cursorRow, selectedId, caret, focused, activeElement}' <<<"$s2"
  want_id="$(jq -r --argjson i "$2" '.[$i].id' <<<"$rows0")"
  jq -e --argjson i "$2" --arg id "$want_id" --argjson r "$rows0" \
    '.cursorRow.index == $i and .selectedId == $id and .focused == true and .caret == [3, 3] and .value == "r10" and .rows == $r' <<<"$s2"
  border_ok "$2"
}
for i in $(seq 1 $((n - 1))); do step_to Down "$i"; done
step_to Down $((n - 1))
key ctrl+Down; sleep 0.8
sm | jq -e --argjson i $((n - 1)) '.cursorRow.index == $i'
for i in $(seq $((n - 2)) -1 0); do step_to Up "$i"; done
step_to Up 0
key Escape
sm | jq -e '.on == false and .cursor == null and .anchorId == null'
