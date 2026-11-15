#!/usr/bin/env bash
# R11 history ends — proves R11, R12 and U4: |<< and >>| sit around |< > >| before collapse; |<< goes to the first frame, >>| goes live (running) or to the last frame (ended), and flashes with Live.
# Asserts: the toolbar order jumpStart, stepBack, playPause, stepForward, jumpEnd, collapseGaps (left edges); live: End disabled, Start enabled, both carry Live's live-* classes; Start → playback at timeline[0]; there End and Live both live-beacon, their running animations with startTime 0; End → live; ended session: Start → first frame, End → last frame; an unrecorded session shows neither button.
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
a="$(seed_session r11-a 'for i in 1 2 3 4 5 6; do echo F$i; sleep 0.4; done; echo A""READY' AREADY)"
select_session "$a"
sleep 2
left() { sty "#$1" | jq '.rect.left'; }
prev=-1
for id in jumpStart stepBack playPause stepForward jumpEnd collapseGaps; do
  l="$(left "$id")"; echo "$id $l"; [ "$(jq -n --argjson a "$prev" --argjson b "$l" '$b > $a')" = true ]; prev="$l"
done
sty '#jumpStart .btn-icon, #jumpStart i' | jq -e '.className | test("fa-backward-fast")'
sty '#jumpEnd i' | jq -e '.className | test("fa-forward-fast")'
cls() { sty "#$1" | jq -c '[.className | split(" ")[] | select(startswith("live-"))] | sort'; }
pb() { cmd '{"command":"playback-state"}'; }
pb | jq -e '.mode == "live"'
sty '#jumpEnd' | jq -e '.disabled == true'
sty '#jumpStart' | jq -e '.disabled == false'
[ "$(cls goLive)" = "$(cls jumpEnd)" ]
click_sel '#jumpStart'
sleep 1.5
p="$(pb)"; jq -c '{mode, seq, first: .timeline[0][0], lastSeq}' <<<"$p"
jq -e '.mode == "playback" and .seq == .timeline[0][0]' <<<"$p"
cls goLive; cls jumpEnd
[ "$(cls goLive)" = "$(cls jumpEnd)" ]
cls jumpEnd | jq -e 'index("live-beacon") != null'
sty '#jumpEnd' | jq -e '.disabled == false'
for id in goLive jumpEnd; do
  sty "#$id" | tee -a /dev/stderr | jq -e '[.animationClocks[] | select(.currentTime != null)] | length > 0 and all(.startTime == 0)'
done
click_sel '#jumpEnd'
sleep 1.5
pb | jq -e '.mode == "live"'
sty '#jumpEnd' | jq -e '.disabled == true'
# An ended session: End is its last frame.
# The session runs a script that exits (an `exit` typed into a shell can leave an
# outer shell running).
printf '%s\n' 'for i in 1 2 3 4; do echo G$i; sleep 0.4; done' >"$ZBUI_APP_HOME/r11-b.sh"
b="$(api POST /sessions "$(jq -nc --arg h "$ZBUI_APP_HOME" \
  '{name: "r11-b", cols: 80, rows: 24, cwd: $h, command: ("sh " + $h + "/r11-b.sh")}')" | jq -r .sessionId)"
test -n "$b"
b_ended() { api GET "/sessions/$b" | jq -e '.entry.active == false or .opened.active == false' >/dev/null; }
wait_until 30 b_ended
select_session "$a"; sleep 1
select_session "$b"; sleep 3
pb | jq -c '{mode, active, seq, lastSeq}'
click_sel '#jumpStart'; sleep 1.5
pb | jq -e '.mode == "playback" and .active == false and .seq == .timeline[0][0]'
click_sel '#jumpEnd'; sleep 1.5
pb | jq -e '.mode == "playback" and .seq == .lastSeq'
# Unrecorded: neither button is drawn.
open_dialog '{"command":"click","selector":"#newSession"}' >/dev/null
set_field name '"r11 unrecorded"' >/dev/null
set_field 'Record session' false | jq -e '.set == true' >/dev/null
cmd '{"command":"dialog-submit"}' >/dev/null
wait_until 30 has_session 'r11 unrecorded'
u="$(sid_of 'r11 unrecorded')"
select_session "$u"; sleep 1
sty '#jumpStart' | jq -e '.visible == false'
sty '#jumpEnd' | jq -e '.visible == false'
