#!/usr/bin/env bash
# R6 deleted_template — proves R6: after deleting a template session its trigger still creates a session with the deleted profile's own name and settings, and that session is now the trigger's template.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/../../261110_ui-chrome/acceptance/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
d="$ZBUI_APP_HOME/r6"; mkdir -p "$d"
s="$(open_dialog '{"command":"click","selector":"#newSession"}')"
jq -e '.modal.details | any(.summary == "Advanced")' <<<"$s"
cmd '{"command":"dialog-cancel"}' >/dev/null
new_profile 'r6 tpl' "$d" 'sh' true "$ZBUI_CHOICE_SHIFT_NEW" true
delete_session() { # Shift on the row's Delete goes to the confirmation; answer OK.
  row_action "$1" delete true >/dev/null
  cmd '{"command":"confirm-answer","ok":true}' >/dev/null
  gone() { ! api GET /sessions | jq -e --arg id "$1" 'any(.[]; .sessionId == $id)' >/dev/null; }
  wait_until 20 gone "$1"
}
delete_session "$(sid_of 'r6 tpl')"
# The template survives as a hidden copy.
t="$(cmd '{"command":"templates"}')"
jq '.' <<<"$t"
jq -e '.newSessionTemplates.shiftNew.sessionId == null and .newSessionTemplates.shiftNew.copy.name == "r6 tpl"' <<<"$t"
# Its trigger creates a session under the deleted profile's own name and settings ...
cmd '{"command":"click","selector":"#newSession","shift":true}' >/dev/null
wait_until 30 has_session 'r6 tpl' || true
id="$(sid_of 'r6 tpl')"
jq -e --arg d "$d" '.cwd == $d and .command == "sh"' <<<"$(entry_of "$id")"
# ... and that session is now the template.
jq -e --arg id "$id" '.newSessionTemplates.shiftNew.sessionId == $id' <<<"$(cmd '{"command":"templates"}')"
# With the name taken by another session, it is restored as "<name> #N" and still becomes the template.
delete_session "$id"
api POST /sessions '{"name":"r6 tpl","cols":80,"rows":24,"select":false}' >/dev/null
cmd '{"command":"click","selector":"#newSession","shift":true}' >/dev/null
wait_until 30 has_session 'r6 tpl #2' || true
id="$(sid_of 'r6 tpl #2')"
jq -e --arg d "$d" '.cwd == $d and .command == "sh"' <<<"$(entry_of "$id")"
jq -e --arg id "$id" '.newSessionTemplates.shiftNew.sessionId == $id' <<<"$(cmd '{"command":"templates"}')"
