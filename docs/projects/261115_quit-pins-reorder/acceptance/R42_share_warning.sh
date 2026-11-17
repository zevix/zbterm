#!/usr/bin/env bash
# R42 share warning — proves R42: the Share dialog's warning follows its options instead of the old shouted "until we add user authentication" line, and "Only verified people can join" makes a link the host stores as verified-only.
# Asserts: Single-use, no approval: "Whoever opens this link first joins right away", not red; Group (approval on by default): "can ask to join" and "verified GitHub identity", not red; Group with approval unticked (a real click): "joins right away, without your approval", red (.share-warning-danger); verified-only ticked (a real click): "Only people who prove a GitHub identity can join", not red; nowhere "YOU CANT TELL"; the shared link (share.listLinks) has verifiedOnly true. Approval and verified-only lines each end in a dot (right of the text), orange (--warn) while unticked, green (--ok) while ticked, both clicks flipping them; with the relay from the registry and no key, the relay line reads exactly "Relay (default): N/A". Screenshots in the log dir.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R42_share_warning
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_qp.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real clicks on the private display"
set -x
start_app
win_size 1280 900
s1="$(seed_session r42-1 'echo 1""READY' 1READY)"
guard_wait
cmd "$(jq -nc --arg s "$s1" '{command: "click", selector: (".session-row[data-session-id=\"" + $s + "\"] .session-name")}')" >/dev/null; sleep 0.8
warn() { cmd '{"command":"style-of","selector":".modal-overlay .share-warning"}'; }
text() { state | jq -r '.modal.text'; }
red() { cmd '{"command":"style-of","selector":".modal-overlay .share-warning-danger"}' | jq -e '.found' >/dev/null; }
cmd '{"command":"share-open"}' | jq -e '.text | contains("YOU CANT TELL") | not'
# The relay line: no default relay key means "Relay (default): N/A".
rs="$(inv share.relayStatus '{"wait":false}')"; echo "$rs"
if jq -e '.source == "registry" and (.relayKey | not) and .found != "found"' <<<"$rs" >/dev/null; then
  for _ in $(seq 1 20); do [ "$(order | jq -r '.relayStatus')" = 'Relay (default): N/A' ] && break; sleep 0.5; done
  test "$(order | jq -r '.relayStatus')" = 'Relay (default): N/A'
fi
APPROVAL_DOT='.modal-overlay .share-safety:not(.share-verified-only) .share-safety-dot'
VERIFIED_DOT='.modal-overlay .share-verified-only .share-safety-dot'
dot() { cmd "$(jq -nc --arg s "$1" '{command: "style-of", selector: $s}')"; }
ORANGE="$(dot "$VERIFIED_DOT" | jq -r '.backgroundColor')"
cmd '{"command":"share-select","type":"single"}' >/dev/null
text | grep -F 'Whoever opens this link first joins right away'
! red
cmd '{"command":"share-select","type":"group"}' >/dev/null
text | grep -F "can ask to join. You'll see each person's verified GitHub identity"
! red
# Dots: approval ticked by default (green), verified-only not (orange), each right of its text.
dot "$APPROVAL_DOT" | jq -e '.found and (.className | test("\\bon\\b"))'
GREEN="$(dot "$APPROVAL_DOT" | jq -r '.backgroundColor')"
dot "$VERIFIED_DOT" | jq -e '.found and (.className | test("\\bon\\b") | not)'
test "$GREEN" != "$ORANGE"
span="$(dot '.modal-overlay .share-verified-only span:not(.share-safety-dot)')"
jq -e --argjson d "$(dot "$VERIFIED_DOT" | jq -c '.rect')" '.rect.right <= $d.left' <<<"$span"
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R42_group_approval.png" >/dev/null
click_sel '.modal-overlay .share-options-form > label:not(.share-verified-only) input'; sleep 0.5
text | grep -F 'Anyone with this link joins right away, without your approval. Some may be unidentified.'
red
test "$(dot "$APPROVAL_DOT" | jq -r '.backgroundColor')" = "$ORANGE"
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R42_group_open.png" >/dev/null
click_sel '.modal-overlay .share-verified-only input'; sleep 0.5
text | grep -F 'Only people who prove a GitHub identity can join.'
test "$(dot "$VERIFIED_DOT" | jq -r '.backgroundColor')" = "$GREEN"
! red
text | grep -vqF 'YOU CANT TELL'
uisolate screenshot "$ZBUI_SESSION" "$ACCEPT_LOG_DIR/R42_verified_only.png" >/dev/null
cmd '{"command":"share-submit"}' >/dev/null; sleep 2
inv share.listLinks "$(jq -nc --arg s "$s1" '{sessionId: $s}')" | tee /dev/stderr | jq -e '[.. | objects | select(has("linkId"))] | length == 1 and (.[0].verifiedOnly == true)'
xdo key Escape
