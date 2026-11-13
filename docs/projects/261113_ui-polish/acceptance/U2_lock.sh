#!/usr/bin/env bash
# U2 lock — proves U2: a joined, played-back or ended session never offers the size lock, and the viewer never resizes the host.
# Asserts: host A: a live session u2-host with the lock button shown; scrolled back (a real Step back: playback of the live session) the button is hidden, and back live it shows; a second app B joins A's share (approved on A): in B the joined session shows no lock button, and B's window resized (1280x800 -> 900x600) leaves A's session grid (GET /sessions/:id .opened.frame cols/rows, 80 x 25 from the lock) unchanged; on A, u2-host ended ('exit'): no lock button; the lock A set before the end (25 x 80) no longer applies (size-lock-state .active == false).
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
need "$UB_REPO/test/debug-server-e2e.js" "the join flow the second app copies"
cannot() { echo "cannot run here: $*" >&2; exit 75; }
sid="$(seed_session u2-host 'p=U2; echo "${p}MARK"' U2MARK)"
select_session "$sid"
sleep 1
lstate | jq -e '.button.hidden == false'
# Scrolled back: no lock.
for i in 1 2 3; do sinput "$sid" "echo u2-line-$i"; sleep 0.7; done
click_sel '#stepBack'
playback() { lstate | jq -e '.mode == "playback"' >/dev/null; }
wait_until 15 playback
lstate | jq -e '.button.hidden == true'
api POST "/sessions/$sid/switch" >/dev/null
click_sel '#goLive' || true
live() { lstate | jq -e '.mode == "live" and .button.hidden == false' >/dev/null; }
wait_until 15 live
# A lock before the end.
click_rect "$(lstate | jq -c '.button.rect')"
click_rect "$(lstate | jq -c '[.menu[] | select(.label == "25 x 80")][0].rect')"
sleep 1
lstate | jq -e '.term.rows == 25 and .term.cols == 80'
# The host session's grid as the engine holds it (its mirror's frame).
grid() { api GET "/sessions/$sid" | jq -c '.opened.frame | {cols, rows}'; }
jq -e '.cols == 80 and .rows == 25' <<<"$(grid)"
# Joined in B: no lock, and B's window never resizes A's session.
start_second_app
share="$(api POST "/sessions/$sid/share" '{"type":"group","maxViewers":1,"autoJoin":false}')"
uri="$(jq -r '.uri // empty' <<<"$share")"
[ -n "$uri" ] || cannot "no share link: $share"
on_b api POST /join "$(jq -nc --arg u "$uri" '{uri: $u}')" >/dev/null || true
approval() { api GET /popups | jq -e --arg s "$sid" 'any(.[]; .type == "share-approval" and .data.sessionId == $s)' >/dev/null; }
wait_until 90 approval || cannot "join failed: no approval request reached the host in 90 s"
pid="$(api GET /popups | jq -r --arg s "$sid" '[.[] | select(.type == "share-approval" and .data.sessionId == $s)][0].id')"
api POST "/popups/$(jq -rn --arg p "$pid" '$p | @uri')/actions/approve" >/dev/null
b_live() { on_b api GET /sessions | jq -e --arg s "$sid" 'any(.[]; .sessionId == $s and .active and (.pending | not))' >/dev/null; }
wait_until 90 b_live || cannot "join failed: B never listed the session live"
on_b select_session "$sid"
sleep 2
g0="$(grid)"
on_b lstate | jq '{button, selectedId, mode}'
on_b lstate | jq -e --arg s "$sid" '.selectedId == $s and .button.hidden == true'
on_b win_size 1280 800
on_b win_size 900 600
sleep 2
g1="$(grid)"
echo "host grid: $g0 -> $g1"
[ "$g0" = "$g1" ] && [ "$g0" = '{"cols":80,"rows":25}' ]
stop_second_app
# Ended: no lock, nothing resized.
sinput "$sid" exit
ended() { api GET "/sessions/$sid" | jq -e '.entry.active == false' >/dev/null; }
wait_until 20 ended
sleep 1.5
lstate | jq -e '.button.hidden == true'
# The lock no longer applies (it is only for an own live session shown live).
lstate | jq -e '.active == false'
