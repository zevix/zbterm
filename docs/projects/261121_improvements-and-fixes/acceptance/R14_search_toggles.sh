#!/usr/bin/env bash
# R14 search toggles — proves R14, R15, R16, U5: the status line's search position reads "M / N" with M bold cyan, the slash plain and N cyan not bold; two toggles beside the box's x, "Match case" and "Match whole word", each with its hover text, narrow every search the box drives (the name list and its cyan marks, the terminal's count, the live sessions' counts) without taking the focus from the box, and are remembered across a restart; while the engine starts the list says "Loading profiles…" (never "No sessions yet"), and the engine starts before the page has loaded.
# Asserts: profiles "Build-TMP", "tmpfiles", the current "my tmp" and "delta"; "my tmp" and "delta" print "x tmp y", "TMP", "tmpdir", "a_tmp". Typing "tmp": status "1 / 4 (In terminal …)", its first span (text "1") cyan weight 700, its second (text "4") cyan weight 400, the " / " between them the line's own colour; name rows Build-TMP and tmpfiles; delta's buffer row "4 matches". A real click on Match case: aria-pressed true, cyan, the box keeps the focus and "tmp"; status "M / 3", name rows tmpfiles only (its mark "tmp"), delta "3 matches". Then Match whole word too: "M / 1", no name rows, delta "1 match". Match case off (word on): "M / 2", Build-TMP only (its mark "TMP"), delta "2 matches". Hovering each toggle: its title is "Match case…" / "Match whole word…". After a restart: whole word still on, case still off; the list showed "Loading profiles…" while the engine started and never "No sessions yet"; the log has the engine's start (app:mode) before the page's first call (app.info).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R14_search_toggles
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_if.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and keys on the private display"
set -x
start_app
win_size 1400 800
HINT='(In terminal Enter/Shift+Enter, in profiles ⬆️/⬇️ )'
# Each output line spelled with t""mp, so the typed command line holds no "tmp".
LINES='echo "x t""mp y"; echo "T""MP"; echo "t""mpdir"; echo "a_t""mp"'
a="$(seed_session Build-TMP 'echo A""READY' AREADY false)"
b="$(seed_session tmpfiles 'echo B""READY' BREADY false)"
d="$(seed_session delta "$LINES; echo D""READY" DREADY false)"
c="$(seed_session 'my tmp' "$LINES; echo C""READY" CREADY)"
select_session "$c"
# Kit correction 2026-11-21: the All/Active toggle above the list stays shown and in place (the
# first R14 build reused its class name and hid it).
sty '#activeOnly' | jq -e '.visible and .rect.width > 20 and .rect.height > 10'

# "M / N": after a toggle the current match keeps its place when it still matches, so a step
# names N exactly and M as "*" (any) or exactly.
pos_is() {
  local got m="${1%% / *}" n="${1##* / }" re
  got="$(status_text)"
  [ "$m" = "*" ] && m='[1-9][0-9]*'
  re="^${m} / ${n} "
  [[ "$got" =~ $re ]] && [ "${got#* / $n }" = "$HINT" ]
}
names() { sstate | jq -c '[.sessions.rows[] | select(.section == "name") | .name] | sort'; }
names_are() { [ "$(names)" = "$1" ]; }
delta_is() {
  sstate | jq -e --arg d "$d" --arg t "$1" \
    'any(.sessions.rows[]; .section == "buffer" and .id == $d and (.sub | contains($t)))' >/dev/null
}
settled() { local p="$1" n="$2" m="$3"; wait_until 15 pos_is "$p" && wait_until 15 names_are "$n" && wait_until 20 delta_is "$m"; }
box_kept() { sstate | jq -e '.box.focused and .box.value == "tmp"'; }
CYAN='rgb(77, 217, 230)'

# --- R14: "M / N" --------------------------------------------------------------------
type_box tmp; wait_search
settled '1 / 4' '["Build-TMP","tmpfiles"]' '4 matches'
sty '#status .search-pos-index' | jq -e --arg c "$CYAN" '.text == "1" and .color == $c and .fontWeight == "700"'
sty '#status .search-pos-total' | jq -e --arg c "$CYAN" '.text == "4" and .color == $c and .fontWeight == "400"'
st="$(sty '#status')"; echo "$st"
jq -e --arg c "$CYAN" '.color != $c and .fontWeight == "400"' <<<"$st"
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R14_status.png" >/dev/null

# --- R15: the toggles ------------------------------------------------------------------
for t in '#searchCase:Match case' '#searchWord:Match whole word'; do
  sel="${t%%:*}"
  r="$(sty "$sel" | jq -c '.rect')"
  mouse_to "$(jq '(.left + .width / 2) | floor' <<<"$r")" "$(jq '(.top + .height / 2) | floor' <<<"$r")"
  sty "$sel" | jq -e --arg t "${t#*:}" '.visible and (.title | startswith($t)) and .ariaPressed == "false"'
done
# Beside the x, inside the box.
x="$(sty '#searchIcon' | jq -c '.rect')"; bx="$(sstate | jq -c '.box.rect')"
for sel in '#searchCase' '#searchWord'; do
  sty "$sel" | jq -e --argjson x "$x" --argjson b "$bx" '.rect.right <= $x.left + 1
    and .rect.left >= $x.left - 60 and .rect.left >= $b.left and .rect.top >= $b.top - 1
    and .rect.bottom <= $b.bottom + 1'
done

click_sel '#searchCase'
sty '#searchCase' | jq -e --arg c "$CYAN" '.ariaPressed == "true" and .color == $c and (.title | startswith("Match case"))'
box_kept
settled '* / 3' '["tmpfiles"]' '3 matches'
sty ".session-row[data-session-id=\"$b\"] .session-name mark.name-match" | jq -e '.text == "tmp"'

click_sel '#searchWord'
sty '#searchWord' | jq -e '.ariaPressed == "true"'
box_kept
settled '* / 1' '[]' '1 match'

click_sel '#searchCase'
sty '#searchCase' | jq -e '.ariaPressed == "false"'
box_kept
settled '* / 2' '["Build-TMP"]' '2 matches'
sty ".session-row[data-session-id=\"$a\"] .session-name mark.name-match" | jq -e '.text == "TMP"'
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R15_toggles.png" >/dev/null

# --- R16 / U5: restart: the toggles remembered, "Loading profiles…" while the engine starts ---
# The next start_app takes this port; a watcher reads the list from the first answer on.
port="$(free_port)"; free_port() { echo "$port"; }
seen="$ACCEPT_LOG_DIR/R16_list_texts.txt"; : >"$seen"
quit_app
before="$(wc -l <"$ZBUI_APP_LOG")"
( end=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$end" ]; do
    out="$(curl -s --max-time 2 -X POST "http://127.0.0.1:$port/renderer/command" \
      -H 'content-type: application/json' -d '{"command":"style-of","selector":"#sessions"}' 2>/dev/null || true)"
    t="$(jq -r '.text // empty' <<<"$out" 2>/dev/null || true)"
    [ -n "$t" ] && echo "$t" >>"$seen"
    grep -q 'delta' <<<"$t" && break
    sleep 0.03
  done ) &
watch=$!
start_app
wait "$watch" || true
cat "$seen" | uniq -c | head -20
grep -qx 'Loading profiles…' "$seen"
! grep -q 'No sessions yet' "$seen"
state | jq -e '.searchOptions == {caseSensitive: false, wholeWord: true}'
state | jq -e '.startup.sessionsLoaded and any(.startup.marks[]; .step == "list drawn")'
log="$(tail -n +"$((before + 1))" "$ZBUI_APP_LOG")"
mode="$(grep -n 'app:mode' <<<"$log" | head -n1 | cut -d: -f1)"
info="$(grep -n 'zbterm:invoke.*app.info' <<<"$log" | head -n1 | cut -d: -f1)"
echo "app:mode at log line $mode, first app.info at $info"
[ -n "$mode" ] && [ -n "$info" ] && [ "$mode" -lt "$info" ]
set +x
echo "R14 search toggles: PASS"
