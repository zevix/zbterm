#!/usr/bin/env bash
# U3 template_takeover — proves U3: choosing a trigger held by profile A in profile B's dialog asks, naming A; Cancel leaves A as the template; OK moves it to B.
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
a="$(api POST /sessions '{"name":"u3 a","cols":80,"rows":24}' | jq -r .sessionId)"
b="$(api POST /sessions '{"name":"u3 b","cols":80,"rows":24}' | jq -r .sessionId)"
sleep 1
pick() { set_field "$ZBUI_ADVANCED_SELECT" "$(jq -n --arg v "$ZBUI_CHOICE_CTRL_SHIFT_T" '$v')"; }
# A holds Ctrl+Shift+T.
s="$(row_action "$a" edit)"
jq -e '.modal.details | any(.summary == "Advanced")' <<<"$s"
set_field Advanced true >/dev/null
jq -e '.set == true' <<<"$(pick)"
cmd '{"command":"dialog-submit"}' >/dev/null
sleep 1
jq -e --arg a "$a" '.newSessionTemplates.ctrlShiftT.sessionId == $a' <<<"$(cmd '{"command":"templates"}')"
# B picks it: asked first, naming A (on the pick, or at the latest on OK).
ask() {
  local c
  c="$(cmd '{"command":"confirm-state"}')"
  if [ "$c" = null ]; then cmd '{"command":"dialog-submit"}' >/dev/null; c="$(cmd '{"command":"confirm-state"}')"; fi
  printf '%s' "$c"
}
row_action "$b" edit >/dev/null
set_field Advanced true >/dev/null
pick >/dev/null
c="$(ask)"
jq '.' <<<"$c"
jq -e '.text | test("\"?u3 a\"? is the template for .+\\. Make this profile the template instead\\?")' <<<"$c"
# Cancel: A stays the template, B's dialog stays open.
cmd '{"command":"confirm-answer","ok":false}' >/dev/null
jq -e '.modal.kind == "session-editor"' <<<"$(state)"
jq -e --arg a "$a" '.newSessionTemplates.ctrlShiftT.sessionId == $a' <<<"$(cmd '{"command":"templates"}')"
cmd '{"command":"dialog-cancel"}' >/dev/null
# OK: it moves to B.
row_action "$b" edit >/dev/null
set_field Advanced true >/dev/null
pick >/dev/null
ask >/dev/null
cmd '{"command":"confirm-answer","ok":true}' >/dev/null
if jq -e '.modal.kind == "session-editor"' <<<"$(state)" >/dev/null; then cmd '{"command":"dialog-submit"}' >/dev/null; fi
sleep 1
jq -e --arg b "$b" '.newSessionTemplates.ctrlShiftT.sessionId == $b' <<<"$(cmd '{"command":"templates"}')"
