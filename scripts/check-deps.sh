# Sourced by build_all.sh and run.sh (from the repo root): checks what both
# need and offers to run install_deps.sh (Ubuntu, Debian, Fedora) when
# something is missing. Exits the calling script if it stays missing.

NODE_MIN_MAJOR=20

missing_deps() {
  local cmd
  for cmd in node npm git curl tar; do
    command -v "$cmd" >/dev/null 2>&1 || echo "$cmd"
  done
  if command -v node >/dev/null 2>&1 &&
    [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MIN_MAJOR" ]; then
    echo "node>=$NODE_MIN_MAJOR (found $(node -v))"
  fi
  [ -e node_modules/.bin/electron-forge ] || echo "npm dependencies (node_modules)"
}

check_deps() {
  local missing reply=n
  missing=$(missing_deps)
  [ -z "$missing" ] && return 0

  echo "Missing dependencies:"
  echo "$missing" | sed 's/^/  - /'
  if [ -t 0 ]; then
    read -r -p "Run ./install_deps.sh now? [Y/n] " reply || reply=n
    [ -z "$reply" ] && reply=y
  fi
  case "$reply" in
    y | Y | yes | YES) ./install_deps.sh -y ;;
    *)
      echo "Run ./install_deps.sh, then try again." >&2
      exit 1
      ;;
  esac

  missing=$(missing_deps)
  if [ -n "$missing" ]; then
    echo "Still missing after install_deps.sh:" >&2
    echo "$missing" | sed 's/^/  - /' >&2
    exit 1
  fi
}
