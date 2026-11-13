#!/usr/bin/env bash
# R2 bubble_clock — proves R2: a live seek and a hover in a session recorded now show 'HH:MM:SS' beside the elapsed time; the renderer's formatter (debug command bubble-format with tsMs and nowMs) gives 'Ddd HH:MM:SS' for 3 days ago, 'YYYY-MM-DD HH:MM:SS' for 10 days ago, across midnight and a DST change.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
# The app formats in the viewer's zone; Berlin has a DST change on 2026-10-25.
export TZ=Europe/Berlin
start_app
api POST /window/bounds '{"x":0,"y":0,"width":1280,"height":800}' >/dev/null
sid="$(api POST /sessions '{"name":"r2 clock","cols":80,"rows":24}' | jq -r .sessionId)"
test -n "$sid"
for i in 1 2 3 4; do
  api POST /sessions/current/input "{\"text\":\"echo r2-line-$i\",\"enter\":true}" >/dev/null
  sleep 1
done
clock='^[0-9]{2}:[0-9]{2}:[0-9]{2} · [0-9]+:[0-9]{2}'
# A hover over the timeline of a session recorded now: today's clock beside the elapsed time.
s="$(state)"
jq '.bubble' <<<"$s"
read -r x y < <(jq -r '.bubble.scrubber | "\((.left + .width * 0.5) | floor) \((.top + .height / 2) | floor)"' <<<"$s")
mouse_to "$x" "$y"
s="$(state)"
jq '.bubble' <<<"$s"
jq -e '.bubble.hidden == false' <<<"$s"
jq -e --arg re "$clock" '.bubble.text | test($re)' <<<"$s"
# Kit correction 2026-11-13 (builder 261113_ui-polish R4): the bubble is two centred lines now (clock, then
# elapsed); ui-state's .bubble.text still joins them as "<clock> · <elapsed>", so the check above is
# unchanged. Added: the two lines as drawn, the clock first.
jq -e '(.bubble.lines | length) == 2 and (.bubble.lines[0].text | test("^[0-9]{2}:[0-9]{2}:[0-9]{2}$"))' <<<"$s"
# A live seek: the bubble while the playhead is dragged.
mouse_to "$(jq -r '.bubble.scrubber | (.left + .width * 0.3) | floor' <<<"$s")" "$y"
xdo mousedown 1
mouse_to "$(jq -r '.bubble.scrubber | (.left + .width * 0.4) | floor' <<<"$s")" "$y"
s="$(state)"
xdo mouseup 1
jq '.bubble' <<<"$s"
jq -e --arg re "$clock" '.bubble.hidden == false and (.bubble.text | test($re))' <<<"$s"
# The formatter: epoch ms in, the viewer's local wall clock out (Europe/Berlin here).
ms() { echo "$(date -u -d "$1" +%s)000"; }
fmt() { cmd "{\"command\":\"bubble-format\",\"tsMs\":$(ms "$1"),\"nowMs\":$(ms "$2")}"; }
check() { # check <ts UTC> <now UTC> <expected Berlin text>
  local got
  got="$(fmt "$1" "$2")"
  echo "bubble-format ts=$1 now=$2 -> $got (want $3)"
  jq -e --arg want "$3" '(if type == "object" then .text else . end) == $want' <<<"$got"
}
check 2026-11-11T08:15:30Z 2026-11-11T09:00:00Z '09:15:30'               # today
check 2026-11-08T13:32:05Z 2026-11-11T09:00:00Z 'Sun 14:32:05'           # 3 days ago
check 2026-11-01T11:00:00Z 2026-11-11T09:00:00Z '2026-11-01 12:00:00'    # 10 days ago
check 2026-11-05T08:00:00Z 2026-11-11T09:00:00Z 'Thu 09:00:00'           # 6 days ago: this week
check 2026-11-04T22:00:00Z 2026-11-11T09:00:00Z '2026-11-04 23:00:00'    # 7 days ago: full date
check 2026-11-12T09:00:00Z 2026-11-11T09:00:00Z '2026-11-12 10:00:00'    # future: full date
check 2026-11-10T22:59:50Z 2026-11-10T23:00:30Z 'Tue 23:59:50'           # 40 s ago, across midnight
check 2026-10-24T23:30:00Z 2026-10-25T11:00:00Z '01:30:00'               # same day across DST (CEST->CET)
check 2026-10-25T00:30:00Z 2026-10-25T01:45:00Z '02:30:00'               # the repeated 02:xx hour
check 2026-10-24T11:30:00Z 2026-10-25T11:00:00Z 'Sat 13:30:00'           # 23.5 h ago, previous day
check 2026-10-24T10:30:00Z 2026-10-25T11:00:00Z 'Sat 12:30:00'           # 24.5 h ago across DST
