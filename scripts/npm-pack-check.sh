#!/usr/bin/env bash
# Validates the npm tarball ZBTerm would publish, before anything irreversible
# can happen. Runs lint + tests, builds a real tarball with `npm pack`, and
# asserts its contents, then leaves the tarball's absolute path on stdout as
# the very last line so callers can pipe it into npm-smoke-install.sh:
#
#   bash scripts/npm-pack-check.sh | tee /tmp/pack.log
#   bash scripts/npm-smoke-install.sh "$(tail -1 /tmp/pack.log)"
#
# This script never publishes anything - see scripts/release-npm.sh.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/npm-pack-check.sh [--help]

Pre-publish validation of the zbterm npm tarball. Runnable from any cwd; the
repo root is resolved from this script's own path.

Checks, in order:
  1. package-lock.json is fresh (`npm install --package-lock-only` is a no-op).
  2. `npm run lint` passes.
  3. `npm test` passes.
  4. `npm pack` builds a tarball into the repo root (stale zbterm-*.tgz are
     removed first so an old artifact can never be validated by mistake).
  5. The tarball contains bin/zbterm.js, bin/lib/{doctor,desktop}.js,
     electron/main.js, renderer/vendor/, at least one build/icon/icon-*.png,
     and a non-empty renderer/logo-ascii.js.
  6. The tarball contains none of out/, node_modules/, test/, docs/, spikes/,
     assets/, relay/, forge.config.js.
  7. The tarball is 5 MB or smaller.

Output: progress on stdout, and the absolute tarball path as the last line.
Exit status: 0 when every check passed, 1 otherwise.
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "npm-pack-check: unknown option: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

MAX_TARBALL_BYTES=$((5 * 1024 * 1024))

WORK=$(mktemp -d "${TMPDIR:-/tmp}/zbterm-packcheck-XXXXXX")
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

FAILURES=0

step() { echo "==> $*"; }
ok() { echo "    ok: $*"; }
bad() {
  echo "    FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

# ---------------------------------------------------------------------------
# 1. Lockfile freshness.
#
# The plan's literal check is `npm install --package-lock-only && git diff
# --exit-code package-lock.json`, which only means anything on a clean tree.
# Comparing against a snapshot taken immediately before the regenerate is
# equivalent there and still correct while the working tree is dirty, so that
# is what runs here. A stale lockfile is left regenerated on purpose - the
# regenerated file is the fix.
# ---------------------------------------------------------------------------
step "Checking package-lock.json freshness"
cp package-lock.json "$WORK/package-lock.before.json"
npm install --package-lock-only
if cmp -s package-lock.json "$WORK/package-lock.before.json"; then
  ok "package-lock.json is up to date"
else
  bad "package-lock.json was stale; it has been regenerated - review and keep the new file"
fi

step "Running npm run lint"
npm run lint

step "Running npm test"
npm test

# ---------------------------------------------------------------------------
# 4. Pack.
#
# `npm pack` writes into the cwd unless --pack-destination is given; both are
# pinned to the repo root here, and stale tarballs are removed first so the
# assertions below can never run against a previous build.
# ---------------------------------------------------------------------------
step "Removing stale zbterm-*.tgz from $ROOT"
rm -f "$ROOT"/zbterm-*.tgz

step "Running npm pack"
# `prepack` (renderer asset vendoring) runs here, exactly as it will during a
# real `npm publish`.
npm pack --pack-destination "$ROOT" | tee "$WORK/pack.out"
TARBALL_NAME=$(grep -E '\.tgz$' "$WORK/pack.out" | tail -1)
TARBALL="$ROOT/$TARBALL_NAME"
if [ ! -f "$TARBALL" ]; then
  echo "npm-pack-check: npm pack did not produce a tarball ($TARBALL)" >&2
  exit 1
fi

LISTING="$WORK/listing.txt"
tar -tzf "$TARBALL" >"$LISTING"

step "Checking required paths"
require() {
  local pattern="$1" label="$2"
  if grep -qE "$pattern" "$LISTING"; then
    ok "$label"
  else
    bad "missing from tarball: $label"
  fi
}

require '^package/bin/zbterm\.js$' 'bin/zbterm.js'
require '^package/bin/lib/doctor\.js$' 'bin/lib/doctor.js'
require '^package/bin/lib/desktop\.js$' 'bin/lib/desktop.js'
# The postinstall runs as `node bin/lib/postinstall.js` and requires
# native-linkage.js; if either is missing from the tarball every install fails
# with MODULE_NOT_FOUND before npm ever gets to link the bin shim.
require '^package/bin/lib/postinstall\.js$' 'bin/lib/postinstall.js'
require '^package/bin/lib/native-linkage\.js$' 'bin/lib/native-linkage.js'
require '^package/electron/main\.js$' 'electron/main.js'
require '^package/renderer/vendor/' 'renderer/vendor/'
# `install-desktop` silently installs zero icons when build/icon/ is missing
# from the tarball, so at least one sized icon has to be there.
require '^package/build/icon/icon-[^/]+\.png$' 'build/icon/icon-*.png'

# renderer/logo-ascii.js is the source of truth for the mark and the startup
# splash loads it directly, so it has to ship. Nothing regenerates it - `icons`
# generates *from* it and is deliberately not part of `prepack`.
LOGO_ENTRY='package/renderer/logo-ascii.js'
if grep -qxF "$LOGO_ENTRY" "$LISTING"; then
  LOGO_BYTES=$(tar -xzOf "$TARBALL" "$LOGO_ENTRY" | wc -c)
  if [ "$LOGO_BYTES" -gt 0 ]; then
    ok "renderer/logo-ascii.js ($LOGO_BYTES bytes)"
  else
    bad "renderer/logo-ascii.js is empty in the tarball"
  fi
else
  bad "missing from tarball: renderer/logo-ascii.js"
fi

step "Checking forbidden paths"
forbid() {
  local pattern="$1" label="$2"
  local hits
  hits=$(grep -E "$pattern" "$LISTING" || true)
  if [ -z "$hits" ]; then
    ok "no $label"
  else
    bad "tarball contains $label:"
    echo "$hits" | sed 's/^/      /' >&2
  fi
}

forbid '^package/out/' 'out/'
forbid '^package/node_modules/' 'node_modules/'
forbid '^package/test/' 'test/'
forbid '^package/docs/' 'docs/'
forbid '^package/spikes/' 'spikes/'
forbid '^package/assets/' 'assets/'
forbid '^package/relay/' 'relay/'
forbid '^package/forge\.config\.js$' 'forge.config.js'

step "Checking tarball size"
TARBALL_BYTES=$(wc -c <"$TARBALL")
echo "    tarball size: $TARBALL_BYTES bytes ($((TARBALL_BYTES / 1024)) KiB), entries: $(wc -l <"$LISTING")"
if [ "$TARBALL_BYTES" -le "$MAX_TARBALL_BYTES" ]; then
  ok "within the $((MAX_TARBALL_BYTES / 1024 / 1024)) MB limit"
else
  bad "tarball is larger than $((MAX_TARBALL_BYTES / 1024 / 1024)) MB"
fi

# NOTE: `electron` is listed in BOTH dependencies and devDependencies on
# purpose - electron-forge only reads devDependencies, while the npm package
# needs the runtime copy. That duplicate is not an error and is not flagged.

if [ "$FAILURES" -ne 0 ]; then
  echo "npm-pack-check: $FAILURES check(s) failed" >&2
  exit 1
fi

echo "==> All checks passed."
# Last line of stdout, by contract.
echo "$TARBALL"
