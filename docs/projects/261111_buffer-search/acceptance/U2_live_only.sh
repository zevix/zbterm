#!/usr/bin/env bash
# U2 live_only — proves U2: text only in an ended session, or only in recorded history, is never listed and no history is read from disk.
# Asserts: session 'gone' prints ENDMARK then exits (ended); session 'live' is running and cleared its screen and scrollback after printing OLDMARK (printf '\033[3J\033[H\033[2J'), so OLDMARK is only in its recording: typing ENDMARK or OLDMARK in #search shows the heading with .sessions.empty == true and no buffer rows; buffer-search-log has no request for the ended session; GET /events shows no player/session open for either while the search runs; and the engine's count of history reads (debug.historyReads: stores opened on a recording, packets read, snapshots read) is the same after both searches as before them, while a GET /sessions/<ended>/stats afterwards (a positive control) raises it.
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
# Kit correction 2026-11-13 (builder fix round; report 2026-11-12, finding 5): "no history is
# read from disk" was shown by proxies only (no player:* event, no request for the ended
# session; both kept below). Now the engine's own count of history reads is compared:
# debug.historyReads (POST /invoke) counts every store opened on a recording, every packet
# read from one and every snapshot read from the cache; it must not move across the two
# searches. A positive control afterwards (GET /sessions/:id/stats opens the ended session's
# recording) must move it, so an unchanged count is not a dead counter.
reads() { api POST /invoke '{"method":"debug.historyReads"}'; }
h0="$(reads)"
echo "history reads before the search: $h0"
jq -e 'has("storeOpens") and has("packets") and has("snapshots")' <<<"$h0"
# From here on nothing but the search touches the sessions.
bslog >/dev/null
# Kit correction 2026-11-13 (builder fix round): this host's date (uutils coreutils 0.12.0)
# misprints %3N when the milliseconds start with a zero (043 as 43x, up to ~0.9 s late), which
# could start the GET /events window late; bash's own clock instead.
t0="${EPOCHREALTIME//[!0-9]/}"; t0="${t0:0:13}"
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
h1="$(reads)"
echo "history reads after the search: $h1"
jq -e --argjson a "$h0" '. == $a' <<<"$h1"
ev="$(api GET /events)"
jq -c --argjson t "$t0" '[.[] | select(.ts >= $t) | .name] | group_by(.) | map({(.[0]): length}) | add' <<<"$ev"
jq -e --argjson t "$t0" '[.[] | select(.ts >= $t and (.name | startswith("player:")))] == []' <<<"$ev"
# The positive control (after the GET /events check, which it would trip): opening the ended
# session's recording moves the same count.
api GET "/sessions/$sg/stats" >/dev/null
h2="$(reads)"
echo "history reads after GET /sessions/<ended>/stats: $h2"
jq -e --argjson a "$h1" '(.storeOpens + .packets + .snapshots) > ($a.storeOpens + $a.packets + $a.snapshots)' <<<"$h2"
