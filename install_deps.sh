#!/usr/bin/env bash
# Installs what build_all.sh and run.sh need on Ubuntu, Debian or Fedora:
# Node.js >= 20 + npm, git, curl, tar, a C/C++ toolchain, CMake and python3
# (node-gyp fallback for native modules without a prebuild; the zxterm-core
# sidecar's build), Rust via rustup (the sidecar; zxterm/rust-toolchain.toml
# pins the version, which distro cargo can't follow), and then the npm
# dependencies (`npm install`). Optionally also the tools the snap/flatpak
# makers need, and FUSE 2 to run the AppImage it makes.
#
# Usage:
#   ./install_deps.sh              # required system packages + npm install
#   ./install_deps.sh --optional   # also flatpak-builder, snapcraft + lxd, FUSE 2
#   ./install_deps.sh --no-npm     # system packages only
#   ./install_deps.sh -y           # don't ask before installing
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

OPTIONAL=0
NPM=1
YES=0

for arg in "$@"; do
  case "$arg" in
    --optional) OPTIONAL=1 ;;
    --no-npm) NPM=0 ;;
    -y | --yes) YES=1 ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--optional] [--no-npm] [-y]" >&2
      exit 1
      ;;
  esac
done

NODE_MIN_MAJOR=20

SUDO=()
if [ "$(id -u)" != "0" ]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "ERROR: not root and sudo is not installed." >&2
    exit 1
  fi
  SUDO=(sudo)
fi

if [ ! -r /etc/os-release ]; then
  echo "ERROR: /etc/os-release not found - can't detect the distribution." >&2
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release

FAMILY=""
for id in ${ID:-} ${ID_LIKE:-}; do
  case "$id" in
    ubuntu | debian) FAMILY=debian; break ;;
    fedora | rhel | centos) FAMILY=fedora; break ;;
  esac
done
if [ -z "$FAMILY" ]; then
  echo "ERROR: unsupported distribution '${PRETTY_NAME:-$ID}' (Ubuntu, Debian and Fedora are supported)." >&2
  exit 1
fi

case "$FAMILY" in
  debian)
    PACKAGES=(nodejs npm git curl ca-certificates tar build-essential cmake python3)
    # AppImages dlopen libfuse.so.2; Ubuntu >= 24.04 / Debian >= 13 renamed
    # the package for the 64-bit time_t transition.
    if apt-cache show libfuse2t64 >/dev/null 2>&1; then FUSE2=libfuse2t64; else FUSE2=libfuse2; fi
    OPTIONAL_PACKAGES=(flatpak-builder snapd "$FUSE2")
    pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
    pkg_install() {
      "${SUDO[@]}" apt-get update
      "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
    }
    ;;
  fedora)
    PACKAGES=(nodejs npm git curl ca-certificates tar gcc gcc-c++ make cmake python3)
    OPTIONAL_PACKAGES=(flatpak-builder snapd fuse-libs)
    # --whatprovides: Fedora's npm is the nodejs-npm package's "npm" provide.
    pkg_installed() { rpm -q --whatprovides "$1" >/dev/null 2>&1; }
    pkg_install() { "${SUDO[@]}" dnf install -y "$@"; }
    ;;
esac

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -p 'process.versions.node.split(".")[0]'
}

confirm() {
  [ "$YES" = "1" ] && return 0
  local reply
  read -r -p "$1 [Y/n] " reply || return 1
  case "$reply" in "" | y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

wanted=("${PACKAGES[@]}")
[ "$OPTIONAL" = "1" ] && wanted+=("${OPTIONAL_PACKAGES[@]}")

# A Node.js that didn't come from the distro (nvm, NodeSource, a tarball)
# and is new enough is kept - don't pull the distro's nodejs/npm over it.
if [ "$(node_major || echo 0)" -ge "$NODE_MIN_MAJOR" ] && command -v npm >/dev/null 2>&1; then
  filtered=()
  for pkg in "${wanted[@]}"; do
    case "$pkg" in nodejs | npm) ;; *) filtered+=("$pkg") ;; esac
  done
  wanted=("${filtered[@]}")
fi

missing=()
for pkg in "${wanted[@]}"; do
  pkg_installed "$pkg" || missing+=("$pkg")
done

echo "==> Distribution: ${PRETTY_NAME:-$ID} ($FAMILY family)"
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing system packages: ${missing[*]}"
  if confirm "Install them now?"; then
    pkg_install "${missing[@]}"
  else
    echo "Skipped installing system packages." >&2
    exit 1
  fi
else
  echo "All system packages are installed."
fi

major=$(node_major || echo 0)
if [ "$major" -lt "$NODE_MIN_MAJOR" ]; then
  echo "ERROR: Node.js >= $NODE_MIN_MAJOR is required, found $(node -v 2>/dev/null || echo none)." >&2
  echo "       This distribution's nodejs package is too old. Install a newer Node.js" >&2
  echo "       (e.g. nvm: https://github.com/nvm-sh/nvm, or https://nodejs.org/en/download)" >&2
  echo "       and run this script again." >&2
  exit 1
fi
echo "Node.js $(node -v), npm $(npm -v)"

if ! command -v cargo >/dev/null 2>&1 && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  if confirm "Rust (cargo) not found - install it with rustup (https://rustup.rs) for your user?"; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
    echo "NOTE: add Rust to PATH: . \"\$HOME/.cargo/env\" (or open a new shell)."
  else
    echo "NOTE: skipped Rust - the zxterm-core sidecar (npm run build:sidecar) needs it."
  fi
fi

if [ "$OPTIONAL" = "1" ]; then
  # snapcraft and lxd ship only as snaps. On Fedora, snapd needs its /snap
  # symlink and a running socket before `snap install` works.
  if ! command -v snapcraft >/dev/null 2>&1 || ! command -v lxd >/dev/null 2>&1; then
    if [ "$FAMILY" = "fedora" ] && [ ! -e /snap ]; then
      "${SUDO[@]}" ln -s /var/lib/snapd/snap /snap
    fi
    "${SUDO[@]}" systemctl enable --now snapd.socket
    command -v snapcraft >/dev/null 2>&1 || "${SUDO[@]}" snap install snapcraft --classic
    if ! command -v lxd >/dev/null 2>&1; then
      "${SUDO[@]}" snap install lxd
      "${SUDO[@]}" lxd init --auto
      "${SUDO[@]}" usermod -aG lxd "${SUDO_USER:-$USER}"
      echo "NOTE: added ${SUDO_USER:-$USER} to the lxd group - log out and back in for it to apply."
    fi
    echo "NOTE: snap binaries live in /snap/bin - open a new shell if snapcraft/lxd aren't on PATH yet."
  fi
fi

if [ "$NPM" = "1" ]; then
  echo "==> Installing npm dependencies"
  # npm only - pnpm breaks forge.config.js (see AGENTS.md). .npmrc keeps
  # install scripts on, which the electron binary download needs.
  npm install
fi

echo "==> Done. Run ./build_all.sh"
