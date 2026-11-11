#!/usr/bin/env bash
# R8 joined_session — proves R8: a joined live session is searched too, through the copy this app holds.
# Asserts: app A hosts a session printing JOINMARK; app B joins it (POST /join + approve on A); in B, typing JOINMARK in the box lists the joined session under 'Session buffer matches' with '1 match' or more; in B, with the joined session selected, the same box shows .inSession.total >= 1.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_bs.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
need "$UB_REPO/test/debug-server-e2e.js" "the join flow the second app copies"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
cannot() { echo "cannot run here: $*" >&2; exit 75; }
start_app
sid="$(seed_session r8-host 'p=JOIN; echo "${p}MARK"' JOINMARK)"
start_second_app
share="$(api POST "/sessions/$sid/share" '{"type":"group","maxViewers":1,"autoJoin":false}')"
uri="$(jq -r '.uri // empty' <<<"$share")"
[ -n "$uri" ] || cannot "no share link: $share"
on_b api POST /join "$(jq -nc --arg u "$uri" '{uri: $u}')" >/dev/null || true
# A approves B's join (the share-approval popup).
approval() { api GET /popups | jq -e --arg s "$sid" 'any(.[]; .type == "share-approval" and .data.sessionId == $s)' >/dev/null; }
wait_until 90 approval || cannot "join failed: no approval request reached the host in 90 s: $(api GET /popups)"
pid="$(api GET /popups | jq -r --arg s "$sid" '[.[] | select(.type == "share-approval" and .data.sessionId == $s)][0].id')"
api POST "/popups/$(jq -rn --arg p "$pid" '$p | @uri')/actions/approve" >/dev/null
b_live() { on_b api GET /sessions | jq -e --arg s "$sid" 'any(.[]; .sessionId == $s and .active and (.pending | not))' >/dev/null; }
wait_until 90 b_live || cannot "join failed: B never listed the session live: $(on_b api GET /sessions)"
wait_until 60 on_b mirror_has "$sid" JOINMARK || cannot "join failed: JOINMARK never reached B's copy"
# In B: the box lists the joined session under "Session buffer matches".
on_b win_size 1280 800
on_b type_box JOINMARK
on_b wait_search
s="$(on_b sstate)"
jq '{inSession, sessions, selectedId}' <<<"$s"
jq -e '.sessions.heading == "Session buffer matches"' <<<"$s"
jq -e --arg s "$sid" 'any(.sessions.rows[]; .section == "buffer" and .id == $s and (.sub | test("^[0-9]+ match(es)?$")))' <<<"$s"
# With the joined session selected in B, the same box finds it in-session.
on_b select_session "$sid"
sleep 1
jq -e '.inSession.total >= 1' <<<"$(on_b sstate)"
