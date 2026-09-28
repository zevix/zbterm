# CHANGELOG

## Phase V0: Baseline

**Goal.** `baseline.md` records the suite and lint counts, and `git status --porcelain`, before
any code changes.

**Verification.** `npm test`; `npm run lint`. Pass = the counts are written down with failing ids.

### V0
- **Decisions:** none. Run by the orchestrator (measurement only). **Measured:** 354 tests / 2132 asserts, exit 0; lint exit 0, 98 warnings. **Files touched:** `baseline.md`. **Next free:** `S-17`, `D-08`. **Suite:** 354 / 2132.

**Verification output.**
```
# tests = 354/354 pass
# asserts = 2132/2132 pass
# ok
lint: 98 warnings, exit 0
```

---

## Phase V1: Remove the Pear OTA updater from every build

**Goal.** No source file, manifest, package or document claims or carries the Pear OTA updater.
`--no-updates` is still accepted and does nothing. The npm registry check works as before.
A package without the Pear backend still loses `hyperswarm` and `hyperdht`.

**Requirements & inputs.** `V-1`…`V-4`, `A-3`…`A-7`. Read first: `workers/main.js`,
`electron/updater-available.js`, `electron/main.js` (symbols `CLI_OPTIONS`, `updaterAvailable`,
`hasUpdater`, `updates`, `mainWorkerSpecifier`, `workers`, `getWorker`, the `pear:applyUpdate`,
`pear:startWorker`, `app:afterUpdate` and `pear:worker:*` handlers, the `upgrade`/`version`/
`productName` reads, the `app.info` answer that carries `hasUpdater`), `electron/preload.js`,
`renderer/app.js` (`wireUpdater`, `wireNpmUpdater`, `els.updateBtn`, `state.appInfo`),
`forge.config.js` (`BUILD_BACKENDS`, `plink`, the `readPackageJson` hook), `package.json`,
`engine/package.json`, `engine/spawn-worker.js` and `engine/worker.js` (comments only),
`test/backend-boundary.test.js`, `test/core-boundary.test.js`, `test/build-variants.test.js`,
`test/spawn-worker.test.js`, `test/backends/registry.test.js`, `test/renderer-static.test.js`,
`.github/workflows/build-release.yml`, `.github/workflows/integrate.yml`, `README.md`,
`docs/ARCHITECTURE.md` (§A.2 and the component diagram), `docs/CORE-CONTRACT.md`,
`docs/RELEASE-NPM.md`, `scripts/release-npm.sh` (comment), `docs/decisions.md` (`D-02`, `D-07`).

**Steps.**
1. Delete `workers/main.js` (and the then-empty `workers/`), `electron/updater-available.js`,
   `pear.json`.
2. `electron/main.js`: remove the updater worker machinery listed above and everything only it
   used (check each helper such as `getAppPath`, `FramedStream`, `spawnWorker`, `upgrade` for
   other users before removing). Keep the `--no-updates` entry in `CLI_OPTIONS` with a
   description that says it is accepted for compatibility and has no effect. Keep `detectChannel`,
   `checkForUpdate`, `updateCheckEnabled`, `app.updateCheck`. `app.info` stops reporting
   `hasUpdater`/`updates` only if no renderer code reads them after step 3.
3. `electron/preload.js` and `renderer/app.js`: remove the OTA half. `wireUpdater` becomes the
   npm path only: on the npm channel behave exactly as today, otherwise leave `#update-btn`
   hidden. Remove the bridge members nothing uses any more.
4. `forge.config.js`: `BUILD_BACKENDS.pear = { dependencies: ['hyperswarm', 'hyperdht'], files: [] }`;
   remove `plink`, the `UPGRADE_KEY`/`upgrade` validation, and fix the header comment.
   `pruneDroppedDependencies` and the `packageAfterPrune` hook stay (`V-4`).
5. `package.json`: remove `upgrade`, `"workers/"` from `files`, `workers` from `lint` and
   `format`, and `pear-runtime` and `corestore` from `optionalDependencies` — after confirming with
   a grep that nothing outside `workers/`, `spikes/`, `docs/`, `node_modules/`, `out/`,
   `tabby-plugin/`, `archive/` requires `corestore` or `pear-runtime`. Keep `--no-updates` in
   `scripts.start` (harmless, and proves `V-2`). Then
   `npm install --package-lock-only --ignore-scripts`; if it needs the network and fails, leave
   the lockfile, say so, and record an `S-nn`.
6. Tests: retarget, do not weaken. `test/backend-boundary.test.js`: `SHIPPED_DIRS` loses
   `workers`; the updater-stack test becomes "`pear-runtime`, `pear-link` and `corestore` are
   required by no shipped file, and `hyperswarm` only under `engine/backends/pear/`", plus
   "`workers/main.js`, `electron/updater-available.js` and `pear.json` do not exist".
   `test/core-boundary.test.js`: `CORE_DIRS` is `['engine']`. `test/build-variants.test.js` and
   `test/backends/registry.test.js`: every expectation about `pear-runtime`, `corestore`,
   `/workers/main.js` or `updaterAvailable` follows the new `BUILD_BACKENDS`. Add a test (in
   `test/renderer-static.test.js` or a new `test/no-updater.test.js`) that pins: `electron/main.js`
   has no `pear:applyUpdate`, `pear:startWorker` or `getWorker`; still lists `--no-updates`;
   `package.json` has no `upgrade`; `renderer/app.js` still has `wireNpmUpdater`.
   Name every removed assertion in the handoff.
7. Workflows: in `build-release.yml` remove the `upgrade-key` input and its uses unless the
   reused action marks it required (`A-7`; say which). Fix the `pear-runtime` comment in
   `integrate.yml`.
8. Documents: `docs/decisions.md` gets `D-08` (owner's words from `Q-1`, what it supersedes) and
   dated blockquotes under `D-02` and `D-07`. `docs/register.md`: a row for anything found.
   `README.md`: blockquotes where the OTA updater is described (install/update section, the
   development section, the `ZBTERM_BUILD_BACKENDS` row's note, the `--no-updates` row).
   `docs/ARCHITECTURE.md` §A.2 and diagram, `docs/CORE-CONTRACT.md`, `docs/RELEASE-NPM.md`:
   dated blockquotes. Fix stale code comments in `engine/spawn-worker.js`, `engine/worker.js`,
   `scripts/release-npm.sh` in place (comments are not inherited documents).

**Acceptance.**
- `grep -rnE "require\(['\"](pear-runtime|pear-link|corestore)['\"]\)" --include=*.js electron engine renderer bin scripts forge.config.js test` prints nothing
  that is a real require (test files may name the strings in assertions).
- `ls workers pear.json electron/updater-available.js` fails for all three.
- `node -e "require('./forge.config.js')"` exits 0; `node -e "const p=require('./package.json'); if (p.upgrade||p.optionalDependencies['pear-runtime']||p.optionalDependencies.corestore) process.exit(1)"` exits 0.
- `node --check electron/main.js electron/preload.js renderer/app.js` style syntax checks pass
  (`node --check <file>` per file).
- `npm test` green with a count ≥ baseline minus the named removed assertions plus the new ones;
  `npm run lint` exit 0.
- `ZBTERM_BUILD_BACKENDS=none ZBTERM_FORGE_OUT_DIR=<scratch>/none npx electron-forge package`
  and the default variant into `<scratch>/default` both succeed; neither has `workers/`,
  `pear-runtime` or `corestore` under `resources/app/` outside `tabby-plugin/` and `archive/`;
  `none` has no `hyperswarm`/`hyperdht` in `resources/app/node_modules`, default has both.
  (The default will still carry `pear-runtime` in `node_modules` only if another shipped package
  depends on it; if so, name that package and record an `S-nn` instead of deleting by hand.)

**Verification.** The commands above, output verbatim.

**Gotchas.** `A-6`: the working tree's `node_modules` still contains `pear-runtime`, so
"resolves" proves nothing; tests must scan source. The packager prunes from the **source**
manifest (`S-15`), so after step 5 it should drop `pear-runtime` itself in every variant. Under
Node 24 a `Module._resolveFilename` stub needs `require.cache` eviction (`S-12`). `brittle-node`
runs all test files in one process. Packaging copies ~800 MB (`S-14`); use a scratch dir with
space, outside the repo.

**Re-planning signals.** Something other than the updater requires `pear-runtime` or `corestore`
at run time → stop and report. `build-release.yml`'s reused action requires `upgrade-key` →
keep the input, note it for V3's `open-issues.md`.

### V1
- **Decisions:** `D-08` recorded. `holepunchto/actions/make-pear-app@v1` declares `upgrade_key` `required: false`, so the `upgrade-key` input left `.github/workflows/build-release.yml` (`A-7`). `app.info` never carried `hasUpdater`/`updates`; they left the `[app:channel]` debug line. `--no-updates` stays in `electron/main.js::CLI_OPTIONS` as a no-op. Removed from `electron/main.js` with no other user: `FramedStream`, `spawnWorker`, `upgrade`, `getAppPath`, `getWorker`, `workers`, the three IPC handlers; from `electron/preload.js`: `startWorker`, `applyUpdate`, `appAfterUpdate`, `onWorker*`, `writeWorkerIPC`. `renderer/app.js::wireUpdater` is the npm path only.
- **Gotchas hit:** `npm install --package-lock-only` also rewrote `node_modules/.package-lock.json` (`S-18`, open); no module directory changed; 18 packages are now extraneous in the working tree (`A-6`). `test/spawn-worker.test.js` read files under `node_modules/pear-runtime` and would have failed on a clean install (`S-17`, fixed: retargeted to the helper's own source). The packager prunes from the source manifest (`S-15`), so `pear-runtime` left the default package by itself. Not edited because not listed: `docs/npm-zbterm-plan.md`, `docs/npm-zbterm-handoff.md`, `docs/npm-zbterm_CHANGELOG.md` still mention OTA (retired plans; history).
- **Removed assertions (V-7), all about deleted code:** `test/build-variants.test.js` — the whole test "updaterAvailable: decided by the package record and by resolution, never by a throw" (14), the `pear-runtime`/`corestore` optional-dependency and "resolves" checks (replaced by absence checks), every `/workers/main.js` ignore expectation, "a Pear build keeps the updater (U-4)" (inverted); the prune fixture now uses `hyperswarm → swarm-only`. `test/backend-boundary.test.js` — the updater-stack owner rule and "the host module that owns the updater exists" (replaced by a zero-site rule over more directories, a hyperswarm-only-under-`engine/backends/pear/` rule, and a deleted-files test). `test/spawn-worker.test.js` — the two comparisons against `pear-runtime`'s source. New: `test/no-updater.test.js`.
- **Measured:** 359 tests / 2180 asserts (orchestrator re-run), lint exit 0 with 98 warnings. Packages (reported, not gated): `none` 175 top-level modules, no `hyperswarm`/`hyperdht`; default 190, both present; neither has `workers/`, `pear-runtime`, `corestore` or `pear-link` outside `tabby-plugin/`. Every bare `require` in the default package's `electron/`, `engine/`, `bin/` resolves in its pruned `node_modules` (except `electron` itself and the optional `node-pty` fallback, as before). Repo `out/` untouched.
- **Files touched:** deleted `workers/`, `electron/updater-available.js`, `pear.json`; edited `electron/{main,preload,update-channel}.js`, `renderer/app.js`, `forge.config.js`, `package.json`, `package-lock.json`, comments in `engine/{spawn-worker,worker}.js` and `scripts/release-npm.sh`, both workflows, the four tests above, `README.md`, `docs/{ARCHITECTURE,CORE-CONTRACT,RELEASE-NPM,decisions,register}.md`; added `test/no-updater.test.js`.
- **Next free:** `S-19`, `D-09`. **Suite:** 359 / 2180.

**Verification output (orchestrator re-run).**
```
grep require(pear-runtime|pear-link|corestore): no output, exit 1
ls workers pear.json electron/updater-available.js: No such file or directory (x3)
node -e "require('./forge.config.js')": exit 0;  package.json check: exit 0
node --check electron/main.js, electron/preload.js, renderer/app.js: exit 0
# tests = 359/359 pass
# asserts = 2180/2180 pass
# ok
lint: 98 warnings, exit 0
none package: no workers/pear-runtime/corestore/pear-link; no node_modules/hyperswarm, hyperdht
default package: same find empty; node_modules/hyperswarm and hyperdht present
repo out/: mtime 2026-07-18, untouched
```

---

## Phase V2: Archive the Tabby plugin

**Goal.** `tabby-plugin/` lives at `archive/tabby-plugin/`, its two documents beside it,
an `archive/README.md` explains it, and nothing in the root build, tests, lint or packages
reaches into it.

**Requirements & inputs.** `V-5`…`V-7`, `A-1`, `A-2`. Read first: `tabby-plugin/README.md`,
`docs/tabby-plugin_plan.md` (top only), `forge.config.js::ignoreFile` and
`PACKAGER_DEFAULT_IGNORES`, `test/backends/registry.test.js` (the test that reads
`tabby-plugin/src/main/host.ts`), `test/build-variants.test.js` (the `S-14` fixture),
`README.md`, `docs/CORE-CONTRACT.md`, `docs/ARCHITECTURE.md`, `docs/projects/README.md`,
`.github/workflows/*.yml`, `.gitignore`, `package.json` (`files`, `lint`).

**Steps.**
1. `mkdir archive && mv tabby-plugin archive/tabby-plugin` (plain `mv`, same filesystem; not
   `git mv`). `mkdir archive/tabby-plugin/docs && mv docs/tabby-plugin_plan.md
   docs/tabby-plugin_CHANGELOG.md archive/tabby-plugin/docs/`.
2. `archive/README.md`: what is here, archived 2026-09-19 on the owner's words ("it did not go
   well"), that it was built against the core as of that date and is not built, tested, linted
   or packaged, and that the core seams it used remain (`docs/CORE-CONTRACT.md`).
3. `forge.config.js`: add `/^\/archive($|\/)/` to the ignore list under its own name (it is
   not a packager default), with a test in `test/build-variants.test.js`:
   `ignoreFile('/archive/tabby-plugin/package.json')` is true for every variant. Update that
   file's `S-14` fixture only if it breaks.
4. `test/backends/registry.test.js`: remove the one assertion that reads
   `tabby-plugin/src/main/host.ts` (`V-7`); name it in the handoff. Grep `test/` for any
   other path into the plugin.
5. Every relative link to the two moved documents or to `tabby-plugin/` in `README.md`,
   `docs/*.md` (not under `docs/projects/*/CHANGELOG.md`): add a dated blockquote nearby giving
   the new path and "archived"; in `README.md`'s env table mark the "Tabby plugin" consumer as
   archived with a note under the table. `docs/register.md`: append rows marking `S-16` fixed
   (the plugin's `node_modules` no longer ship) and noting `S-14` is reduced, not closed.
   `docs/projects/README.md`'s preamble mentions flat plans "stay where they are": add a dated
   blockquote naming the two that moved.
6. Workflows and `.gitignore`: fix any path into `tabby-plugin/` (`archive/**/node_modules`
   is already covered by the `node_modules/` rule; check `dist`).

**Acceptance.**
- `ls tabby-plugin docs/tabby-plugin_plan.md` fails; `ls archive/tabby-plugin/src archive/tabby-plugin/docs/tabby-plugin_plan.md archive/README.md` succeeds.
- `grep -rn "tabby-plugin" --include=*.js --include=*.json --include=*.yml electron engine renderer bin scripts test forge.config.js package.json .github` prints only the
  `/archive` ignore test and fixture strings.
- `npm test` green: count = the count before this phase minus the one named assertion plus the
  new ones. `npm run lint` exit 0.
- `node -e "const f=require('./forge.config.js'); if(!f.packagerConfig.ignore('/archive/x')) process.exit(1)"` exits 0.

**Verification.** The commands above, output verbatim. No packaging run is needed here; V3
packages once.

**Gotchas.** The move is a rename of 451 MB including `node_modules`; do not copy. Do not run
anything inside the plugin (`npm run build` there is over). The plugin's `core-resolver` may
reference `../engine` relatively; that is archived code, leave it. `docs/projects/*/CHANGELOG.md`
and retired plans are history: do not edit them.

**Re-planning signals.** Root code `require`s something from `tabby-plugin/` → stop and report.

### V2
- **Decisions:** no `D-nn`. `forge.config.js::ARCHIVE_IGNORE` (`/^\/archive($|\/)/`, anchored at the app root) is its own constant, checked in `ignoreFile`. `README.md` and `docs/*.md` had no relative link to the moved paths, so the dated blockquotes sit beside the prose that describes the plugin as live (`README.md` env table, `docs/CORE-CONTRACT.md` top and `ZBTERM_BACKEND` sentence, `docs/projects/README.md` preamble). The `S-14` fixture in `test/build-variants.test.js` builds its own temporary tree and was left alone.
- **Gotchas hit:** calling `test/build-variants.test.js::withVariant` in a loop stacks teardowns that restore intermediate values and can leak `ZBTERM_BUILD_BACKENDS` into later files (`brittle-node` is one process); the new test calls it once. The plugin's own `.gitignore` moved with it and still covers its `dist` and `node_modules`.
- **Removed assertion (V-7):** `test/backends/registry.test.js`, test "host: the limit reaches the worker as the 4th spawn argument": "the Tabby host reads ZBTERM_BACKEND". New test: "/archive is never packaged, whatever the variant (V-5)" (12 asserts).
- **Measured:** the move was a rename (same inodes; nothing copied or deleted); `archive/` is 451 MB (reported, not gated). 360 tests / 2191 asserts; lint exit 0, 98 warnings. Register: appended rows mark `S-16` fixed and `S-14` "open, reduced".
- **Files touched:** moved `tabby-plugin/` → `archive/tabby-plugin/`, `docs/tabby-plugin_{plan,CHANGELOG}.md` → `archive/tabby-plugin/docs/`; new `archive/README.md`; edited `forge.config.js`, `test/build-variants.test.js`, `test/backends/registry.test.js`, `README.md`, `docs/CORE-CONTRACT.md`, `docs/projects/README.md`, `docs/register.md`.
- **Next free:** `S-19`, `D-09`. **Suite:** 360 / 2191.

**Verification output (orchestrator re-run).**
```
ls tabby-plugin docs/tabby-plugin_plan.md: No such file or directory (x2)
ls archive: README.md tabby-plugin; archive/tabby-plugin/docs: tabby-plugin_CHANGELOG.md tabby-plugin_plan.md
grep tabby-plugin (js/json/yml): only test/build-variants.test.js (the /archive ignore test, the S-14 fixture)
packagerConfig.ignore('/archive/x'): exit 0
# tests = 360/360 pass
# asserts = 2191/2191 pass
# ok
lint: 98 warnings, exit 0
```

---

## Phase V3: Full gate and close-out

**Goal.** One full gate on the final tree, ledgers reconciled, project closed per the exec
template step 7.

**Steps.** `npm test`, `npm run lint`; package `none` and default into a scratch dir and check:
no `workers/`, `archive/`, `tabby-plugin/`, `pear-runtime`, `corestore` under `resources/app`;
`hyperswarm` only in the default. Reconcile `docs/register.md` and `docs/decisions.md` against
the handoff notes. Write `open-issues.md`, the "Closed" paragraph, `status--done.md`, the
`docs/projects/README.md` row, and a follow-on pointer plus lesson in
`../260919_nonpear-no-updater/plan.md`.

**Acceptance.** All of the above hold; `du -sh resources/app` is reported (not gated).

### V3
- **Decisions:** none. Run by the orchestrator. **Gotchas hit:** the first `npm test` of the gate died before any test ran: `brittle`'s glob walker (`globbie`) `lstat`ed a `.git/index.lock` that another process created and removed mid-scan (`ENOENT`); the re-run was green. Recorded in `open-issues.md`, not a test failure. **Measured:** 360 tests / 2191 asserts; lint exit 0, 98 warnings; both packages build; `resources/app` has no `workers/`, `archive/`, `tabby-plugin/`, `pear-runtime` or `corestore` in either, `hyperswarm`/`hyperdht` only in the default; `resources/app` is about 340 MB in both against 794 MB before (reported, not gated), 280 MB of it `spikes/` (`S-14`). Repo `out/` untouched. **Files touched:** this project's close-out files, `docs/projects/README.md`, `../260919_nonpear-no-updater/{plan,open-issues}.md`. **Next free:** `S-19`, `D-09`. **Suite:** 360 / 2191.

**Verification output (orchestrator re-run).**
```
npm test (1st): died in brittle's glob on a vanished .git/index.lock, no test ran; (2nd):
# tests = 360/360 pass
# asserts = 2191/2191 pass
# ok
lint: 98 warnings, exit 0
electron-forge package: none exit 0, default exit 0 (scratch out dirs)
none:    find workers|archive|tabby-plugin|pear-runtime|corestore -> empty; no hyperswarm/hyperdht
default: same find -> empty; /node_modules/hyperswarm, /node_modules/hyperdht
```
