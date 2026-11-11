#!/usr/bin/env bash
# U3 responsive — proves U3: typing and output in the terminal stay responsive while a cross-session search runs over several full buffers.
# Asserts: five sessions filled to 5000 lines of 200 columns; while a search for a 1-character query (most matches) runs, a key typed in the selected session echoes within 150 ms (time from POST input to the byte in GET /sessions/:id/stats's frame, median of 10), and the same measure without a search is recorded beside it in the log; buffer-search-log shows every search finished (no request left unanswered).
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
wait_search 60
log="$(bslog)"
jq -c '.logging, (.entries | length), [.entries[] | select(.answeredAt == null)]' <<<"$log"
# The searches ran, over every live session, and every one finished.
jq -e '.logging == true and (.entries | length) >= 5' <<<"$log"
jq -e '[.entries[] | select(.answeredAt == null)] == []' <<<"$log"
[ "$b_med" -le 150 ]
