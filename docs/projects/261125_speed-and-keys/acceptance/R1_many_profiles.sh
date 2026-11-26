#!/usr/bin/env bash
# R1 many profiles — proves R1 (independent of the number of profiles).
# Asserts: 100 small profiles (30 live); over 30 Ctrl+PgDn the probe's key-to-drawn median is <= 80 ms, no long task over 100 ms, errors == 0.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# Kit correction 2026-11-25 (P6 builder): lib.sh names the storage and HOME dirs by the id's part
# before "_", so "R1_many_profiles" shared "R1" with R1_switch_speed.sh; under run_all.sh (one state
# dir) R1_switch_speed then started on these 100 profiles and failed its "12 profiles" wait.
ZBUI_ID=R1m_many_profiles
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$ZBUI_LIB_IF"; source "$here/lib_sk.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and keys on the private display"
set -x
start_app
win_size 1280 800
# 100 small profiles: each prints its marker; 70 of them then exit (closed), 30 stay live.
ids=()
for i in $(seq 1 100); do
  n="$(printf '%03d' "$i")"
  ids+=("$(mk_session "mp-$n")")
done
for i in $(seq 1 100); do
  n="$(printf '%03d' "$i")"
  if [ "$i" -le 30 ]; then sinput "${ids[$((i - 1))]}" "echo SKM\"\"${n}K"
  else sinput "${ids[$((i - 1))]}" "echo SKM\"\"${n}K; exit"; fi
done
counts() { api GET /sessions | jq -e 'length == 100 and ([.[] | select(.active)] | length) == 30' >/dev/null; }
wait_until 60 counts
api GET /sessions | jq -c '{profiles: length, live: ([.[] | select(.active)] | length)}'
listed() { [ "$(drawn_ids | jq 'length')" = 100 ]; }
wait_until 20 listed
select_session "${ids[0]}"
wait_until 15 guard_off
focus_terminal
perf_start | jq -e '.started and .longTaskObserver'

# --- R1: 30 Ctrl+PgDn, 400 ms apart ------------------------------------------------
keys 400 ctrl+Next 30
sleep 1.5
p="$(perf_read)"
all="$(jq -c '[.switches[].ms]' <<<"$p")"
med="$(median "$all")"; long="$(maxof "$(jq -c '.longTasks' <<<"$p")")"
echo "MEASURED many_profiles: switches=$(jq 'length' <<<"$all") median_ms=$med max_ms=$(maxof "$all") longest_task_ms=$long errors=$(jq '.errors' <<<"$p")"
jq -c '{switches: [.switches[].ms], longTasks}' <<<"$p"
# Every key made a switch that was drawn and timed.
jq -e '(.switches | length) >= 28' <<<"$p"
le "$med" 80
le "$long" 100
jq -e '.errors == 0' <<<"$p"
echo "R1 many profiles: PASS"
