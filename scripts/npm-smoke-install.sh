#!/usr/bin/env bash
# Installs a zbterm tarball into a throwaway global prefix and proves the
# result actually works: the CLI runs, every `zbterm doctor` check is green,
# the runtime Electron survived the install, and - when a display is available
# - the app boots far enough for the Bare engine to come up.
#
#   bash scripts/npm-smoke-install.sh /path/to/zbterm-1.2.3.tgz
#
# Unix only; scripts/npm-smoke-install.ps1 is the Windows counterpart.
#
# Nothing outside the temporary prefix is touched: HOME stays put, but
# XDG_CONFIG_HOME is redirected into the prefix so the real ~/.config tree is
# never read or written. The prefix is removed on exit, including on failure.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/npm-smoke-install.sh [tarball] [--help]

Smoke-tests an installed zbterm npm tarball. Unix-only (see below). Runnable
from any cwd; the repo root is resolved from this script's own path.

  tarball   Path to a zbterm-*.tgz. Defaults to the tarball for the current
            package version in the repo root, and runs `npm pack` to build one
            if it is not there. Use scripts/npm-pack-check.sh to produce a
            validated tarball first.

What it does:
  1. Installs the tarball into `mktemp -d` used as an `npm install -g --prefix`.
  2. Runs `zbterm --version`.
  3. Runs `zbterm doctor --json` - the primary health gate; it is the cheapest
     end-to-end proof. The assertion is on the PARSED report - every check must
     report ok:true - and the exit code is checked as well, not instead.
  4. Asserts the installed tree still has a runtime `electron` (a global
     install drops devDependencies, so the deliberate duplicate listing of
     electron in both dependency blocks must not be the only copy).
  5. With xvfb-run or a $DISPLAY: launches the app with --debug-server on a
     free port under a sandboxed XDG_CONFIG_HOME, and polls GET /health for up
     to 60s until the body contains "engineReady":true. HTTP 200 alone is not
     a pass - /health answers 200 with {"ok":false,"engineReady":false} when
     the Bare engine failed to load, which is exactly how a missing bare-*
     dependency shows up. Then it terminates only the process group it
     started, polls until it is gone (shutdown takes ~10-15s) and asserts no
     orphans are left.

Not Windows: `npm install -g --prefix DIR` puts binaries in DIR/bin on Unix
but in DIR itself on Windows, so this script refuses to run there rather than
silently passing. Use the Windows counterpart instead:

  pwsh scripts/npm-smoke-install.ps1 [tarball]

Exit status: 0 when every stage passed, 1 otherwise.
EOF
}

TARBALL=""
for arg in "$@"; do
  case "$arg" in
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "npm-smoke-install: unknown option: $arg" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -n "$TARBALL" ]; then
        echo "npm-smoke-install: more than one tarball given" >&2
        exit 1
      fi
      TARBALL="$arg"
      ;;
  esac
done

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    echo "npm-smoke-install: Unix-only." >&2
    echo "  On Windows 'npm install -g --prefix DIR' installs the shims into DIR" >&2
    echo "  itself, not DIR/bin, so this script cannot verify the install here." >&2
    echo "  Run the Windows counterpart instead:" >&2
    echo "    pwsh scripts/npm-smoke-install.ps1 [tarball]" >&2
    exit 1
    ;;
esac

ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

step() { echo "==> $*"; }
ok() { echo "    ok: $*"; }
die() {
  echo "    FAIL: $*" >&2
  exit 1
}

if [ -z "$TARBALL" ]; then
  VERSION=$(node -p "require('$ROOT/package.json').version")
  TARBALL="$ROOT/zbterm-$VERSION.tgz"
  if [ ! -f "$TARBALL" ]; then
    step "No tarball given and $TARBALL is missing - running npm pack"
    npm pack --pack-destination "$ROOT" >/dev/null
  fi
fi
[ -f "$TARBALL" ] || die "tarball not found: $TARBALL"
TARBALL=$(CDPATH= cd -- "$(dirname -- "$TARBALL")" && printf '%s/%s' "$(pwd)" "$(basename -- "$TARBALL")")

PREFIX=$(mktemp -d "${TMPDIR:-/tmp}/zbterm-smoke-XXXXXX")
APP_PGID=""

cleanup() {
  local status=$?
  if [ -n "$APP_PGID" ]; then
    # Only ever signal the process group this script created. A bare
    # `pkill zbterm` would also hit the developer's live instance.
    kill -TERM -- "-$APP_PGID" 2>/dev/null || true
    local waited=0
    while kill -0 -- "-$APP_PGID" 2>/dev/null && [ "$waited" -lt 40 ]; do
      command sleep 1
      waited=$((waited + 1))
    done
    kill -KILL -- "-$APP_PGID" 2>/dev/null || true
  fi
  rm -rf "$PREFIX"
  exit $status
}
trap cleanup EXIT INT TERM

step "Temporary global prefix: $PREFIX"
export XDG_CONFIG_HOME="$PREFIX/xdg-config"
export XDG_CACHE_HOME="$PREFIX/xdg-cache"
# Without this the app mints its own $TMPDIR/zbterm-electron-<pid>-<hex>
# scratch Chromium profile, which survives a SIGTERM teardown and would leave
# litter in /tmp. Pointing it inside the prefix keeps everything under one
# directory that the trap removes.
export ZBTERM_ELECTRON_USER_DATA="$PREFIX/electron-user-data"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"

step "Installing $TARBALL"
# ignore-scripts is pinned off explicitly: the electron and node-pty install
# scripts have to run, and the repo-local .npmrc that normally guarantees that
# does not apply to an install targeting a different prefix.
npm install -g --prefix "$PREFIX" --ignore-scripts=false "$TARBALL"

BIN="$PREFIX/bin/zbterm"
[ -x "$BIN" ] || die "no executable at $BIN"
ok "$BIN"

INSTALLED="$PREFIX/lib/node_modules/zbterm"
[ -d "$INSTALLED" ] || die "installed package not found at $INSTALLED"

step "zbterm --version"
"$BIN" --version

step "Checking the installed tree kept a runtime electron"
ELECTRON_BINARY=$(node -e '
  const path = require("path")
  const root = process.argv[1]
  try {
    const binary = require(path.join(root, "node_modules", "electron"))
    if (typeof binary === "string" && binary) { process.stdout.write(binary); process.exit(0) }
  } catch (err) {
    process.stderr.write(String(err && err.message) + "\n")
  }
  process.exit(1)
' "$INSTALLED") || die "the global install has no usable electron (devDependencies are dropped - electron must stay in dependencies too)"
[ -x "$ELECTRON_BINARY" ] || die "electron binary is not executable: $ELECTRON_BINARY"
ok "electron binary: $ELECTRON_BINARY"

step "zbterm doctor --json"
DOCTOR_OUT="$PREFIX/doctor.json"
DOCTOR_STATUS=0
"$BIN" doctor --json >"$DOCTOR_OUT" || DOCTOR_STATUS=$?
# The parsed report is the assertion, not the exit code: a doctor that
# forgot to propagate a failure, or that printed nothing at all, must not be
# able to pass this stage. The exit code is then checked as a cheap
# cross-check that doctor agrees with its own report.
if ! node -e '
  const report = require(process.argv[1])
  const checks = report.checks || report
  if (!Array.isArray(checks) || checks.length === 0) {
    console.log("    no checks in the report")
    process.exit(1)
  }
  let failed = 0
  for (const c of checks) {
    console.log("    " + (c.info ? "INFO" : c.ok ? "PASS" : "FAIL") + " " + c.name + ": " + c.detail)
    if (!c.ok) {
      failed++
      if (c.fix) console.log("         fix: " + c.fix)
    }
  }
  process.exit(failed ? 1 : 0)
' "$DOCTOR_OUT"; then
  cat "$DOCTOR_OUT" >&2 || true
  die "zbterm doctor --json reported a check with ok:false (or produced no usable report)"
fi
[ "$DOCTOR_STATUS" -eq 0 ] || die "zbterm doctor --json exited $DOCTOR_STATUS"
ok "doctor: every check ok"

# ---------------------------------------------------------------------------
# GUI stage.
#
# `zbterm --help` is deliberately NOT exercised here: it never exits (the
# Electron child outlives main.js's process.exit and the launcher waits on it),
# so it would need a timeout plus its own process-group teardown. It is covered
# by the CLI tests instead.
# ---------------------------------------------------------------------------
LAUNCH_PREFIX=()
if command -v xvfb-run >/dev/null 2>&1; then
  # Preferred even when $DISPLAY is set: no window lands on the developer's
  # real desktop.
  LAUNCH_PREFIX=(xvfb-run -a)
  step "GUI stage: using xvfb-run"
elif [ -n "${DISPLAY:-}" ]; then
  step "GUI stage: using DISPLAY=$DISPLAY"
else
  echo "==> GUI stage SKIPPED: no xvfb-run and no \$DISPLAY on this machine."
  echo "    The install was verified only through 'zbterm doctor'."
  exit 0
fi

PORT=$(node -e '
  const net = require("net")
  const s = net.createServer()
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => console.log(p)) })
')
step "Launching zbterm --debug-server on 127.0.0.1:$PORT"

LOG="$PREFIX/app.log"
# setsid puts the whole app tree (launcher -> electron -> renderer/engine) into
# its own process group, which is the only reliable handle on it: xvfb-run's
# children outlive the wrapper, so killing the wrapper alone leaks Electron.
setsid "${LAUNCH_PREFIX[@]}" "$BIN" --debug-server --debug-server-port "$PORT" --no-updates \
  >"$LOG" 2>&1 &
LAUNCH_PID=$!
APP_PGID=$(ps -o pgid= -p "$LAUNCH_PID" | tr -d ' ')
[ -n "$APP_PGID" ] || die "could not determine the process group of the launched app"
ok "process group $APP_PGID"

step "Polling GET /health for \"engineReady\":true (up to 60s)"
HEALTHY=0
BODY=""
for _ in $(seq 1 60); do
  BODY=$(node -e '
    const http = require("http")
    const req = http.get({ host: "127.0.0.1", port: process.argv[1], path: "/health", timeout: 2000 }, (res) => {
      let body = ""
      res.on("data", (d) => (body += d))
      res.on("end", () => { process.stdout.write(body); process.exit(0) })
    })
    req.on("timeout", () => { req.destroy(); process.exit(1) })
    req.on("error", () => process.exit(1))
  ' "$PORT" 2>/dev/null) || BODY=""
  case "$BODY" in
    *'"engineReady":true'*)
      HEALTHY=1
      break
      ;;
  esac
  if ! kill -0 -- "-$APP_PGID" 2>/dev/null; then
    echo "--- app log ---" >&2
    cat "$LOG" >&2 || true
    die "the app exited before /health reported engineReady"
  fi
  command sleep 1
done

if [ "$HEALTHY" -ne 1 ]; then
  echo "--- last /health body ---" >&2
  echo "${BODY:-<no response>}" >&2
  echo "--- app log ---" >&2
  cat "$LOG" >&2 || true
  # A 200 with {"ok":false,"engineReady":false} means the Bare engine never
  # loaded - typically a missing bare-* dependency in the packed tree.
  die "/health never reported \"engineReady\":true within 60s"
fi
ok "/health: $BODY"

step "Terminating the launched process group ($APP_PGID)"
kill -TERM -- "-$APP_PGID" 2>/dev/null || true
GONE=0
for _ in $(seq 1 40); do
  if ! kill -0 -- "-$APP_PGID" 2>/dev/null; then
    GONE=1
    break
  fi
  command sleep 1
done
if [ "$GONE" -ne 1 ]; then
  kill -KILL -- "-$APP_PGID" 2>/dev/null || true
  command sleep 2
fi

ORPHANS=$(pgrep -g "$APP_PGID" 2>/dev/null || true)
if [ -n "$ORPHANS" ]; then
  echo "    orphan pids: $ORPHANS" >&2
  die "processes from the launched group survived teardown"
fi
ok "no orphans left from process group $APP_PGID"
APP_PGID=""

# Electron's own setAsDefaultProtocolClient prints
# "xdg-mime: application argument missing" on every Linux launch; it is
# harmless and is not treated as a failure.
if grep -qi 'xdg-mime: application argument missing' "$LOG" 2>/dev/null; then
  echo "    note: ignored the harmless 'xdg-mime: application argument missing' lines"
fi

echo "==> Smoke install passed."
