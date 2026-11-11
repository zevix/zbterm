#!/usr/bin/env bash
# R4 playback — proves R4: in playback the box searches the frame on screen, and searches again when the frame changes.
# Asserts: for an ended recorded session opened in playback: a word on screen at the end of the recording gives total >= 1 and .inSession.mode == "playback"; after a seek to the start (where the word was not yet printed) total == 0 without retyping; after seeking back, total >= 1 again.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_bs.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
total_ge() { sstate | jq -e --argjson n "$1" '.inSession.total >= $n' >/dev/null; }
total_is() { sstate | jq -e --argjson n "$1" '.inSession.total == $n' >/dev/null; }
is_ended() { api GET /sessions | jq -e --arg s "$1" 'any(.[]; .sessionId == $s and (.active | not))' >/dev/null; }
# A recorded session: EARLYMARK, a pause, LATEMARK, then it ends.
sid="$(seed_session r4-play 'echo EARLY""MARK' EARLYMARK)"
sleep 2
sinput "$sid" 'echo LATE""MARK'
wait_until 20 mirror_has "$sid" LATEMARK
sleep 2
sinput "$sid" exit
wait_until 30 is_ended "$sid"
api POST "/sessions/$sid/playback/open" >/dev/null
sleep 1
p="$(cmd '{"command":"playback-state"}')"
jq '{mode, startTs, endTs}' <<<"$p"
start_ts="$(jq '.startTs' <<<"$p")"
end_ts="$(jq '.endTs' <<<"$p")"
api POST "/sessions/$sid/playback/seek" "{\"tsMs\":$end_ts}" >/dev/null
wait_until 10 term_has LATEMARK
type_box LATEMARK
wait_until 10 total_ge 1 || true
s="$(sstate)"
jq '{box, inSession}' <<<"$s"
jq -e '.inSession.mode == "playback"' <<<"$s"
jq -e '.inSession.total >= 1' <<<"$s"
# A seek to the start (LATEMARK not printed yet): the search follows without retyping.
api POST "/sessions/$sid/playback/seek" "{\"tsMs\":$start_ts}" >/dev/null
wait_until 10 total_is 0 || true
s="$(sstate)"
jq '.inSession' <<<"$s"
jq -e '.inSession.total == 0 and .box.value == "LATEMARK"' <<<"$s"
api POST "/sessions/$sid/playback/seek" "{\"tsMs\":$end_ts}" >/dev/null
wait_until 10 total_ge 1 || true
jq -e '.inSession.total >= 1' <<<"$(sstate)"
