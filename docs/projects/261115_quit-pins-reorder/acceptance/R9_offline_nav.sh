#!/usr/bin/env bash
# R9 offline nav — proves R9 and R10: outside search, Ctrl+PgDn/PgUp onto an ended session show it in playback without resuming it, with the toast "Press ^R or Enter to resume the session"; Enter in the terminal resumes it; in the search box Enter resumes only while that toast shows (else it steps matches, no resume).
# Asserts: list c, b (ended), a; from c Ctrl+PgDn: b selected, mode playback, not active, toast resume-hint with that text; Ctrl+PgDn to a: no toast; Ctrl+PgUp to b: toast again; Enter in the terminal: b active and live; then in the box (query "r9", d ended): Down onto d: toast; Enter: d active and live, the box keeps the focus; Enter on a live row: no session changes state.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R9_offline_nav
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_qp.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display"
set -x
start_app
win_size 1280 800
ended_session() { # name → id of a session whose script exits (and is then replaced by one that stays up)
  printf '%s\n' "echo $1-ran" >"$ZBUI_APP_HOME/$1.sh"
  local id
  id="$(api POST /sessions "$(jq -nc --arg h "$ZBUI_APP_HOME" --arg n "$1" \
    '{name: $n, cols: 80, rows: 24, cwd: $h, command: ("sh " + $h + "/" + $n + ".sh")}')" | jq -r .sessionId)"
  echo "$id"
}
ended() { api GET "/sessions/$1" | jq -e '.entry.active == false' >/dev/null; }
live() { api GET "/sessions/$1" | jq -e '.entry.active == true' >/dev/null && cmd '{"command":"playback-state"}' | jq -e '.mode == "live"' >/dev/null; }
a="$(seed_session r9-a 'echo A""READY' AREADY)"
b="$(ended_session r9-b)"; wait_until 30 ended "$b"
c="$(seed_session r9-c 'echo C""READY' CREADY)"
select_session "$c"; sleep 2; wait_until 30 ended "$b"
order | jq -c '[.rows[] | {id, name}]'
toasts() { cmd '{"command":"search-mode"}' | jq -c '.toasts'; }
toast_text() { sty '.toast' | jq -r '.text // ""'; }
sel() { cmd '{"command":"search-mode"}' | jq -r '.selectedId'; }
has_hint() { cmd '{"command":"search-mode"}' | jq -e '.toasts | index("resume-hint") != null' >/dev/null; }
# The keys that walk from c to b: Next when b is below c, else Prior.
pos() { order | jq --arg s "$1" '[.rows[].id] | index($s)'; }
if [ "$(pos "$b")" -gt "$(pos "$c")" ]; then fwd=ctrl+Next back=ctrl+Prior; else fwd=ctrl+Prior back=ctrl+Next; fi
focus_terminal
for _ in 1 2 3; do key "$fwd"; sleep 1.5; [ "$(sel)" = "$b" ] && break; ended "$b"; done
test "$(sel)" = "$b"
cmd '{"command":"playback-state"}' | jq -e '.mode == "playback" and .active == false'
has_hint
toast_text | grep -F 'Press ^R or Enter to resume the session'
ended "$b"
# Off b to a live session: no toast; back: the toast again, still not resumed.
key "$fwd"; sleep 1.5
[ "$(sel)" != "$b" ]
! has_hint || exit 1
key "$back"; sleep 1.5
test "$(sel)" = "$b"
has_hint
ended "$b"
# R10: Enter in the terminal resumes it.
printf '%s\n' 'echo r9-b-resumed; exec sleep 600' >"$ZBUI_APP_HOME/r9-b.sh"
focus_terminal
key Return
wait_until 30 live "$b"
# R10 in the box: d ended; Down walks onto it; Enter resumes it there.
d="$(ended_session r9-d)"; wait_until 30 ended "$d"
select_session "$c"; sleep 2; wait_until 30 ended "$d"
type_box r9
wait_search; sleep 1
s="$(cmd '{"command":"search-mode"}')"
di="$(jq --arg d "$d" '[.rows[].id] | index($d)' <<<"$s")"; [ "$di" != null ]
ci="$(jq --arg c "$c" '.cursorRow.index' <<<"$s")"
# Enter on a live row with no toast: no session changes state.
before="$(api GET /sessions | jq -c '[.[] | {sessionId, active}] | sort_by(.sessionId)')"
key Return; sleep 1.5
test "$(api GET /sessions | jq -c '[.[] | {sessionId, active}] | sort_by(.sessionId)')" = "$before"
on_d() { cmd '{"command":"search-mode"}' | jq -e --arg d "$d" '.selectedId == $d' >/dev/null; }
# Onto d by the walk itself (a d selected some other way shows no toast): off it and back.
for k in Down Down Down Down Up Up Up Up Up Up Up Up; do { on_d && has_hint; } && break; key "$k"; sleep 1.2; done
cmd '{"command":"search-mode"}' | jq -e --arg d "$d" '.selectedId == $d and (.toasts | index("resume-hint") != null)'
printf '%s\n' 'echo r9-d-resumed; exec sleep 600' >"$ZBUI_APP_HOME/r9-d.sh"
key Return
wait_until 30 live "$d"
cmd '{"command":"search-mode"}' | jq -e '.focused == true'
