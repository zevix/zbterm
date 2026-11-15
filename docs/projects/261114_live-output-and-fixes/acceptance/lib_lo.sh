# source me after `activate`, "$ZBUI_LIB" and "$ZBUI_LIB_UP". This kit's helpers:
#   lstream                 cmd live-stream-state (the renderer's stream positions, resyncs)
#   seam <prefix>           cmd live-seam: lines "<prefix><n>" in the renderer's buffers
#   flood <sid> <tag> [n]   types a loop printing "L <tag> <i>" for i in 1..n (default 1200),
#                           ~2 ms apart, then "END<tag>" (spelled so the typed command does not contain it)
#   seam_ok <tag> [n]       the seam check: every "L <tag> " line 1..n once, none twice, none missing
#   wait_end <sid> <tag>    until the engine's mirror holds "END<tag>" (60 s)
lstream() { cmd '{"command":"live-stream-state"}'; }
seam() { cmd "$(jq -nc --arg p "$1" '{command: "live-seam", prefix: $p}')"; }
flood() {
  local n="${3:-1200}"
  sinput "$1" "t=$2; for i in \$(seq 1 $n); do echo \"L \${t} \$i\"; sleep 0.002; done; echo EN\"\"D\${t}"
}
wait_end() { wait_until 60 mirror_has "$1" "END$2"; }
seam_ok() {
  local n="${2:-1200}" s
  s="$(seam "L $1 ")"
  jq -c '{lines, first, last, dups: .dups[:10], missing: .missing[:10]}' <<<"$s"
  jq -e --argjson n "$n" '.dups == [] and .missing == [] and .first == 1 and .last == $n and .lines == (.last - .first + 1)' <<<"$s" >/dev/null
}
