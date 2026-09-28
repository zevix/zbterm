#!/usr/bin/env bash
# Releases zbterm to npm - or, by default, explains exactly what would happen
# and what is standing in the way.
#
#   bash scripts/release-npm.sh patch              # dry run: plan + blockers
#   bash scripts/release-npm.sh patch --publish    # the real thing
#
# Nothing here touches forge.config.js, the electron-forge makers or
# build_all.sh: the npm package and the installer release paths are separate
# and both stay working (there is no OTA release path any more, D-08). See
# docs/RELEASE-NPM.md.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/release-npm.sh <patch|minor|major|x.y.z> [options]

Options:
  --publish        Actually release. Without it the script is a dry run: it
                   prints the exact commands it would run, then a BLOCKERS:
                   section, and changes nothing.
  --otp <code>     npm two-factor one-time password, passed to `npm publish`.
  --yes            Skip the interactive branch confirmation.
  -h, --help       This text.

Guards, all evaluated and reported by name:
  clean-tree         `git status --porcelain` is empty.
  branch-confirmed   the current branch was confirmed (prompt, or --yes).
  npm-whoami         `npm whoami` succeeds. Note that being logged in is not
                     the same as having publish rights on the name; the first
                     publish claims it. This script never tries to claim it.
  version-available  `npm view zbterm version` differs from the target. An
                     E404 means the package is simply unpublished, which is
                     fine, not an error.
  pack-check         scripts/npm-pack-check.sh passes.
  smoke-install      scripts/npm-smoke-install.sh passes on that tarball.

Dry run (no --publish):
  Guard failures are reported, never fatal. The full publish plan is printed
  either way. Exit 0 when no guard failed, 3 when any did. The working tree and
  the git refs are left untouched in both cases.

With --publish:
  Any failed guard aborts non-zero BEFORE anything irreversible happens - the
  cheap guards are evaluated first, so a dirty tree never even reaches the pack
  check. Once every guard is green:
      npm version <target>          (creates the release commit and the tag)
      npm publish --access public   (plus --otp when given)
  and then the `git push --follow-tags` command is PRINTED, not run.

Exit status: 0 ok, 2 aborted (--publish), 3 blockers found (dry run).
EOF
}

TARGET_SPEC=""
PUBLISH=0
OTP=""
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --publish)
      PUBLISH=1
      ;;
    --yes)
      ASSUME_YES=1
      ;;
    --otp)
      shift
      [ $# -gt 0 ] || {
        echo "release-npm: --otp needs a code" >&2
        exit 1
      }
      OTP="$1"
      ;;
    --otp=*)
      OTP="${1#--otp=}"
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
echo "   mode            : $([ "$PUBLISH" -eq 1 ] && echo 'PUBLISH (irreversible)' || echo 'dry run')"
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
# Cheap guards. These run first so that, with --publish, a failure aborts long
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

if WHOAMI=$(npm whoami 2>&1); then
  record npm-whoami 1 "logged in as '$WHOAMI' (publish rights on '$PKG_NAME' are still not guaranteed)"
else
  record npm-whoami 0 "npm whoami failed - run 'npm login'. ($(printf '%s' "$WHOAMI" | head -1))"
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
  echo "release-npm: aborting BEFORE 'npm version' / 'npm publish'."
  echo "             No commit, no tag, no registry request was made."
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
PUBLISH_CMD="npm publish --access public"
[ -n "$OTP" ] && PUBLISH_CMD="$PUBLISH_CMD --otp <redacted>"

echo
echo "Publish plan for $PKG_NAME@$TARGET_VERSION:"
echo "  1. bash scripts/npm-pack-check.sh"
echo "  2. bash scripts/npm-smoke-install.sh <tarball>"
echo "  3. npm version $TARGET_SPEC          # -> v$TARGET_VERSION commit + tag"
echo "  4. $PUBLISH_CMD"
echo "  5. git push --follow-tags            # printed, never run by this script"

if [ "$PUBLISH" -ne 1 ]; then
  echo
  if [ "$TOTAL_FAILURES" -eq 0 ]; then
    echo "No blockers. Re-run with --publish to release."
    echo "(Dry run: nothing was published, no commit and no tag were created.)"
    exit 0
  fi
  echo "BLOCKERS:"
  for i in "${!GUARD_NAMES[@]}"; do
    [ "${GUARD_OK[$i]}" = "1" ] || echo "  - ${GUARD_NAMES[$i]}: ${GUARD_DETAIL[$i]}"
  done
  echo
  echo "$TOTAL_FAILURES guard(s) failed. Nothing was published; the working tree and"
  echo "git refs are untouched."
  exit 3
fi

if [ "$TOTAL_FAILURES" -ne 0 ]; then
  echo
  echo "BLOCKERS:"
  for i in "${!GUARD_NAMES[@]}"; do
    [ "${GUARD_OK[$i]}" = "1" ] || echo "  - ${GUARD_NAMES[$i]}: ${GUARD_DETAIL[$i]}"
  done
  echo
  echo "release-npm: aborting BEFORE 'npm version' / 'npm publish'."
  echo "             No commit, no tag, no registry request was made."
  exit 2
fi

# ---------------------------------------------------------------------------
# Irreversible from here on. Every guard above is green.
# ---------------------------------------------------------------------------
echo
echo "==> npm version $TARGET_SPEC"
npm version "$TARGET_SPEC"

echo "==> $PUBLISH_CMD"
# `prepack` (asset vendoring) runs again inside npm publish; the tag already
# exists at this point, which is exactly why pack-check ran first.
if [ -n "$OTP" ]; then
  npm publish --access public --otp "$OTP"
else
  npm publish --access public
fi

echo
echo "==> Published $PKG_NAME@$TARGET_VERSION."
echo "    The commit and tag are local. Push them yourself:"
echo
echo "        git push --follow-tags"
echo
