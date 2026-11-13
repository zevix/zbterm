#!/usr/bin/env bash
# docs/acceptance/run.sh — runs ZBTerm's tests by tier (docs/acceptance/README.md).
#
#   run.sh --sanity                 lint, the quick unit tests, three short GUI checks (<= 2 min)
#   run.sh --topic search[,chrome]  sanity plus those topics (index.json "topics")
#   run.sh --changed [<range>]      sanity plus the topics the changed files select; <range> is
#                                   anything `git diff` takes (default: the working tree against
#                                   HEAD, untracked files included)
#   run.sh --full                   the release set: lint, every test file, every kit script
#   run.sh --list                   the topics, their scripts, tests and rough seconds
# Options:
#   -j N            parallel jobs for test files and GUI scripts (default 4); the scripts in
#                   index.json "serial" always run alone, after the others
#   --package       package first: ZBTERM_FORGE_OUT_DIR=<out> npm run package
#   --out DIR       the scratch package to test (default /tmp/claude-$UID/zbtiers/out)
#   --logs DIR      where every log goes (default /tmp/claude-$UID/zbtiers/runs/<stamp>); kept
#   --dry-run       print what would run, run nothing
#
# Every GUI script is the project kit's own script, run as its run_all.sh runs it, against the
# package in --out, under uisolate, with its own scratch HOME and storage (the kit's activate).
# Test files run one per process with a scratch HOME and a short TMPDIR. Exit 0 when nothing
# failed; a file in index.json "known_failures" that fails is reported KNOWN, not FAIL.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
index="$here/index.json"
uid="$(id -u)"
mode="" topics_arg="" range="" jobs=4 package="" dry=""
out="/tmp/claude-$uid/zbtiers/out"
logs=""
usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --sanity) mode=sanity ;;
    --full) mode=full ;;
    --list) mode=list ;;
    --topic) mode=topic; topics_arg="${2:?--topic needs a list}"; shift ;;
    --changed)
      mode=changed
      if [ $# -gt 1 ] && [ "${2#-}" = "$2" ]; then range="$2"; shift; fi ;;
    -j) jobs="${2:?-j needs a number}"; shift ;;
    --package) package=1 ;;
    --out) out="${2:?}"; shift ;;
    --logs) logs="${2:?}"; shift ;;
    --dry-run) dry=1 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
  shift
done
[ -n "$mode" ] || usage
command -v jq >/dev/null || { echo "jq is needed" >&2; exit 75; }
cd "$repo"

if [ "$mode" = list ]; then
  jq -r '"sanity: lint, \(.sanity.tests | length) test files, scripts \(.sanity.scripts | join(" "))",
    (.topics | to_entries[] | "\(.key) (~\(.value.seconds) s): \(.value.about)\n  scripts: \(.value.scripts | join(" "))\n  tests: \(.value.tests | join(" "))")' "$index"
  exit 0
fi

# ---- what to run --------------------------------------------------------------
declare -A want_topic=()
add_topics() { local t; for t in $(tr ',' ' ' <<<"$1"); do
  jq -e --arg t "$t" '.topics | has($t)' "$index" >/dev/null || { echo "no topic '$t' (see --list)" >&2; exit 2; }
  want_topic[$t]=1
done; }

changed_files() {
  if [ -n "$range" ]; then git diff --name-only $range
  else git diff --name-only HEAD; git ls-files --others --exclude-standard; fi | sort -u
}
# The lines a change added or removed in <file> (for "content" rules).
changed_lines() {
  if [ -n "$range" ]; then git diff -U0 $range -- "$1"
  elif git ls-files --error-unmatch "$1" >/dev/null 2>&1; then git diff -U0 HEAD -- "$1"
  else sed 's/^/+/' "$1"; fi | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) '
}
pick_changed() {
  local f t pat hit regex lines
  while read -r f; do
    [ -n "$f" ] || continue
    hit=""
    for t in $(jq -r '.topics | keys[]' "$index"); do
      while read -r pat; do
        [ -n "$pat" ] || continue
        # shellcheck disable=SC2053
        if [[ $f == $pat ]]; then want_topic[$t]=1; hit="$hit $t"; break; fi
      done < <(jq -r --arg t "$t" '.topics[$t].paths[]' "$index")
      # A test file selects the topics that list it.
      if jq -e --arg t "$t" --arg f "$f" '.topics[$t].tests | index($f) != null' "$index" >/dev/null; then
        want_topic[$t]=1; hit="$hit $t"
      fi
      regex="$(jq -r --arg t "$t" --arg f "$f" '.topics[$t].content[$f] // empty' "$index")"
      if [ -n "$regex" ]; then
        lines="$(changed_lines "$f" 2>/dev/null || true)"
        if grep -qE -- "$regex" <<<"$lines"; then want_topic[$t]=1; hit="$hit $t"; fi
      fi
    done
    if [ -z "$hit" ]; then
      while read -r pat; do
        # shellcheck disable=SC2053
        if [[ $f == $pat ]]; then
          hit="$(jq -r --arg p "$pat" '.fallback[$p] | join(" ")' "$index")"
          for t in $hit; do want_topic[$t]=1; done
          hit="${hit:-nothing beyond sanity} (fallback $pat)"
          break
        fi
      done < <(jq -r '.fallback | keys_unsorted[] | select(. != "about")' "$index")
    fi
    echo "changed: $f ->${hit:- nothing beyond sanity}"
  done < <(changed_files)
}

lint=1
tests=() scripts=()
if [ "$mode" = full ]; then
  mapfile -t tests < <(ls test/*.test.js test/backends/*.test.js)
  for k in $(jq -r '.kits | keys[]' "$index"); do
    d="$(jq -r --arg k "$k" '.kits[$k]' "$index")"
    for s in "$d"/R*.sh "$d"/U*.sh; do [ -e "$s" ] && scripts+=("$k/$(basename "$s" .sh)"); done
  done
else
  [ "$mode" = topic ] && add_topics "$topics_arg"
  [ "$mode" = changed ] && pick_changed
  mapfile -t tests < <(jq -r '.sanity.tests[]' "$index")
  mapfile -t scripts < <(jq -r '.sanity.scripts[]' "$index")
  for t in "${!want_topic[@]}"; do
    mapfile -t -O "${#tests[@]}" tests < <(jq -r --arg t "$t" '.topics[$t].tests[]' "$index")
    mapfile -t -O "${#scripts[@]}" scripts < <(jq -r --arg t "$t" '.topics[$t].scripts[]' "$index")
  done
fi
mapfile -t tests < <(printf '%s\n' "${tests[@]}" | sed '/^$/d' | sort -u)
mapfile -t scripts < <(printf '%s\n' "${scripts[@]}" | sed '/^$/d' | sort -u)
mapfile -t serial < <(jq -r '.serial[]' "$index")
par=() ser=()
for s in "${scripts[@]}"; do
  if printf '%s\n' "${serial[@]}" | grep -qxF -- "$s"; then ser+=("$s"); else par+=("$s"); fi
done
topics_run="$(printf '%s ' "${!want_topic[@]}" | sed 's/ $//')"
echo "tier: $mode${topics_run:+ (topics: $topics_run)}; lint; ${#tests[@]} test files; ${#scripts[@]} GUI scripts (${#ser[@]} alone); -j $jobs"
if [ -n "$dry" ]; then
  printf 'test   %s\n' "${tests[@]}"; printf 'script %s\n' "${par[@]}"; printf 'alone  %s\n' "${ser[@]}"
  exit 0
fi

# ---- scratch dirs and logs ----------------------------------------------------
stamp="$(date +%Y%m%d-%H%M%S)"
logs="${logs:-/tmp/claude-$uid/zbtiers/runs/$stamp-$mode}"
mkdir -p "$logs/tests" "$logs/scripts"
scratch="/tmp/claude-$uid/zbtiers/scratch-$$"
ttmp="/tmp/zbtt$$"      # short: the SSH-agent socket path limit (AGENTS.md)
gtmp="/tmp/zbtg$$"
mkdir -p "$scratch" "$ttmp" "$gtmp"
export ZXTERM_CORE_BIN="${ZXTERM_CORE_BIN:-$repo/npm/zxterm-core-linux-x64/zxterm-core}"
results="$logs/results.txt"; : >"$results"
t_start="$(date +%s)"
echo "logs: $logs"

# result <id> <rc> <seconds> <log> [known]
result() {
  local word
  case "$2" in
    0) word=PASS ;;
    75) word="CANNOT RUN" ;;
    *) if [ -n "${5:-}" ]; then word=KNOWN; else word=FAIL; fi ;;
  esac
  printf '%-10s %-55s %5ss  %s\n' "$word" "$1" "$3" "$4" | tee -a "$results"
}

# Runs "<cmd...>" for each item with at most $jobs at once; each call is `$1 <item>`.
pool() {
  local fn="$1"; shift
  local item
  for item in "$@"; do
    while [ "$(jobs -rp | wc -l)" -ge "$jobs" ]; do wait -n || true; done
    "$fn" "$item" &
  done
  wait
}

run_test() {
  local f="$1" n log t0 rc known=""
  n="$(sed 's#^test/##; s#/#_#g' <<<"$f")"; log="$logs/tests/$n.log"
  mkdir -p "$scratch/h-$n"
  t0="$(date +%s)"
  HOME="$scratch/h-$n" TMPDIR="$ttmp" timeout 900 node_modules/.bin/brittle-node "$f" >"$log" 2>&1
  rc=$?
  jq -e --arg f "$f" '.known_failures | has($f)' "$index" >/dev/null && known=1
  result "$f" "$rc" "$(($(date +%s) - t0))" "$log" "$known"
}

run_script() {
  local id="$1" k n d log t0 rc
  k="${id%%/*}"; n="${id#*/}"
  d="$(jq -r --arg k "$k" '.kits[$k]' "$index")"
  log="$logs/scripts/$k-$n.txt"
  t0="$(date +%s)"
  env -u UBITRON_TEST_STATE_DIR ZBUI_OUT="$out" ZBUI_APP="$out/ZBTerm-linux-x64/ZBTerm" \
    ZBUI_TMP="$gtmp" ACCEPT_LOG_DIR="$logs/scripts/$k" timeout 1200 "$repo/$d/$n.sh" >"$log" 2>&1
  rc=$?
  result "$id" "$rc" "$(($(date +%s) - t0))" "$log"
}

# Processes a test left behind (zxterm-seam's fixture worker): only those whose command
# line carries this run's own scratch TMPDIR, which no other process uses.
reap() {
  local p line
  for p in $(pgrep -f -- "$ttmp" 2>/dev/null); do
    [ "$p" = "$$" ] && continue
    line="$({ tr '\0' ' ' <"/proc/$p/cmdline"; } 2>/dev/null)"
    if grep -qF -- "$ttmp/" <<<"$line"; then
      kill "$p" 2>/dev/null && echo "reaped $p (${line:0:120})" >>"$logs/reaped.txt"
    fi
  done
}

if [ -n "$package" ]; then
  t0="$(date +%s)"
  ZBTERM_FORGE_OUT_DIR="$out" npm run package >"$logs/package.log" 2>&1
  result package $? "$(($(date +%s) - t0))" "$logs/package.log"
fi
if [ "${#scripts[@]}" -gt 0 ] && [ ! -x "$out/ZBTerm-linux-x64/ZBTerm" ]; then
  echo "no package at $out (use --package)" | tee -a "$results"
  echo "CANNOT RUN package missing" >>"$results"
fi
if [ -n "$lint" ]; then
  t0="$(date +%s)"
  npm run lint >"$logs/lint.log" 2>&1
  result lint $? "$(($(date +%s) - t0))" "$logs/lint.log"
fi
t_tests="$(date +%s)"
[ "${#tests[@]}" -gt 0 ] && pool run_test "${tests[@]}"
reap
echo "test files: $(($(date +%s) - t_tests)) s" | tee -a "$results"
t_gui="$(date +%s)"
[ "${#par[@]}" -gt 0 ] && pool run_script "${par[@]}"
for s in "${ser[@]}"; do run_script "$s"; done
echo "GUI scripts: $(($(date +%s) - t_gui)) s" | tee -a "$results"

wall=$(($(date +%s) - t_start))
fails="$(grep -cE '^(FAIL|CANNOT RUN)' "$results")"
known="$(grep -c '^KNOWN' "$results")"
passes="$(grep -c '^PASS' "$results")"
echo "summary: tier $mode, $passes PASS, $fails FAIL/CANNOT RUN, $known KNOWN; wall ${wall} s; host $(hostname); logs $logs" | tee -a "$results"
# Scratch HOMEs and TMPDIRs of this run (logs are kept).
for d in "$scratch" "$ttmp" "$gtmp"; do
  case "$d" in /tmp/claude-"$uid"/*) "${UB_PY:-/ubitron/dev/.venv/bin/python}" -m ubitron.envs.safe_delete "$d" >/dev/null 2>&1 || true ;; esac
done
[ "$fails" = 0 ]
