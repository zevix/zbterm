# Live output and fixes — baseline (phase 0)

**Written:** 2026-11-14, after the build had started (see *Note*) · **At:** `190f46e` (HEAD; facts read
with `git show HEAD:<file>`) · **Log:** this page; the measured numbers are `../261113_ui-polish/delivery-design.md` *Proof*.

Read by the planner and builders by path. The user does not approve this page.

**Note.** The user said "go implement" on 2026-11-14 and the code was changed before this page was
written; every *Today* row is therefore read from the committed tree (`HEAD`), not the working tree.

## Reference program

`acceptance/run_all.sh` (one script per row, `acceptance/README.md`); the design it serves is
`design.md` (design A of `../261113_ui-polish/delivery-design.md`).

## Today

| fact | command → output |
|---|---|
| the frame is cut, then an await runs before the answer | `git show HEAD:engine/index.js \| grep -n "frame = runtime.mirror.snapshot(runtime.store.log.length)\|availability: await availabilitySummary(runtime.store),"` → `2260:` snapshot, `2270:` await after it |
| no stream position on the wire or in the contract | `git show HEAD:engine/rpc/schema.js \| grep -n '\bend\b'` → only `player:end`, a decoder bound and the allocator; `git show HEAD:engine/index.js \| grep -n through` → comments only |
| the template mark is a check, after the pin | `git show HEAD:renderer/app.js \| grep -n "fa-check session-default-mark"` → `2797:` (the pin is appended at `2792`) |
| the row count is one number | `git show HEAD:renderer/app.js \| grep -n "matchCount === 1 ? 'match'"` → `2786:` |
| the font buttons say "Font" | `git show HEAD:renderer/app.js \| grep -n "'fa-plus', 'Font'"` → `5414:` |
| drops and duplicates on a switch | `../261113_ui-polish/delivery-design.md` *Proof* (2026-11-13): drop 5 of 8 with a 50 ms injected window; duplicates 2 of 18 and 1 of 18 |

## Cost (mandatory)

| what | today | target | measured by |
|---|---|---|---|
| unit suite | 587/589 pass at the working tree, 2026-11-14 (the 2 failures are host checks: `doctor`, `native-linkage`) | the same, plus the new tests | `HOME=/tmp/zb14/full TMPDIR=/tmp/zb14 npm test` |
| packaged build | ~3 min on `zr` | unchanged | `ZBTERM_FORGE_OUT_DIR=/tmp/claude-1000/zblive/out npm run package` |
| per chunk, renderer | one queue push | one position compare and at most one `subarray` | `renderer/live-stream.js::take` |
| per `session.open`, engine | snapshot | snapshot + concat of the pending tail (as `buildLiveBootstrap`) | `engine/index.js::_liveFrame` |

## Working tree

`git status --porcelain` at the start (2026-11-14): `?? .ubtrees/`, `?? docs/projects/261114_live-output-and-fixes/`.
