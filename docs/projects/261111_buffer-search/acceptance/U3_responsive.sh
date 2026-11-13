#!/usr/bin/env bash
# U3 responsive — proves U3: typing and output in the terminal stay responsive while a cross-session search runs over several full buffers.
# Asserts: five sessions filled to 5000 lines of 200 columns; the query is "0" (most matches).
#   Typing: a real key typed in the terminal echoes on the selected session's rows within 150 ms
#   (median of 10, from the key event's own time to the row read on screen) in samples where a
#   cross-session search was in flight when the key happened (buffer-search-log: a request sent
#   before the key and answered after it); the same measure without a search recorded beside it.
#   Output: a loop prints its clock every 0.05 s; the median time from a line's clock to its row on
#   screen is within 150 ms over at least 10 lines printed while a search request was in flight,
#   the same without a search recorded beside it.
#   Throughput: a flood of 600 000 lines reaches the screen at no less than half the rate it does
#   without a search, while the query is retyped by real keys throughout and requests are in flight
#   for at least a fifth of the flood's time.
#   buffer-search-log shows every search finished (no request left unanswered).
# Kit correction 2026-11-13 (F3): report 2026-11-13 finding 4: the overlap of the measurement with
# a running search was not asserted, the echo was posted (POST /sessions/current/input) rather than
# typed, and output throughput was not measured. Every "during" sample is now tied to a request in
# flight; the key is a real key; throughput added. The 150 ms bounds are unchanged.
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
# Five sessions, each 5000 lines of 200 columns (zero-padded numbers: "0" matches everywhere).
for n in a b c d e; do
  sid="$(seed_session "u3-$n" 'seq -f "%0199g" 1 5000; echo U3""DONE' U3DONE)"
done
wait_until 10 term_has U3DONE
# Kit correction 2026-11-13 (F3): the echo is a real key on the private display, timed from the
# key event's own time (key-probe "at", the renderer's clock) to the moment this script reads the
# char on the selected session's rows (the same wall clock; the polling adds to the figure, never
# takes from it). The app keeps the terminal and the box apart (Tab never leaves the box), so a
# key reaches the terminal during a search the way a user's does: the query typed in the box,
# then a click in the terminal (R10 ends the search in the renderer; the engine's scans already
# sent keep running and answer), then the key. A sample counts as "during" only when the
# renderer's buffer-search-log shows a request sent before the key and answered after it.
now_ms() { local t="${EPOCHREALTIME//[!0-9]/}"; echo "${t:0:13}"; }
median() { sort -n | awk '{a[NR]=$1} END {print int((a[int((NR+1)/2)] + a[int(NR/2)+1]) / 2)}'; }
# chain '<sh>': xdotool steps run by one shell on the private display, so their spacing is not
# stretched by a uisolate start between them; the pointer is placed first (no --sync: it waits for
# a move, forever when the pointer is already there), and the click (with no
# delay after it: xdotool's default is 100 ms) and the key are one xdotool call (the
# engine answers a search over the five buffers in ~70 ms: the click must come after the requests
# are sent, or it ends the search before they go, and the key before the answers).
chain() { uisolate run --name "$ZBUI_SESSION" -t 60 -- sh -c "$1" >/dev/null 2>&1; }
r="$(api GET /renderer/terminal-display | jq -c '.terminal.rects.screen // .renderer.rects.screen')"
read -r tx ty < <(_zbui_screen_xy "$(jq '(.left + .width / 2) | floor' <<<"$r")" "$(jq '(.top + .height / 2) | floor' <<<"$r")")
win="$(_zbui_window)"
logs_all="$ACCEPT_LOG_DIR/U3.bslog.jsonl"; : >"$logs_all"
keep_log() { bslog | tee -a "$logs_all"; }
prompt_is() { term_text | grep -qE "^\\\$ $1 *\$"; }
# echo_sample <during 0|1> <delay s>: one real key ("k" during, "a" without), echo time in ms and
# whether a request was in flight when it happened: prints "<ms> <in flight 0|1> <where>"
# (<where>: before / after the search, for the delay's correction; "-" otherwise).
echo_sample() {
  local during="$1" d="$2" c steps cp seen="" end p at log ok where
  if [ "$during" = 1 ]; then c=k; else c=a; fi
  wait_until 10 prompt_is '' || true
  keep_log >/dev/null
  cmd '{"command":"key-probe","action":"start","scope":"document"}' >/dev/null
  if [ "$during" = 1 ]; then
    steps="xdotool windowfocus --sync $win mousemove $tx $ty; xdotool key --clearmodifiers ctrl+shift+f 0; sleep $d; xdotool click --delay 0 1 key $c"
  else
    steps="xdotool windowfocus --sync $win mousemove $tx $ty; sleep 0.2; xdotool click --delay 0 1 key $c"
  fi
  chain "$steps" &
  cp=$!
  end=$((SECONDS + 8))
  until [ -n "$seen" ] || [ "$SECONDS" -ge "$end" ]; do
    if prompt_is "$c"; then seen="$(now_ms)"; fi
  done
  wait "$cp" || true
  p="$(cmd '{"command":"key-probe","action":"take"}')"
  sleep 0.5
  log="$(keep_log)"
  key ctrl+u
  at="$(jq --arg c "$c" '[.events[] | select(.key == $c)][0].at // empty' <<<"$p")"
  if [ -z "$seen" ] || [ -z "$at" ]; then echo "99999 0 -"; return 0; fi
  ok="$(jq --argjson t "$at" '[.entries[] | select(.answeredAt != null and .sentAt <= $t and .answeredAt >= $t)] | length > 0' <<<"$log")"
  where="-"
  if [ "$ok" != true ] && [ "$during" = 1 ]; then
    where="$(jq -r --argjson t "$at" 'if ([.entries[] | select(.sentAt <= $t)] | length) == 0 then "before" else "after" end' <<<"$log")"
  fi
  jq -c --arg c "$c" '[.events[] | select(.key == $c)][0] | {key, target, at, handledAt}' <<<"$p" >&2
  echo "$(( seen - ${at%.*} )) $([ "$ok" = true ] && echo 1 || echo 0) $where"
}
quiet=()
for _ in 1 2 3 4 5 6 7 8 9 10; do
  read -r ms _ _ < <(echo_sample 0 0)
  quiet+=("$ms")
done
q_med="$(printf '%s\n' "${quiet[@]}" | median)"
echo "echo ms without a search: ${quiet[*]} (median $q_med)"
# During: the query retyped ("0" over the restored "0": a new search after the box's 200 ms
# delay), the click and the key timed to land while the engine answers. Up to 40 tries for 10
# samples with a request in flight; the delay follows the misses.
busy=(); tries=0; d=0.22
while [ "${#busy[@]}" -lt 10 ] && [ "$tries" -lt 40 ]; do
  tries=$((tries + 1))
  read -r ms inflight where < <(echo_sample 1 "$d")
  echo "try $tries (delay $d s): echo $ms ms, request in flight: $inflight $where"
  if [ "$inflight" = 1 ]; then busy+=("$ms")
  elif [ "$where" = before ]; then d="$(awk -v d="$d" 'BEGIN {printf "%.3f", d + 0.01}')"
  elif [ "$where" = after ]; then d="$(awk -v d="$d" 'BEGIN {printf "%.3f", (d > 0.03 ? d - 0.01 : d)}')"
  fi
done
echo "echo samples with a request in flight: ${#busy[@]} of $tries tries"
[ "${#busy[@]}" -ge 10 ]
b_med="$(printf '%s\n' "${busy[@]}" | median)"
echo "echo ms during a search: ${busy[*]} (median $b_med; without: $q_med)"
# Leave the search: Esc in the box forgets the text the clicks kept.
key ctrl+shift+f
key Escape
# Output latency. A loop in the selected session prints its own clock ("OT<epoch ms>-<epoch ms>",
# the repeat so a row overwritten in part is never read) every 0.05 s; this script reads the rows
# without pause and takes, for each line, the first time it saw it minus the line's clock (bash's
# $EPOCHREALTIME on both sides: this host's date misprints %3N).
out_loop() {
  api POST /sessions/current/input "$(jq -nc --arg t "for i in \$(seq $1); do t=\${EPOCHREALTIME//[!0-9]/}; printf 'OT%s-%s\\n' \${t:0:13} \${t:0:13}; sleep 0.05; done; echo OT$2\"\"END" '{text: $t, enter: true}')" >/dev/null
}
out_done() { term_text | grep -qE "^OT${1}END *$"; }
# collect_lines <secs>: "<line clock> <first seen>" for each line printed after it started.
collect_lines() {
  local start now end rows
  start="$(now_ms)"; end=$((start + $1 * 1000))
  while :; do
    rows="$(term_text)"
    now="$(now_ms)"
    sed -nE 's/^OT([0-9]{13})-\1 *$/\1/p' <<<"$rows" | awk -v n="$now" -v s="$start" '$1 > s {print $1, n}'
    [ "$now" -ge "$end" ] && break
  done | sort -k1,1n -k2,2n | awk '!seen[$1]++'
}
out_loop 60 Q
lines_q="$(collect_lines 2)"
wait_until 15 out_done Q
oq_med="$(awk '{print $2 - $1}' <<<"$lines_q" | median)"
echo "output: $(wc -l <<<"$lines_q") lines without a search, median $oq_med ms"
# During: a real-key chain retypes the query every 0.25 s (each retype a new search over the five
# buffers, sent after the box's 200 ms delay and answered in ~70 ms, so requests are in flight
# about a quarter of the time) while the lines are read.
flag="$UBITRON_TEST_STATE_DIR/u3-stop"; rm -f "$flag"
retype_loop() {
  chain "i=0; while [ ! -e '$flag' ] && [ \$i -lt 120 ]; do xdotool key BackSpace 0; sleep 0.25; i=\$((i + 1)); done"
}
type_box 0
wait_search 60
keep_log >/dev/null
# ~36 searches over 9 s, each with requests in flight ~70 ms: many lines are printed in flight.
out_loop 200 B
retype_loop &
rp=$!
lines_b="$(collect_lines 9)"
touch "$flag"; wait "$rp" || true
wait_until 40 out_done B
wait_search 60
log="$(keep_log)"
# The lines printed while a request was in flight (its clock between a request's sent and answered).
inflight_lines="$(jq -r '.entries[] | select(.answeredAt != null) | "\(.sentAt) \(.answeredAt)"' <<<"$log" \
  | awk 'NR == FNR {s[NR] = $1; a[NR] = $2; n = NR; next} {for (i = 1; i <= n; i++) if ($1 >= s[i] && $1 <= a[i]) {print; break}}' - <(echo "$lines_b"))"
n_in="$(grep -c . <<<"$inflight_lines" || true)"
ob_med="$(awk '{print $2 - $1}' <<<"$inflight_lines" | median)"
echo "output: $(wc -l <<<"$lines_b") lines during the retyping, $n_in printed with a request in flight, median $ob_med ms (without: $oq_med)"
[ "$n_in" -ge 10 ]
# Throughput: a flood of 600 000 numbered lines, from the command's post to its end marker on
# screen; without a search, then while the query is retyped (as above) throughout.
end_seen() { term_text | grep -qE "^FE$1END *$"; }
flood() {
  local t0 t1
  t0="$(now_ms)"
  api POST /sessions/current/input "$(jq -nc --arg t "seq -f 'F%09g' 1 600000; echo FE$1\"\"END" '{text: $t, enter: true}')" >/dev/null
  local end=$((SECONDS + 120))
  until end_seen "$1" || [ "$SECONDS" -ge "$end" ]; do :; done
  t1="$(now_ms)"
  echo "$t0 $t1"
}
key Escape
sleep 1
read -r f0 f1 < <(flood Q)
fq=$((f1 - f0))
type_box 0
wait_search 60
keep_log >/dev/null
rm -f "$flag"
retype_loop &
rp=$!
sleep 1
read -r g0 g1 < <(flood B)
touch "$flag"; wait "$rp" || true
wait_search 60
log="$(keep_log)"
fb=$((g1 - g0))
# The share of the flood's time with a request in flight (the union of the requests' spans).
cover="$(jq --argjson a "$g0" --argjson b "$g1" '
  [.entries[] | select(.answeredAt != null and .answeredAt >= $a and .sentAt <= $b)
   | [([.sentAt, $a] | max), ([.answeredAt, $b] | min)]] | sort
  | reduce .[] as $s ({end: 0, sum: 0}; if $s[0] > .end then {end: $s[1], sum: (.sum + $s[1] - $s[0])}
      elif $s[1] > .end then {end: $s[1], sum: (.sum + $s[1] - .end)} else . end)
  | (.sum * 100 / ($b - $a)) | floor' <<<"$log")"
seqs="$(jq --argjson a "$g0" --argjson b "$g1" '[.entries[] | select(.sentAt >= $a and .sentAt <= $b) | .seq] | unique | length' <<<"$log")"
echo "throughput: 600000 lines in $fq ms without a search, $fb ms during ($seqs searches sent, requests in flight ${cover}% of the time)"
echo "U3 summary: echo median $b_med ms during a search ($q_med without); output median $ob_med ms during a search ($oq_med without); flood $fb ms during ($fq without); bound 150"
# Every search of this run finished, over every live session.
jq -s -c '{entries: (map(.entries | length) | add), unanswered: [.[].entries[] | select(.answeredAt == null)]}' "$logs_all"
jq -s -e '(.[0].logging == true) and (map(.entries | length) | add) >= 5' "$logs_all"
jq -s -e '[.[].entries[] | select(.answeredAt == null)] == []' "$logs_all"
[ "$seqs" -ge 3 ]
[ "$cover" -ge 20 ]
[ "$b_med" -le 150 ]
[ "$ob_med" -le 150 ]
# At least half the rate: the flood takes at most twice as long.
[ "$fb" -le $((fq * 2)) ]
