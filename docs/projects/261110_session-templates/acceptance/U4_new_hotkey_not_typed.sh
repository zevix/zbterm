#!/usr/bin/env bash
# U4 new_hotkey_not_typed — proves U4: with the shell running 'od -c' on its input, Ctrl+Shift+T produces no input bytes while a session is created.
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
api POST /sessions '{"name":"u4 od","cols":80,"rows":24}' >/dev/null
sleep 1.5
before="$(api GET /sessions | jq length)"
# The shell runs `od -c` on its input: whatever the terminal sends shows up as bytes.
api POST /sessions/current/input '{"text":"clear; od -c","enter":true}' >/dev/null
sleep 1
focus_terminal
# Control: a plain real key reaches the program, so the terminal has the focus.
key x
key ctrl+shift+t
sleep 2
after="$(api GET /sessions | jq length)"
# Back to the od session, end the line and the input: od prints every byte it read.
api POST "/sessions/$(sid_of 'u4 od')/switch" >/dev/null
sleep 1
api POST "/sessions/$(sid_of 'u4 od')/input" '{"data":"\r\u0004"}' >/dev/null
sleep 1
out="$(term_text)"
printf '%s\n' "$out"
grep -F '0000000' <<<"$out"
grep -E '^0000000 +x ' <<<"$out"
# Ctrl+T is octal 024: it must not have reached the program.
jq -e -R -s 'contains(" 024") | not' <<<"$out"
# A session was created.
jq -e -n --argjson a "$before" --argjson b "$after" '$b == $a + 1'
