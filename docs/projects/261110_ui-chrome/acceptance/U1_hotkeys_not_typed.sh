#!/usr/bin/env bash
# U1 hotkeys_not_typed — proves U1: with the shell running 'od -c' on its input, Ctrl+Shift+B produces no input bytes while the pane toggles.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display, not synthetic events"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
api POST /sessions '{"name":"u1 od","cols":80,"rows":24}' >/dev/null
sleep 1.5
# The shell runs `od -c` on its input: whatever the terminal sends shows up as bytes.
api POST /sessions/current/input '{"text":"clear; od -c","enter":true}' >/dev/null
sleep 1
focus_terminal
# Control: a plain real key reaches the program, so the terminal has the focus.
key x
key ctrl+shift+b
s="$(state)"
# End the line and the input: od prints every byte it read.
api POST /sessions/current/input '{"data":"\r\u0004"}' >/dev/null
sleep 1
out="$(term_text)"
printf '%s\n' "$out"
grep -F '0000000' <<<"$out"
grep -E '^0000000 +x ' <<<"$out"
# Ctrl+B is octal 002: it must not have reached the program.
jq -e -R -s 'contains(" 002") | not' <<<"$out"
jq -e '.sideCollapsed == true' <<<"$s"
