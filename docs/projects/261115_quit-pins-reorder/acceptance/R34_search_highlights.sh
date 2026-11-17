#!/usr/bin/env bash
# R34 search highlights — proves R34, R35, R36, U6: the in-session search's highlights are xterm decorations kept on their lines: scrolling the view registers and disposes none; on the alternate screen (less) a one-line scroll keeps the moved rows' highlights and adds only the rows scrolled in, with no stale highlight 150 ms after the key; back on the normal screen nothing of less's highlights is left; past 2000 matching rows at most 2000 rows are highlighted, around the view, re-chosen after a scroll; after a resize they are still on the query's cells.
# Asserts (in-session debug state: highlights {rows, registered, disposed, window}, drawn [{row, col, width}] with drawnCells (the text each covers), screen [row text]): normal buffer, 100 matching rows over ~10 screens: rows == 100; 30 wheel clicks up (viewportY moved): registered and disposed unchanged, drawn non-empty, every drawn cell text holds the query (case-insensitive); less on a file (alternate): every screen row holding the query is drawn and every drawn one holds it; after "j" and after "k" (to the PTY), 150 ms later, the same, and registered grew by <= 3 and disposed by <= 3 per key; after "f" (a page) the same; "q": buffer normal, every drawn cell text holds the query; 4500 matching rows (the scrollback holds 5000; more than 2000 matches counted): rows <= 2000, window set, every screen row drawn; 150 wheel clicks up: window changed, every screen row drawn; a resize to 1000x700: every drawn cell text holds the query.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R34_search_highlights
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_qp.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real wheel clicks and key presses on the private display"
set -x
start_app
win_size 1280 800
s="$(seed_session r34 'echo R34""READY' R34READY)"
keys_to() { api POST "/sessions/$s/input" "$(jq -nc --arg t "$1" '{text: $t}')" >/dev/null; }
ins() { sstate | jq -c '.inSession'; }
hs() { ins | jq -c '.highlights'; }
# Every drawn highlight on the query's cells; with "all", every screen row
# holding the query drawn too.
consistent() { # query [all]
  ins | jq -e --arg q "$1" --arg all "${2:-}" '($q | ascii_downcase) as $q
    | (.drawn | length > 0)
    and ([.drawnCells[] | . // "" | ascii_downcase | contains($q)] | all)
    and (if $all == "all" then
      ([.drawn[].row] | unique) as $d
      | [.screen | to_entries[] | select((.value // "") | ascii_downcase | contains($q)) | .key] as $want
      | ($want - $d) == []
    else true end)'
}
wheel_up() { # clicks
  local r
  r="$(sty '#terminal' | jq -r '.rect | "\((.left + .width / 2) | floor) \((.top + .height / 2) | floor)"')"
  mouse_to ${r% *} ${r#* }
  xdo click --repeat "$1" --delay 15 4
  sleep 0.5
}
# R34: the normal buffer.
sinput "$s" 'for i in $(seq 1 300); do if [ $((i % 3)) = 0 ]; then echo "n$i HL""QX x"; else echo "n$i"; fi; done; echo D""ONE1'
wait_until 20 mirror_has "$s" DONE1
type_box HLQX
total_is() { ins | jq -e --argjson n "$1" '.total == $n' >/dev/null; }
wait_until 15 total_is 100
sleep 0.5
h0="$(hs)"; echo "$h0"
jq -e '.rows == 100' <<<"$h0"
v0="$(ins | jq .viewportY)"
wheel_up 30
h1="$(hs)"; echo "$h1"
ins | jq -e --argjson v "$v0" '.viewportY < $v'
jq -e -n --argjson a "$h0" --argjson b "$h1" '$a.registered == $b.registered and $a.disposed == $b.disposed'
consistent HLQX all
# R35: less on a file.
clear_box
sinput "$s" 'for i in $(seq 1 400); do if [ $((i % 4)) = 0 ]; then echo "a$i AL""QZ y"; else echo "a$i"; fi; done > "$HOME/r34.txt"; clear; less "$HOME/r34.txt"'
alt_on() { ins | jq -e '.buffer == "alternate"' >/dev/null; }
wait_until 15 alt_on
sleep 0.5
type_box ALQZ
has_total() { ins | jq -e '.total > 0' >/dev/null; }
wait_until 15 has_total
sleep 0.5
consistent ALQZ all
for k in j k j j k; do
  a="$(hs)"
  keys_to "$k"; sleep 0.15
  consistent ALQZ all
  b="$(hs)"; echo "$k $a -> $b"
  jq -e -n --argjson a "$a" --argjson b "$b" '($b.registered - $a.registered) <= 3 and ($b.disposed - $a.disposed) <= 3'
done
keys_to f; sleep 0.15
consistent ALQZ all
# U6: back to the shell.
keys_to q
alt_off() { ins | jq -e '.buffer == "normal"' >/dev/null; }
wait_until 10 alt_off
sleep 0.15
ins | jq -e --arg q alqz '[.drawnCells[] | . // "" | ascii_downcase | contains($q)] | all'
sleep 0.6
ins | jq -e --arg q alqz '[.drawnCells[] | . // "" | ascii_downcase | contains($q)] | all'
# R36: 4500 matching rows (the scrollback holds 5000).
clear_box
sinput "$s" 'clear; seq 1 4500 | sed "s/^/CAPZ /"; echo D""ONE2'
wait_until 30 mirror_has "$s" DONE2
type_box CAPZ
big() { ins | jq -e '.total > 2000' >/dev/null; }
wait_until 20 big || { ins | jq -c '{total, length, baseY}'; false; }
sleep 0.8
ins | jq -c '{total, length, baseY}'
sleep 0.8
h="$(hs)"; echo "$h"
jq -e '.rows <= 2000 and .window != null' <<<"$h"
consistent CAPZ all
wheel_up 150
h2="$(hs)"; echo "$h2"
jq -e -n --argjson a "$h" --argjson b "$h2" '$a.window != $b.window and $b.rows <= 2000'
consistent CAPZ all
# A resize: re-scanned, still on the query's cells.
win_size 1000 700; sleep 1.5
consistent CAPZ
