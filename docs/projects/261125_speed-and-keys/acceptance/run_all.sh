#!/usr/bin/env bash
# Runs every R*.sh and U*.sh here; prints PASS / FAIL / CANNOT RUN per script; exit 1 if any
# did not pass. An empty kit is a FAIL. `--needs` only checks the scripts' `need` lines
# (grep, no run) and exits 0 when this host satisfies them all (phase 0 uses it).
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/activate"
if [ "${1:-}" = "--needs" ]; then
  rc=0
  while read -r what why; do
    what="$(eval printf '%s' "$what")"   # need lines may spell \$UB_PY / \$UB_REPO (activate exported them)
    [ -e "$what" ] || command -v "$what" >/dev/null 2>&1 \
      || { echo "cannot run here: $what missing ($why)"; rc=75; }
  done < <(grep -h -E '^[[:space:]]*need ' "$here"/R*.sh "$here"/U*.sh 2>/dev/null \
           | sed -E 's/^[[:space:]]*need[[:space:]]+//; s/"//g')
  [ "$rc" = 0 ] && echo "needs: all satisfied on $(hostname)"
  exit "$rc"
fi
rc=0; n_run=0
for s in "$here"/R*.sh "$here"/U*.sh; do
  [ -e "$s" ] || continue
  n="$(basename "$s" .sh)"; n_run=$((n_run + 1))
  # One script at most 240 s (the user, 2026-11-13); a timeout (124) is a FAIL.
  lim=240
  if timeout "$lim" "$s" > "$ACCEPT_LOG_DIR/$n.txt" 2>&1; then echo "PASS $n"
  else
    code=$?
    if [ "$code" = 75 ]; then echo "CANNOT RUN $n  ($(tail -n1 "$ACCEPT_LOG_DIR/$n.txt"))"
    else echo "FAIL $n  ($ACCEPT_LOG_DIR/$n.txt)"; fi
    rc=1
  fi
done
[ "$n_run" -gt 0 ] || { echo "FAIL: no R*.sh / U*.sh in $here"; rc=1; }
# Where the per-script logs are (kept).
echo "host: $(hostname)  state dir: $UBITRON_TEST_STATE_DIR  logs: $ACCEPT_LOG_DIR"
exit $rc
