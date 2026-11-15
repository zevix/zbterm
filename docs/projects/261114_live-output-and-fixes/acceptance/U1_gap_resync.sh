#!/usr/bin/env bash
# U1 gap resync — proves U1: output lost between the engine and the screen is repainted from a fresh frame, not left as a hole.
# Asserts: mid-flood the renderer drops one chunk (live-drop-next): it resyncs (resyncs >= 1, a gap counted) and then holds every line 1..1200 once; then the whole tail of a burst is dropped (no later chunk shows the gap): within 5 s the renderer resyncs again and shows the burst's marker.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/activate"
source "$ZBUI_LIB"
source "$ZBUI_LIB_UP"
source "$here/lib_lo.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
a="$(seed_session u1-a 'echo A""READY' AREADY)"
select_session "$a"
flood "$a" G1G
sleep 1
cmd '{"command":"live-drop-next","chunks":1}' | jq -c .
wait_end "$a" G1G
sleep 2
s="$(lstream)"; jq -c . <<<"$s"
jq -e '.resyncs >= 1 and .stream.counts.gaps >= 1 and .dropNext == 0' <<<"$s"
seam_ok G1G
# A lost tail: everything of one burst, and nothing after it.
r0="$(jq '.resyncs' <<<"$s")"
cmd '{"command":"live-drop-next","chunks":100000}' >/dev/null
sinput "$a" 'p=TA; echo "${p}IL1MARK"'
wait_until 20 mirror_has "$a" TAIL1MARK
sleep 0.3
cmd '{"command":"live-drop-next","chunks":0}' >/dev/null
term_has TAIL1MARK && { echo "the marker is on screen before any resync: the drop did not happen"; exit 1; }
shown() { term_has TAIL1MARK; }
wait_until 5 shown
lstream | jq -e --argjson r "$r0" '.resyncs > $r'
