#!/usr/bin/env bash
# R1 record_checkbox — proves R1: the New and Copy dialogs both show 'Record session', ticked; unticking it greys Copy history and Share session now.
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
rec='[.modal.fields[] | select(.label == "Record session")][0]'
# New: the dialog has "Record session", ticked.
s="$(open_dialog '{"command":"click","selector":"#newSession"}')"
jq '.modal' <<<"$s"
jq -e '.modal.kind == "session-editor"' <<<"$s"
jq -e "$rec | .type == \"checkbox\" and .checked == true" <<<"$s"
# Unticked, it greys "Share session now".
s="$(set_field 'Record session' false)"
jq -e '[.modal.fields[] | select(.label == "Share session now")][0].disabled == true' <<<"$s"
cmd '{"command":"dialog-cancel"}' >/dev/null
# Copy: the same box, ticked; unticked, it greys "Copy history" and "Share session now".
sid="$(api POST /sessions '{"name":"r1 source","cols":80,"rows":24}' | jq -r .sessionId)"
sleep 1
s="$(row_action "$sid" copy)"
jq '.modal' <<<"$s"
jq -e '.modal.kind == "session-editor"' <<<"$s"
jq -e "$rec | .type == \"checkbox\" and .checked == true" <<<"$s"
s="$(set_field 'Record session' false)"
jq -e '[.modal.fields[] | select(.label == "Copy history" or .label == "Share session now") | .disabled] == [true, true]' <<<"$s"
