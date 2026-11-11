#!/usr/bin/env bash
# U1 unrecorded_nothing_on_disk — proves U1: a unique marker typed and echoed in an unrecorded session appears in no file under the scratch storage directory (grep -rF), while the same marker in a recorded session's mirror does (control).
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
# The marker is printed, never typed: the typed command line holds its parts only.
n="$$$RANDOM"; marker="zbuimk-$n-out"
show="{\"text\":\"printf '%s-%s-out\\\\n' zbuimk $n\",\"enter\":true}"
# An unrecorded session, made through the New dialog.
open_dialog '{"command":"click","selector":"#newSession"}' >/dev/null
set_field name '"u1 unrecorded"' >/dev/null
s="$(set_field 'Record session' false)"
jq -e '.set == true' <<<"$s"
cmd '{"command":"dialog-submit"}' >/dev/null
wait_until 30 has_session 'u1 unrecorded'
sid="$(sid_of 'u1 unrecorded')"
sleep 1
log_length() { api GET "/sessions/$sid/stats" | jq '.history.availability.logLength // .history.length'; }
# Print; resize; a 5 MB flood; print again.
api POST "/sessions/$sid/input" "$show" >/dev/null
wait_until 20 term_has "$marker"
api POST "/sessions/$sid/resize" '{"cols":100,"rows":30}' >/dev/null
sleep 1
before="$(log_length)"
api POST "/sessions/$sid/input" '{"text":"yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 5000000; echo flood-done","enter":true}' >/dev/null
wait_until 90 term_has 'flood-done'
api POST "/sessions/$sid/input" "$show" >/dev/null
sleep 2
# The log took nothing after its header and first resize.
jq -e -n --argjson a "$before" --argjson b "$(log_length)" '$a == $b'
# Ended and extended, it prints again.
api POST "/sessions/$sid/input" '{"text":"exit","enter":true}' >/dev/null
sleep 2
api POST "/sessions/$sid/extend" '{}' >/dev/null
sleep 2
api POST "/sessions/$sid/input" "$show" >/dev/null
wait_until 20 term_has "$marker"
# Control: the same marker in a recorded session's mirror (its history, played back).
rid="$(api POST /sessions '{"name":"u1 recorded","cols":80,"rows":24}' | jq -r .sessionId)"
sleep 1.5
api POST "/sessions/$rid/input" "$show" >/dev/null
sleep 2
api POST "/sessions/$rid/playback/open" >/dev/null
jq -e --arg m "$marker" 'tostring | contains($m)' <<<"$(api POST "/sessions/$rid/playback/seek" "{\"tsMs\":$(date +%s)999}")"
# Close the app; then no file under the scratch HOME, storage or TMPDIR holds the marker.
quit_app
hits="$(grep -rlF -- "$marker" "$ZBUI_APP_HOME" "$ZBUI_APP_STORAGE" "$ZBUI_APP_TMP" 2>/dev/null || true)"
printf 'files holding the marker: %s\n' "${hits:-none}"
jq -e -n --arg h "$hits" '$h == ""'
