#!/usr/bin/env bash
# R1 switch speed — proves R1, U3: a switch draws its target without a perceptible wait whatever the history size or the number of profiles; a burst of switch keys ends on the right profile, drawn correctly.
# Asserts: 12 profiles, one live and one closed with a 200 000-entry timeline; over ten Ctrl+PgDn rounds the probe (debug command perf) reports a key-to-drawn median <= 150 ms onto the big profiles and <= 60 ms onto the small ones, and no long task over 100 ms; a row click and a search-box arrow onto the big live profile meet the same 150 ms; then 15 Ctrl+PgDn within 300 ms: the selected profile is the one 15 steps on in drawn order, the terminal shows that profile own marker text and no other marker, the status line holds no error.
# Also (design review 2026-11-25, F1-F16): cold switches (the first visit after an app restart) onto both big profiles meet the same 150 ms to drawn, with no long task over 100 ms until the probe reports the timeline complete; on the cold closed profile the transport is disabled until then and a step back afterwards changes the frame; A -> B -> A onto the big live profile within 200 ms leaves the cached timeline length equal to the engine's; the probe's errors count is 0 throughout (the status line alone is not the proof).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R1_switch_speed
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$ZBUI_LIB_IF"; source "$here/lib_sk.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and keys on the private display"
set -x
start_app
win_size 1280 800
# --- The store: 12 profiles, each prints its marker SKM<nn>K and exits ---------------
ids=(); declare -A mark
for n in 01 02 03 04 05 06 07 08 09 10 11 12; do
  s="$(mk_session "sk-$n")"; ids+=("$s"); mark[$s]="SKM${n}K"
  sinput "$s" "echo SKM\"\"${n}K; sleep 1; exit"
done
BL="${ids[2]}"; BC="${ids[7]}"          # the big live and the big closed profile
live=("${ids[1]}" "$BL" "${ids[3]}" "${ids[6]}" "${ids[8]}")
all_closed() { api GET /sessions | jq -e 'length == 12 and all(.[]; .active | not)' >/dev/null; }
wait_until 60 all_closed
# The 200 000-entry timelines are written with the app stopped.
quit_app
seed_big_timeline "$BL" 200000
seed_big_timeline "$BC" 200000
start_app
win_size 1280 800
for s in "${live[@]}"; do engine_extend "$s"; done
five_live() { api GET /sessions | jq -e '([.[] | select(.active)] | length) == 5' >/dev/null; }
wait_until 30 five_live
for s in "${live[@]}"; do n="${mark[$s]}"; sinput "$s" "echo SKM\"\"${n#SKM}"; done
sleep 2
# The fixture stands: the engine serves the hand-written timelines (else: stop and report).
tl_bl="$(engine_timeline "$BL" live)"; tl_bc="$(engine_timeline "$BC" playback)"
echo "FIXTURE big live: $tl_bl  big closed: $tl_bc"
jq -e '.length >= 200000' <<<"$tl_bl"
jq -e '.length >= 200000' <<<"$tl_bc"
order="$(cmd '{"command":"session-order"}' | jq -c '.ids')"      # the order Ctrl+PgDn walks
jq -e 'length == 12' <<<"$order"
at() { jq -r --arg s "$1" --argjson d "$2" '.[((index($s) + $d) % length + length) % length]' <<<"$order"; }
before_bc="$(at "$BC" -1)"; before_bl="$(at "$BL" -1)"
# Reach the profile before the big closed one by keyboard (lib_sk.sh walk_to: /switch would
# resume it and reorder the list), from the nearest live profile before it, never through either
# big profile (their first visit is the cold one).
start="$(jq -r --arg s "$before_bc" --arg bl "$BL" --argjson live "$(printf '%s\n' "${live[@]}" | jq -Rsc 'split("\n") | map(select(. != ""))')" '
  . as $o | ($o | index($s)) as $i
  | [range(0; length) | $o[(($i - .) % ($o | length) + ($o | length)) % ($o | length)]]
  | map(select(. as $x | ($live | index($x)) != null and $x != $bl)) | first' <<<"$order")"
select_session "$start"
wait_until 15 guard_off
focus_terminal
walk_to "$before_bc" "$BC" "$BL"
sleep 1
test "$(cmd '{"command":"session-order"}' | jq -c '.ids')" = "$order"   # the walk did not reorder
perf_start | jq -e '.started and .longTaskObserver'

# --- Cold: the first visit after the restart ------------------------------------------
keys 0 ctrl+Next 1
samples='[]'                              # (complete, transport disabled) while the profile opens
for k in 1 2 3 4 5 6; do
  samples="$(jq -c --argjson r "$(perf_read)" '. + [{complete: $r.timeline.complete, disabled: $r.transport.disabled, selectedId: $r.selectedId}]' <<<"$samples")"
done
bc_done() { perf_read | jq -e --arg s "$BC" '.selectedId == $s and .timeline.complete and (.transport.disabled | not)' >/dev/null; }
wait_until 20 bc_done
seq_before="$(perf_read | jq '.transport.seq')"
cmd '{"command":"click","selector":"#stepBack"}' >/dev/null
sleep 1
seq_after="$(perf_read | jq '.transport.seq')"
keys 700 ctrl+Next 11
sleep 1.5
cold="$(perf_read)"
cold_bc="$(switch_ms "$cold" "$BC" true | jq '.[0]')"; cold_bl="$(switch_ms "$cold" "$BL" true | jq '.[0]')"
cold_long="$(maxof "$(jq -c '.longTasks' <<<"$cold")")"
cold_err="$(jq '.errors' <<<"$cold")"

# --- Warm: nine more rounds of the twelve ----------------------------------------------
perf_start >/dev/null
for round in 2 3 4 5 6 7 8 9 10; do keys 700 ctrl+Next 12; done
sleep 1.5
warm="$(perf_read)"
big="$(jq -c --arg a "$BL" --arg b "$BC" '[.switches[] | select(.sessionId == $a or .sessionId == $b) | .ms]' <<<"$warm")"
small="$(jq -c --arg a "$BL" --arg b "$BC" '[.switches[] | select(.sessionId != $a and .sessionId != $b) | .ms]' <<<"$warm")"
big_med="$(median "$big")"; small_med="$(median "$small")"
warm_long="$(maxof "$(jq -c '.longTasks' <<<"$warm")")"
echo "MEASURED switch_speed cold: big_closed_ms=$cold_bc big_live_ms=$cold_bl longest_task_ms=$cold_long long_tasks=$(jq -c '.longTasks' <<<"$cold") errors=$cold_err"
echo "MEASURED switch_speed warm: big n=$(jq length <<<"$big") median_ms=$big_med max_ms=$(maxof "$big") | small n=$(jq length <<<"$small") median_ms=$small_med max_ms=$(maxof "$small") | longest_task_ms=$warm_long long_tasks=$(jq -c '.longTasks' <<<"$warm") errors=$(jq '.errors' <<<"$warm")"
echo "big=$big"; echo "small=$small"
# The walk was timed: both big profiles and the small ones have samples.
jq -e 'length >= 9' <<<"$big"
jq -e 'length >= 45' <<<"$small"
# R1, the timing assertions (baseline.md Cost).
# Both cold switches were timed (a missing sample is not a timing result).
test "$cold_bc" != null
test "$cold_bl" != null
timing_le warm_big_median_ms "$big_med" 150
timing_le warm_small_median_ms "$small_med" 60
timing_le warm_longest_task_ms "$warm_long" 100
timing_le cold_big_closed_ms "$cold_bc" 150
timing_le cold_big_live_ms "$cold_bl" 150
timing_le cold_longest_task_ms "$cold_long" 100

# --- The lazy timeline's side of the cold visit (design F7, F14) ------------------------
echo "cold closed profile: samples=$samples seq $seq_before -> $seq_after"
# Never usable while the timeline is incomplete; a step back afterwards changed the frame.
jq -e 'all(.[]; .complete or .disabled)' <<<"$samples"
test "$seq_before" != null
test "$seq_after" != "$seq_before"
test "$cold_err" = 0
jq -e '.errors == 0' <<<"$warm"

# --- A row click and a search-box arrow onto the big live profile ------------------------
select_session "${ids[6]}"
wait_until 15 guard_off
perf_start >/dev/null
r="$(row_rect "$BL")"
click_at "$(jq -r '(.left + 40) | floor' <<<"$r")" "$(jq -r '(.top + .height / 2) | floor' <<<"$r")"
wait_until 15 shows "$BL"
sleep 1
click_ms="$(switch_ms "$(perf_read)" "$BL" | jq '.[-1]')"
drawn="$(drawn_ids)"
above="$(jq -r --arg s "$BL" '.[index($s) - 1]' <<<"$drawn")"
walk_to "$above" "$BL"
wait_until 15 guard_off
click_box
perf_start >/dev/null
key Down
wait_until 15 shows "$BL"
sleep 1
arrow="$(perf_read)"
arrow_ms="$(switch_ms "$arrow" "$BL" | jq '.[-1]')"
echo "MEASURED switch_speed onto the big live profile: row_click_ms=$click_ms search_arrow_ms=$arrow_ms"
test "$click_ms" != null
test "$arrow_ms" != null
timing_le row_click_ms "$click_ms" 150
timing_le search_arrow_ms "$arrow_ms" 150
jq -e '.errors == 0' <<<"$arrow"
key Escape
focus_terminal

# --- U3: 15 Ctrl+PgDn within 300 ms ----------------------------------------------------------
drawn="$(drawn_ids)"
from="$(perf_read | jq -r '.selectedId')"
target="$(jq -r --arg s "$from" '.[(index($s) + 15) % length]' <<<"$drawn")"
perf_start >/dev/null
keys 15 ctrl+Next 15
wait_until 15 shows "$target"
sleep 1.5
burst="$(perf_read)"
jq -c '{selectedId, switches, longTasks, errors}' <<<"$burst"
jq -e --arg s "$target" '.selectedId == $s' <<<"$burst"
# Its own marker on the screen and no other profile's.
test "$(markers_shown)" = "${mark[$target]}"
st="$(status_text)"; echo "status: $st"
! grep -qiE 'error|E_[A-Z]' <<<"$st"
jq -e '.errors == 0' <<<"$burst"

# --- F3: A -> B -> A onto the big live profile within 200 ms ---------------------------------
focus_terminal
walk_to "$before_bl" "$BL"
wait_until 15 guard_off
perf_start >/dev/null
xdo key --clearmodifiers --delay 60 ctrl+Next ctrl+Prior ctrl+Next
bl_done() { perf_read | jq -e --arg s "$BL" '.selectedId == $s and .timeline.complete' >/dev/null; }
wait_until 20 bl_done
sleep 1
# The engine's timeline grows while the profile is live (run 2: one entry 36 s after the renderer's
# last, read 0.2 s before the engine's): the two reads are compared once they agree or after 5 s.
aba_agrees() {
  aba="$(perf_read)"; eng="$(engine_timeline "$BL" live)"
  jq -e --argjson e "$eng" '.timeline.cached == $e.length and .timeline.lastTsMs == $e.lastTsMs' <<<"$aba" >/dev/null
}
wait_until 5 aba_agrees || true
echo "A-B-A: renderer $(jq -c '.timeline' <<<"$aba") engine $eng"
jq -e --argjson e "$eng" '.timeline.cached == .timeline.engine and .timeline.cached == $e.length
  and .timeline.lastTsMs == $e.lastTsMs and .errors == 0' <<<"$aba"
timing_verdict "R1 switch speed"
echo "R1 switch speed: PASS"
