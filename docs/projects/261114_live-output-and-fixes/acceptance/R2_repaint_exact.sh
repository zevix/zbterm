#!/usr/bin/env bash
# R2 repaint exact — proves R2: extending a session's history, and restoring it after a restart, shows every output line exactly once.
# Asserts: a session with 20000 lines of history is ended, then selected (extend: live at once, the history restored behind it, then the session:restored repaint) while it prints 1200 numbered lines; the renderer holds each line 1..1200 once. Then the app is restarted and the same is checked on the restore after the restart.
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
ended() { api GET /sessions | jq -e --arg s "$1" 'any(.[]; .sessionId == $s and (.active | not))' >/dev/null; }
restored() { api GET "/sessions/$1" | jq -e '(.opened.restoring // false) | not' >/dev/null; }
start_app
win_size 1280 800
a="$(seed_session r2-a 'seq 1 20000; echo H""DONE' HDONE)"
b="$(seed_session r2-b 'echo B""READY' BREADY)"
round() {
  local tag="$1"
  sinput "$a" exit
  wait_until 30 ended "$a"
  select_session "$b"
  # The switch extends the ended session; output starts at once, while the history restores.
  api POST "/sessions/$a/switch" >/dev/null
  wait_until 30 mirror_has "$a" '$ ' || true
  flood "$a" "$tag"
  wait_end "$a" "$tag"
  wait_until 60 restored "$a"
  sleep 1.5
  lstream | jq -c '{selectedId, mode, stream: .stream.counts, resyncs}'
  seam_ok "$tag"
}
round Y1Y
restart_app
win_size 1280 800
round Y2Y
