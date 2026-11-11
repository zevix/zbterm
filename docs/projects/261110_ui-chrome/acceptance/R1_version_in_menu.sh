#!/usr/bin/env bash
# R1 version_in_menu — proves R1: the version is the last settings-menu item (disabled, below a separator) and #version is gone from the brand bar.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
ver="$(jq -r .version "$UB_REPO/package.json")"
s="$(cmd '{"command":"settings-open"}')"
jq '{menu, brandVersion}' <<<"$s"
# The last item is the version: kind info, "ZBTerm <version>", disabled, below a separator.
jq -e '.menu[-1].kind == "info"' <<<"$s"
jq -e --arg v "$ver" '.menu[-1].label | test("^ZBTerm v?" + ($v | gsub("\\."; "\\.")) + "$")' <<<"$s"
jq -e '.menu[-1].disabled == true' <<<"$s"
jq -e '.menu[-2].kind == "separator"' <<<"$s"
# Gone from the brand bar.
jq -e '(.brandVersion // "") == ""' <<<"$s"
