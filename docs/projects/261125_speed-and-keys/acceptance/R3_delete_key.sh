#!/usr/bin/env bash
# R3 delete key — proves R3, R4, R5, U1, U2: Ctrl+D deletes a closed session where Ctrl+R would resume it, after the confirmation; the toast names it; the neighbour is shown; a live or unresumable session is never deleted.
# Asserts: Ctrl+PgDn onto a closed profile shows the toast "Press ^R or Enter to resume the session, ^D to delete it"; a real Ctrl+D opens the delete confirmation naming that profile; Cancel: the profile is still listed, no session deleted, the focus is back in the terminal (U2); Ctrl+D then confirm: the profile is gone from the list and from the engine, the row that followed it is selected, in playback, not resumed (R3, R5); the same from the search box: the box keeps the focus and its text after the confirm and after the cancel (R7, U2); in a live profile whose shell runs cat, Ctrl+D ends cat (the shell prints a marker afterwards) and the profile count is unchanged (U1); a held Ctrl+D (key repeat) on a closed profile opens one confirmation and deletes at most that one profile.
# Also (design review 2026-11-25, F1-F16): Ctrl+PgDn immediately followed by Ctrl+D (within 50 ms) never opens a confirmation for a profile that is not drawn: none opens, or it names the drawn profile; the confirmation always names the profile that is then deleted; after a delete from search the selected profile is listed and is not the deleted one; deleting the only remaining profile leaves the empty screen and errors == 0.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R3_delete_key
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$ZBUI_LIB_IF"; source "$here/lib_sk.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and keys on the private display"
set -x
TOAST='Press ^R or Enter to resume the session, ^D to delete it'
start_app
win_size 1280 800
perf_start | jq -e '.started'

# --- The store: four closed profiles and one live one ----------------------------------
ids=(); declare -A name
for n in 01 02 03 04; do
  s="$(mk_session "dk-$n")"; ids+=("$s"); name[$s]="dk-$n"
  sinput "$s" "echo DKM\"\"${n}K; sleep 1; exit"
done
L="$(mk_session dk-live)"; name[$L]=dk-live
sinput "$L" 'echo LIVE""READY'
four_closed() {
  api GET /sessions | jq -e --arg l "$L" 'length == 5
    and ([.[] | select(.active | not)] | length) == 4
    and any(.[]; .sessionId == $l and .active)' >/dev/null
}
wait_until 60 four_closed
count() { api GET /sessions | jq 'length'; }
listed() { api GET /sessions | jq -e --arg s "$1" 'any(.[]; .sessionId == $s)' >/dev/null; }
gone() { ! listed "$1"; }
active_of() { api GET /sessions | jq -r --arg s "$1" '.[] | select(.sessionId == $s) | .active'; }
order_ids() { cmd '{"command":"session-order"}' | jq -c '.ids'; }
modal_title() { state | jq -r '.modal.title // empty'; }
modal_open() { [ -n "$(modal_title)" ]; }
no_modal() { ! modal_open; }
overlays() { cmd '{"command":"session-order"}' | jq '.overlays'; }
term_focused() { sstate | jq -e '.terminalFocused' >/dev/null; }
selected() { sstate | jq -r '.selectedId // empty'; }
mode() { perf_read | jq -r '.mode'; }
toast_shown() { [ "$(sty '.toast' | jq -r '.text // empty')" = "$TOAST" ]; }
# The shown closed profile is drawn (the Ctrl+D guard waits for that, design F1).
shown_closed() {
  perf_read | jq -e --arg s "$1" '.selectedId == $s and .mode == "playback"' >/dev/null
}

# --- R4: Ctrl+PgDn onto a closed profile whose next row is closed too --------------------
order="$(order_ids)"
C="$(jq -r --argjson cl "$(api GET /sessions | jq -c '[.[] | select(.active | not) | .sessionId]')" '
  . as $o | [range(0; length - 1) as $i
    | select(($cl | index($o[$i])) != null and ($cl | index($o[$i + 1])) != null) | $o[$i]] | first' <<<"$order")"
test -n "$C" && test "$C" != null
select_session "$L"
wait_until 15 guard_off
focus_terminal
walk_to "$C"
wait_until 15 shown_closed "$C"
wait_until 5 toast_shown
echo "toast: $(sty '.toast' | jq -c '.text')"
toast_shown
test "$(active_of "$C")" = false

# --- U2: Ctrl+D, then Cancel ----------------------------------------------------------
n0="$(count)"
key ctrl+d
wait_until 10 modal_open
echo "confirmation: $(modal_title)"
test "$(modal_title)" = "Delete \"${name[$C]}\"?"
key Escape
wait_until 10 no_modal
sleep 0.5
listed "$C"
test "$(count)" = "$n0"
test "$(selected)" = "$C"
term_focused
test "$(active_of "$C")" = false

# --- R3, R5: Ctrl+D, then confirm: deleted, the row after it shown, not resumed ---------
drawn="$(drawn_ids)"
N1="$(jq -r --arg s "$C" '. as $d | ($d | index($s)) as $i | [$d[($i + 1):][] | select(. != $s)] | first' <<<"$drawn")"
test -n "$N1" && test "$N1" != null
test "$(active_of "$N1")" = false
key ctrl+d
wait_until 10 modal_open
test "$(modal_title)" = "Delete \"${name[$C]}\"?"
key Return
wait_until 20 gone "$C"
wait_until 15 shown_closed "$N1"
sleep 1
test "$(count)" = "$((n0 - 1))"
! cmd '{"command":"session-order"}' | jq -e --arg s "$C" 'any(.ids[]; . == $s)'
test "$(selected)" = "$N1"
test "$(mode)" = playback
test "$(active_of "$N1")" = false
term_focused
jq -e '.errors == 0' <<<"$(perf_read)"

# --- F2: a held Ctrl+D opens one confirmation; confirm deletes that profile only ----------
n1="$(count)"
xdo keydown --clearmodifiers ctrl+d
peak=0
for k in 1 2 3 4 5 6; do
  sleep 0.25
  o="$(overlays)"; [ "$o" -gt "$peak" ] && peak="$o"
done
xdo keyup ctrl+d
sleep 0.5
o="$(overlays)"; [ "$o" -gt "$peak" ] && peak="$o"
echo "held Ctrl+D: peak overlays $peak"
test "$peak" = 1
test "$(modal_title)" = "Delete \"${name[$N1]}\"?"
drawn="$(drawn_ids)"
N2="$(jq -r --arg s "$N1" '. as $d | ($d | index($s)) as $i
  | ([$d[($i + 1):][] | select(. != $s)] + ([$d[:$i][] | select(. != $s)] | reverse)) | first' <<<"$drawn")"
key Return
wait_until 20 gone "$N1"
sleep 1
test "$(count)" = "$((n1 - 1))"
listed "$L"
no_modal
# The neighbour is shown (the live one is shown live; a closed one in playback, not resumed).
wait_until 15 _bs_shows "$N2"
if [ "$N2" != "$L" ]; then wait_until 15 shown_closed "$N2"; test "$(active_of "$N2")" = false; fi

# --- F1: Ctrl+PgDn and Ctrl+D within 50 ms: no confirmation for a profile not drawn -------
# From a closed profile, the way whose next row is closed (never onto the live one: a Ctrl+D
# that reaches its shell would end it).
X="$(api GET /sessions | jq -r --arg l "$L" '[.[] | select(.sessionId != $l)] | .[0].sessionId')"
Y="$(api GET /sessions | jq -r --arg l "$L" --arg x "$X" '[.[] | select(.sessionId != $l and .sessionId != $x)] | .[0].sessionId')"
test -n "$Y" && test "$Y" != null
focus_terminal
walk_to "$X"
wait_until 15 shown_closed "$X"
order="$(order_ids)"
dir="$(jq -r --arg x "$X" --arg y "$Y" '. as $o | ($o | index($x)) as $i | length as $n
  | if $o[($i + 1) % $n] == $y then "Next" elif $o[($i - 1 + $n) % $n] == $y then "Prior" else "none" end' <<<"$order")"
test "$dir" != none
n2="$(count)"
xdo key --clearmodifiers --delay 20 "ctrl+$dir" ctrl+d
sleep 1.5
t="$(modal_title)"; sel="$(selected)"
echo "F1: selected $sel, confirmation '${t}'"
test "$sel" = "$Y"
if [ -n "$t" ]; then
  test "$t" = "Delete \"${name[$Y]}\"?"
  key Escape
  wait_until 10 no_modal
fi
test "$(count)" = "$n2"
listed "$X"; listed "$Y"

# --- The search box (P5): Ctrl+D from the box; the focus and the text stay after the cancel
# --- and after the confirm (R7, U2); the selected profile is listed and not the deleted one (F13).
in_box() {
  sstate | jq -e '.searchActive and .box.focused and .box.value == "dk-" and .sectionsDrawn
    and (.terminalFocused | not)' >/dev/null
}
focus_terminal
click_box
xdo type --delay 30 -- dk-
wait_search
wait_until 10 in_box
srows() { cmd '{"command":"search-mode"}' | jq -c '[.rows[].id]'; }
Z="$(jq -r --arg l "$L" --arg s "$(selected)" '[.[] | select(. != $l and . != $s)] | first' <<<"$(srows)")"
test -n "$Z" && test "$Z" != null
at="$(cmd '{"command":"search-mode"}' | jq -r '.cursorRow.index // 0')"
to="$(jq -r --arg z "$Z" 'index($z)' <<<"$(srows)")"
if [ "$to" -gt "$at" ]; then keys 700 Down "$((to - at))"; else keys 700 Up "$((at - to))"; fi
wait_until 15 shown_closed "$Z"
n4="$(count)"
key ctrl+d
wait_until 10 modal_open
echo "search confirmation: $(modal_title)"
test "$(modal_title)" = "Delete \"${name[$Z]}\"?"
key Escape
wait_until 10 no_modal
sleep 0.5
wait_until 5 in_box
listed "$Z"
test "$(count)" = "$n4"
test "$(selected)" = "$Z"
key ctrl+d
wait_until 10 modal_open
test "$(modal_title)" = "Delete \"${name[$Z]}\"?"
key Return
wait_until 20 gone "$Z"
sleep 1
wait_until 5 in_box
test "$(count)" = "$((n4 - 1))"
s="$(selected)"
echo "after the delete from search: selected $s"
test -n "$s" && test "$s" != "$Z"
listed "$s"
jq -e '.errors == 0' <<<"$(perf_read)"
key Escape
wait_until 10 term_focused

# --- U1: Ctrl+D in a live shell running cat ends cat, deletes nothing ---------------------
select_session "$L"
wait_until 15 guard_off
focus_terminal
sinput "$L" 'cat; echo CAT""DONE'
sleep 1
n3="$(count)"
key ctrl+d
wait_until 10 term_has CATDONE
sleep 0.5
no_modal
test "$(count)" = "$n3"
test "$(active_of "$L")" = true
test "$(selected)" = "$L"

# --- F12: delete every profile by key; the last leaves the empty screen ---------------------
sinput "$L" exit
l_closed() { test "$(active_of "$L")" = false; }
wait_until 20 l_closed
wait_until 15 shown_closed "$L"
while [ "$(count)" -gt 0 ]; do
  s="$(selected)"
  test -n "$s"
  wait_until 15 shown_closed "$s"
  before="$(count)"
  key ctrl+d
  wait_until 10 modal_open
  test "$(modal_title)" = "Delete \"${name[$s]}\"?"
  key Return
  wait_until 20 gone "$s"
  test "$(count)" = "$((before - 1))"
  sleep 1
done
sleep 1
test -z "$(selected)"
test "$(count)" = 0
no_modal
title="$(sty '#title' | jq -r '.text // empty')"
echo "empty screen: selected none, title '$title'"
test "$title" = 'No session selected'
jq -e '.errors == 0' <<<"$(perf_read)"
echo "R3 delete key: PASS"
