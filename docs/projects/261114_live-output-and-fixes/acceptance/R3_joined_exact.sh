#!/usr/bin/env bash
# R3 joined exact — proves R3: selecting a joined session in the viewer while the host prints shows every output line exactly once.
# Asserts: host A shares session r3-host, app B joins it (POST /join, A approves); 6 trials: B shows its own session, A prints 1200 numbered lines, after 0.3-1.1 s B selects the joined session; once B's mirror has the end marker, B's renderer holds each line 1..1200 once.
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
cannot() { echo "cannot run here: $*" >&2; exit 75; }
start_app
h="$(seed_session r3-host 'echo H""READY' HREADY)"
share="$(api POST "/sessions/$h/share" '{"type":"group","maxViewers":1,"autoJoin":false}')"
uri="$(jq -r '.uri // empty' <<<"$share")"
[ -n "$uri" ] || cannot "no share link: $share"
start_second_app
on_b win_size 1280 800
o="$(on_b seed_session r3-own 'echo O""READY' OREADY)"
on_b api POST /join "$(jq -nc --arg u "$uri" '{uri: $u}')" >/dev/null
approval() { api GET /popups | jq -e --arg s "$h" 'any(.[]; .type == "share-approval" and .data.sessionId == $s)' >/dev/null; }
wait_until 90 approval || cannot "join failed: no approval request reached the host in 90 s"
pid="$(api GET /popups | jq -r --arg s "$h" '[.[] | select(.type == "share-approval" and .data.sessionId == $s)][0].id')"
api POST "/popups/$(jq -rn --arg p "$pid" '$p | @uri')/actions/approve" >/dev/null
joined() { on_b mirror_has "$h" HREADY; }
wait_until 90 joined || cannot "the joined session never reached B"
sleep 4
bad=0
for k in $(seq 1 6); do
  on_b select_session "$o"
  flood "$h" "J${k}J"
  sleep "0.$((RANDOM % 9 + 3))"
  on_b select_session "$h"
  on_b wait_end "$h" "J${k}J"
  sleep 1.5
  on_b seam_ok "J${k}J" || { echo "trial $k: SEAM BROKEN"; bad=$((bad + 1)); }
done
on_b lstream | jq -c '.stream.counts, .resyncs'
[ "$bad" = 0 ]
