# No Pear updater anywhere, Tabby plugin archived — plan

**Closed 2026-09-19.** All four phases are retired (see [`CHANGELOG.md`](CHANGELOG.md)). No build
has the Pear OTA updater (`D-08`): `workers/`, `electron/updater-available.js`, `pear.json`,
`package.json#upgrade`, `pear-runtime` and `corestore` are gone; `--no-updates` is accepted and
does nothing; the npm registry check is unchanged. The Tabby plugin is at
`archive/tabby-plugin/` and packages ignore `/archive`. Suite: 360 tests / 2191 asserts
(pinned by `npm test`). `S-16` and `S-17` fixed, `S-14` reduced, `S-18` open. Left open:
[`open-issues.md`](open-issues.md).

**Opened 2026-09-19.** Follow-on to [`../260919_nonpear-no-updater/`](../260919_nonpear-no-updater/).
The WHAT is [`requirements.md`](requirements.md) (`V-1`…`V-7`); assumptions are
[`QnA_assumptions.md`](QnA_assumptions.md) (`Q-1`, `A-1`…`A-7`). Decision to record in V1: `D-08`
(the Pear OTA updater leaves every build; supersedes the scope sentence of `D-07` and the updater
part of `D-02`).

**Goal.** No build carries the Pear OTA updater; the Tabby plugin sits in `archive/` and is out of
the build, the tests and the packages. Four phases, `V0`–`V3`.

## Conventions every phase honours

- Repo root: the predecessor repository (frozen at commit `b856e15`). Plain CommonJS, Node ≥ 20, no build step.
- Baseline (V0, 2026-09-19): see `baseline.md` beside this plan. `test/engine-extend.test.js`
  has a known intermittent failure (`S-03`): on that red only, re-run once and report both runs.
- Runnable: `npm test`, `npx brittle-node test/<file>`, `npm run lint`. Agent shells need
  `PATH=$HOME/.local/bin:$HOME/.cargo/bin:$PATH`.
- Ledgers `docs/register.md` (`S-nn`) and `docs/decisions.md` (`D-nn`) are append-only. Next
  free at opening: `S-17`, `D-08`; take the next free id at landing time, from the register's tail.
- A number written into a ledger or README is pinned by a named test or marked "reported, not
  gated". Cite symbols (`file::symbol`), never `path:line`.
- The phase that changes a fact updates every ledger row, docstring and comment that claims it.
  Inherited documents are corrected with dated blockquotes, never rewritten.
- **Process safety — the owner runs this session inside a live ZBTerm started from this
  working tree.** Never run `pkill`, `killall`, `kill` by pattern, `fuser -k` or `timeout`-style
  kills on anything named electron, ZBTerm, node, npm, bare or pear. Never touch port 17069 or
  `~/.zbterm-zeev-dev` or any `~/.zbterm*`. Do not run `npm start`, `electron-forge start`,
  or any `npm install`/`npm uninstall`/`npm prune`/`npm ci` that changes `node_modules`
  (`npm install --package-lock-only --ignore-scripts` is allowed). Do not launch the app at all in
  this project: no phase needs a GUI run. Never write into the repo's `out/`; package only with
  `ZBTERM_FORGE_OUT_DIR=<scratch dir outside the repo>`. List every process-launching or
  signalling command you ran in your report.
- Do not touch git (no `git mv`, `add`, `stash`, `checkout`; read-only `git status`/`git diff` is
  fine).

## Phase order

```
V0 baseline                 first (done by the orchestrator)
V1 remove the Pear updater  after V0
V2 archive the Tabby plugin after V0; may swap with V1
V3 gate + close-out         last
```

## Out of scope

- Do not add an update channel for installers. Do not change the npm registry check (`A-4`).
- Do not trim package contents beyond ignoring `/archive` (`S-14` stays open for the rest).
- Do not revert the core/host split or remove any core seam (`A-2`).
- Do not prune the working tree's `node_modules` (`A-6`).
- Never lower a tolerance, weaken an assertion or re-bless a count to get green. An assertion
  about deleted code is removed with the code and named in the handoff (`V-7`).

## Handoff contract and completion protocol

After each phase append 2–5 bullets under `## Handoff notes`: **Decisions**, **Gotchas hit**,
**Measured**, **Files touched**, **Next free** `S-nn`/`D-nn`, suite count. On green the phase
section is cut verbatim into `CHANGELOG.md` with its note and verification output, leaving
`## Phase Vn: <title> — ✅ done (see CHANGELOG)`.

## Handoff notes

### V3
- **Decisions:** none. Run by the orchestrator. **Gotchas hit:** the first `npm test` of the gate died before any test ran: `brittle`'s glob walker (`globbie`) `lstat`ed a `.git/index.lock` that another process created and removed mid-scan (`ENOENT`); the re-run was green. Recorded in `open-issues.md`, not a test failure. **Measured:** 360 tests / 2191 asserts; lint exit 0, 98 warnings; both packages build; `resources/app` has no `workers/`, `archive/`, `tabby-plugin/`, `pear-runtime` or `corestore` in either, `hyperswarm`/`hyperdht` only in the default; `resources/app` is about 340 MB in both against 794 MB before (reported, not gated), 280 MB of it `spikes/` (`S-14`). Repo `out/` untouched. **Files touched:** this project's close-out files, `docs/projects/README.md`, `../260919_nonpear-no-updater/{plan,open-issues}.md`. **Next free:** `S-19`, `D-09`. **Suite:** 360 / 2191.

### V2
- **Decisions:** no `D-nn`. `forge.config.js::ARCHIVE_IGNORE` (`/^\/archive($|\/)/`, anchored at the app root) is its own constant, checked in `ignoreFile`. `README.md` and `docs/*.md` had no relative link to the moved paths, so the dated blockquotes sit beside the prose that describes the plugin as live (`README.md` env table, `docs/CORE-CONTRACT.md` top and `ZBTERM_BACKEND` sentence, `docs/projects/README.md` preamble). The `S-14` fixture in `test/build-variants.test.js` builds its own temporary tree and was left alone.
- **Gotchas hit:** calling `test/build-variants.test.js::withVariant` in a loop stacks teardowns that restore intermediate values and can leak `ZBTERM_BUILD_BACKENDS` into later files (`brittle-node` is one process); the new test calls it once. The plugin's own `.gitignore` moved with it and still covers its `dist` and `node_modules`.
- **Removed assertion (V-7):** `test/backends/registry.test.js`, test "host: the limit reaches the worker as the 4th spawn argument": "the Tabby host reads ZBTERM_BACKEND". New test: "/archive is never packaged, whatever the variant (V-5)" (12 asserts).
- **Measured:** the move was a rename (same inodes; nothing copied or deleted); `archive/` is 451 MB (reported, not gated). 360 tests / 2191 asserts; lint exit 0, 98 warnings. Register: appended rows mark `S-16` fixed and `S-14` "open, reduced".
- **Files touched:** moved `tabby-plugin/` → `archive/tabby-plugin/`, `docs/tabby-plugin_{plan,CHANGELOG}.md` → `archive/tabby-plugin/docs/`; new `archive/README.md`; edited `forge.config.js`, `test/build-variants.test.js`, `test/backends/registry.test.js`, `README.md`, `docs/CORE-CONTRACT.md`, `docs/projects/README.md`, `docs/register.md`.
- **Next free:** `S-19`, `D-09`. **Suite:** 360 / 2191.

### V1
- **Decisions:** `D-08` recorded. `holepunchto/actions/make-pear-app@v1` declares `upgrade_key` `required: false`, so the `upgrade-key` input left `.github/workflows/build-release.yml` (`A-7`). `app.info` never carried `hasUpdater`/`updates`; they left the `[app:channel]` debug line. `--no-updates` stays in `electron/main.js::CLI_OPTIONS` as a no-op. Removed from `electron/main.js` with no other user: `FramedStream`, `spawnWorker`, `upgrade`, `getAppPath`, `getWorker`, `workers`, the three IPC handlers; from `electron/preload.js`: `startWorker`, `applyUpdate`, `appAfterUpdate`, `onWorker*`, `writeWorkerIPC`. `renderer/app.js::wireUpdater` is the npm path only.
- **Gotchas hit:** `npm install --package-lock-only` also rewrote `node_modules/.package-lock.json` (`S-18`, open); no module directory changed; 18 packages are now extraneous in the working tree (`A-6`). `test/spawn-worker.test.js` read files under `node_modules/pear-runtime` and would have failed on a clean install (`S-17`, fixed: retargeted to the helper's own source). The packager prunes from the source manifest (`S-15`), so `pear-runtime` left the default package by itself. Not edited because not listed: `docs/npm-zbterm-plan.md`, `docs/npm-zbterm-handoff.md`, `docs/npm-zbterm_CHANGELOG.md` still mention OTA (retired plans; history).
- **Removed assertions (V-7), all about deleted code:** `test/build-variants.test.js` — the whole test "updaterAvailable: decided by the package record and by resolution, never by a throw" (14), the `pear-runtime`/`corestore` optional-dependency and "resolves" checks (replaced by absence checks), every `/workers/main.js` ignore expectation, "a Pear build keeps the updater (U-4)" (inverted); the prune fixture now uses `hyperswarm → swarm-only`. `test/backend-boundary.test.js` — the updater-stack owner rule and "the host module that owns the updater exists" (replaced by a zero-site rule over more directories, a hyperswarm-only-under-`engine/backends/pear/` rule, and a deleted-files test). `test/spawn-worker.test.js` — the two comparisons against `pear-runtime`'s source. New: `test/no-updater.test.js`.
- **Measured:** 359 tests / 2180 asserts (orchestrator re-run), lint exit 0 with 98 warnings. Packages (reported, not gated): `none` 175 top-level modules, no `hyperswarm`/`hyperdht`; default 190, both present; neither has `workers/`, `pear-runtime`, `corestore` or `pear-link` outside `tabby-plugin/`. Every bare `require` in the default package's `electron/`, `engine/`, `bin/` resolves in its pruned `node_modules` (except `electron` itself and the optional `node-pty` fallback, as before). Repo `out/` untouched.
- **Files touched:** deleted `workers/`, `electron/updater-available.js`, `pear.json`; edited `electron/{main,preload,update-channel}.js`, `renderer/app.js`, `forge.config.js`, `package.json`, `package-lock.json`, comments in `engine/{spawn-worker,worker}.js` and `scripts/release-npm.sh`, both workflows, the four tests above, `README.md`, `docs/{ARCHITECTURE,CORE-CONTRACT,RELEASE-NPM,decisions,register}.md`; added `test/no-updater.test.js`.
- **Next free:** `S-19`, `D-09`. **Suite:** 359 / 2180.

### V0
- **Decisions:** none. Run by the orchestrator (measurement only). **Measured:** 354 tests / 2132 asserts, exit 0; lint exit 0, 98 warnings. **Files touched:** `baseline.md`. **Next free:** `S-17`, `D-08`. **Suite:** 354 / 2132.

## Phase V0: Baseline — ✅ done (see CHANGELOG)

## Phase V1: Remove the Pear OTA updater from every build — ✅ done (see CHANGELOG)

## Phase V2: Archive the Tabby plugin — ✅ done (see CHANGELOG)

## Phase V3: Full gate and close-out — ✅ done (see CHANGELOG)
