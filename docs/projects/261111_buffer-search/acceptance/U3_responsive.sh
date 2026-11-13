#!/usr/bin/env bash
# U3 responsive — proves U3: typing and output in the terminal stay responsive while a cross-session search runs over several full buffers.
# Asserts: five sessions filled to 5000 lines of 200 columns; while a search for a 1-character query (most matches) runs, a key typed in the selected session echoes within 150 ms (time from POST input to the byte in GET /sessions/:id/stats's frame, median of 10), and the same measure without a search is recorded beside it in the log; buffer-search-log shows every search finished (no request left unanswered). Kit correction 2026-11-13: output too: a loop in the selected session prints its clock every 0.25 s; the time from a line's clock to its row on screen (median of 10) is within 150 ms while the search is retyped and running, the same measure without a search recorded beside it.
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
# Five sessions, each 5000 lines of 200 columns (zero-padded numbers: "0" matches everywhere).
for n in a b c d e; do
  sid="$(seed_session "u3-$n" 'seq -f "%0199g" 1 5000; echo U3""DONE' U3DONE)"
done
wait_until 10 term_has U3DONE
# echo_ms <char> <typed so far>: from POST input to <typed so far> on the selected session's rows.
echo_ms() {
  local t0 t1 end
  t0="$(date +%s%N)"
  api POST /sessions/current/input "$(jq -nc --arg d "$1" '{data: $d}')" >/dev/null
  end=$((SECONDS + 5))
  until term_text | grep -qF -- "$2"; do
    [ "$SECONDS" -ge "$end" ] && { echo 99999; return 0; }
  done
  t1="$(date +%s%N)"
  echo $(((t1 - t0) / 1000000))
}
median() { sort -n | awk '{a[NR]=$1} END {print int((a[int((NR+1)/2)] + a[int(NR/2)+1]) / 2)}'; }
quiet=()
typed=""
for c in a b c d e f g h i j; do typed="$typed$c"; quiet+=("$(echo_ms "$c" "$typed")"); done
api POST /sessions/current/input '{"data":"\u0015"}' >/dev/null
q_med="$(printf '%s\n' "${quiet[@]}" | median)"
echo "echo ms without a search: ${quiet[*]} (median $q_med)"
# Kit correction 2026-11-13 (builder fix round; report 2026-11-12, finding 6): the row says
# typing *and output* stay responsive; only the echo was measured. Output is now timed too:
# a loop in the selected session prints its own clock ("OT<epoch ms>-<epoch ms>", the
# repeat so a row overwritten in part is never read) every 0.25 s, and
# out_ms waits for the first line printed after it started looking and takes now minus that
# line's clock (the shell and this script read the same clock, bash's $EPOCHREALTIME). Measured without a search
# here and during one below, with the same 150 ms bound on the median.
# out_loop <n> <tag>: the loop, n lines, then OT<tag>END (the command line never holds it).
out_loop() {
  api POST /sessions/current/input "$(jq -nc --arg t "for i in \$(seq $1); do t=\${EPOCHREALTIME//[!0-9]/}; printf 'OT%s-%s\\n' \${t:0:13} \${t:0:13}; sleep 0.25; done; echo OT$2\"\"END" '{text: $t, enter: true}')" >/dev/null
}
# Milliseconds since the epoch from bash's own clock: this host's date (uutils coreutils
# 0.12.0) misprints %3N when the milliseconds start with a zero (043 comes out as 43x).
now_ms() { local t="${EPOCHREALTIME//[!0-9]/}"; echo "${t:0:13}"; }
out_ms() {
  local start ts now rows
  start="$(now_ms)"
  while :; do
    rows="$(term_text)"
    ts="$(sed -nE 's/^OT([0-9]{13})-\1 *$/\1/p' <<<"$rows" | sort -n | tail -n1)"
    now="$(now_ms)"
    if [ -n "$ts" ] && [ "$ts" -gt "$start" ]; then
      echo "out_ms: line clock $ts, seen $now" >&2
      [ $((now - ts)) -ge 0 ] || printf 'out_ms: rows then:\n%s\n' "$rows" >&2
      echo $((now - ts)); return 0
    fi
    [ $((now - start)) -gt 5000 ] && { echo 99999; return 0; }
  done
}
out_done() { term_text | grep -qE "^OT${1}END *$"; }
oquiet=()
out_loop 16 Q
for _ in 1 2 3 4 5 6 7 8 9 10; do oquiet+=("$(out_ms)"); done
wait_until 15 out_done Q
oq_med="$(printf '%s\n' "${oquiet[@]}" | median)"
echo "output ms without a search: ${oquiet[*]} (median $oq_med)"
# The same while a cross-session search for "0" runs: each round retypes the query
# (a new search over the five full buffers), then types into the terminal.
bslog >/dev/null
type_box 0
busy=()
typed=""
for c in k l m n o p q r s t; do
  key BackSpace
  xdo type 0
  sleep 0.25
  typed="$typed$c"
  busy+=("$(echo_ms "$c" "$typed")")
done
api POST /sessions/current/input '{"data":"\u0015"}' >/dev/null
b_med="$(printf '%s\n' "${busy[@]}" | median)"
echo "echo ms during a search: ${busy[*]} (median $b_med; without: $q_med)"
# Output during the search: each round retypes the query (a new search over the five
# buffers; the loop's own lines also re-run the selected session's search), then times a line.
obusy=()
out_loop 60 B
for _ in 1 2 3 4 5 6 7 8 9 10; do
  key BackSpace
  xdo type 0
  obusy+=("$(out_ms)")
done
wait_until 30 out_done B
ob_med="$(printf '%s\n' "${obusy[@]}" | median)"
echo "output ms during a search: ${obusy[*]} (median $ob_med; without: $oq_med)"
echo "U3 summary: echo median $b_med ms during a search ($q_med without); output median $ob_med ms during a search ($oq_med without); bound 150"
wait_search 60
log="$(bslog)"
jq -c '.logging, (.entries | length), [.entries[] | select(.answeredAt == null)]' <<<"$log"
# The searches ran, over every live session, and every one finished.
jq -e '.logging == true and (.entries | length) >= 5' <<<"$log"
jq -e '[.entries[] | select(.answeredAt == null)] == []' <<<"$log"
[ "$b_med" -le 150 ]
[ "$ob_med" -le 150 ]
