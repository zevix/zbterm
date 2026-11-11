#!/usr/bin/env bash
# R4 trigger_creates — proves R4: + New, Ctrl+Shift+T and Shift+New each create from their template (cwd, command, record, share choice copied; name '<template> #N'); skip-dialog opens directly, else the dialog opens prefilled; after editing the template the next creation uses the new values.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/../../261110_ui-chrome/acceptance/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
d1="$ZBUI_APP_HOME/r4new"; d2="$ZBUI_APP_HOME/r4ctrl"; d3="$ZBUI_APP_HOME/r4shift"; mkdir -p "$d1" "$d2" "$d3"
s="$(open_dialog '{"command":"click","selector":"#newSession"}')"
jq -e '.modal.details | any(.summary == "Advanced")' <<<"$s"
cmd '{"command":"dialog-cancel"}' >/dev/null
# One template per trigger: + New with the dialog, the other two skipping it.
new_profile 'r4 new' "$d1" 'bash' true "$ZBUI_CHOICE_NEW" false
new_profile 'r4 ctrl' "$d2" 'sh' true "$ZBUI_CHOICE_CTRL_SHIFT_T" true true
new_profile 'r4 shift' "$d3" 'bash --norc' false "$ZBUI_CHOICE_SHIFT_NEW" true
field='. as $f | [.modal.fields[] | select(.name == $f)][0]'
# + New: the dialog opens, prefilled from its template.
s="$(open_dialog '{"command":"click","selector":"#newSession"}')"
jq '.modal.fields' <<<"$s"
jq -e --arg d "$d1" '.modal.kind == "session-editor"
  and ([.modal.fields[] | select(.name == "name")][0].value == "r4 new #2")
  and ([.modal.fields[] | select(.name == "cwd")][0].value == $d)
  and ([.modal.fields[] | select(.name == "command")][0].value == "bash")
  and ([.modal.fields[] | select(.label == "Record session")][0].checked == true)' <<<"$s"
cmd '{"command":"dialog-submit"}' >/dev/null
wait_until 30 has_session 'r4 new #2' || true
jq -e --arg d "$d1" '.cwd == $d and .command == "bash" and .record != false' <<<"$(entry_of "$(sid_of 'r4 new #2')")"
# Ctrl+Shift+T (a real key): created directly, with its template's settings and share choice.
focus_terminal
key ctrl+shift+t
wait_until 30 has_session 'r4 ctrl #2' || true
jq -e '.modal == null' <<<"$(state)"
id="$(sid_of 'r4 ctrl #2')"
jq -e --arg d "$d2" '.cwd == $d and .command == "sh" and .record != false' <<<"$(entry_of "$id")"
jq -e 'length > 0' <<<"$(api GET "/sessions/$id/shares")"
# Shift + "+ New": created directly, unrecorded like its template.
cmd '{"command":"click","selector":"#newSession","shift":true}' >/dev/null
wait_until 30 has_session 'r4 shift #2' || true
jq -e '.modal == null' <<<"$(state)"
jq -e --arg d "$d3" '.cwd == $d and .command == "bash --norc" and .record == false' <<<"$(entry_of "$(sid_of 'r4 shift #2')")"
# After editing a template, the next creation uses the new values.
row_action "$(sid_of 'r4 ctrl')" edit >/dev/null
set_field command '"bash"' | jq -e '.set' >/dev/null
cmd '{"command":"dialog-submit"}' >/dev/null
sleep 1
focus_terminal
key ctrl+shift+t
wait_until 30 has_session 'r4 ctrl #3' || true
jq -e --arg d "$d2" '.cwd == $d and .command == "bash"' <<<"$(entry_of "$(sid_of 'r4 ctrl #3')")"
