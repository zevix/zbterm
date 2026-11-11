#!/usr/bin/env bash
# R2 unrecorded_live — proves R2: an unrecorded session echoes typed text on screen; its Share and Playback controls are disabled; share.createLink, player.open and copyHistoryFrom return E_NOT_RECORDED; Extend relaunches it unrecorded.
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
# An unrecorded session, made through the New dialog.
open_dialog '{"command":"click","selector":"#newSession"}' >/dev/null
set_field name '"r2 unrecorded"' >/dev/null
s="$(set_field 'Record session' false)"
jq '.modal' <<<"$s"
jq -e '.set == true' <<<"$s"
cmd '{"command":"dialog-submit"}' >/dev/null
wait_until 30 has_session 'r2 unrecorded'
sid="$(sid_of 'r2 unrecorded')"
jq -e '.record == false' <<<"$(entry_of "$sid")"
sleep 1
# Heavy output (5 MB), then typed text still echoes live.
api POST "/sessions/$sid/input" '{"text":"yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 5000000; printf \"%s-%s\\n\" r2live done","enter":true}' >/dev/null
wait_until 90 term_has 'r2live-done'
api POST "/sessions/$sid/input" '{"text":"printf \"%s-%s\\n\" r2typed $((6*7))","enter":true}' >/dev/null
wait_until 20 term_has 'r2typed-42'
jq -e -R -s 'contains("r2typed-42")' <<<"$(term_text)"
# Share and Playback are disabled, saying why.
s="$(state)"
jq '.controls' <<<"$s"
jq -e '.controls.shareSession.disabled == true and (.controls.shareSession.title | test("Not recorded"))' <<<"$s"
jq -e '[.controls.playPause, .controls.scrubber] | all(.disabled == true or .hidden == true)' <<<"$s"
# The engine refuses what needs a recording.
jq -e '.error.code == "E_NOT_RECORDED"' <<<"$(api POST /invoke "{\"method\":\"share.createLink\",\"args\":{\"sessionId\":\"$sid\",\"type\":\"group\"}}")"
jq -e '.error.code == "E_NOT_RECORDED"' <<<"$(api POST /invoke "{\"method\":\"player.open\",\"args\":{\"sessionId\":\"$sid\"}}")"
jq -e '.error.code == "E_NOT_RECORDED"' <<<"$(api POST /invoke "{\"method\":\"session.create\",\"args\":{\"name\":\"r2 copy\",\"copyHistoryFrom\":\"$sid\"}}")"
# Extend relaunches it, still unrecorded.
api POST "/sessions/$sid/input" '{"text":"exit","enter":true}' >/dev/null
ended() { api GET "/sessions/$sid" | jq -e '.entry.active == false or .opened.active == false'; }
wait_until 20 ended
api POST "/sessions/$sid/extend" '{}' >/dev/null
sleep 2
jq -e '.record == false' <<<"$(entry_of "$sid")"
jq -e 'any(.[]; .sessionId == $id and .active)' --arg id "$sid" <<<"$(api GET /sessions)"
