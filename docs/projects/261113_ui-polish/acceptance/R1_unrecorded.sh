#!/usr/bin/env bash
# R1 unrecorded — proves R1: an unrecorded session shows its duration alone at the bottom right (the right end of the playback bar), with no timeline controls; it ticks while the session runs and is frozen at endedAt - startedAt once it has ended.
# Asserts: an unrecorded session made through the New dialog (entry .record == false): #stepBack, #playPause, #stepForward, #collapseGaps, .scrubber-wrap, #timeLabel and #speed are not drawn (no client rects); #sessionDuration is drawn, its text a duration (^[0-9]+:[0-9]{2}$), its right edge within 4 px of #playback's right edge and right of the status text, and both in the right half of the bottom bar; the text changes within 3 s while live; after 'exit' it stays the same over 3 s and equals the duration formatter's text for the entry's endedAt - startedAt (±1 s); a recorded session selected afterwards shows the scrubber and the time label, and no #sessionDuration.
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
open_dialog '{"command":"click","selector":"#newSession"}' >/dev/null
set_field name '"r1 unrecorded"' | jq -e '.set'
set_field 'Record session' false | jq -e '.set'
cmd '{"command":"dialog-submit"}' >/dev/null
wait_until 30 has_session 'r1 unrecorded'
sid="$(sid_of 'r1 unrecorded')"
jq -e '.record == false' <<<"$(entry_of "$sid")"
sleep 2
for sel in '#stepBack' '#playPause' '#stepForward' '#collapseGaps' '.scrubber-wrap' '#timeLabel' '#speed'; do
  sty "$sel" | jq -c '{selector, visible}'
  sty "$sel" | jq -e '.visible == false'
done
d="$(sty '#sessionDuration')"; p="$(sty '#playback')"; b="$(sty '.bottom')"; st="$(sty '#status')"
jq -c '{text, visible, rect}' <<<"$d"; jq -c '.rect' <<<"$p"; jq -c '.rect' <<<"$b"; jq -c '{text, rect}' <<<"$st"
jq -e '.visible == true and (.text | test("^[0-9]+:[0-9]{2}$"))' <<<"$d"
jq -e -n --argjson d "$d" --argjson p "$p" '($p.rect.right - $d.rect.right) | fabs <= 4'
jq -e -n --argjson d "$d" --argjson s "$st" '$d.rect.left >= $s.rect.left'
jq -e -n --argjson d "$d" --argjson b "$b" '$d.rect.left > ($b.rect.left + $b.rect.width / 2) and ($b.rect.right - $d.rect.right) <= 24'
# It ticks while the session runs.
t0="$(jq -r .text <<<"$d")"
ticked() { [ "$(sty '#sessionDuration' | jq -r .text)" != "$t0" ]; }
wait_until 3 ticked
# Ended: frozen at endedAt - startedAt.
sinput "$sid" exit
ended() { api GET "/sessions/$sid" | jq -e '.entry.active == false'; }
wait_until 20 ended
sleep 1.5
e="$(entry_of "$sid")"
jq -c '{startedAt, endedAt, active}' <<<"$e"
t1="$(sty '#sessionDuration' | jq -r .text)"
sleep 3
t2="$(sty '#sessionDuration' | jq -r .text)"
echo "ended: $t1 then $t2"
[ "$t1" = "$t2" ]
sty '#sessionDuration' | jq -e '.visible == true'
sty '.scrubber-wrap' | jq -e '.visible == false'
ms="$(jq '.endedAt - .startedAt' <<<"$e")"
ok=""
for delta in 0 -1000 1000; do
  want="$(cmd "{\"command\":\"duration-format\",\"ms\":$((ms + delta))}" | jq -r .text)"
  [ "$want" = "$t2" ] && ok=1
done
[ -n "$ok" ]
# A recorded session keeps the timeline.
rid="$(seed_session r1-recorded 'echo R1""REC' R1REC)"
select_session "$rid"
sleep 1
sty '.scrubber-wrap' | jq -e '.visible == true'
sty '#timeLabel' | jq -e '.visible == true'
sty '#sessionDuration' | jq -e '.visible == false'
