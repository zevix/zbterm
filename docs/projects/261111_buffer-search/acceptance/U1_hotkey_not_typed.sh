#!/usr/bin/env bash
# U1 hotkey_not_typed — proves U1: Ctrl+Shift+F never reaches the program, and does nothing while a dialog is open.
# Asserts: with the shell running od -c: key x, key ctrl+shift+f → od shows x and no 006 (Ctrl+F) byte, and the box (#search, bottom left) is focused; the same with the side pane collapsed (Ctrl+Shift+B first); the same under 'setxkbmap ru' on the private display (od shows no 006 and the box is focused); with a dialog open (click #newSession, wait for the modal): key ctrl+shift+f leaves .box.focused == false and the modal open, and the key is not swallowed (the dialog's focused input still receives the event: a keydown counter in modal-state, or the dialog stays focused).
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
need setxkbmap "the non-Latin layout case"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
# > FILL (P1): copy ../../261110_ui-chrome/acceptance/U1_hotkeys_not_typed.sh's od -c pattern; then open_dialog and press the chord again.
echo "body not written yet (P1)" >&2
exit 1
