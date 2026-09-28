#!/usr/bin/env bash
# Builds everything ZBTerm ships: the headless relay executables (all
# platforms - these cross-build cleanly, see scripts/build-relay.js) and the
# Electron GUI app (packaged for all platforms; installer-generation ("make")
# only for the platform this script runs on - see the note below).
#
# Usage:
#   ./build_all.sh                 # relay (all targets) + GUI package (all targets) + GUI make (host only)
#   ./build_all.sh --relay-only
#   ./build_all.sh --gui-only
#   ./build_all.sh --no-make       # skip the installer ("make") step entirely
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

RELAY=0
GUI=1
MAKE=1

for arg in "$@"; do
  case "$arg" in
    --relay-only) GUI=0 ;;
    --gui-only) RELAY=0 ;;
    --no-make) MAKE=0 ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--relay-only|--gui-only] [--no-make]" >&2
      exit 1
      ;;
  esac
done

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
  local dir="out/${APP_NAME}-${platform}-${arch}"
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

if [ "$RELAY" = "1" ]; then
  echo "==> Building relay executables (all platforms)"
  npm run build:relay -- --all
fi

if [ "$GUI" = "1" ]; then
  echo "==> Packaging GUI app (all platforms)"
  # electron-packager just lays out the right prebuilt Electron + app files
  # per platform/arch - no native OS tooling needed, so this cross-builds
  # fine from any host. It's unsigned/unnotarized here (MAC_CODESIGN_IDENTITY
  # / WINDOWS_SIGN_HOOK aren't set), which is fine for local packages but not
  # for shipping signed builds - see forge.config.js.
  for target in "${GUI_TARGETS[@]}"; do
    read -r platform arch <<< "$target"
    echo "--> package $platform/$arch"
    npx electron-forge package --platform="$platform" --arch="$arch"
    version_pkg_artifacts "$platform" "$arch"
  done

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
      # appimage bundles its own tooling; flatpak/snap need flatpak-builder /
      # snapcraft+lxd installed on this box - skip whichever is missing
      # instead of letting one missing tool abort the whole make step.
      make_targets+=("pear-electron-forge-maker-appimage")
      if command -v flatpak-builder >/dev/null 2>&1; then
        make_targets+=("pear-electron-forge-maker-flatpak")
      else
        echo "NOTE: flatpak-builder not found - skipping the flatpak maker."
      fi
      if command -v snapcraft >/dev/null 2>&1 && command -v lxd >/dev/null 2>&1; then
        make_targets+=("pear-electron-forge-maker-snap")
      else
        echo "NOTE: snapcraft/lxd not found - skipping the snap maker."
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
    echo "NOTE: dmg (macOS) and msix (Windows) installers were not built here -"
    echo "      run 'npm run make -- --platform=darwin --arch=x64' (etc.) on"
    echo "      those OSes directly."
  fi
fi

echo "==> Done. See out/relay/ and out/ for artifacts."
