# Improvements and fixes — baseline (evidence, phase 0)

**Measured:** 2026-11-21 on this host (the maintainer's Linux box), node v24.19.0, tree at `6d81b4b`
with R1's uncommitted work (below) · **Logs:** `/tmp/claude-1000/zbruns/` (scratch, not kept)

## Reference program

The packaged app, as the user runs it: `ZBTERM_FORGE_OUT_DIR=<scratch> npm run package`, then
`<scratch>/ZBTerm-linux-x64/ZBTerm`; the kit drives it the same way on a private display
(`acceptance/README.md`).

## Today

| fact | command → output |
|---|---|
| full suite before this project's R2–R13 edits: 4 failing tests, all older than it | `HOME=/tmp/zbt-h TMPDIR=/tmp/zbt-t npm test` → `# asserts = 4388/4394 pass`; `not ok 240 - native-linkage: scan follows the dependency graph and flags libnode`, `not ok 339 - the startup logo text ends on the last row without scrolling`, `not ok 345 - buffer-search: the buffer-match section, its cyan in both themes, alternate-screen highlights`, `not ok 403 - golden: diagnostics() key set` |
| the golden failure predates this project: the link record gained `verifiedOnly` in 261115 R42 | same log: `actual: … autoJoin, verifiedOnly, revoked, consumed` vs `expected: … autoJoin, revoked, consumed` (`test/share-manager-seam.test.js:79`) |
| static renderer test: two of those four | `npx brittle-node test/renderer-static.test.js` → `not ok 31 - the startup logo text …`, `not ok 37 - buffer-search: …` |
| R8's jump, measured on the build before the fix (`/tmp/claude-1000/zpk`, 00:25) | `ZBUI_OUT=/tmp/claude-1000/zpk acceptance/R8_dialog_steady.sh` → `top with the full list: 142`, `after z: {"top":266,…,"height":526}` → exit 1 |
| N/M sat beside the box's x | `renderer/index.html` `.search-count { position: absolute; … right: 30px }` (before this project) |
| there is no "stop sharing" RPC; `revokeLink` disconnects and rekeys | `grep -n "'share\." engine/index.js` → createLink, listLinks, revokeLink, revokeMember, join, …; no stop |
| the profile right-click menu was Rename, Delete History, Remove HD, Delete | `git show 6d81b4b:renderer/app.js \| grep -n "label: 'Rename'"` → the `openSessionMenu` default items |

## Cost

| what | today | target | measured by |
|---|---|---|---|
| full unit suite | 279 s | unchanged | `npm test` `# time = 279054ms` |
| package | ~4 min | unchanged | `npm run package` |
| kit | — | ≤ 240 s per GUI script, ≤ 600 s for R13 | `acceptance/run_all.sh` |

## Working tree

`git status --short` at the start of R2–R13 (R1's work, the version bump to 1.9.2, the 261118 status rename):

```
 M build/AppxManifest.xml
RM docs/projects/261118_session-plugins/status--verifying.md -> docs/projects/261118_session-plugins/status--done.md
 M electron/main.js
 M package-lock.json
 M package.json
 M renderer/app.js
?? docs/projects/261121_improvements-and-fixes/
```
