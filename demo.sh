#!/usr/bin/env bash
# The ZBTerm walk-through: starts ZBTerm on scratch data and drives its real
# UI, with a caption for every feature it shows. Nothing of yours is touched:
# the demo has its own HOME, storage and settings under /tmp/zbdemo.*, removed
# when it ends.
#
# Usage:
#   ./demo.sh [options]
#
# Part one is one window (sessions, time travel, search, pins). Part two moves
# it to the right half of the screen and opens a second ZBTerm in the left
# half, with a profile of its own, to share a terminal: invite link, host
# approval, live view, keyboard sharing. Part two needs the network (the two
# find each other over the Pear DHT).
#
# Options:
#   --part <1|2|all>     which part to run (default: all)
#   --speed <n>          pacing: 1 is the recording pace (default), 2 twice as fast
#   --fast               --speed 4: a quick check that every step works
#   --step               wait for Enter in this terminal before each scene
#   --no-captions        no caption cards (title cards and key badges stay)
#   --packaged           run the packaged app from out/ instead of this checkout
#   --out <dir>          where the packaged build is (default: out, or $ZBTERM_FORGE_OUT_DIR)
#   --screen <WxH+X+Y>   the screen area to use (default: the display's work area)
#   --wayland            don't force X11 (then the windows cannot be placed)
#   --shots <dir>        save a picture of each window as every scene ends
#   --keep               keep the scratch directory (logs, storage) afterwards
#   --close              close the windows when the demo ends instead of waiting
#   --verbose            print every caption as it is shown
#
# While it runs, keep the mouse and keyboard away from the demo's windows.
# Ctrl+C here closes them. The storyboard is docs/demo.md.
set -euo pipefail
# Relative paths on the command line (--shots) are the caller's.
export ZBDEMO_CWD="$PWD"
cd "$(dirname "${BASH_SOURCE[0]}")"

for arg in "$@"; do
  case "$arg" in
    -h | --help)
      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

PACKAGED=0
for arg in "$@"; do [ "$arg" = "--packaged" ] && PACKAGED=1; done

# Node.js, npm, git, curl, tar and node_modules - offers install_deps.sh.
. scripts/check-deps.sh
check_deps

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) ARCH=$(uname -m) ;;
esac
case "$(uname -s)" in
  Linux) PLATFORM=linux ;;
  *)
    # On macOS the app keeps its window state, settings and debug log under
    # the real ~/Library/Application Support whatever HOME says, so the demo
    # could not keep its promise to touch nothing of yours.
    echo "demo.sh runs on Linux only (elsewhere it cannot isolate the app's settings yet)." >&2
    exit 1
    ;;
esac

# The engine refuses to start without the zxterm-core sidecar (run.sh builds it).
SIDECAR="npm/zxterm-core-${PLATFORM}-${ARCH}/zxterm-core"
if [ -z "${ZXTERM_CORE_BIN:-}" ] && [ ! -x "$SIDECAR" ]; then
  echo "No zxterm-core sidecar at $SIDECAR - the engine won't start without it." >&2
  echo "Build it first: npm run build:sidecar (or start ./run.sh once, which offers to)." >&2
  exit 1
fi

WAYLAND=0
for arg in "$@"; do [ "$arg" = "--wayland" ] && WAYLAND=1; done
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "No display: demo.sh opens windows, so it needs a desktop session." >&2
  exit 1
fi
if [ -z "${DISPLAY:-}" ] && [ "$WAYLAND" = "0" ]; then
  echo "No X display (DISPLAY is not set): the demo runs the app as an X11 client so it" >&2
  echo "can place its windows. Start XWayland, or pass --wayland (windows are not placed)." >&2
  exit 1
fi

# From source the renderer needs its vendored assets, as `npm start` makes them.
if [ "$PACKAGED" = "0" ]; then
  node scripts/vendor-assets.js >/dev/null
fi

exec node scripts/demo/demo.js "$@"
