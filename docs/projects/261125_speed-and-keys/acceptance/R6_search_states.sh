#!/usr/bin/env bash
# R6 search states — proves R6-R11: results exist only while the search box has the focus; browsing keeps the focus in the box; each key has one meaning; the status line names the state; Ctrl+PgUp/PgDn outside search walk the drawn list.
# Asserts: with text in the box and sections drawn: after a real click on a result row, after Ctrl+R on a closed profile, and after a dialog opened and closed, the box has the focus and the sections are still drawn (R7); a real click in the terminal: the box is empty, the list is plain, a typed key reaches the shell, and the next Ctrl+Shift+F puts the text back selected (R6); after Ctrl+1 (a pinned profile) with text in the box no state exists with sections drawn and the terminal focused (R6); on a closed profile with the resume toast up and matches in its frame, Enter moves the match position and the profile stays closed (R8); Up/Down and Ctrl+PgUp/PgDn move the cursor one row as drawn without wrapping (R8); Esc empties the box and focuses the terminal (R8); with zero matches the status line still starts with the search hint and names the arrows, Enter and Esc, and with matches it starts with "M / N" (R9); outside search, Ctrl+PgDn pressed as many times as there are rows visits each drawn row once in order and returns to the first (R10); during a walk the heading over the top row is "Current session" only while that row is the shown profile (R11).
# Also (design review 2026-11-25, F1-F16): also after a toolbar button click, Ctrl+Shift+B twice and the settings menu opened and closed the box has the focus (R6, R7); with the box emptied by Backspace, Ctrl+R on a closed profile leaves the focus in the box (R7); a new session started by its key during search ends the search and the next typed key reaches the new shell (R6); Shift+Enter moves the match position back (R8); when the shown live profile exits during search the status line gains the ^R and ^D words within 2 s (R9).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R6_search_states
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$ZBUI_LIB_IF"; source "$here/lib_sk.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and keys on the private display"
set -x
TOAST='Press ^R or Enter to resume the session, ^D to delete it'
KEYS='Search: ⬆️/⬇️ profiles · Enter/Shift+Enter matches · Esc exit'
CLOSED_KEYS='^R resume · ^D delete'
start_app
win_size 1280 800
perf_start | jq -e '.started'

# --- Helpers ---------------------------------------------------------------------------
active_of() { api GET /sessions | jq -r --arg s "$1" '.[] | select(.sessionId == $s) | .active'; }
is_closed() { test "$(active_of "$1")" = false; }
selected() { sstate | jq -r '.selectedId // empty'; }
mode() { perf_read | jq -r '.mode'; }
shown_closed() { perf_read | jq -e --arg s "$1" '.selectedId == $s and .mode == "playback"' >/dev/null; }
shown_live() { perf_read | jq -e --arg s "$1" '.selectedId == $s and .mode == "live"' >/dev/null; }
toast_shown() { [ "$(sty '.toast' | jq -r '.text // empty')" = "$TOAST" ]; }
modal_open() { state | jq -e '.modal != null' >/dev/null; }
no_modal() { ! modal_open; }
menu_open() { state | jq -e '.menuOpen' >/dev/null; }
menu_closed() { ! menu_open; }
# In search: the flag set, the box focused and holding <text>, the sections drawn when it
# holds text, the terminal not focused (R6, R7).
in_search() {
  sstate | jq -e --arg v "$1" '.searchActive and .box.focused and .box.value == $v
    and (.terminalFocused | not) and (.sectionsDrawn == ($v != ""))' >/dev/null
}
# In the terminal: no flag, the box empty, a plain list, the terminal focused (R6).
in_terminal() {
  sstate | jq -e '(.searchActive | not) and (.box.focused | not) and .box.value == ""
    and (.sectionsDrawn | not) and .terminalFocused' >/dev/null
}
# The third state, which must never exist: sections drawn while the terminal has the focus.
third_state() { sstate | jq -e '.sectionsDrawn and .terminalFocused' >/dev/null; }
no_third_for() {
  local i
  for ((i = 0; i < $1; i++)); do
    if third_state; then echo "third state: $(sstate | jq -c '{searchActive, sectionsDrawn, terminalFocused, box: .box.value}')"; return 1; fi
    sleep 0.2
  done
}
status_is_search() { status_text | grep -qF -- "$KEYS"; }
status_starts_keys() { [ "$(status_text | cut -c1-${#KEYS})" = "$KEYS" ]; }
status_has_pos() { status_text | grep -qE '^\[[0-9]+ / [0-9]+\] Search: '; }
status_has_closed() { status_text | grep -qF -- "$CLOSED_KEYS"; }
pos_m() { status_text | sed -nE 's/^\[([0-9]+) \/ ([0-9]+)\] .*/\1/p'; }
pos_n() { status_text | sed -nE 's/^\[([0-9]+) \/ ([0-9]+)\] .*/\2/p'; }
pos_is_not() { local m; m="$(pos_m)"; [ -n "$m" ] && [ "$m" != "$1" ]; }
pos_is() { [ "$(pos_m)" = "$1" ]; }
heading0() { sstate | jq -r '.sessions.headings[0].text // empty'; }
heading_is() { [ "$(heading0)" = "$1" ]; }
cursor_index() { cmd '{"command":"search-mode"}' | jq -r '.cursorRow.index // -1'; }
row_count() { cmd '{"command":"search-mode"}' | jq -r '.rows | length'; }
cursor_is() { [ "$(cursor_index)" = "$1" ]; }
# Moves the search cursor (Up/Down in the box) onto the first drawn row of <sid>.
search_walk_to() {
  local sid="$1" at to n dir
  at="$(cursor_index)"
  to="$(cmd '{"command":"search-mode"}' | jq -r --arg s "$sid" '[.rows[].id] | index($s) // -1')"
  [ "$to" -ge 0 ] || { echo "search_walk_to: $sid not drawn" >&2; return 1; }
  if [ "$at" -lt 0 ]; then at=0; fi
  if [ "$to" -gt "$at" ]; then dir=Down; n=$((to - at)); else dir=Up; n=$((at - to)); fi
  [ "$n" -gt 0 ] && keys 500 "$dir" "$n"
  wait_until 15 _bs_shows "$sid"
}

# --- The store ---------------------------------------------------------------------------
# Kit correction 2026-11-25 (P6 builder): lib_up.sh's seed_session first waits up to 20 s for a
# '$ ' prompt in the GET /sessions/<id> frame, which never shows it in this kit (P5 Gotchas), so
# each of the three seeds below cost a fixed 20 s. seed_fast is seed_session without that wait:
# the same create (selected), the same input (the PTY holds it until bash reads it, as R1/R3's
# mk_session + sinput rely on) and the same 60 s wait for the text in the mirror.
seed_fast() {
  local sid
  sid="$(api POST /sessions "$(jq -nc --arg n "$1" '{name: $n, cols: 100, rows: 30, select: true}')" | jq -er '.sessionId')"
  sinput "$sid" "$2"
  wait_until 60 mirror_has "$sid" "$3" || { echo "seed_fast: '$3' never reached $1 ($sid)" >&2; return 1; }
  echo "$sid"
}
# The command lines spell "z""q", so only the output lines match "zq".
g="$(seed_fast gamma-zq 'echo "x z""q y"; echo "z""q"; echo G""READY' GREADY)"
a="$(seed_fast alpha-zq 'echo A""READY' AREADY)"
e="$(seed_fast exit-me 'echo E""READY' EREADY)"
c="$(mk_session closed-c)"
sinput "$c" 'echo "z""q one"; echo "z""q two"; echo "z""q three"; echo C""DONE; sleep 1; exit'
d="$(mk_session closed-d)"
sinput "$d" 'echo D""DONE; sleep 1; exit'
wait_until 60 is_closed "$c"
wait_until 60 is_closed "$d"
# A pinned profile for Ctrl+1 (R6's exit).
row_action "$a" pin >/dev/null
sleep 1
cmd '{"command":"session-order"}' | jq -e --arg a "$a" '.pinned | index($a) != null'
select_session "$g"
wait_until 15 guard_off
focus_terminal
wait_until 10 in_terminal

# --- R9, R11: the box takes the focus; the status line names the search ------------------
click_box
wait_until 10 in_search ''
wait_until 10 status_is_search
status_starts_keys
xdo type --delay 30 -- zq
wait_search
wait_until 10 in_search zq
wait_until 10 status_has_pos
echo "status with matches: $(status_text)"
heading_is 'Current session'
test "$(sstate | jq -r '.sessions.rows[0].id')" = "$g"

# --- R7: a real click on a result row: shown, the focus and the sections stay ---------------
wait_until 15 guard_off
r="$(row_rect "$a")"
click_at "$(jq -r '(.left + 40) | floor' <<<"$r")" "$(jq -r '(.top + .height / 2) | floor' <<<"$r")"
wait_until 15 _bs_shows "$a"
sleep 0.5
wait_until 5 in_search zq
no_third_for 5
# R11: the walk has left the top row: its heading says so.
wait_until 5 heading_is 'Search started here'

# --- F9: toolbar buttons, Ctrl+Shift+B twice, the settings menu ---------------------------
for sel in '#themeToggle' '#themeToggle' '#activeOnly' '#activeOnly'; do
  click_sel "$sel"
  sleep 0.5
  wait_until 5 in_search zq
done
key ctrl+shift+b
sleep 0.5
wait_until 5 in_search zq
key ctrl+shift+b
sleep 0.8
wait_until 5 in_search zq
click_sel '#settingsToggle'
wait_until 5 menu_open
in_search zq
click_sel '#settingsToggle'
wait_until 5 menu_closed
sleep 0.3
wait_until 5 in_search zq
no_third_for 3

# --- R7: a dialog opened from search (the "+ New" button) and closed -----------------------
n0="$(api GET /sessions | jq 'length')"
click_sel '#newSession'
wait_until 15 modal_open
sstate | jq -e '.searchActive'
key Escape
wait_until 10 no_modal
sleep 0.5
wait_until 5 in_search zq
test "$(api GET /sessions | jq 'length')" = "$n0"

# --- R8: Enter with the resume toast up steps a match; the profile stays closed -------------
wait_until 15 guard_off
search_walk_to "$c"
wait_until 15 shown_closed "$c"
wait_until 10 status_has_pos
wait_until 5 status_has_closed
echo "status on the closed profile: $(status_text)"
test "$(pos_n)" = 3
toast_shown
p0="$(pos_m)"
key Return
wait_until 5 pos_is_not "$p0"
p1="$(pos_m)"
key Return
wait_until 5 pos_is_not "$p1"
p2="$(pos_m)"
echo "Enter, Enter: $p0 -> $p1 -> $p2"
sleep 0.5
is_closed "$c"
test "$(mode)" = playback
test "$(selected)" = "$c"
in_search zq
key shift+Return
wait_until 5 pos_is "$p1"
echo "Shift+Enter: $p2 -> $(pos_m)"
is_closed "$c"
in_search zq

# --- R7: Ctrl+R resumes; the focus stays in the box ------------------------------------------
key ctrl+r
wait_until 20 shown_live "$c"
sleep 0.5
wait_until 5 in_search zq
no_third_for 3

# --- R9: zero matches: the status line still names the search and its keys -----------------
key ctrl+a
xdo type --delay 30 -- qqnomatchqq
wait_search
wait_until 10 in_search qqnomatchqq
wait_until 10 status_starts_keys
echo "status, zero matches: $(status_text)"
! status_has_pos

# --- F10: the box emptied by Backspace; Ctrl+R on a closed profile keeps the box ------------
key ctrl+a
key BackSpace
wait_search
wait_until 10 in_search ''
wait_until 10 status_starts_keys
search_walk_to "$d"
wait_until 15 shown_closed "$d"
wait_until 5 status_has_closed
key ctrl+r
wait_until 20 shown_live "$d"
sleep 0.5
wait_until 5 in_search ''

# --- R8: Up/Down and Ctrl+PgUp/PgDn move the cursor one row as drawn, no wrap ---------------
rows="$(row_count)"
keys 500 Up "$rows"
wait_until 10 cursor_is 0
key Up
sleep 0.8
cursor_is 0
key Down
wait_until 10 cursor_is 1
key ctrl+Next
wait_until 10 cursor_is 2
key ctrl+Prior
wait_until 10 cursor_is 1
keys 500 Down "$rows"
wait_until 10 cursor_is "$((rows - 1))"
key ctrl+Next
sleep 0.8
cursor_is "$((rows - 1))"
in_search ''

# --- F12: the shown live profile exits during search: ^R and ^D join the line within 2 s ----
xdo type --delay 30 -- zq
wait_search
wait_until 10 in_search zq
search_walk_to "$e"
wait_until 15 shown_live "$e"
sleep 0.5
! status_has_closed
t0="$(date +%s%N)"
sinput "$e" exit
wait_until 10 status_has_closed
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
echo "F12: ^R/^D in the status line after $ms ms: $(status_text)"
test "$ms" -le 2000
in_search zq

# --- R6: a real click in the terminal ends the search; the text comes back on the next focus -
search_walk_to "$g"
wait_until 15 shown_live "$g"
sinput "$g" 'read -rsn1 k; printf "GOT%q\n" "$k"'
sleep 0.5
focus_terminal
wait_until 10 in_terminal
sstate | jq -e '.remembered == "zq"'
no_third_for 3
key x
wait_until 15 mirror_has "$g" 'GOTx'
key ctrl+shift+f
wait_search
wait_until 10 in_search zq
sstate | jq -e '.box.selStart == 0 and .box.selEnd == 2'

# --- R11: a fresh walk: "Current session" only while the top row is the one shown ------------
heading_is 'Current session'
test "$(sstate | jq -r '.sessions.rows[0].id')" = "$g"
wait_until 15 guard_off
key Down
wait_until 10 cursor_is 1
sleep 0.8
test "$(selected)" != "$g"
heading_is 'Search started here'
key Up
wait_until 10 cursor_is 0
wait_until 10 _bs_shows "$g"
sleep 0.5
heading_is 'Current session'

# --- R6: Ctrl+1 (a pinned profile) is an exit: no third state ------------------------------
key ctrl+1
wait_until 15 _bs_shows "$a"
wait_until 10 in_terminal
no_third_for 5

# --- R8: Esc ends the search, its text forgotten, the terminal focused ---------------------
key ctrl+shift+f
wait_search
wait_until 10 in_search zq
key Escape
wait_until 10 in_terminal
sstate | jq -e '.remembered == ""'
no_third_for 3

# --- F11: a new session by its key during search ends the search; the next key reaches it ---
key ctrl+shift+f
xdo type --delay 30 -- zq
wait_search
wait_until 10 in_search zq
before="$(api GET /sessions | jq -c '[.[].sessionId]')"
key ctrl+shift+t
new_listed() {
  api GET /sessions | jq -e --argjson b "$before" '[.[].sessionId | select(. as $id | ($b | index($id)) == null)] | length == 1' >/dev/null
}
wait_until 20 new_listed
ns="$(api GET /sessions | jq -r --argjson b "$before" '[.[].sessionId | select(. as $id | ($b | index($id)) == null)][0]')"
wait_until 20 shown_live "$ns"
wait_until 10 in_terminal
sleep 1.5
xdo type --delay 30 -- 'echo NEW""OK'
key Return
wait_until 15 term_has NEWOK
selected | grep -qx "$ns"
sstate | jq -e '.box.value == ""'

# --- R10: outside search, Ctrl+PgDn visits every drawn row once, in order, and wraps --------
wait_until 15 guard_off
in_terminal
order="$(drawn_ids | jq -c 'reduce .[] as $x ([]; if index($x) then . else . + [$x] end)')"
n="$(jq 'length' <<<"$order")"
start="$(selected)"
i="$(jq -r --arg s "$start" 'index($s)' <<<"$order")"
echo "R10: $n rows, from $start (index $i): $order"
seen=()
for ((k = 1; k <= n; k++)); do
  want="$(jq -r --argjson k "$((i + k))" --argjson n "$n" '.[$k % $n]' <<<"$order")"
  key ctrl+Next
  wait_until 15 _bs_shows "$want"
  seen+=("$want")
  sleep 0.4
done
test "$(selected)" = "$start"
test "$(drawn_ids | jq -c 'reduce .[] as $x ([]; if index($x) then . else . + [$x] end)')" = "$order"
jq -e '.errors == 0' <<<"$(perf_read)"
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R6_end.png" >/dev/null || true
echo "R6 search states: PASS"
