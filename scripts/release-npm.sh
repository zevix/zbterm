#!/usr/bin/env bash
# Cuts a zbterm npm release - or, by default, explains exactly what would
# happen and what is standing in the way.
#
#   bash scripts/release-npm.sh patch          # dry run: plan + blockers
#   bash scripts/release-npm.sh patch --tag    # version commit + tag
#
# Publishing itself happens in CI: pushing the tag runs
# .github/workflows/publish.yml, which builds the zxterm-core sidecar for
# every platform from the zxterm/ submodule, publishes its platform packages
# and then zbterm. A local publish could only ever carry this machine's
# sidecar, so this script never runs `npm publish`.
#
# Nothing here touches forge.config.js, the electron-forge makers or
# build_all.sh: the npm package and the installer release paths are separate
# and both stay working (there is no OTA release path any more, D-08). See
# docs/RELEASING.md.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/release-npm.sh <patch|minor|major|x.y.z> [options]

Options:
  --tag            Create the release commit and tag. Without it the script is
                   a dry run: it prints the exact commands it would run, then a
                   BLOCKERS: section, and changes nothing.
  --yes            Skip the interactive branch confirmation.
  -h, --help       This text.

Guards, all evaluated and reported by name:
  clean-tree         `git status --porcelain` is empty.
  branch-confirmed   the current branch was confirmed (prompt, or --yes).
  version-available  `npm view zbterm version` differs from the target. An
                     E404 means the package is simply unpublished, which is
                     fine, not an error.
  pack-check         scripts/npm-pack-check.sh passes.
  smoke-install      scripts/npm-smoke-install.sh passes on that tarball, with
                     the sidecar `npm run build:sidecar` staged.

Dry run (no --tag):
  Guard failures are reported, never fatal. The full release plan is printed
  either way. Exit 0 when no guard failed, 3 when any did. The working tree and
  the git refs are left untouched in both cases.

With --tag:
  Any failed guard aborts non-zero BEFORE the commit and tag are made - the
  cheap guards are evaluated first, so a dirty tree never even reaches the pack
  check. Once every guard is green:
      npm version <target>          (creates the release commit and the tag)
  and then the `git push --follow-tags` command that starts the CI publish is
  PRINTED, not run.

Exit status: 0 ok, 2 aborted (--tag), 3 blockers found (dry run).
EOF
}

TARGET_SPEC=""
PUBLISH=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --tag)
      PUBLISH=1
      ;;
    --publish)
      echo "release-npm: publishing runs in CI (publish.yml) now; use --tag, then push the tag" >&2
      exit 1
      ;;
    --yes)
      ASSUME_YES=1
      ;;
    -*)
      echo "release-npm: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -n "$TARGET_SPEC" ]; then
        echo "release-npm: more than one version target given" >&2
        exit 1
      fi
      TARGET_SPEC="$1"
      ;;
  esac
  shift
done

if [ -z "$TARGET_SPEC" ]; then
  echo "release-npm: a version target is required" >&2
  usage >&2
  exit 1
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

PKG_NAME=$(node -p "require('$ROOT/package.json').name")
CURRENT_VERSION=$(node -p "require('$ROOT/package.json').version")

case "$TARGET_SPEC" in
  patch | minor | major)
    TARGET_VERSION=$(node -e '
      const [current, kind] = process.argv.slice(1)
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current)
      if (!m) { console.error("unparseable current version: " + current); process.exit(1) }
      let [, a, b, c] = m.map(Number)
      if (kind === "major") { a += 1; b = 0; c = 0 }
      else if (kind === "minor") { b += 1; c = 0 }
      else c += 1
      console.log(a + "." + b + "." + c)
    ' "$CURRENT_VERSION" "$TARGET_SPEC")
    ;;
  [0-9]*.[0-9]*.[0-9]*)
    TARGET_VERSION="$TARGET_SPEC"
    ;;
  *)
    echo "release-npm: target must be patch, minor, major or x.y.z (got '$TARGET_SPEC')" >&2
    exit 1
    ;;
esac

echo "=============================================================="
echo " $PKG_NAME release"
echo "   current version : $CURRENT_VERSION"
echo "   target          : $TARGET_SPEC -> $TARGET_VERSION"
echo "   mode            : $([ "$PUBLISH" -eq 1 ] && echo 'TAG (commit + tag)' || echo 'dry run')"
echo "=============================================================="
echo

GUARD_NAMES=()
GUARD_OK=()
GUARD_DETAIL=()

record() {
  GUARD_NAMES+=("$1")
  GUARD_OK+=("$2")
  GUARD_DETAIL+=("$3")
  if [ "$2" = "1" ]; then
    echo "  [ok]     $1: $3"
  else
    echo "  [BLOCKED] $1: $3"
  fi
}

failed_guards() {
  local i count=0
  for i in "${!GUARD_NAMES[@]}"; do
    [ "${GUARD_OK[$i]}" = "1" ] || count=$((count + 1))
  done
  echo "$count"
}

# ---------------------------------------------------------------------------
# Cheap guards. These run first so that, with --tag, a failure aborts long
# before `npm version` (which would create a commit and a tag) is reached.
# ---------------------------------------------------------------------------
echo "Guards:"

DIRTY=$(git -C "$ROOT" status --porcelain)
if [ -z "$DIRTY" ]; then
  record clean-tree 1 "git status --porcelain is empty"
else
  DIRTY_COUNT=$(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ')
  record clean-tree 0 "working tree is dirty ($DIRTY_COUNT entries); npm version refuses to run on a dirty tree"
  printf '%s\n' "$DIRTY" | sed 's/^/             /'
fi

BRANCH=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)
if [ "$ASSUME_YES" -eq 1 ]; then
  record branch-confirmed 1 "releasing from branch '$BRANCH' (confirmed by --yes)"
elif [ -t 0 ]; then
  printf 'Release %s %s from branch %s? [y/N] ' "$PKG_NAME" "$TARGET_VERSION" "$BRANCH"
  read -r ANSWER || ANSWER=""
  case "$ANSWER" in
    y | Y | yes | YES)
      record branch-confirmed 1 "releasing from branch '$BRANCH' (confirmed interactively)"
      ;;
    *)
      record branch-confirmed 0 "branch '$BRANCH' was not confirmed"
      ;;
  esac
else
  record branch-confirmed 0 "branch '$BRANCH' needs confirmation, but stdin is not a terminal - pass --yes"
fi

if VIEW_OUT=$(npm view "$PKG_NAME" version 2>&1); then
  PUBLISHED_VERSION=$(printf '%s' "$VIEW_OUT" | tail -1 | tr -d ' ')
  if [ "$PUBLISHED_VERSION" = "$TARGET_VERSION" ]; then
    record version-available 0 "$PKG_NAME@$TARGET_VERSION is already published"
  else
    record version-available 1 "latest published is $PUBLISHED_VERSION, target $TARGET_VERSION is free"
  fi
elif printf '%s' "$VIEW_OUT" | grep -q 'E404\|404'; then
  # Unpublished package: there is no version to collide with.
  record version-available 1 "$PKG_NAME is not published yet (E404), so $TARGET_VERSION is free"
else
  record version-available 0 "npm view $PKG_NAME version failed: $(printf '%s' "$VIEW_OUT" | head -1)"
fi

CHEAP_FAILURES=$(failed_guards)

if [ "$PUBLISH" -eq 1 ] && [ "$CHEAP_FAILURES" -ne 0 ]; then
  echo
  echo "BLOCKERS:"
  for i in "${!GUARD_NAMES[@]}"; do
    [ "${GUARD_OK[$i]}" = "1" ] || echo "  - ${GUARD_NAMES[$i]}: ${GUARD_DETAIL[$i]}"
  done
  echo
  echo "release-npm: aborting BEFORE 'npm version'."
  echo "             No commit and no tag were made."
  exit 2
fi

# ---------------------------------------------------------------------------
# Expensive guards: the pack check and the smoke install. Both are read-only
# with respect to git; the tarball they leave behind in the repo root is
# gitignored (*.tgz).
# ---------------------------------------------------------------------------
echo
echo "Verification:"
PACK_LOG=$(mktemp "${TMPDIR:-/tmp}/zbterm-release-pack-XXXXXX.log")
trap 'rm -f "$PACK_LOG"' EXIT

TARBALL=""
if bash "$ROOT/scripts/npm-pack-check.sh" | tee "$PACK_LOG"; then
  TARBALL=$(tail -1 "$PACK_LOG")
  record pack-check 1 "$TARBALL"
else
  record pack-check 0 "scripts/npm-pack-check.sh failed (see the output above)"
fi

if [ -n "$TARBALL" ] && [ -f "$TARBALL" ]; then
  if bash "$ROOT/scripts/npm-smoke-install.sh" "$TARBALL"; then
    record smoke-install 1 "installed and verified $TARBALL"
  else
    record smoke-install 0 "scripts/npm-smoke-install.sh failed (see the output above)"
  fi
else
  record smoke-install 0 "skipped - no tarball to install (pack-check did not produce one)"
fi

TOTAL_FAILURES=$(failed_guards)

# ---------------------------------------------------------------------------
# The plan. Printed in both modes - a dry run has to tell the maintainer
# exactly what a real release would do.
# ---------------------------------------------------------------------------
echo
echo "Release plan for $PKG_NAME@$TARGET_VERSION:"
echo "  1. bash scripts/npm-pack-check.sh"
echo "  2. bash scripts/npm-smoke-install.sh <tarball>"
echo "  3. npm version $TARGET_SPEC          # -> v$TARGET_VERSION commit + tag"
echo "  4. git push --follow-tags            # printed, never run by this script"
echo "  5. publish.yml (CI) publishes the sidecar packages, then $PKG_NAME"

if [ "$PUBLISH" -ne 1 ]; then
  echo
  if [ "$TOTAL_FAILURES" -eq 0 ]; then
    echo "No blockers. Re-run with --tag to cut the release."
    echo "(Dry run: no commit and no tag were created.)"
    exit 0
  fi
  echo "BLOCKERS:"
  for i in "${!GUARD_NAMES[@]}"; do
    [ "${GUARD_OK[$i]}" = "1" ] || echo "  - ${GUARD_NAMES[$i]}: ${GUARD_DETAIL[$i]}"
  done
  echo
  echo "$TOTAL_FAILURES guard(s) failed. The working tree and git refs are untouched."
  exit 3
fi

if [ "$TOTAL_FAILURES" -ne 0 ]; then
  echo
  echo "BLOCKERS:"
  for i in "${!GUARD_NAMES[@]}"; do
    [ "${GUARD_OK[$i]}" = "1" ] || echo "  - ${GUARD_NAMES[$i]}: ${GUARD_DETAIL[$i]}"
  done
  echo
  echo "release-npm: aborting BEFORE 'npm version'."
  echo "             No commit and no tag were made."
  exit 2
fi

# ---------------------------------------------------------------------------
# Every guard above is green.
# ---------------------------------------------------------------------------
echo
echo "==> npm version $TARGET_SPEC"
npm version "$TARGET_SPEC"

echo
echo "==> Tagged $PKG_NAME@$TARGET_VERSION."
echo "    The commit and tag are local. Push them to publish from CI:"
echo
echo "        git push --follow-tags"
echo
