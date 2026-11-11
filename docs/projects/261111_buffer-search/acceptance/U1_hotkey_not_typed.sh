#!/usr/bin/env bash
# U1 hotkey_not_typed — proves U1: Ctrl+Shift+F never reaches the program, and does nothing while a dialog is open.
# Asserts: with the shell running od -c: key x, key ctrl+shift+f → od shows x and no 006 (Ctrl+F) byte, and the box (#search, bottom left) is focused; the same with the side pane collapsed (Ctrl+Shift+B first); the same under 'setxkbmap ru' on the private display (od shows no 006 and the box is focused); with a dialog open (click #newSession, wait for the modal): key ctrl+shift+f leaves .box.focused == false and the modal open, and the key is not swallowed (the dialog's focused input still receives the event: a keydown counter in modal-state, or the dialog stays focused).
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$ZBUI_LIB"
source "$(cd "$(dirname "$0")" && pwd)/lib_bs.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
need setxkbmap "the non-Latin layout case"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
win_size 1280 800
api POST /sessions '{"name":"u1 od","cols":80,"rows":24}' >/dev/null
sleep 1.5
# od_check <chord>: the shell runs `od -c`; a real x, then the chord; od must show x and no 006 (Ctrl+F).
od_check() {
  api POST /sessions/current/input '{"text":"clear; od -c","enter":true}' >/dev/null
  sleep 1
  focus_terminal
  key x
  key "$1"
  s="$(sstate)"
  api POST /sessions/current/input '{"data":"\r\u0004"}' >/dev/null
  sleep 1
  out="$(term_text)"
  printf '%s\n' "$out"
  grep -E '^0000000 +x ' <<<"$out"
  jq -e -R -s 'contains(" 006") | not' <<<"$out"
  jq '.box | {focused, inSidebar}' <<<"$s"
  jq -e '.box.focused == true' <<<"$s"
}
od_check ctrl+shift+f
# Collapsed.
focus_terminal
key ctrl+shift+b
jq -e '.sideCollapsed == true' <<<"$(sstate)"
od_check ctrl+shift+f
key ctrl+shift+b
# A Russian layout on the private display: the F key types Cyrillic_a, its code is still KeyF.
uisolate run --name "$ZBUI_SESSION" -t 30 -- setxkbmap ru
od_check ctrl+shift+Cyrillic_a
uisolate run --name "$ZBUI_SESSION" -t 30 -- setxkbmap us
# With a dialog open: nothing happens, and the dialog keeps the key.
focus_terminal
open_dialog '{"command":"click","selector":"#newSession"}' >/dev/null
s="$(sstate)"
jq -e '.activeInModal == true' <<<"$s"
key ctrl+shift+f
s="$(sstate)"
jq '{box, activeElement, activeInModal}' <<<"$s"
jq -e '.box.focused == false and .activeInModal == true' <<<"$s"
jq -e '.modal != null' <<<"$(state)"
