# Acceptance report: speed fixes (R1, R2, U3, U4), 2026-11-25

Host `zr` (Linux x64). Package exit **0** (`ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zblive/out npm run package`). Lint exit **0** (97 warnings, all `require-await`, no errors).

| script | exit | verdict | key numbers vs thresholds (as printed) |
|---|---|---|---|
| `R1_switch_speed.sh` (R1, U3) | 0 | PASS | **Warm:** big-profile median 75.8 ≤ 150 (n=18, max 137.9); small-profile median 35.85 ≤ 60 (n=90, max 144.3); longest task 71 ≤ 100. **Cold:** big closed 110.7 ≤ 150; big live 33.9 ≤ 150; longest task 0 ≤ 100. **Onto the big live profile:** row click 38 ≤ 150; search arrow 39.9 ≤ 150. errors=0 throughout. The U3 burst, the cold-transport check and the A-B-A check left no failed assertion. |
| `R1_many_profiles.sh` (R1) | 0 | PASS | 30 switches; median 63.4 ≤ 80; max 81.6; longest task 0 ≤ 100; errors=0 |
| `R2_typing_speed.sh` (R2, U4) | 0 | PASS | **Quiet:** 50 echoes, median 13.15 ≤ 30 (max 130.9), misses=0, longest task 0 ≤ 50. **Streaming:** 50 echoes, median 12.1 ≤ 30 (max 152.6), misses=0, longest task 0 ≤ 50. sequence_shown_s=9. The U4 no-loss assertions left no failure. |

No failing assertions.

Logs are in `/home/zeev/.claude/projects/-zp-zdata-zeev-github-zbterm/runs/261125_speed-and-keys/verify-speed/`:
- `R1_switch_speed.log`
- `R1_many_profiles.log`
- `R2_typing_speed.log`
- `package.log`
- `lint.log`

The scripts' own log dirs were also kept: `/tmp/claude-1000/accept/iiUoucPI.logs`, `/tmp/claude-1000/accept/ruaLk8cT.logs` and `/tmp/claude-1000/accept/DfN5R4BF.logs`.

**Overall verdict: GREEN.** All three scripts, the package build and lint exited 0.
