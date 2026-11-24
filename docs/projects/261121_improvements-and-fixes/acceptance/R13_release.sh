#!/usr/bin/env bash
# R13 release — proves R13: the version is the same everywhere a build reads it, the packaged build under test is that version and boots (engine ready, the settings menu's last line names it), lint passes, and the renderer and share tests fail only where they failed before this project (baseline.md).
# Asserts: package.json, package-lock.json (root and packages[""]) and build/AppxManifest.xml Identity (as N.N.N.0) carry one version V; the packaged app's resources/app/package.json is V; started on a scratch HOME it reaches ready and its settings menu ends "ZBTerm vV"; `npm run lint` exits 0; brittle-node on test/renderer-static.test.js, test/share-manager.test.js, test/buffer-search.test.js and test/catalog-sort.test.js: every 261121 test (four) passes, the other three files pass whole, and the only failing tests are the two named in baseline.md (startup logo; buffer-search section), each logged.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R13_release
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_if.sh"
need uisolate "the app runs only on a private display"
need jq "reads the manifests and debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
need npm "lint and tests"
set -x
cd "$UB_REPO"
V="$(jq -r .version package.json)"
test "$(jq -r .version package-lock.json)" = "$V"
test "$(jq -r '.packages[""].version' package-lock.json)" = "$V"
grep -q "<Identity Name=\"ZBTerm\" Version=\"$V.0\"" build/AppxManifest.xml
test "$(jq -r .version "$(dirname "$ZBUI_APP")/resources/app/package.json")" = "$V"

start_app
menu | jq -e --arg v "ZBTerm v$V" 'last | .kind == "info" and .label == $v'
close_menu
stop_app

timeout 300 npm run lint > "$ACCEPT_LOG_DIR/R13_lint.txt" 2>&1
T="$ACCEPT_LOG_DIR/R13_tests"
mkdir -p "$T"
HOME="$UBITRON_TEST_STATE_DIR/home" TMPDIR="$ZBUI_TMP" timeout 200 npx brittle-node test/share-manager.test.js > "$T/share-manager.txt" 2>&1
# Kit correction 2026-11-21 (R14-R16 added): the matcher's and the catalog's tests (match case,
# whole word) pass whole too, and the static file has four 261121 tests.
HOME="$UBITRON_TEST_STATE_DIR/home" TMPDIR="$ZBUI_TMP" timeout 200 npx brittle-node test/buffer-search.test.js > "$T/buffer-search.txt" 2>&1
HOME="$UBITRON_TEST_STATE_DIR/home" TMPDIR="$ZBUI_TMP" timeout 200 npx brittle-node test/catalog-sort.test.js > "$T/catalog-sort.txt" 2>&1
grep -E '^ok [0-9]+ - (match case|searchBuffer: caseSensitive|catalog: the name filter)' "$T/buffer-search.txt" "$T/catalog-sort.txt"
HOME="$UBITRON_TEST_STATE_DIR/home" TMPDIR="$ZBUI_TMP" timeout 200 npx brittle-node test/renderer-static.test.js > "$T/renderer-static.txt" 2>&1 || true
grep -E '^(not )?ok [0-9]+ - 261121' "$T/renderer-static.txt"
! grep -qE '^not ok [0-9]+ - 261121' "$T/renderer-static.txt"
test "$(grep -cE '^ok [0-9]+ - 261121' "$T/renderer-static.txt")" = 4
failing="$(grep -E '^not ok [0-9]+ - ' "$T/renderer-static.txt" | sed -E 's/^not ok [0-9]+ - //; s/ # time.*$//' | sort)"
echo "renderer-static failing: $failing"
expected="$(printf '%s\n' 'buffer-search: the buffer-match section, its cyan in both themes, alternate-screen highlights' 'the startup logo text ends on the last row without scrolling' | sort)"
test "$failing" = "$expected"
echo "R13 release: PASS ($V)"
