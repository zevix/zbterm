#!/usr/bin/env bash
# U2 template_warnings — proves U2: deleting a template session shows a confirmation naming the trigger and the restore name; creating a profile with a deleted template's name warns that it will replace that template.
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
s="$(open_dialog '{"command":"click","selector":"#newSession"}')"
jq -e '.modal.details | any(.summary == "Advanced")' <<<"$s"
cmd '{"command":"dialog-cancel"}' >/dev/null
new_profile 'u2 tpl' "$ZBUI_APP_HOME" 'sh' true "$ZBUI_CHOICE_SHIFT_NEW" true
sid="$(sid_of 'u2 tpl')"
# Deleting a template: the confirmation names the trigger and the restore name.
row_action "$sid" delete true >/dev/null
c="$(cmd '{"command":"confirm-state"}')"
jq '.' <<<"$c"
jq -e '.text | test("\"?u2 tpl\"? is the template for .+\\. It will be restored as \"?u2 tpl\"? the next time you ")' <<<"$c"
cmd '{"command":"confirm-answer","ok":true}' >/dev/null
gone() { ! api GET /sessions | jq -e --arg id "$sid" 'any(.[]; .sessionId == $id)' >/dev/null; }
wait_until 20 gone
replace='.text | test("\"?u2 tpl\"? is the deleted template for .+; this profile will replace it")'
# Reusing the deleted template's name warns, naming the trigger: New ...
open_dialog '{"command":"click","selector":"#newSession"}' >/dev/null
set_field name '"u2 tpl"' >/dev/null
cmd '{"command":"dialog-submit"}' >/dev/null
c="$(cmd '{"command":"confirm-state"}')"
jq '.' <<<"$c"
jq -e "$replace" <<<"$c"
cmd '{"command":"confirm-answer","ok":false}' >/dev/null
cmd '{"command":"dialog-cancel"}' >/dev/null
# ... Copy ...
other="$(api POST /sessions '{"name":"u2 other","cols":80,"rows":24}' | jq -r .sessionId)"
sleep 1
row_action "$other" copy >/dev/null
set_field name '"u2 tpl"' >/dev/null
cmd '{"command":"dialog-submit"}' >/dev/null
jq -e "$replace" <<<"$(cmd '{"command":"confirm-state"}')"
cmd '{"command":"confirm-answer","ok":false}' >/dev/null
cmd '{"command":"dialog-cancel"}' >/dev/null
# ... and rename (the Edit dialog).
row_action "$other" edit >/dev/null
set_field name '"u2 tpl"' >/dev/null
cmd '{"command":"dialog-submit"}' >/dev/null
jq -e "$replace" <<<"$(cmd '{"command":"confirm-state"}')"
cmd '{"command":"confirm-answer","ok":false}' >/dev/null
