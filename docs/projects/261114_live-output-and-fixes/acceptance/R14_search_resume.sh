#!/usr/bin/env bash
# R14 search resume — proves R14 and R15: in the search box Ctrl+PgDn/PgUp walk the session list exactly as Down/Up do; an ended session reached that way is shown, not resumed, with the "Press ^R to resume the session" toast; Ctrl+R in the box resumes it, the focus staying in the box.
# Asserts: query "r14" with c selected; Ctrl+PgDn steps the cursor row by row (index, selectedId, rows unchanged, box focused, caret [3,3]) exactly as Down does in R10; on the ended session b: mode playback, not active, toast key "resume-hint" shown; on the next session: no "resume-hint" toast; Ctrl+PgUp back to b brings the toast again; Ctrl+R in the box: b becomes active and live, the box keeps the focus and caret [3,3], b stays selected and the cursor stays on b's row (the earlier rows kept in order; b's resumed output may append a buffer-match row), no "resume-hint" toast.
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
need xdotool "real key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
a="$(seed_session r14-a 'echo A""READY' AREADY)"
# b runs a script that exits: an own, ended, resumable session. (A new session is
# selected when created, which resumes it; it exits again.) Before Ctrl+R the script
# is replaced by one that stays up, since a resume runs the same command again.
printf '%s\n' 'echo r14-b-ran' >"$ZBUI_APP_HOME/r14-b.sh"
b="$(api POST /sessions "$(jq -nc --arg h "$ZBUI_APP_HOME" \
  '{name: "r14-b", cols: 80, rows: 24, cwd: $h, command: ("sh " + $h + "/r14-b.sh")}')" | jq -r .sessionId)"
test -n "$b"
b_ended() { api GET "/sessions/$b" | jq -e '.entry.active == false or .opened.active == false' >/dev/null; }
wait_until 30 b_ended
c="$(seed_session r14-c 'echo C""READY' CREADY)"
select_session "$c"
sleep 2
wait_until 30 b_ended
type_box r14
wait_search
sleep 1
sm() { cmd '{"command":"search-mode"}'; }
s="$(sm)"; jq -c '{rows, cursorRow, selectedId, caret}' <<<"$s"
rows0="$(jq -c '.rows' <<<"$s")"
n="$(jq '.rows | length' <<<"$s")"
bi="$(jq --arg b "$b" '[.rows[].id] | index($b)' <<<"$s")"
[ "$bi" != null ] && [ "$bi" -gt 0 ] && [ "$bi" -lt $((n - 1)) ]   # b has a row after it
jq -e '.cursorRow.index == 0 and .focused == true and .caret == [3, 3]' <<<"$s"
on_row() { # expected index [rows check: "same" (default) | "prefix"] → the Down/Up contract of R10
  local s2 want_id; s2="$(sm)"; jq -c '{cursorRow, selectedId, caret, focused, toasts, rows}' <<<"$s2"
  want_id="$(jq -r --argjson i "$1" '.[$i].id' <<<"$rows0")"
  jq -e --argjson i "$1" --arg id "$want_id" --argjson r "$rows0" --arg how "${2:-same}" \
    '.cursorRow.index == $i and .selectedId == $id and .focused == true and .caret == [3, 3] and .value == "r14"
     and (if $how == "prefix" then .rows[0:($r | length)] == $r else .rows == $r end)' <<<"$s2"
}
pb() { cmd '{"command":"playback-state"}'; }
on_b() {
  pb | tee -a /dev/stderr | jq -e --arg b "$b" '.mode == "playback" and .active == false' >/dev/null
  api GET "/sessions/$b" | jq -e '.entry.active == false' >/dev/null
  sm | jq -e '.toasts | index("resume-hint") != null' >/dev/null
}
for i in $(seq 1 "$bi"); do key ctrl+Next; sleep 1.5; on_row "$i"; done
on_b
key ctrl+Next; sleep 1.5; on_row $((bi + 1))
sm | jq -e '.toasts | index("resume-hint") == null'
api GET "/sessions/$b" | jq -e '.entry.active == false'
key ctrl+Prior; sleep 1.5; on_row "$bi"
on_b
# Ctrl+R in the box resumes b; the focus and the cursor stay.
printf '%s\n' 'echo r14-b-resumed; exec sleep 600' >"$ZBUI_APP_HOME/r14-b.sh"
key ctrl+r
b_live() { api GET "/sessions/$b" | jq -e '.entry.active == true' >/dev/null && pb | jq -e '.mode == "live"' >/dev/null; }
wait_until 30 b_live
sleep 1
# Live again, b's new output ("r14-b-resumed") legitimately adds a "Session buffer
# matches" row for b at the end of the list: the earlier rows must be kept, not the count.
on_row "$bi" prefix
sm | jq -e '.toasts | index("resume-hint") == null'
