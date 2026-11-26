#!/usr/bin/env bash
# R2 typing speed — proves R2, U4: a typed key echoes without perceptible lag in a live profile with a large history, quiet and while output streams; no output or recorded byte is lost to the speed fix.
# Asserts: in the live profile with a 1 000 000-entry timeline (planner 2026-11-25: at 200 000 today already echoes in 13 ms), 50 real keys typed 100 ms apart: echo median <= 30 ms and no long task over 50 ms, once on a quiet shell and once while the same profile prints 20 lines a second; a numbered sequence 1..5000 printed during the run is complete, in order, in the terminal mirror and in the playback of the recording after the session ends; the scrubber end label still advances while output arrives (within 1 s).
# Also (design review 2026-11-25, F1-F16): an echo is the parsed write that contains the typed character (typed characters do not occur in the stream); after the run the renderer's cached timeline has the engine's length and last entry; within 500 ms of the output stopping the scrubber's marks equal those of a forced redraw at the same clock as their draw (planner 2026-11-25).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R2_typing_speed
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$ZBUI_LIB_IF"; source "$here/lib_sk.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and keys on the private display"
set -x
start_app
win_size 1280 800
small="$(mk_session sk-small)"; sinput "$small" 'echo SM""ALL; sleep 1; exit'
BL="$(mk_session sk-big)"; sinput "$BL" 'echo BIG""READY; sleep 1; exit'
all_closed() { api GET /sessions | jq -e 'length == 2 and all(.[]; .active | not)' >/dev/null; }
wait_until 60 all_closed
# The 1 000 000-entry timeline is written with the app stopped; the profile is then resumed.
quit_app
seed_big_timeline "$BL" 1000000
start_app
win_size 1280 800
engine_extend "$BL"
is_live() { api GET /sessions | jq -e --arg s "$BL" 'any(.[]; .sessionId == $s and .active)' >/dev/null; }
wait_until 30 is_live
sleep 2
tl="$(engine_timeline "$BL" live)"; echo "FIXTURE big live: $tl"
jq -e '.length >= 1000000' <<<"$tl"          # else: stop and report (phases.md P1)
select_session "$BL"
wait_until 15 guard_off
focus_terminal
sleep 1
typed="$(printf 'jk%.0s' $(seq 1 25))"      # 50 keys; neither letter occurs in what the shell prints

# --- Quiet shell ---------------------------------------------------------------------------
perf_start | jq -e '.started and .longTaskObserver'
xdo type --delay 100 -- "$typed"
sleep 1
quiet="$(perf_read)"
key ctrl+u

# --- While the profile prints 20 lines a second ----------------------------------------------
sinput "$BL" 'for i in $(seq 1 170); do echo "L $i"; sleep 0.05; done; echo ST""DONE'
sleep 1
label1="$(cmd '{"command":"time-labels"}' | jq -r '.total')"
sleep 1
label2="$(cmd '{"command":"time-labels"}' | jq -r '.total')"
perf_start >/dev/null
xdo type --delay 100 -- "$typed"
sleep 0.5
stream="$(perf_read)"
wait_until 30 term_has STDONE
# The scrubber's marks 500 ms after the output stopped, and after a forced redraw.
sleep 0.5
marks="$(perf_read refresh | jq -c '{marks, marksRefreshed, drawEnd}')"
key ctrl+u

# --- U4: a numbered sequence 1..5000, ten lines at a time ----------------------------------------
tl0="$(engine_timeline "$BL" live)"; seq0="$(jq '.lastSeq' <<<"$tl0")"; ts0="$(jq '.lastTsMs' <<<"$tl0")"
sinput "$BL" 'for i in $(seq 1 500); do seq -f "S %g" $((i*10-9)) $((i*10)); sleep 0.01; done; echo SQ""DONE'
# A harness wait, not a timing assertion: at 1 000 000 entries today's renderer took over 60 s to
# show the 5000 lines (run 2), so it gets 150 s; the time taken is printed.
sq_t0=$SECONDS
wait_until 150 term_has SQDONE
echo "MEASURED typing_speed sequence_shown_s=$((SECONDS - sq_t0))"
sleep 1

q_med="$(median "$(jq -c '.echoes' <<<"$quiet")")"; q_long="$(maxof "$(jq -c '.longTasks' <<<"$quiet")")"
s_med="$(median "$(jq -c '.echoes' <<<"$stream")")"; s_long="$(maxof "$(jq -c '.longTasks' <<<"$stream")")"
echo "MEASURED typing_speed quiet: echoes=$(jq '.echoes | length' <<<"$quiet") median_ms=$q_med max_ms=$(maxof "$(jq -c '.echoes' <<<"$quiet")") misses=$(jq '.echoMisses' <<<"$quiet") longest_task_ms=$q_long long_tasks=$(jq -c '.longTasks' <<<"$quiet")"
echo "MEASURED typing_speed streaming: echoes=$(jq '.echoes | length' <<<"$stream") median_ms=$s_med max_ms=$(maxof "$(jq -c '.echoes' <<<"$stream")") misses=$(jq '.echoMisses' <<<"$stream") longest_task_ms=$s_long long_tasks=$(jq -c '.longTasks' <<<"$stream")"
jq -c '.echoes' <<<"$quiet"; jq -c '.echoes' <<<"$stream"
# Every typed key was echoed and timed (an echo is the parsed write holding the typed character).
jq -e '(.echoes | length) == 50 and .echoMisses == 0' <<<"$quiet"
jq -e '(.echoes | length) == 50 and .echoMisses == 0' <<<"$stream"
# R2, the timing assertions (baseline.md Cost).
timing_le quiet_echo_median_ms "$q_med" 30
timing_le quiet_longest_task_ms "$q_long" 50
timing_le streaming_echo_median_ms "$s_med" 30
timing_le streaming_longest_task_ms "$s_long" 50

# --- The scrubber while output arrives (F8) ----------------------------------------------------
echo "end label: $label1 -> $label2  marks: $marks"
test "$label1" != "$label2"
jq -e '.drawEnd != null and .marks == .marksRefreshed and (.marks | startswith("0:") | not)' <<<"$marks"

# --- U4: the sequence in the terminal ------------------------------------------------------------
sm="$(cmd '{"command":"live-seam","prefix":"S "}')"
jq -c '{lines, first, last, dups: .dups[:10], missing: .missing[:10]}' <<<"$sm"
jq -e '.dups == [] and .missing == [] and .first == 1 and .last == 5000 and .lines == 5000' <<<"$sm"
jq -e '.errors == 0' <<<"$(perf_read)"

# --- U4: the sequence in the playback of the recording, after the session ends ---------------------
sinput "$BL" 'exit'
is_closed() { api GET /sessions | jq -e --arg s "$BL" 'any(.[]; .sessionId == $s and (.active | not))' >/dev/null; }
wait_until 30 is_closed
sleep 1
# Every recorded packet after the sequence started, played through the engine's player from the
# last entry before it and read as the text the player sends (debug command playback-text,
# 261125 P3, planner decision): the "S n" lines must be exactly 1..5000, in order. (Until P3 this
# sampled the 30-row frame once per packet, which cannot see a packet of 555 lines whole.)
cmd "$(jq -nc --arg s "$BL" --argjson t "$ts0" '{command: "playback-text", sessionId: $s, tsMs: $t, timeoutMs: 50000}')" \
  > "$ACCEPT_LOG_DIR/R2_playback_text.json"
# A line is what follows its last carriage return (bash writes "\e[?2004l\r" before the first one).
jq -c --argjson seq0 "$seq0" '[.text | split("\n")[] | sub("\r$"; "") | (split("\r") | last // "")
    | select(test("^S [0-9]+$")) | .[2:] | tonumber] as $n
  | {startSeq, seq0: $seq0, ended, packets, bytes, lines: ($n | length), first: $n[0], last: $n[-1],
     inOrder: ($n == [range(1; 5001)])}' "$ACCEPT_LOG_DIR/R2_playback_text.json" | tee "$ACCEPT_LOG_DIR/R2_playback.json"
jq -e --argjson seq0 "$seq0" '.ended and .startSeq != null and .startSeq <= $seq0 and .lines == 5000 and .inOrder' "$ACCEPT_LOG_DIR/R2_playback.json"

# --- F6: the renderer's timeline is the engine's -----------------------------------------------------
focus_terminal
perf_start >/dev/null
xdo key --clearmodifiers --delay 1500 ctrl+Next ctrl+Prior
bl_done() { perf_read | jq -e --arg s "$BL" '.selectedId == $s and .timeline.complete' >/dev/null; }
wait_until 20 bl_done
sleep 1
fin="$(perf_read)"; eng="$(engine_timeline "$BL" playback)"
echo "timeline: renderer $(jq -c '.timeline' <<<"$fin") engine $eng"
jq -e --argjson e "$eng" '.timeline.cached == .timeline.engine and .timeline.cached == $e.length
  and .timeline.lastSeq == $e.lastSeq and .timeline.lastTsMs == $e.lastTsMs and .errors == 0' <<<"$fin"
timing_verdict "R2 typing speed"
echo "R2 typing speed: PASS"
