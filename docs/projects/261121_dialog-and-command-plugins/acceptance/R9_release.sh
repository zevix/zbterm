#!/usr/bin/env bash
# R9 release — proves R9 (and U5 through test/engine-client-pty.test.js): lint passes, the tests this project touched pass, the static checks pass whole, and the packaged build under test carries this source and boots healthy.
# Asserts: `npm run lint` exits 0; brittle-node on test/command-plugins.test.js, test/launch-plugins.test.js and test/engine-client-pty.test.js exits 0 and prints no "not ok" (the last includes U5's commandArgs case for a shell outside the list); test/renderer-static.test.js exits 0 and prints no "not ok" (kit correction 2026-11-21: its two baseline failures were fixed); the packaged build's resources/app holds byte-identical copies of the project's source files (electron/command-plugins.js, electron/pty-session.js, electron/main.js, renderer/app.js, renderer/index.html, renderer/plugins/{launch-core,steps-editor,shell-command}.js and the samples); started on a scratch HOME under uisolate it reaches ready, /health says ok, engineReady and renderer.ok, and the seeded plugins directory holds commands.json and sample_custom_command.js.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ZBUI_ID=R9_release
source "$here/activate"; source "$ZBUI_LIB"; source "$ZBUI_LIB_UP"; source "$here/lib_dp.sh"
need uisolate "the app runs only on a private display"
need jq "reads the debug-server JSON"
need curl "talks to the debug server"
need npm "lint and tests"
need npx "runs brittle-node"
need cmp "compares the packaged files with the source"
need "$ZBUI_APP" "packaged build under test"
need "$ZXTERM_CORE_BIN" "the zxterm-core sidecar the packaged app runs"
set -x
cd "$UB_REPO"
T="$ACCEPT_LOG_DIR/R9_tests"
mkdir -p "$T"

# Lint (= CI).
timeout 300 npm run lint > "$ACCEPT_LOG_DIR/R9_lint.txt" 2>&1

# The tests this project touched, whole. Scratch HOME, short TMPDIR (AGENTS.md).
run_test() {
  HOME="$UBITRON_TEST_STATE_DIR/home" TMPDIR="$ZBUI_TMP" timeout 180 npx brittle-node "test/$1.test.js" > "$T/$1.txt" 2>&1
}
for f in command-plugins launch-plugins engine-client-pty; do
  run_test "$f"
  ! grep -qE '^not ok [0-9]+ ' "$T/$f.txt"
  grep -qE '^ok [0-9]+ ' "$T/$f.txt"
done

# Kit correction 2026-11-21 (orchestrator, stale tests fixed): renderer-static baseline failures 31/37 fixed; the file must now pass whole
# The static checks, whole (like the three above).
run_test renderer-static
! grep -qE '^not ok [0-9]+ ' "$T/renderer-static.txt"
grep -qE '^ok [0-9]+ ' "$T/renderer-static.txt"

# The packaged build under test carries this source (a build older than the source proves nothing).
A="$(dirname "$ZBUI_APP")/resources/app"
for f in electron/command-plugins.js electron/pty-session.js electron/main.js renderer/app.js \
  renderer/index.html renderer/plugins/launch-core.js renderer/plugins/steps-editor.js \
  renderer/plugins/shell-command.js renderer/plugins/samples/*.js; do
  cmp "$f" "$A/$f"
done

# It boots on a scratch HOME under uisolate and reports healthy.
start_app
h="$(api GET /health)"
echo "$h" | jq -c '{ok, engineReady, renderer}'
jq -e '.ok == true and .engineReady == true and .renderer.ok == true' <<<"$h"
d="$(plugins_dir)"
case "$d" in "$UBITRON_TEST_STATE_DIR"/*) ;; *) echo "plugins dir outside the state dir: $d" >&2; exit 1 ;; esac
test -f "$d/commands.json"
test -f "$d/sample_custom_command.js"
stop_app
echo "R9 release: PASS"
