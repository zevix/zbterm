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
#   run.sh --self-check             the index against the tree, the selection rules on fixed
#                                   cases, the KNOWN rule on fixture logs, --list and --dry-run
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
# failed; a file in index.json "known_failures" that fails for its known reason (its listed
# failing tests, its crash text) is reported KNOWN; failing for any other reason, FAIL.
# ZB_TIERS_FILES (newline-separated paths), when set, stands for the changed files of --changed
# (the self-check uses it to try the selection rules).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
self="$here/$(basename "${BASH_SOURCE[0]}")"   # absolute: the repo root has a run.sh of its own
repo="$(git -C "$here" rev-parse --show-toplevel)"
index="$here/index.json"
uid="$(id -u)"
mode="" topics_arg="" range="" jobs=4 package="" dry=""
out="/tmp/claude-$uid/zbtiers/out"
logs=""
usage() { sed -n '2,31p' "$self" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --sanity) mode=sanity ;;
    --full) mode=full ;;
    --list) mode=list ;;
    --self-check) mode=selfcheck ;;
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
    (.topics | to_entries[] | "\(.key) (~\(.value.seconds) s): \(.value.about)\n  scripts: \(.value.scripts | join(" "))\n  tests: \(.value.tests | join(" "))"),
    "self-check, selected by: \(.self.paths | join(" ")) (and in --full)",
    "docs only (nothing beyond sanity): \(.docs_only.paths | join(" "))",
    (.harness | to_entries[] | select(.key != "about") | "harness \(.key): kits \(.value | join(" "))"),
    (.known_failures | to_entries[] | select(.key != "about") | "known failure \(.key): \(.value.failing | join("; "))\(if .value.crash then " (crash: \(.value.crash))" else "" end)")' "$index"
  exit 0
fi

# ---- what to run --------------------------------------------------------------
declare -A want_topic=()
add_topics() { local t; for t in $(tr ',' ' ' <<<"$1"); do
  jq -e --arg t "$t" '.topics | has($t)' "$index" >/dev/null || { echo "no topic '$t' (see --list)" >&2; exit 2; }
  want_topic[$t]=1
done; }

changed_files() {
  if [ -n "${ZB_TIERS_FILES:-}" ]; then printf '%s\n' "$ZB_TIERS_FILES"
  elif [ -n "$range" ]; then git diff --name-only $range
  else git diff --name-only HEAD; git ls-files --others --exclude-standard; fi | sort -u
}
# The lines a change added or removed in <file> (for "content" rules).
changed_lines() {
  if [ -n "$range" ]; then git diff -U0 $range -- "$1"
  elif git ls-files --error-unmatch "$1" >/dev/null 2>&1; then git diff -U0 HEAD -- "$1"
  else sed 's/^/+/' "$1"; fi | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) '
}
# Kit correction 2026-11-13 (F3): the rules, in order (report 2026-11-13, tiers (a)-(d)):
#   1. run.sh / index.json ("self")      -> the self-check (sanity always runs)
#   2. "docs_only" (docs/*.md)           -> nothing beyond sanity
#   3. a kit's R*/U* script              -> the topics listing it
#      a "harness" file                  -> every topic listing a script of the kits using it
#      any other file in a kit's dir     -> every topic listing a script of that kit
#   4. topic paths, listed tests, content rules
#   5. "fallback"
selfcheck=""
topics_of_kits() {   # <kit>...: the topics that list a script of any of them
  jq -r --arg ks "$*" '($ks | split(" ")) as $ks | .topics | to_entries[]
    | select(any(.value.scripts[]; (split("/")[0]) as $k | $ks | index($k) != null)) | .key' "$index"
}
kit_of() {   # <file>: "<kit> <script id or ''>" when the file is in a kit's directory
  local k d
  for k in $(jq -r '.kits | keys[]' "$index"); do
    d="$(jq -r --arg k "$k" '.kits[$k]' "$index")"
    case "$1" in
      "$d"/[RU][0-9]*_*.sh) echo "$k $k/$(basename "$1" .sh)"; return ;;
      "$d"/*) echo "$k"; return ;;
    esac
  done
}
pick_changed() {
  local f t pat hit regex lines kit id kits
  while read -r f; do
    [ -n "$f" ] || continue
    hit=""
    if jq -e --arg f "$f" '.self.paths | index($f) != null' "$index" >/dev/null; then
      selfcheck=1
      echo "changed: $f -> the self-check"
      continue
    fi
    while read -r pat; do
      # shellcheck disable=SC2053
      if [ -n "$pat" ] && [[ $f == $pat ]]; then hit="docs only ($pat)"; break; fi
    done < <(jq -r '.docs_only.paths[]' "$index")
    if [ -n "$hit" ]; then echo "changed: $f -> nothing beyond sanity, $hit"; continue; fi
    kits="$(jq -r --arg f "$f" '.harness[$f] // empty | join(" ")' "$index")"
    read -r kit id < <(kit_of "$f"; echo)
    if [ -n "$kits" ]; then
      for t in $(topics_of_kits $kits); do want_topic[$t]=1; hit="$hit $t"; done
      echo "changed: $f ->${hit:- no topic} (harness of $kits)"
      continue
    elif [ -n "$id" ]; then
      for t in $(jq -r --arg s "$id" '.topics | to_entries[] | select(.value.scripts | index($s) != null) | .key' "$index"); do
        want_topic[$t]=1; hit="$hit $t"
      done
      echo "changed: $f ->${hit:- no topic} (the topics listing $id)"
      continue
    elif [ -n "$kit" ]; then
      for t in $(topics_of_kits "$kit"); do want_topic[$t]=1; hit="$hit $t"; done
      echo "changed: $f ->${hit:- no topic} (kit $kit's own file)"
      continue
    fi
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

# known_reason <test file> <log>: true when the file is a known failure failing for its known
# reason; otherwise prints why not (and is false).
known_reason() {
  local f="$1" log="$2" entry failing name unknown="" crash
  entry="$(jq -c --arg f "$f" '.known_failures[$f] // empty' "$index")"
  [ -n "$entry" ] || return 1
  failing="$(grep -E '^not ok [0-9]+ - ' "$log" | sed -E 's/^not ok [0-9]+ - //; s/ # time = .*$//')"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    jq -e --arg n "$name" '.failing | index($n) != null' <<<"$entry" >/dev/null || unknown="$unknown${unknown:+; }$name"
  done <<<"$failing"
  crash="$(jq -r '.crash // empty' <<<"$entry")"
  if [ -n "$unknown" ]; then echo "known file, new failing test: $unknown"; return 1; fi
  if [ -n "$crash" ]; then
    grep -qF -- "$crash" "$log" || { echo "known file, not its known crash ($crash)"; return 1; }
  else
    grep -qE '^# tests = ' "$log" || { echo "known file, the run stopped before its summary"; return 1; }
    [ -n "$failing" ] || { echo "known file, failed with no failing test"; return 1; }
  fi
  return 0
}

# self_check (F3): the index against the tree, the selection rules on fixed cases, the KNOWN rule
# on fixture logs, --list and --dry-run. Prints "ok - …" / "not ok - …"; false on any not ok.
self_check() {
  local bad=0 k d f t id ids want got out tmp topics_all
  sc() { if eval "$2" >/dev/null 2>&1; then echo "ok - $1"; else echo "not ok - $1"; bad=1; fi; }
  sc "index.json is JSON with kits, sanity, topics, self, docs_only, harness, known_failures, fallback" \
    "jq -e 'has(\"kits\") and has(\"sanity\") and has(\"topics\") and has(\"self\") and has(\"docs_only\") and has(\"harness\") and has(\"known_failures\") and has(\"fallback\")' '$index'"
  for k in $(jq -r '.kits | keys[]' "$index"); do
    d="$(jq -r --arg k "$k" '.kits[$k]' "$index")"
    sc "kit $k: $d exists" "[ -d '$d' ]"
  done
  # Every script id and test the index names exists.
  while read -r id; do
    k="${id%%/*}"; d="$(jq -r --arg k "$k" '.kits[$k] // empty' "$index")"
    [ -n "$d" ] && [ -f "$d/${id#*/}.sh" ] || { echo "not ok - $id names no script"; bad=1; }
  done < <(jq -r '[.sanity.scripts[], (.topics[].scripts[]), .serial[]] | unique[]' "$index")
  while read -r f; do
    [ -f "$f" ] || { echo "not ok - $f is listed but missing"; bad=1; }
  done < <(jq -r '[.sanity.tests[], (.topics[].tests[]), (.known_failures | keys[] | select(. != "about"))] | unique[]' "$index")
  echo "ok - every listed script and test exists (unless named above)"
  # Every kit script and every test file belongs to sanity or a topic.
  ids="$(jq -r '[.sanity.scripts[], (.topics[].scripts[])] | unique[]' "$index")"
  for k in $(jq -r '.kits | keys[]' "$index"); do
    d="$(jq -r --arg k "$k" '.kits[$k]' "$index")"
    for f in "$d"/R*.sh "$d"/U*.sh; do
      [ -e "$f" ] || continue
      grep -qxF -- "$k/$(basename "$f" .sh)" <<<"$ids" || { echo "not ok - $k/$(basename "$f" .sh) is in no topic"; bad=1; }
    done
  done
  ids="$(jq -r '[.sanity.tests[], (.topics[].tests[])] | unique[]' "$index")"
  for f in test/*.test.js test/backends/*.test.js; do
    grep -qxF -- "$f" <<<"$ids" || { echo "not ok - $f is in no topic"; bad=1; }
  done
  echo "ok - every kit script and test file is in sanity or a topic (unless named above)"
  # A harness file lists every kit that uses it: its own kit when a file there names it,
  # another kit when a file of its names "<project>/acceptance/<file>".
  while read -r f; do
    [ -f "$f" ] || { echo "not ok - harness $f is missing"; bad=1; continue; }
    for k in $(jq -r '.kits | keys[]' "$index"); do
      d="$(jq -r --arg k "$k" '.kits[$k]' "$index")"
      if { [ "$d" = "$(dirname "$f")" ] && grep -lqF -- "$(basename "$f")" "$d"/*.sh "$d"/activate 2>/dev/null; } \
        || grep -lqF -- "$(basename "$(dirname "$(dirname "$f")")")/acceptance/$(basename "$f")" "$d"/*.sh "$d"/activate 2>/dev/null; then
        jq -e --arg f "$f" --arg k "$k" '.harness[$f] | index($k) != null' "$index" >/dev/null \
          || { echo "not ok - kit $k uses $f but harness does not list it"; bad=1; }
      fi
    done
  done < <(jq -r '.harness | keys[] | select(. != "about")' "$index")
  echo "ok - every harness file lists the kits that use it (unless named above)"
  # The selection rules on fixed cases (ZB_TIERS_FILES stands for the changed files).
  topics_all="$(jq -r '.topics | keys[]' "$index" | sort | tr '\n' ' ')"
  sel() { ZB_TIERS_FILES="$1" "$self" --changed --dry-run | sed -nE 's/^tier: changed( \(topics: ([^)]*)\))?;.*/\2/p' | tr ' ' '\n' | sed '/^$/d' | sort | tr '\n' ' '; }
  want="$(topics_of_kits uc tf st bs | sort -u | tr '\n' ' ')"
  got="$(sel docs/projects/261110_ui-chrome/acceptance/lib.sh)"
  sc "ui-chrome's lib.sh selects every topic with a uc/tf/st/bs script ($want)" "[ '$got' = '$want' ]"
  got="$(sel docs/projects/261111_buffer-search/goal_requirements.md)"
  sc "a project's goal page (docs/*.md) selects no topic" "[ -z '$got' ]"
  got="$(sel docs/projects/261111_buffer-search/acceptance/README.md)"
  sc "a kit README selects no topic" "[ -z '$got' ]"
  out="$(ZB_TIERS_FILES=docs/acceptance/index.json "$self" --changed --dry-run)"
  sc "index.json selects the self-check and no topic" "grep -q '^check  self-check' <<<\"\$out\" && grep -q '^tier: changed; lint; self-check;' <<<\"\$out\""
  out="$(ZB_TIERS_FILES=docs/acceptance/run.sh "$self" --changed --dry-run)"
  sc "run.sh selects the self-check" "grep -q '^check  self-check' <<<\"\$out\""
  got="$(sel docs/projects/261111_buffer-search/acceptance/R8_joined_session.sh)"
  sc "bs/R8's script selects search and sharing (the topics listing it)" "[ '$got' = 'search sharing ' ]"
  got="$(sel docs/projects/261111_buffer-search/acceptance/lib_bs.sh)"
  want="$(topics_of_kits bs | sort -u | tr '\n' ' ')"
  sc "buffer-search's lib_bs.sh selects every topic with a bs script ($want)" "[ '$got' = '$want' ]"
  out="$(ZB_TIERS_FILES=engine/buffer-search.js "$self" --changed --dry-run)"
  sc "engine/buffer-search.js runs bs/R8 (in the search topic)" "grep -qE '^(script|alone) +bs/R8_joined_session\$' <<<\"\$out\""
  # The KNOWN rule on fixture logs.
  tmp="$(mktemp -d "/tmp/claude-$uid/zbtiers-sc.XXXXXX")"
  printf 'TAP version 13\n    not ok 1 - should be equal\nnot ok 8 - doctor: run() reports every check and exits 0 on this machine # time = 1ms\n# tests = 15/16 pass\n' >"$tmp/doctor-known.log"
  printf 'TAP version 13\nnot ok 8 - doctor: run() reports every check and exits 0 on this machine # time = 1ms\nnot ok 9 - doctor: something new # time = 1ms\n# tests = 14/16 pass\n' >"$tmp/doctor-new.log"
  printf 'TAP version 13\nnot ok 8 - doctor: run() reports every check and exits 0 on this machine # time = 1ms\nTypeError: boom\n' >"$tmp/doctor-crash.log"
  printf 'TAP version 13\n    ok 1 - core.version\nError: no such seam method: test.echo\n  code: E_BACKEND_UNSUPPORTED\n' >"$tmp/seam-known.log"
  printf 'TAP version 13\n    ok 1 - core.version\nError: spawn ENOENT\n' >"$tmp/seam-other.log"
  printf 'TAP version 13\nnot ok 1 - the seam: sidecar spawn # time = 1ms\nError: no such seam method: test.echo\n' >"$tmp/seam-newfail.log"
  sc "KNOWN: doctor failing its known test" "known_reason test/doctor.test.js '$tmp/doctor-known.log'"
  sc "FAIL: doctor with a new failing test" "! known_reason test/doctor.test.js '$tmp/doctor-new.log'"
  sc "FAIL: doctor stopping before its summary" "! known_reason test/doctor.test.js '$tmp/doctor-crash.log'"
  sc "KNOWN: zxterm-seam with its known crash" "known_reason test/zxterm-seam.test.js '$tmp/seam-known.log'"
  sc "FAIL: zxterm-seam with another crash" "! known_reason test/zxterm-seam.test.js '$tmp/seam-other.log'"
  sc "FAIL: zxterm-seam with a failing test" "! known_reason test/zxterm-seam.test.js '$tmp/seam-newfail.log'"
  sc "FAIL: a file not in known_failures" "! known_reason test/store.test.js '$tmp/doctor-known.log'"
  "${UB_PY:-/ubitron/dev/.venv/bin/python}" -m ubitron.envs.safe_delete "$tmp" >/dev/null 2>&1 || true
  # --list, --dry-run of each topic and of --full, an unknown topic.
  sc "--list exits 0" "'$self' --list"
  for t in $topics_all; do sc "--topic $t --dry-run exits 0" "'$self' --topic $t --dry-run"; done
  sc "--topic nope exits 2" "'$self' --topic nope --dry-run; [ \$? = 2 ]"
  out="$("$self" --full --dry-run)"
  got="$(grep -cE '^test ' <<<"$out")"
  want="$(ls test/*.test.js test/backends/*.test.js | wc -l)"
  sc "--full --dry-run lists every test file ($want)" "[ '$got' = '$want' ]"
  got="$(grep -cE '^(script|alone) ' <<<"$out")"
  want=0
  for k in $(jq -r '.kits | keys[]' "$index"); do
    d="$(jq -r --arg k "$k" '.kits[$k]' "$index")"
    want=$((want + $(find "$d" -maxdepth 1 -name 'R*.sh' -o -maxdepth 1 -name 'U*.sh' | wc -l)))
  done
  sc "--full --dry-run lists every kit script ($want)" "[ '$got' = '$want' ]"
  return "$bad"
}

if [ "$mode" = selfcheck ]; then
  self_check; exit $?
fi

lint=1
tests=() scripts=()
if [ "$mode" = full ]; then
  selfcheck=1
  mapfile -t tests < <(ls test/*.test.js test/backends/*.test.js)
  for k in $(jq -r '.kits | keys[]' "$index"); do
    d="$(jq -r --arg k "$k" '.kits[$k]' "$index")"
    for s in "$d"/R*.sh "$d"/U*.sh; do [ -e "$s" ] && scripts+=("$k/$(basename "$s" .sh)"); done
  done
else
  [ "$mode" = topic ] && add_topics "$topics_arg"
  # pick_changed sets want_topic and selfcheck: it runs in this shell, never in a pipe.
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
echo "tier: $mode${topics_run:+ (topics: $topics_run)}; lint; ${selfcheck:+self-check; }${#tests[@]} test files; ${#scripts[@]} GUI scripts (${#ser[@]} alone); -j $jobs"
if [ -n "$dry" ]; then
  [ -n "$selfcheck" ] && echo "check  self-check"
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

# result <id> <rc> <seconds> <log> [known] [note]
result() {
  local word
  case "$2" in
    0) word=PASS ;;
    75) word="CANNOT RUN" ;;
    *) if [ -n "${5:-}" ]; then word=KNOWN; else word=FAIL; fi ;;
  esac
  printf '%-10s %-55s %5ss  %s%s\n' "$word" "$1" "$3" "$4" "${6:+  ($6)}" | tee -a "$results"
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
  # Kit correction 2026-11-13 (F3): KNOWN only for the file's known reason (index.json
  # "known_failures"); a known file failing otherwise is FAIL, with the reason.
  local note=""
  if [ "$rc" != 0 ] && jq -e --arg f "$f" '.known_failures | has($f)' "$index" >/dev/null; then
    if note="$(known_reason "$f" "$log")"; then known=1; note="its known reason"; fi
  fi
  result "$f" "$rc" "$(($(date +%s) - t0))" "$log" "$known" "$note"
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
if [ -n "$selfcheck" ]; then
  t0="$(date +%s)"
  self_check >"$logs/self-check.log" 2>&1
  result self-check $? "$(($(date +%s) - t0))" "$logs/self-check.log"
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
