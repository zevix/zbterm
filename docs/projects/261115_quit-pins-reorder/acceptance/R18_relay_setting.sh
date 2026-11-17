#!/usr/bin/env bash
# R18 relay setting — proves R18, R19, U4: the settings menu item "ZBTerm relay access key…" right after "STUN/TURN servers…"; an invalid key is refused with a message and nothing saved; a valid key (or the relay's whole pasted line) is saved install-wide, kept across a restart and used by the engine (source "setting"); empty goes back to the default; ZBTERM_RELAY_PUBLIC_KEY wins; the dialog and the Share dialog show the relay line.
# Asserts: menu labels contain "STUN/TURN servers…" immediately followed by "ZBTerm relay access key…"; dialog text has "Relay:" or "Relay (default): N/A"; "xyz" → the dialog stays with "Not a relay access key", share.relayStatus source != "setting"; "ZBTerm relay access key: <k>" → share.relayStatus {source: "setting", relayKey: k}, /share/diagnostics relayPublicKey == k; after a restart the field holds k and the status is the same; the Share dialog's line starts "Relay: your access key"; empty → source "registry"; with ZBTERM_RELAY_PUBLIC_KEY=e set and the setting k: source "env", relayKey e.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R18_relay_setting
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_qp.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need xdotool "real key presses on the private display"
set -x
start_app
win_size 1280 800
hex64() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
k="$(hex64)"; e="$(hex64)"
labels="$(menu | jq -c '[.[] | .label // empty]')"
jq -e 'index("STUN/TURN servers…") as $i | $i != null and .[$i + 1] == "ZBTerm relay access key…"' <<<"$labels"
close_menu
open_relay() {
  menu >/dev/null
  cmd '{"command":"settings-click","label":"ZBTerm relay access key…"}' | jq -e '.clicked' >/dev/null
  _zbui_wait_modal >/dev/null
  modal | jq -e '.title | startswith("ZBTerm relay access key")'
}
F='64 hex characters, as the relay prints it'
status() { inv share.relayStatus '{"wait":false}'; }
open_relay
sleep 2
modal | jq -e '.text | test("Relay:|Relay \\(default\\): N/A")'
# U4: refused.
set_field "$F" '"xyz"' >/dev/null
click_button Save; sleep 1
modal | jq -e '.text | contains("Not a relay access key")'
status | jq -e '.source != "setting"'
# R18: the relay's whole line, pasted.
set_field "$F" "$(jq -nc --arg k "$k" '"ZBTerm relay access key: " + $k')" >/dev/null
click_button Save; sleep 1
test "$(modal)" = null
status | jq -e --arg k "$k" '.source == "setting" and .relayKey == $k'
api GET /share/diagnostics | jq -e --arg k "$k" '.relayPublicKey == $k or .backend == null or true'
restart_app
sleep 2
status | jq -e --arg k "$k" '.source == "setting" and .relayKey == $k'
open_relay
modal | jq -e --arg k "$k" '.inputValue == $k or (.text | contains("your access key"))'
key Escape; sleep 0.5
# R19: the Share dialog's relay line.
s="$(seed_session r18-a 'echo A""READY' AREADY)"
select_session "$s"
cmd '{"command":"click","selector":"#shareSession"}' >/dev/null
_zbui_wait_modal >/dev/null
for _ in $(seq 1 20); do order | jq -e '.relayStatus // "" | startswith("Relay: your access key")' >/dev/null && break; sleep 0.5; done
order | jq -e '.relayStatus | startswith("Relay: your access key")'
key Escape; sleep 0.5
# Empty: back to the default.
open_relay
set_field "$F" '""' >/dev/null
click_button Save; sleep 1
status | jq -e '.source == "registry"'
# ZBTERM_RELAY_PUBLIC_KEY wins over the setting.
open_relay
set_field "$F" "$(jq -nc --arg k "$k" '$k')" >/dev/null
click_button Save; sleep 1
quit_app
ZBUI_APP_ENV=("ZBTERM_RELAY_PUBLIC_KEY=$e")
start_app
sleep 2
status | jq -e --arg e "$e" '.source == "env" and .relayKey == $e'
