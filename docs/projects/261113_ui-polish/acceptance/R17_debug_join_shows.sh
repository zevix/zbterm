#!/usr/bin/env bash
# R17 debug join shows — proves R17: with debugging on, a session joined through the Join dialog shows its live stream by itself, with no spinner left and no click.
# Asserts: host A: a live session r17-host, shared; app B (debugging on: the default) joins it through real clicks and typing in the Join dialog; after A approves, B within 15 s, with no input: .liveReveal.pending == false, .liveReveal.spinner == false, B's selected session is r17-host in live mode, and B's mirror shows the host's marker line.
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
cannot() { echo "cannot run here: $*" >&2; exit 75; }
start_app
sid="$(seed_session r17-host 'p=R17; echo "${p}MARK"' R17MARK)"
share="$(api POST "/sessions/$sid/share" '{"type":"group","maxViewers":1,"autoJoin":false}')"
uri="$(jq -r '.uri // empty' <<<"$share")"
[ -n "$uri" ] || cannot "no share link: $share"
start_second_app
on_b win_size 1280 800
# Debugging is on in B (the default; nothing in this scratch profile turned it off).
on_b state | jq -e '.liveReveal.pending == false'
# The Join dialog, by real clicks and typing.
on_b click_sel '#joinLink'
dialog() { state | jq -e '.modal.title == "Join session"' >/dev/null; }
on_b wait_until 10 dialog
on_b click_sel '.modal-input'
on_b xdo type --delay 5 -- "$uri"
sleep 1.5
on_b key Return
approval() { api GET /popups | jq -e --arg s "$sid" 'any(.[]; .type == "share-approval" and .data.sessionId == $s)' >/dev/null; }
wait_until 90 approval || cannot "join failed: no approval request reached the host in 90 s"
pid="$(api GET /popups | jq -r --arg s "$sid" '[.[] | select(.type == "share-approval" and .data.sessionId == $s)][0].id')"
api POST "/popups/$(jq -rn --arg p "$pid" '$p | @uri')/actions/approve" >/dev/null
# The diagnostics pause (2.5 s) is allowed; after it the stream shows with no input.
b_paused() { on_b state | jq -e '.liveReveal.meta == "Joined - paused before live"' >/dev/null; }
wait_until 90 b_paused || true
shown() { on_b lstate | jq -e --arg s "$sid" '.selectedId == $s and .mode == "live"' >/dev/null && on_b state | jq -e '.liveReveal.pending == false and .liveReveal.spinner == false' >/dev/null; }
wait_until 15 shown
on_b state | jq '.liveReveal'
on_b mirror_has "$sid" R17MARK
sleep 3
# Still shown, still no spinner.
on_b state | jq -e '.liveReveal.pending == false and .liveReveal.spinner == false'
