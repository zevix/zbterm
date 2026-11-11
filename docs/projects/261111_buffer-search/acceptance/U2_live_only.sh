#!/usr/bin/env bash
# U2 live_only — proves U2: text only in an ended session, or only in recorded history, is never listed and no history is read from disk.
# Asserts: session 'gone' prints ENDMARK then exits (ended); session 'live' is running and cleared its screen and scrollback after printing OLDMARK (printf '\033[3J\033[H\033[2J'), so OLDMARK is only in its recording: typing ENDMARK or OLDMARK in #search shows the heading with .sessions.empty == true and no buffer rows; buffer-search-log has no request for the ended session; GET /events shows no player/session open for either while the search runs.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_bs.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
is_ended() { api GET /sessions | jq -e --arg s "$1" 'any(.[]; .sessionId == $s and (.active | not))' >/dev/null; }
mirror_lacks() { ! mirror_has "$1" "$2"; }
# 'gone' prints ENDMARK and ends; 'live' printed OLDMARK and cleared its screen and scrollback.
sg="$(seed_session u2-gone 'p=ENDM; echo "${p}ARK"' ENDMARK)"
sinput "$sg" exit
wait_until 30 is_ended "$sg"
sl="$(seed_session u2-live 'p=OLDM; echo "${p}ARK"' OLDMARK)"
sinput "$sl" "printf '\\033[3J\\033[H\\033[2J'"
wait_until 20 mirror_lacks "$sl" OLDMARK
select_session "$sl"
# From here on nothing but the search touches the sessions.
bslog >/dev/null
t0="$(date +%s%3N)"
check_empty() {
  local s
  s="$(sstate)"
  jq '.sessions' <<<"$s"
  jq -e '.sessions.heading == "Session buffer matches" and .sessions.empty == true' <<<"$s"
  jq -e '[.sessions.rows[] | select(.section == "buffer")] == []' <<<"$s"
}
type_box ENDMARK
wait_search
check_empty
clear_box
xdo type --delay 30 OLDMARK
wait_search
check_empty
log="$(bslog)"
jq . <<<"$log"
jq -e '.logging == true' <<<"$log"
jq -e --arg g "$sg" '[.entries[] | select(.sessionId == $g)] == []' <<<"$log"
ev="$(api GET /events)"
jq -c --argjson t "$t0" '[.[] | select(.ts >= $t) | .name] | group_by(.) | map({(.[0]): length}) | add' <<<"$ev"
jq -e --argjson t "$t0" '[.[] | select(.ts >= $t and (.name | startswith("player:")))] == []' <<<"$ev"
