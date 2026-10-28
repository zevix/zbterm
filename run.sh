#!/usr/bin/env bash
# Runs ZBTerm from this checkout: from source (npm start), the packaged app
# under out/, or the headless relay server.
#
# Usage:
#   ./run.sh [mode] [options] [-- <app or relay args>]
#
# Modes:
#   --dev                    from source via `npm start` (default)
#   --packaged               out/ZBTerm-linux-<arch>/ - the build that proves the
#                            Bare sidecar boots; offers to (re)package when it is
#                            missing or older than the sources
#   --relay                  node relay/server.js (ZBTERM_RELAY_PORT/_SEED apply)
#
# Options:
#   --out <dir>              packaged build root (default: out, or $ZBTERM_FORGE_OUT_DIR)
#   --scratch                throwaway storage, Electron userData and HOME under
#                            /tmp - never touches your real profile
#   --keep                   with --scratch: keep the scratch dir afterwards
#   --profile <name>         same as the app's --profile
#   --debug-server [port]    start the debug REST API; a free port if none given
#
# Everything after `--` goes to the app (or relay) unchanged, e.g.
#   ./run.sh --scratch -- --devtools --backend none
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

MODE=dev
OUT_ROOT=${ZBTERM_FORGE_OUT_DIR:-out}
SCRATCH=0
KEEP=0
PROFILE=""
DEBUG_SERVER=0
DEBUG_PORT=""
PASSTHROUGH=()

usage() {
  sed -n '5,24p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dev) MODE=dev ;;
    --packaged) MODE=packaged ;;
    --relay) MODE=relay ;;
    --out)
      [ $# -ge 2 ] || { echo "--out needs a directory" >&2; exit 1; }
      OUT_ROOT=$2
      shift
      ;;
    --scratch) SCRATCH=1 ;;
    --keep) KEEP=1 ;;
    --profile)
      [ $# -ge 2 ] || { echo "--profile needs a name" >&2; exit 1; }
      PROFILE=$2
      shift
      ;;
    --debug-server)
      DEBUG_SERVER=1
      if [[ ${2:-} =~ ^[0-9]+$ ]]; then
        DEBUG_PORT=$2
        shift
      fi
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      PASSTHROUGH=("$@")
      break
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [ "$MODE" = "relay" ] && { [ -n "$PROFILE" ] || [ "$DEBUG_SERVER" = "1" ] || [ "$SCRATCH" = "1" ]; }; then
  echo "--profile, --debug-server and --scratch apply to the app, not --relay." >&2
  exit 1
fi

# Node.js, npm, git, curl, tar and node_modules - offers install_deps.sh.
. scripts/check-deps.sh
check_deps

if [ "$MODE" = "relay" ]; then
  exec node relay/server.js "${PASSTHROUGH[@]}"
fi

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
case "$(uname -s)" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=darwin ;;
  *)
    echo "Unsupported platform: $(uname -s)" >&2
    exit 1
    ;;
esac

APP_NAME=$(node -p "require('./package.json').productName || require('./package.json').name")
APP_VERSION=$(node -p "require('./package.json').version")
SIDECAR_REL="npm/zxterm-core-${PLATFORM}-${ARCH}/zxterm-core"

APP_ARGS=()
[ -n "$PROFILE" ] && APP_ARGS+=(--profile "$PROFILE")
if [ "$DEBUG_SERVER" = "1" ]; then
  if [ -z "$DEBUG_PORT" ]; then
    # A free port, so this never collides with a live instance on 17077.
    DEBUG_PORT=$(node -e "const s = require('net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close() })")
  fi
  APP_ARGS+=(--debug-server --debug-server-port "$DEBUG_PORT")
  echo "==> Debug server: http://127.0.0.1:$DEBUG_PORT"
fi

ask_yes() {
  local reply=n
  if [ -t 0 ]; then
    read -r -p "$1 [Y/n] " reply || reply=n
    [ -z "$reply" ] && reply=y
  fi
  case "$reply" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# The engine refuses to start without the zxterm-core sidecar, which is built
# from the zxterm/ submodule (Rust) and staged under npm/.
ensure_sidecar() {
  [ -n "${ZXTERM_CORE_BIN:-}" ] && return 0
  [ -x "$SIDECAR_REL" ] && return 0
  echo "No zxterm-core sidecar at $SIDECAR_REL - the engine won't start without it."
  [ -x "$HOME/.cargo/bin/cargo" ] && PATH="$HOME/.cargo/bin:$PATH"
  if ! command -v cargo >/dev/null 2>&1; then
    echo "Building it needs Rust - run ./install_deps.sh, then: npm run build:sidecar" >&2
    return 0
  fi
  if ask_yes "Build it now (git submodule update --init zxterm && npm run build:sidecar)?"; then
    # Only when missing: an update would also reset a checked-out zxterm/.
    [ -e zxterm/Cargo.toml ] || git submodule update --init zxterm
    npm run build:sidecar
  fi
}

warn_no_sidecar() {
  if [ -z "${ZXTERM_CORE_BIN:-}" ] && [ ! -x "$1" ]; then
    echo "WARNING: no zxterm-core sidecar at $1 - the engine won't start." >&2
    echo "         Build it with 'npm run build:sidecar' (needs the zxterm submodule:" >&2
    echo "         git submodule update --init zxterm), or set ZXTERM_CORE_BIN." >&2
  fi
}

# Runs the app in its own process group (setsid) so a signal to this script
# reaches the whole tree (npm -> electron-forge -> electron -> Bare worker ->
# sidecar), and returns only once every process in it has exited - otherwise
# a shutting-down Electron rewrites the scratch dir after it was removed.
APP_PGID=""
stop_app() {
  [ -n "$APP_PGID" ] || return 0
  kill -TERM -- "-$APP_PGID" 2>/dev/null || true
  local i
  for i in $(seq 1 100); do
    kill -0 -- "-$APP_PGID" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL -- "-$APP_PGID" 2>/dev/null || true
}
run_app() {
  if ! command -v setsid >/dev/null 2>&1; then
    "$@"
    return
  fi
  trap 'stop_app; exit 130' INT
  trap 'stop_app; exit 143' TERM HUP
  setsid "$@" <&0 &
  APP_PGID=$!
  local status=0
  wait "$APP_PGID" || status=$?
  stop_app
  return "$status"
}

# Last thing before launching: building the sidecar or packaging must still
# see the real HOME (rustup toolchains, the Electron download cache).
setup_scratch() {
  [ "$SCRATCH" = "1" ] || return 0
  # Short and under /tmp on purpose: the sidecar's socket lives inside the
  # profile dir, and Unix socket paths are capped at 108 bytes.
  SCRATCH_DIR=$(mktemp -d /tmp/zbt.XXXXXX)
  mkdir -p "$SCRATCH_DIR/data" "$SCRATCH_DIR/electron" "$SCRATCH_DIR/home"
  if [ "$KEEP" = "1" ]; then
    echo "==> Scratch dir (kept): $SCRATCH_DIR"
  else
    echo "==> Scratch dir (removed on exit): $SCRATCH_DIR"
    trap 'rm -rf "$SCRATCH_DIR"' EXIT
  fi
  APP_ARGS+=(--storage "$SCRATCH_DIR/data")
  export ZBTERM_ELECTRON_USER_DATA="$SCRATCH_DIR/electron"
  export HOME="$SCRATCH_DIR/home"
}

# An unpacked Electron's chrome-sandbox isn't setuid root, so Chromium's
# sandbox can't start unless unprivileged user namespaces are allowed
# (Ubuntu >= 23.10 restricts them via AppArmor). Fall back the way the snap
# does: --no-sandbox.
no_sandbox_fallback() {
  [ "$PLATFORM" = "linux" ] || return 0
  if ! { [ -u "$1" ] && [ "$(stat -c %u "$1")" = "0" ]; }; then
    APP_ARGS+=(--no-sandbox)
  fi
}

if [ "$MODE" = "dev" ]; then
  no_sandbox_fallback node_modules/electron/dist/chrome-sandbox
  ensure_sidecar
  warn_no_sidecar "$SIDECAR_REL"
  setup_scratch
  run_app npm start -- "${APP_ARGS[@]}" "${PASSTHROUGH[@]}"
  exit $?
fi

# --packaged
ensure_sidecar
PKG_DIR="$OUT_ROOT/${APP_NAME}-${PLATFORM}-${ARCH}"

# build_all.sh versions the launcher; `npm run package` leaves it plain.
# When both are there, the newer one is the build to run.
find_exe() {
  local candidate found=""
  for candidate in "$PKG_DIR/${APP_NAME}-${APP_VERSION}" "$PKG_DIR/${APP_NAME}" \
    "$PKG_DIR/${APP_NAME}-${APP_VERSION}.app" "$PKG_DIR/${APP_NAME}.app"; do
    [ -e "$candidate" ] || continue
    if [ -z "$found" ] || [ "$candidate" -nt "$found" ]; then found=$candidate; fi
  done
  [ -z "$found" ] && return 0
  case "$found" in
    *.app) echo "$found/Contents/MacOS/${APP_NAME}" ;;
    *) echo "$found" ;;
  esac
}

app_resources() {
  if [ "$PLATFORM" = "darwin" ]; then
    echo "$(dirname "$(dirname "$1")")/Resources/app"
  else
    echo "$PKG_DIR/resources/app"
  fi
}

EXE=$(find_exe)
reason=""
if [ -z "$EXE" ]; then
  reason="no packaged build in $PKG_DIR"
elif [ -x "$SIDECAR_REL" ] && [ ! -x "$(app_resources "$EXE")/$SIDECAR_REL" ]; then
  reason="the packaged build in $PKG_DIR has no zxterm-core sidecar"
elif [ -n "$(find electron engine renderer package.json -path renderer/vendor -prune -o \
  -newer "$(app_resources "$EXE")" -print -quit)" ]; then
  reason="the packaged build in $PKG_DIR is older than the sources"
fi

if [ -n "$reason" ]; then
  if ask_yes "$reason. Run 'npm run package' now?"; then
    ZBTERM_FORGE_OUT_DIR="$OUT_ROOT" npm run package
    EXE=$(find_exe)
  elif [ -z "$EXE" ]; then
    echo "$reason - run 'npm run package' (or ./build_all.sh) first." >&2
    exit 1
  else
    echo "NOTE: $reason - running it anyway."
  fi
fi

warn_no_sidecar "$(app_resources "$EXE")/$SIDECAR_REL"

no_sandbox_fallback "$PKG_DIR/chrome-sandbox"

setup_scratch
echo "==> $EXE"
run_app "$EXE" "${APP_ARGS[@]}" "${PASSTHROUGH[@]}"
