#!/usr/bin/env bash
# R7 stream_and_cancel — proves R7: live sessions are searched concurrently, each row appears when its session finishes, and stale results are dropped when the text changes.
# Asserts: buffer-search-log shows one request per live session for a query, all sent before the first answer arrives (request times precede the first answer); with one session flooded to 5000 long lines and others small, small sessions' rows appear in search-state before the big one's (rows grow over two reads; kit correction 2026-11-13: in at least 5 reads, the big session 1500 columns wide); typing a second query while the first runs: every answer for the old seq is cancelled or ignored, no row carries the old query's count, and the final rows equal a fresh search for the new query; a session created while the query is in the box (POST /sessions printing the query) gets its row without retyping.
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
# One big session (5000 lines of 499 columns on a 500-column screen, not selected so the
# renderer never refits it; QSEVEN on each 50th) and three small ones;
# the command lines never hold the query (p=QSE … ${p}VEN).
# Kit correction 2026-11-12 (builder P6), user decision 2026-11-12 ("Fix the check's
# timing"): the reads line below could never see the order. The big session was 200-column
# lines on a 100-column screen, i.e. the mirror's 5000-row cap of 100 cells: answered ~9 ms
# after the small ones, and the reads began after type_box's 0.3 s sleep, after the 200 ms
# debounce and every answer. Now the big buffer is 5000 rows of 500 cells (5x the cells; the
# row cap is the product's LIVE_SCROLLBACK, so the width grows instead), and the read loop
# starts right after the last keystroke. The reads assertion is unchanged; no product change.
# Kit correction 2026-11-13 (builder fix round; report 2026-11-12, finding 2): the window in
# which the small rows show without the big one was ~30 ms, seen by 1 to 7 reads, and the
# reads line below passed on a single read in the verifier's run. The big session is now
# 1500 columns wide (5000 rows of 1499 characters, 3x the cells), which widens that window
# to ~100 ms, and the reads line is made stricter: at least 5 reads, not 1, must show small
# rows without the big one. The read loop, the assertions and the product are unchanged.
bigc=1500
big="$(seed_session r7-big "p=QSE; for i in \$(seq 5000); do if [ \$((i % 50)) = 0 ]; then printf \"%s %0$((bigc - 8))d\\n\" \"\${p}VEN\" \$i; else printf \"%0$((bigc - 1))d\\n\" \$i; fi; done; echo R7\"\"BIG" R7BIG false "$bigc")"
s1="$(seed_session r7-s1 'p=QSE; for i in 1 2 3; do echo "${p}VEN $i"; done' 'QSEVEN 3')"
s2="$(seed_session r7-s2 'p=QSE; for i in 1 2 3 4; do echo "${p}VEN $i"; done' 'QSEVEN 4')"
s3="$(seed_session r7-s3 'p=QSE; for i in 1 2; do echo "${p}VEN $i"; echo "${p}VENX $i"; done' 'QSEVENX 2')"
live=4
bslog >/dev/null
# Rows as their sessions finish: read search-state as fast as it answers while the search runs.
# (Kit correction 2026-11-12, above: type_box without its 0.3 s sleep, so the reads start
# before the 200 ms debounce sends the requests.)
click_box
xdo type --delay 30 -- QSEVEN
reads="$ACCEPT_LOG_DIR/R7.reads"
: >"$reads"
end=$((SECONDS + 6))
while [ "$SECONDS" -lt "$end" ]; do
  sstate | jq -c '[.sessions.rows[] | select(.section == "buffer") | .id]' >>"$reads"
done
wait_search
s="$(sstate)"
jq '.sessions' <<<"$s"
log="$(bslog)"
jq . <<<"$log"
# One request per live session for the query, all sent before the first answer.
jq -e --argjson n "$live" '.entries | length == $n' <<<"$log"
jq -e '.entries | (map(.seq) | unique | length == 1) and (map(.sentAt) | max) <= (map(.answeredAt) | min)' <<<"$log"
# The big session answered last; the small ones' rows were shown before its row.
jq -e --arg b "$big" '.entries | (map(select(.sessionId == $b) | .answeredAt) | max) >= (map(.answeredAt) | max)' <<<"$log"
jq -e -s --arg b "$big" 'any(.[]; length > 0 and index($b) == null)' "$reads"
early="$(jq -s --arg b "$big" '[.[] | select(length > 0 and index($b) == null)] | length' "$reads")"
echo "R7 reads: $(wc -l <"$reads") in all, $early with small rows and no big row"
[ "$early" -ge 5 ]
jq -e --arg b "$big" --arg a "$s1" --arg c "$s2" --arg d "$s3" '[.sessions.rows[] | select(.section == "buffer") | .id] | sort == ([$a, $b, $c, $d] | sort)' <<<"$s"
# A second query while the first runs: stale answers are dropped.
clear_box
xdo type --delay 30 QSEVEN
sleep 0.3
xdo type X
wait_search
s="$(sstate)"
log="$(bslog)"
jq . <<<"$log"
jq '.sessions' <<<"$s"
seq_new="$(jq '.sessions.seq' <<<"$s")"
# Both queries were sent (the first one was in flight); the new one's answers are not cancelled.
jq -e '[.entries[].seq] | unique | length >= 2' <<<"$log"
jq -e --argjson q "$seq_new" '[.entries[] | select(.seq == $q)] | length > 0 and all(.[]; (.cancelled | not))' <<<"$log"
jq -e --arg d "$s3" '[.sessions.rows[] | select(.section == "buffer") | {id, sub}] == [{id: $d, sub: "2 matches"}]' <<<"$s"
final="$(jq -c '[.sessions.rows[] | select(.section == "buffer") | {id, sub}]' <<<"$s")"
# The same rows as a fresh search for the new query.
clear_box
xdo type --delay 30 QSEVENX
wait_search
jq -e --argjson f "$final" '[.sessions.rows[] | select(.section == "buffer") | {id, sub}] == $f' <<<"$(sstate)"
# A session started while the query is in the box gets its row without retyping.
late="$(seed_session r7-late 'p=QSE; echo "${p}VENX late"' 'QSEVENX late' false)"
has_late() { sstate | jq -e --arg l "$late" 'any(.sessions.rows[]; .section == "buffer" and .id == $l)' >/dev/null; }
wait_until 15 has_late || true
s="$(sstate)"
jq '.sessions' <<<"$s"
jq -e --arg l "$late" 'any(.sessions.rows[]; .section == "buffer" and .id == $l and .sub == "1 match")' <<<"$s"
