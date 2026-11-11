#!/usr/bin/env bash
# R6 identity_dot — proves R6: with no identity the identity button's dot is orange; after setting one up through the identity-* debug commands it is green (also on the settings button while collapsed).
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
need ssh-keygen "makes the throwaway identity key"
need python3 "serves the stand-in <user>.keys endpoint"
user=zbui-r6
# A throwaway key in the scratch HOME, published by a local stand-in for github.com/<user>.keys.
mkdir -p "$ZBUI_APP_HOME/.ssh"; chmod 700 "$ZBUI_APP_HOME/.ssh"
ssh-keygen -q -t ed25519 -N '' -C "$user@zbui-kit" -f "$ZBUI_APP_HOME/.ssh/id_ed25519"
fp="$(ssh-keygen -lf "$ZBUI_APP_HOME/.ssh/id_ed25519.pub" | awk '{print $2}')"
keys="$ZBUI_APP_HOME/keys-www"; mkdir -p "$keys"
cp "$ZBUI_APP_HOME/.ssh/id_ed25519.pub" "$keys/$user.keys"
start_app_with_keys() {
  kport="$(free_port)"
  # Runs inside this script's uisolate session, so stop_app ends it too.
  run_bg python3 -m http.server "$kport" --bind 127.0.0.1 --directory "$keys"
  ZBUI_APP_ENV=("ZBTERM_GITHUB_KEYS_BASE=http://127.0.0.1:$kport")
  start_app
}
start_app_with_keys
s="$(state)"
jq '{identityDot, identityDotColor, identityDotSettings}' <<<"$s"
# No identity: an orange dot.
jq -e '.identityDot == "unset"' <<<"$s"
jq -e -L "$ZBUI_JQ_LIB" "$JQ_COLOR"'.identityDotColor | is_orange' <<<"$s"
# Set one up through the wizard's debug commands.
cmd '{"command":"identity-open"}' >/dev/null
cmd '{"command":"identity-choose","provider":"github"}' >/dev/null
cmd "{\"command\":\"identity-username\",\"value\":\"$user\"}" >/dev/null
key_listed() { cmd '{"command":"modal-state"}' | jq -e --arg fp "$fp" 'any(.identity.candidates[]?; .fingerprint == $fp and .onProvider)'; }
wait_until 30 key_listed
cmd "{\"command\":\"identity-select-key\",\"fingerprint\":\"$fp\"}" >/dev/null
cmd '{"command":"identity-submit"}' >/dev/null
is_github() { api GET /identity | jq -e '.provider == "github"'; }
wait_until 30 is_github
s="$(state)"
jq '{identityDot, identityDotColor, identityDotSettings}' <<<"$s"
jq -e '.identityDot == "set"' <<<"$s"
jq -e -L "$ZBUI_JQ_LIB" "$JQ_COLOR"'.identityDotColor | is_green' <<<"$s"
# Collapsed, the settings button carries the dot too.
s="$(cmd '{"command":"click","selector":"#brandMark, .brand-mark"}')"
jq -e '.sideCollapsed == true and .identityDotSettings == "set"' <<<"$s"
jq -e -L "$ZBUI_JQ_LIB" "$JQ_COLOR"'.identityDotSettingsColor | is_green' <<<"$s"
