#!/usr/bin/env bash
# U1 record — proves U1: unticking 'Record session' in the template editor of a template backed by a recorded live session never changes that session's recording; the next session from the template is unrecorded.
# Asserts: a recorded session 'u1 rec' made through the New dialog as the '+ New' template; its editor ('Edit new profile defaults'), 'Record session' unticked, OK; then the session's entry has no record == false, player.open on it answers without an error, and Share is enabled for it; a real '+ New' click opens the dialog unticked, OK gives a session whose entry has record == false; 'u1 rec' is still recorded.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_up.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks and key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
new_profile 'u1 rec' "$ZBUI_APP_HOME" 'bash' true "$ZBUI_CHOICE_NEW" false
sid="$(sid_of 'u1 rec')"
jq -e '.record != false' <<<"$(entry_of "$sid")"
menu >/dev/null
open_dialog '{"command":"settings-click","label":"Edit new profile defaults"}' >/dev/null
set_field 'Record session' false | jq -e '.set'
cmd '{"command":"dialog-submit"}' | jq -e '.done'
sleep 1.5
recorded() {
  jq -e '.record != false' <<<"$(entry_of "$sid")"
  r="$(api POST /invoke "{\"method\":\"player.open\",\"args\":{\"sessionId\":\"$sid\"}}")"
  echo "player.open: ${r:0:200}"
  jq -e '.error == null' <<<"$r"
}
recorded
select_session "$sid"
sleep 1
state | jq -e '.controls.shareSession.disabled == false or .controls.shareSession.hidden == true'
state | jq -e '(.controls.shareSession.title | test("Not recorded")) | not'
# The next session from the template is unrecorded.
click_sel '#newSession'
wait_until 15 _zbui_modal_open
s="$(state)"
jq -e '[.modal.fields[] | select(.label == "Record session")][0] | .checked == false' <<<"$s"
set_field name '"u1 next"' | jq -e '.set'
cmd '{"command":"dialog-submit"}' | jq -e '.done'
wait_until 30 has_session 'u1 next'
jq -e '.record == false' <<<"$(entry_of "$(sid_of 'u1 next')")"
recorded
