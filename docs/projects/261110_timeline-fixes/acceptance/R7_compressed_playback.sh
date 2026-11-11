#!/usr/bin/env bash
# R7 compressed_playback — proves R7: collapse on, playing across the 20 s gap at 1x: clockTs sampled every 100 ms is monotonic and keeps moving, the gap passes in about the threshold, and pause then play mid-gap does not jump
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/../../261110_ui-chrome/acceptance/lib.sh"
need uisolate "the app runs only on a private display"
need xdotool "real mouse and keys on the private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
source "$(cd "$(dirname "$0")" && pwd)/tf.sh"
start_app
api POST /window/bounds '{"x":0,"y":0,"width":1280,"height":800}' >/dev/null
seed_gap_session "r7 gap" 20 >/dev/null
# Into playback, then back to the start of the recording (the scrubber's left end).
alt_wheel back
s="$(state)"
read -r x y < <(jq -r '.controls.scrubber.rect | "\((.left + 1) | floor) \((.top + .height / 2) | floor)"' <<<"$s")
click_at "$x" "$y"
sleep 1.5
set_collapse true
p="$(pstate)"; jq -c 'del(.timeline)' <<<"$p"
jq -e '.mode == "playback" and (.playing | not) and .collapse and .compMs < 1000' <<<"$p"
# The 20 s gap: the two recorded packets either side of the longest gap.
read -r gap_from gap_to < <(jq -r '.timeline | [range(1; length) as $i | [.[$i-1][1], .[$i][1]]] | max_by(.[1] - .[0]) | "\(.[0]) \(.[1])"' <<<"$p")
echo "gap: $gap_from .. $gap_to ($(( (gap_to - gap_from) / 1000 )) s)"
test $((gap_to - gap_from)) -ge 19000
threshold=$(jq -r .thresholdMs <<<"$p")
# Play at 1x and sample the clock every 100 ms until it is past the gap (or 12 s).
cmd '{"command":"click","selector":"#playPause"}' >/dev/null
samples="$ACCEPT_LOG_DIR/R7.samples"
: >"$samples"
end=$((SECONDS + 12))
while [ "$SECONDS" -lt "$end" ]; do
  pstate | jq -c '{t: .at, clockTs, compMs, playing}' >>"$samples"
  if tail -n1 "$samples" | jq -e --argjson to "$gap_to" '.clockTs > $to + 500' >/dev/null; then break; fi
  sleep 0.1
done
wc -l <"$samples"
cat "$samples"
# Monotonic: neither clock ever steps back.
jq -se '[range(1; length) as $i | .[$i].clockTs >= .[$i-1].clockTs and .[$i].compMs >= .[$i-1].compMs] | all' "$samples"
# Kit correction 2026-11-11 (builder P1): "keeps moving" is measured on compMs, the
# clock on the compressed timeline the user sees (playback-state). Today clockTs does
# move inside the gap, in real units, so a check on clockTs alone passes while the
# shown time stalls (design.md *Causes*, R7).
# Through the gap (packets either side), the compressed clock keeps moving at about
# 1x: every 300 ms window of wall time advances it by at least half of that.
jq -sc --argjson from "$gap_from" --argjson to "$gap_to" '
  [ .[] | select(.clockTs >= $from and .clockTs < $to and .playing) ] as $g
  | {inGap: ($g | length), wallMs: (($g[-1].t // 0) - ($g[0].t // 0)), compMs: (($g[-1].compMs // 0) - ($g[0].compMs // 0)),
     realMs: (($g[-1].clockTs // 0) - ($g[0].clockTs // 0))}' "$samples"
jq -se --argjson from "$gap_from" --argjson to "$gap_to" '
  [ .[] | select(.clockTs >= $from and .clockTs < $to and .playing) ] as $g
  | ($g | length) >= 4
    and ([ range(0; ($g | length) - 3) as $i | ($g[$i+3].compMs - $g[$i].compMs) >= 0.5 * ($g[$i+3].t - $g[$i].t) ] | all)' "$samples"
# The gap passes in about the threshold of wall time (± 1 s).
jq -se --argjson from "$gap_from" --argjson to "$gap_to" --argjson th "$threshold" '
  [ .[] | select(.clockTs >= $from and .clockTs < $to) | .t ] as $ts
  | ($ts | length) > 0 and (($ts[-1] - $ts[0]) - $th | fabs) <= 1000' "$samples"
# Pause mid-gap, wait, play: the clock does not jump.
click_at "$x" "$y"
sleep 1.5
cmd '{"command":"click","selector":"#playPause"}' >/dev/null
wait_until 15 sh -c "curl -s http://127.0.0.1:$ZBUI_PORT/renderer/command -H 'content-type: application/json' -d '{\"command\":\"playback-state\"}' | jq -e --argjson f $gap_from '.clockTs > \$f' >/dev/null"
sleep 0.8
cmd '{"command":"click","selector":"#playPause"}' >/dev/null
a="$(pstate)"; sleep 1; b="$(pstate)"
cmd '{"command":"click","selector":"#playPause"}' >/dev/null
sleep 0.3; c="$(pstate)"
jq -c '{clockTs, compMs, playing}' <<<"$a"; jq -c '{clockTs, compMs, playing}' <<<"$b"; jq -c '{clockTs, compMs, playing}' <<<"$c"
jq -e --argjson a "$a" --argjson b "$b" -n '($a.playing | not) and $a.compMs == $b.compMs'
jq -e --argjson b "$b" --argjson c "$c" -n '$c.playing and ($c.compMs - $b.compMs) >= 0 and ($c.compMs - $b.compMs) <= 800'
