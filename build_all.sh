#!/usr/bin/env bash
# Builds everything ZBTerm ships: the headless relay executables (all
# platforms - these cross-build cleanly, see scripts/build-relay.js) and the
# Electron GUI app (packaged for all platforms; installer-generation ("make")
# only for the platform this script runs on - see the note below).
#
# Every GUI package ships the Rust zxterm-core sidecar, without which the
# engine won't start. This script cargo-builds it for this machine; a package
# for another platform/arch is built only when its sidecar is already staged
# under npm/zxterm-core-<platform>-<arch>/ (e.g. a CI artifact staged with
# `node scripts/sidecar.js stage <platform>-<arch> <binary>`), and skipped
# otherwise. Windows has no sidecar build yet, so win32 is always skipped.
#
# Usage:
#   ./build_all.sh                 # relay (all targets) + GUI package (all targets) + GUI make (host only)
#   ./build_all.sh --relay-only
#   ./build_all.sh --gui-only
#   ./build_all.sh --no-make       # skip the installer ("make") step entirely
#   ./build_all.sh -j [N]          # parallel: N relay targets at once (default:
#                                  # all), alongside the sidecar + GUI steps
#   ./build_all.sh --bump-build    # 1.2.12 -> 1.2.13 before building
#   ./build_all.sh --bump-minor    # 1.2.12 -> 1.3.0 before building
#   ./build_all.sh --set-build N   # 1.2.12 -> 1.2.N
#   ./build_all.sh --set-minor N   # 1.2.12 -> 1.N.0
#   ./build_all.sh --flatpak       # also make the Flatpak tarball (Linux)
# The version options rewrite package.json, the package-lock.json root and the
# build/AppxManifest.xml Identity version. The minor option (bump or set) is
# applied first, then the build one, so --set-minor 3 --set-build 5 -> 1.3.5.
#
# The Flatpak is built only with --flatpak, which needs the version's release
# notes in flatpak/releases/<version>.md and refuses a version that already
# has a Flatpak built from other sources. It then writes the tarball's name and
# sha512 into flatpak/net.z33v.zbterm.yml and adds the version's <release>
# (with the notes) to the metainfo. Every run ends with a Flatpak note: what
# was built, what a Flatpak of this version still needs, and a warning when
# the last build's sources differ from this version's Flatpak. See
# scripts/flatpak-release.js.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

RELAY=1
GUI=1
MAKE=1
FLATPAK=0
JOBS=1
MINOR_OP=""  # "" | bump | <N>
BUILD_OP=""  # "" | bump | <N>

usage() {
  echo "Usage: $0 [--relay-only|--gui-only] [--no-make] [--flatpak] [-j [N]]" >&2
  echo "          [--bump-build|--set-build N] [--bump-minor|--set-minor N]" >&2
}

# set_op VAR OPTION VALUE: refuses a second minor (or build) option.
set_op() {
  if [ -n "${!1}" ]; then
    echo "Only one of --bump-${3%%-*}/--set-${3%%-*} may be given" >&2
    usage
    exit 1
  fi
  printf -v "$1" '%s' "$2"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --relay-only) GUI=0 ;;
    --gui-only) RELAY=0 ;;
    --no-make) MAKE=0 ;;
    --flatpak) FLATPAK=1 ;;
    -j | --jobs)
      if [[ ${2:-} =~ ^[0-9]+$ ]]; then
        JOBS=$2
        shift
      else
        JOBS=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
      fi
      ;;
    -j[0-9]* | --jobs=[0-9]*) JOBS=${1#-j}; JOBS=${JOBS#--jobs=} ;;
    --bump-build) set_op BUILD_OP bump build ;;
    --bump-minor) set_op MINOR_OP bump minor ;;
    --set-build | --set-minor)
      if ! [[ ${2:-} =~ ^[0-9]+$ ]]; then
        echo "$1 needs a non-negative integer" >&2
        usage
        exit 1
      fi
      if [ "$1" = "--set-build" ]; then set_op BUILD_OP "$((10#$2))" build; else set_op MINOR_OP "$((10#$2))" minor; fi
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done
if ! [[ $JOBS =~ ^[0-9]+$ ]] || [ "$JOBS" -lt 1 ]; then
  echo "Invalid job count: $JOBS" >&2
  usage
  exit 1
fi
if [ "$FLATPAK" = "1" ] && { [ "$GUI" = "0" ] || [ "$MAKE" = "0" ]; }; then
  echo "--flatpak needs the GUI make step (not with --relay-only or --no-make)" >&2
  usage
  exit 1
fi
if [ "$FLATPAK" = "1" ] && [ "$(uname -s)" != "Linux" ]; then
  echo "--flatpak needs Linux (the flatpak maker is Linux-only)" >&2
  exit 1
fi

# Node.js, npm, git, curl, tar and node_modules - offers install_deps.sh
# when one is missing. The snap maker's tools are optional: the make step
# skips it when they are missing. The flatpak maker only needs tar.
. scripts/check-deps.sh
check_deps

# Version update (--bump-*/--set-*), before anything reads the version.
if [ -n "$MINOR_OP$BUILD_OP" ]; then
  MINOR_OP="$MINOR_OP" BUILD_OP="$BUILD_OP" node -e '
    const fs = require("fs")
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"))
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version)
    if (!m) { console.error("package.json version " + pkg.version + " is not MAJOR.MINOR.BUILD"); process.exit(1) }
    let [major, minor, build] = m.slice(1).map(Number)
    const { MINOR_OP: mo, BUILD_OP: bo } = process.env
    if (mo) { minor = mo === "bump" ? minor + 1 : Number(mo); build = 0 }
    if (bo) build = bo === "bump" ? build + 1 : Number(bo)
    const from = pkg.version
    const to = major + "." + minor + "." + build
    // Text replacements keep each file formatting as is.
    const sub = (file, re, rep) => {
      const text = fs.readFileSync(file, "utf8")
      const out = text.replace(re, rep)
      if (out === text && from !== to) { console.error("version not found in " + file); process.exit(1) }
      fs.writeFileSync(file, out)
    }
    sub("package.json", /("version":\s*")[^"]*(")/, "$1" + to + "$2")
    // The lockfile root and its packages[""] entry (the first two "version"s).
    let n = 0
    sub("package-lock.json", /("version":\s*")[^"]*(")/g, (s, a, b) => (n++ < 2 ? a + to + b : s))
    sub("build/AppxManifest.xml", /(<Identity\b[^>]*\bVersion=")[^"]*(")/, "$1" + to + ".0$2")
    // The flatpak manifest/metainfo describe published tarballs: only a
    // --flatpak build updates them (scripts/flatpak-release.js finish).
    console.log("==> Version " + from + " -> " + to)
  '
fi

# Where electron-forge writes packages (forge.config.js reads the same var).
OUT_ROOT=${ZBTERM_FORGE_OUT_DIR:-out}

# The sources being built (after any version update), for the build stamps.
ZBTERM_SRC_FP=$(node scripts/flatpak-release.js fingerprint)
export ZBTERM_SRC_FP
if [ "$FLATPAK" = "1" ]; then
  node scripts/flatpak-release.js check "$OUT_ROOT"
fi

# electron-forge/electron-packager platform+arch names.
GUI_TARGETS=(
  "linux x64"
  "linux arm64"
  "darwin x64"
  "darwin arm64"
  "win32 x64"
)

APP_NAME=$(node -p "require('./package.json').productName || require('./package.json').name")
APP_VERSION=$(node -p "require('./package.json').version")

# electron-packager always writes the packaged app into
# out/<APP_NAME>-<platform>-<arch>. Keep that containing directory stable, but
# put the version on the final launchable artifact inside it:
#   macOS:   ZBTerm-1.0.19.app
#   Windows: ZBTerm-1.0.19.exe
#   Linux:   ZBTerm-1.0.19
version_pkg_artifacts() {
  local platform="$1" arch="$2"
  local dir="$OUT_ROOT/${APP_NAME}-${platform}-${arch}"
  [ -d "$dir" ] || return 0

  case "$platform" in
    darwin)
      rename_artifact "$dir/${APP_NAME}.app" "$dir/${APP_NAME}-${APP_VERSION}.app"
      ;;
    win32)
      rename_artifact "$dir/${APP_NAME}.exe" "$dir/${APP_NAME}-${APP_VERSION}.exe"
      ;;
    linux)
      rename_artifact "$dir/${APP_NAME}" "$dir/${APP_NAME}-${APP_VERSION}"
      ;;
  esac
}

rename_artifact() {
  local src="$1" dst="$2"
  if [ -e "$src" ]; then
    rm -rf "$dst"
    mv "$src" "$dst"
    echo "    -> $dst"
  elif [ -e "$dst" ]; then
    echo "    -> $dst"
  fi
}

# With -j the relay builds in the background while the sidecar and GUI
# steps run (they share nothing: out/relay/ vs the sidecar and $OUT_ROOT).
RELAY_PID=""
if [ "$RELAY" = "1" ]; then
  echo "==> Building relay executables (all platforms, $JOBS at a time)"
  if [ "$JOBS" -gt 1 ] && [ "$GUI" = "1" ]; then
    # Process substitution, not a pipe: $! is then npm itself, so wait gets
    # its exit status and the trap can stop it.
    npm run build:relay -- --all --jobs "$JOBS" > >(sed -u 's/^/[relay] /') 2>&1 &
    RELAY_PID=$!
    # Don't leave it running if this script fails or is interrupted.
    trap '[ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null; true' EXIT
  else
    npm run build:relay -- --all --jobs "$JOBS"
  fi
fi

if [ "$GUI" = "1" ]; then
  echo "==> Building the zxterm-core sidecar for this machine"
  [ -x "$HOME/.cargo/bin/cargo" ] && PATH="$HOME/.cargo/bin:$PATH"
  if ! command -v cargo >/dev/null 2>&1; then
    echo "ERROR: the GUI packages need the zxterm-core sidecar, which needs Rust." >&2
    echo "       Run ./install_deps.sh (or install rustup), or use --relay-only." >&2
    exit 1
  fi
  # Only when missing: an update would also reset a checked-out zxterm/.
  [ -e zxterm/Cargo.toml ] || git submodule update --init zxterm
  npm run build:sidecar

  echo "==> Packaging GUI app (all platforms)"
  # electron-packager just lays out the right prebuilt Electron + app files
  # per platform/arch - no native OS tooling needed, so this cross-builds
  # fine from any host. It's unsigned/unnotarized here (MAC_CODESIGN_IDENTITY
  # / WINDOWS_SIGN_HOOK aren't set), which is fine for local packages but not
  # for shipping signed builds - see forge.config.js.
  skipped=()
  for target in "${GUI_TARGETS[@]}"; do
    read -r platform arch <<< "$target"
    sidecar="npm/zxterm-core-${platform}-${arch}/zxterm-core"
    if [ "$platform" = "win32" ] || [ ! -x "$sidecar" ]; then
      echo "--> skip $platform/$arch: no zxterm-core sidecar staged at $sidecar"
      skipped+=("$platform/$arch")
      continue
    fi
    echo "--> package $platform/$arch"
    npx electron-forge package --platform="$platform" --arch="$arch"
    version_pkg_artifacts "$platform" "$arch"
  done
  node scripts/flatpak-release.js record-build "$OUT_ROOT"

  if [ "$MAKE" = "1" ]; then
    host_platform=$(node -p "process.platform")
    host_arch=$(node -p "process.arch")
    echo "==> Making installers for host platform only: $host_platform/$host_arch"
    # Installer makers need native OS tooling (dmg -> macOS hdiutil, msix ->
    # Windows SDK, appimage/deb/rpm/snap/flatpak -> Linux) so they can't
    # cross-build from here - see the "platforms" field on each maker in
    # forge.config.js. Run this same command on an actual Mac/Windows box
    # (or CI runners for those OSes) to get their installers.
    make_targets=()
    if [ "$host_platform" = "linux" ]; then
      # appimage bundles its own tooling; the flatpak maker only tars the
      # package (and runs only with --flatpak); snap needs snapcraft+lxd
      # installed on this box - skipped when missing instead of letting one
      # missing tool abort the whole make step.
      make_targets+=("pear-electron-forge-maker-appimage")
      [ "$FLATPAK" = "1" ] && make_targets+=("pear-electron-forge-maker-flatpak")
      if command -v snapcraft >/dev/null 2>&1 && command -v lxd >/dev/null 2>&1; then
        make_targets+=("pear-electron-forge-maker-snap")
      else
        echo "NOTE: snapcraft/lxd not found - skipping the snap maker (./install_deps.sh --optional)."
      fi
      IFS=,; targets_csv="${make_targets[*]}"; unset IFS
      npx electron-forge make --platform="$host_platform" --arch="$host_arch" --targets="$targets_csv"
    else
      npx electron-forge make --platform="$host_platform" --arch="$host_arch"
    fi
    # `make` repackages internally (fresh out/<name>-<platform>-<arch> with
    # unversioned launchable files) regardless of the loop above - version the
    # final packaged artifact inside that directory too.
    version_pkg_artifacts "$host_platform" "$host_arch"
    if [ "$FLATPAK" = "1" ]; then
      node scripts/flatpak-release.js finish "$OUT_ROOT"
    fi
    echo "NOTE: dmg (macOS) and msix (Windows) installers were not built here -"
    echo "      run 'npm run make -- --platform=darwin --arch=x64' (etc.) on"
    echo "      those OSes directly."
  fi
fi

if [ -n "$RELAY_PID" ]; then
  echo "==> Waiting for the relay build"
  pid=$RELAY_PID
  RELAY_PID=""
  wait "$pid" || { echo "ERROR: the relay build failed (see the [relay] lines above)." >&2; exit 1; }
fi

if [ "$GUI" = "1" ] && [ "${#skipped[@]}" -gt 0 ]; then
  echo "NOTE: GUI packages skipped for lack of a zxterm-core sidecar: ${skipped[*]}"
  echo "      Stage one with 'node scripts/sidecar.js stage <platform>-<arch> <binary>'"
  echo "      (Windows has no sidecar build yet)."
fi
if [ "$GUI" = "1" ]; then
  node scripts/flatpak-release.js report "$OUT_ROOT" "$FLATPAK"
fi
echo "==> Done. See out/relay/ and $OUT_ROOT/ for artifacts."
