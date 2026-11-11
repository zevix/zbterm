#!/usr/bin/env bash
# R3 template_choice — proves R3: the Advanced section lists none + the three triggers in the user's words, takes one choice, and the choice is stored in newSessionTemplates.
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
sid="$(api POST /sessions '{"name":"r3 profile","cols":80,"rows":24}' | jq -r .sessionId)"
sleep 1
sel="[.modal.fields[] | select(.label | rtrimstr(\":\") == \"${ZBUI_ADVANCED_SELECT%:}\")][0]"
s="$(row_action "$sid" edit)"
jq '.modal' <<<"$s"
jq -e '.modal.kind == "session-editor"' <<<"$s"
# An expandable Advanced section.
jq -e '.modal.details | any(.summary == "Advanced")' <<<"$s"
s="$(set_field Advanced true)"
jq '.modal.fields' <<<"$s"
# One choice: none, then the three triggers in the user's words.
jq -e "$sel | .type == \"select-one\"" <<<"$s"
jq -e --arg a "$ZBUI_CHOICE_NEW" --arg b "$ZBUI_CHOICE_CTRL_SHIFT_T" --arg c "$ZBUI_CHOICE_SHIFT_NEW" \
  "[$sel | .options[].text] | length == 4 and (.[0] | test(\"^none\$\"; \"i\")) and .[1:] == [\$a, \$b, \$c]" <<<"$s"
# The skip-dialog box.
jq -e --arg k "$ZBUI_SKIP" 'any(.modal.fields[]; .label == $k and .type == "checkbox")' <<<"$s"
# The choice is stored.
s="$(set_field "$ZBUI_ADVANCED_SELECT" "$(jq -n --arg v "$ZBUI_CHOICE_CTRL_SHIFT_T" '$v')")"
jq -e '.set == true' <<<"$s"
cmd '{"command":"dialog-submit"}' >/dev/null
sleep 1
t="$(cmd '{"command":"templates"}')"
jq '.' <<<"$t"
jq -e --arg s "$sid" '.newSessionTemplates.ctrlShiftT.sessionId == $s' <<<"$t"
jq -e --arg s "$sid" '[.newSessionTemplates[] | select(.sessionId == $s)] | length == 1' <<<"$t"
# The section is in the New and Copy dialogs too.
s="$(open_dialog '{"command":"click","selector":"#newSession"}')"
jq -e '.modal.details | any(.summary == "Advanced")' <<<"$s"
cmd '{"command":"dialog-cancel"}' >/dev/null
s="$(row_action "$sid" copy)"
jq -e '.modal.details | any(.summary == "Advanced")' <<<"$s"
