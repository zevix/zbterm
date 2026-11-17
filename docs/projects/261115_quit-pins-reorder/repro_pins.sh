#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")/acceptance" && pwd)"
ZBUI_ID=P0_repro
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_qp.sh"
set -x
start_app
a="$(seed_session p-a 'echo A""READY' AREADY)"
b="$(seed_session p-b 'echo B""READY' BREADY)"
row_action "$b" pin >/dev/null
sleep 1
cat "$(prefs_file)"
focus_terminal
key ctrl+q
wait_gone 30 || echo "app did not exit on ctrl+q"
cat "$(prefs_file)"
_zbui_stop_run_pid
start_app
sleep 2
cat "$(prefs_file)"
sty ".session-row[data-session-id=\"$b\"] .session-pin-mark" | jq -c '{visible}'
api GET /sessions | jq -c '[.[] | {name, sessionId, active}]'
