# source me after `activate`, "$ZBUI_LIB", "$ZBUI_LIB_UP", "$ZBUI_LIB_IF". This kit's helpers:
#   perf_start              cmd perf start: empties the probe's buffers (installs it the first time)
#   perf_read [refresh]     cmd perf read: {on, longTasks: [ms], switches: [{sessionId, ms, cold,
#                           timelineMs}], echoes: [ms], echoMisses, errors, selectedId, mode,
#                           timeline: {sessionId, cached, engine, complete, lastSeq, lastTsMs},
#                           transport: {disabled, playerReady, seq}, marks, marksRefreshed};
#                           with "refresh" the scrubber's marks are redrawn before marksRefreshed,
#                           at drawEnd: the clock (end of the span) the last scrubber draw used
#   median '<json array>'   the median of a JSON array of numbers ("null" when empty)
#   maxof '<json array>'    its largest number (0 when empty)
#   le <a> <b>              true when a <= b (numbers; false when a is "null")
#   timing_le <what> <a> <b>  a timing assertion: a <= b, else "TIMING FAIL" and the script goes
#                           on (so its other assertions still run); timing_verdict at the end
#                           exits 1 when any failed
#   switch_ms <perf json> <sid> [cold true|false]   the ms of the switches onto <sid>, a JSON array
#   mk_session <name>       POST /sessions without selecting it; prints the session id
#   engine_invoke <method> '<args json>'   POST /invoke
#   engine_extend <sid>     resumes a closed session in the engine (the renderer does not visit it)
#   engine_timeline <sid> <live|playback>  {length, lastSeq, lastTsMs} of the engine's timeline
#   seed_big_timeline <sid> <entries>      with the app STOPPED: rewrites the session's
#                           timeline.json to <entries> entries (the real ones kept, the rest spread
#                           over the same time span, each naming the packet shown at its time)
#   keys <delay ms> <chord> <count>        <count> real presses of <chord>, <delay> apart, one xdotool run
#   shows <sid>             true when the renderer's selected session is <sid> (for wait_until)
#   drawn_ids               the list's rows in drawn order, a JSON array of session ids
#   markers_shown           the SKM<nn>K markers in the terminal's visible rows, sorted, one per line
#   walk_to <sid> [avoid..] moves the selection to <sid> with real Ctrl+PgDn/PgUp presses along the
#                           drawn order, the way that passes none of <avoid> (fails when neither
#                           way does). The debug server's /switch and a row click RESUME a closed
#                           session, which moves it to the top of the list and changes the order a
#                           script computed; the keyboard walk leaves it closed and in place.

perf_start() { cmd '{"command":"perf","action":"start"}'; }
perf_read() {
  if [ "${1:-}" = refresh ]; then cmd '{"command":"perf","action":"read","refresh":true}'
  else cmd '{"command":"perf","action":"read"}'; fi
}

median() {
  jq -n --argjson a "$1" '($a | map(select(type == "number")) | sort) as $s
    | ($s | length) as $n
    | if $n == 0 then null
      elif $n % 2 == 1 then $s[($n - 1) / 2]
      else (($s[$n / 2 - 1] + $s[$n / 2]) / 2) end'
}
maxof() { jq -n --argjson a "$1" '$a | map(select(type == "number")) | (max // 0)'; }
le() { jq -en --argjson a "$1" --argjson b "$2" '($a | type) == "number" and $a <= $b' >/dev/null; }
timing_failed=()
timing_le() {
  if le "$2" "$3"; then echo "TIMING ok: $1 = $2 <= $3"
  else echo "TIMING FAIL: $1 = $2, wanted <= $3"; timing_failed+=("$1=$2>$3"); fi
}
timing_verdict() {
  if [ "${#timing_failed[@]}" -gt 0 ]; then
    echo "$1: FAIL at timing: ${timing_failed[*]}"; return 1
  fi
}

switch_ms() {
  jq -c --arg s "$2" --arg c "${3:-any}" \
    '[.switches[] | select(.sessionId == $s and ($c == "any" or (.cold | tostring) == $c)) | .ms]' <<<"$1"
}

mk_session() {
  api POST /sessions "$(jq -nc --arg n "$1" '{name: $n, cols: 100, rows: 30, select: false}')" \
    | jq -er '.sessionId'
}

engine_invoke() {
  local args="${2:-}"
  [ -n "$args" ] || args='{}'
  api POST /invoke "$(jq -nc --arg m "$1" --argjson a "$args" '{method: $m, args: $a}')"
}
engine_extend() { engine_invoke session.extend "$(jq -nc --arg s "$1" '{sessionId: $s}')" >/dev/null; }
engine_timeline() {
  local method=session.open
  [ "${2:-live}" = playback ] && method=player.open
  engine_invoke "$method" "$(jq -nc --arg s "$1" '{sessionId: $s}')" \
    | jq -c '(.timeline // []) | {length: length, lastSeq: (last | .seq), lastTsMs: (last | .tsMs)}'
}

seed_big_timeline() {
  local sid="$1" n="$2" f
  f="$(find "$ZBUI_APP_STORAGE" -type f -path "*/$sid/timeline.json" | head -n1)"
  if [ -z "$f" ]; then
    echo "seed_big_timeline: no timeline.json for $sid under $ZBUI_APP_STORAGE" >&2
    return 1
  fi
  node -e '
    const fs = require("fs")
    const file = process.argv[1]
    const want = Number(process.argv[2])
    const real = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!Array.isArray(real) || real.length < 2) throw new Error("timeline too short: " + file)
    const t0 = real[0].tsMs
    const span = real[real.length - 1].tsMs - t0
    if (!(span > 0)) throw new Error("timeline has no time span: " + file)
    const pad = want - real.length
    const out = [real[0]]
    let r = 0
    for (let i = 0; i < pad; i++) {
      const tsMs = t0 + Math.floor(((i + 1) * span) / (pad + 1))
      while (r + 1 < real.length && real[r + 1].tsMs <= tsMs) out.push(real[++r])
      out.push({ seq: real[r].seq, tsMs, hd: !!real[r].hd })
    }
    while (r + 1 < real.length) out.push(real[++r])
    fs.writeFileSync(file, JSON.stringify(out))
    console.error("seed_big_timeline: " + file + " " + real.length + " -> " + out.length + " entries")
  ' "$f" "$n"
}

keys() {
  local delay="$1" chord="$2" n="$3" a=() i win parts plus
  for ((i = 0; i < n; i++)); do a+=("$chord"); done
  # Kit correction 2026-11-25 (P6 builder): xdotool's --delay is spent per key of a chord, half
  # after each press and half after each release, so "ctrl+Next" with --delay 700 came 1400 ms
  # apart, not the 700 this helper promises (R1 ran ~260 s of its 240). The delay is divided by
  # the chord's key count, so presses are <delay> apart as documented above.
  plus="${chord//[^+]/}"; parts=$((${#plus} + 1))
  win="$(_zbui_window)"
  [ -n "$win" ] && xdo windowfocus --sync "$win" >/dev/null 2>&1 || true
  xdo key --clearmodifiers --delay "$((delay / parts))" "${a[@]}"
}

shows() { perf_read | jq -e --arg s "$1" '.selectedId == $s' >/dev/null; }
drawn_ids() { cmd '{"command":"session-order"}' | jq -c '[.rows[].id]'; }
markers_shown() { term_text | grep -oE 'SKM[0-9]+K' | sort -u || true; }

_sel_id() { sstate | jq -r '.selectedId'; }
walk_to() {
  local sid="$1" from order plan dir n
  shift
  from="$(_sel_id)"
  [ "$from" = "$sid" ] && return 0
  order="$(cmd '{"command":"session-order"}' | jq -c '.ids')"
  plan="$(jq -r --arg f "$from" --arg t "$sid" --argjson av "$(printf '%s\n' "$@" | jq -Rsc 'split("\n") | map(select(. != ""))')" '
    . as $o | length as $n | ($o | index($f)) as $i | ($o | index($t)) as $j
    | ((($j - $i) % $n + $n) % $n) as $fw | ($n - $fw) as $bw
    | def clear(ids): all(ids[]; . as $x | ($av | index($x)) == null);
      if clear([range(1; $fw) | $o[($i + .) % $n]]) then "Next \($fw)"
      elif clear([range(1; $bw) | $o[(($i - .) % $n + $n) % $n]]) then "Prior \($bw)"
      else "none" end' <<<"$order")"
  echo "walk_to: $from -> $sid: $plan (order $order)" >&2
  [ "$plan" != none ] || return 1
  dir="${plan% *}"; n="${plan#* }"
  keys 700 "ctrl+$dir" "$n"
  wait_until 15 _bs_shows "$sid"
}
