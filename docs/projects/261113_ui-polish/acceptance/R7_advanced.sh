#!/usr/bin/env bash
# R7 advanced — proves R7: the editor's Advanced section is spaced like the rest of the dialog.
# Asserts: the New dialog with Advanced open: a screenshot of the private display is written to the log dir (R7_advanced.png, non-empty, for the reader); measured with getBoundingClientRect, the gaps summary -> label, label -> select and select -> skip checkbox are each >= 6 px (the panel's own row gap is 8 px), and the controls are indented under the summary (label.left > summary.left).
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
open_dialog '{"command":"click","selector":"#newSession"}' >/dev/null
set_field Advanced true | jq -e '.set'
sleep 0.5
sm="$(sty '.session-editor-advanced > summary' | jq -c .rect)"
lb="$(sty '.session-editor-advanced .session-editor-label' | jq -c .rect)"
se="$(sty '#sessionEditorTrigger' | jq -c .rect)"
sk="$(sty '.session-editor-advanced .session-editor-skip' | jq -c .rect)"
echo "summary $sm"; echo "label $lb"; echo "select $se"; echo "skip $sk"
png="$ACCEPT_LOG_DIR/R7_advanced.png"
uisolate screenshot "$ZBUI_SESSION" "$png" >/dev/null
[ -s "$png" ]
echo "screenshot: $png"
gap() { jq -n --argjson a "$1" --argjson b "$2" '$b.top - $a.bottom'; }
for pair in "$sm $lb" "$lb $se" "$se $sk"; do
  set -- $pair
  g="$(gap "$1" "$2")"
  echo "gap $g"
  jq -e -n --argjson g "$g" '$g >= 6'
done
jq -e -n --argjson s "$sm" --argjson l "$lb" '$l.left > $s.left'
