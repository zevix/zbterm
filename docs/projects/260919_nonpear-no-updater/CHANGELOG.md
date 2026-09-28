# Non-Pear builds without the OTA updater — changelog

---

## Phase U0: Spawn helper, updater gating, variant pruning

**Goal.** U-1…U-6 hold.

**Requirements & inputs.** `requirements.md`; `engine/client.js::EngineClient._spawnWorker`;
`electron/main.js` (`mainWorkerSpecifier`, `getWorker`, `updates`, `isNpmChannel`);
`workers/main.js`; `forge.config.js` (the B7 `ignore` function and `readPackageJson` hook);
`package.json`, `engine/package.json`; `tabby-plugin/src/main/host.ts`;
`test/backend-boundary.test.js`, `test/build-variants.test.js`, `test/core-boundary.test.js`.

**Steps.**
1. Add `engine/spawn-worker.js::spawnWorker(entrypoint, args, opts)`: `new Sidecar(...)` from
   `bare-sidecar`. Make `bare-sidecar` a direct dependency where `pear-runtime` is one today.
   Use it in `engine/client.js` and for the updater worker spawn; remove the `pear-runtime`
   require from `engine/client.js`.
2. `electron/main.js`: require `pear-runtime` nowhere at top level. Add
   `updaterAvailable()` (resolves `pear-runtime` and `workers/main.js` with
   `require.resolve` in a try, and honours `zbtermBackends`); when false, force
   `updates = false`, log one line, and never call `getWorker`.
3. `forge.config.js`: for a variant without `pear`, also ignore `workers/main.js` and drop
   `pear-runtime`, `corestore` (and `hyperswarm`, `hyperdht`) from the package's dependencies;
   move `pear-runtime` and `corestore` to `optionalDependencies`. Check with `npm ls` which
   other shipped package still needs any of them and report it.
4. Tests: extend `test/backend-boundary.test.js` (U-5) and `test/build-variants.test.js`
   (U-1, U-3 static). Add a unit test for `spawnWorker` with a stubbed `bare-sidecar`.
5. Docs: README and `docs/CORE-CONTRACT.md` (U-6); dated blockquote under `D-02` in
   `docs/decisions.md` pointing at `D-07`; mark `S-13` `fixed 2026-09-19 (D-07)` by appending.

**Acceptance.** Package `none` and the default into scratch. In `none`:
`find <scratch>/none -type d \( -name hyperswarm -o -name hyperdht -o -name pear-runtime -o -name corestore \) -path '*node_modules*'`
is empty, `workers/main.js` is absent, and under uisolate with `--backend none` the app
starts, a session opens and a screenshot shows the terminal; the log has the one
"updates unavailable" line and no stack trace. The default package still contains all four
and `workers/main.js`, and starts under uisolate with updates on (`--no-updates` not passed)
without a new error in its log.

**Verification.** `npm test` ≥ 347 / 2053 green; `npm run lint` exit 0, ≤ 98 warnings;
`tabby-plugin` `npm run build`; the `find` above; both uisolate runs with screenshots copied
to `shots/`.

**Gotchas.** Forge copies the mutated `package.json` before pruning, so removed deps are pruned
by Forge itself. `hypercore` depends on `protomux` and on `@hyperswarm/secret-stream` (a
different package from `hyperswarm`; it stays). CI forbids `--omit=optional`; the default
install must still bring everything in. `engine/` must not require a host module.

**Re-planning signals.** Another shipped package requires `hyperdht` or `corestore`: stop
pruning that one, record an `S-nn`, report. `bare-sidecar` resolves a different version than
`pear-runtime`'s: pin to the version `pear-runtime` uses.

#### Handoff note

### U0
- **Decisions:** no `D-nn`. `engine/spawn-worker.js::spawnWorker` spawns through `bare-sidecar` (0.4.5, the copy `pear-runtime` uses); `engine/client.js` and the updater-worker spawn in `electron/main.js` use it. `electron/updater-available.js` is the one host module that owns the updater; when it says no, `getWorker` is never called (the npm-channel path) and one line is logged. `pear-runtime` left `engine/package.json`; in the root it and `corestore` are `optionalDependencies`. `forge.config.js::pruneDroppedDependencies` runs from `packageAfterPrune`, removes the dropped dependencies and what only they needed, and does nothing for the default variant.
- **Gotchas hit:** the plan's gotcha was wrong: `@electron/packager` prunes from the **source** manifest while copying, so Forge does not prune dependencies the hook removed (`S-15`); B7's re-planning signal should have fired for this reason. The acceptance `find` is non-empty only under `tabby-plugin/node_modules`, which ships because of `S-14` (`S-16`); with `-not -path '*/tabby-plugin/*'` it is empty. `--no-updates` today still spawns the updater worker with `updates=false`; a build without the updater spawns none. A `Module._resolveFilename` stub for `bare-sidecar` has no effect (`S-12`); replace the `require.cache` entry. The first-run identity wizard shows `~/.ssh` key paths; dismiss it before any screenshot kept in `docs/`. GUI runs were halted by the orchestrator after the user's ZBTerm died (cause not tied to this work); both uisolate runs had already completed, and the orchestrator read both screenshots.
- **Measured:** 354 tests / 2132 asserts; lint exit 0, 98 warnings; Tabby build compiled. `none` package: no `hyperswarm`, `hyperdht`, `pear-runtime`, `pear-runtime-updater`, `corestore` in the app's `node_modules`, `workers/` empty, 175 top-level modules against 208 in the default; its run shows a live session, no Share/Local/Join, one "updates unavailable" log line, no stack trace. Default package: all modules and `workers/main.js` present; its run shows Share, Local, Join and a live session. Repo `out/` untouched.
- **Files touched:** new `engine/spawn-worker.js`, `electron/updater-available.js`, `test/spawn-worker.test.js`; edited `engine/client.js`, `electron/main.js`, `forge.config.js`, `package.json`, `engine/package.json`, `package-lock.json`, `test/backend-boundary.test.js`, `test/build-variants.test.js`, `test/backends/registry.test.js`, `README.md`, `docs/CORE-CONTRACT.md`, `docs/decisions.md`, `docs/register.md` (`S-13` fixed, `S-15`, `S-16`); `shots/u0-{none,default}.png`.
- **Next free:** `S-17`, `D-08`. **Suite:** 354 / 2132.

#### Verification output (retired 2026-09-19)

```
$ npm test   (re-run by the orchestrator)
# tests = 354/354 pass
# asserts = 2132/2132 pass
# ok
$ npm run lint
98 warnings   (exit 0)
$ (tabby-plugin) npm run build   (subagent)
tabby-plugin-main (webpack 5.109.2) compiled successfully in 5347 ms
$ find <scratch>/u0-out/none -type d ( -name hyperswarm -o -name hyperdht -o -name pear-runtime -o -name corestore -o -name pear-runtime-updater ) -path '*node_modules*' -not -path '*/tabby-plugin/*'
(empty)      without the -not clause: 4 hits, all under resources/app/tabby-plugin/node_modules (S-16)
$ ls <scratch>/u0-out/none/.../resources/app/workers/
(empty)
$ grep -c "updates unavailable" u0-run-none.log u0-run-default.log
1 / 0
Screenshots: shots/u0-none.png, shots/u0-default.png
```

---

## Phase U1: Close-out

**Goal.** Ledgers and both projects' documents agree with the code.

**Steps.** "Closed" paragraph here; `status--done.md`; rows in `docs/projects/README.md`;
a dated blockquote in `../260918_backend-abstraction/open-issues.md` and `plan.md` saying the
`S-13` exception is resolved by `D-07`; `open-issues.md` here.

**Acceptance / Verification.** `grep -rn "S-13" docs/` shows it fixed everywhere it is called
open. **Gotchas.** None. **Re-planning signals.** None.

#### Verification output (retired 2026-09-19)

```
$ grep -rn "S-13" docs/   -> register row `fixed 2026-09-19 (D-07)`; open-issues.md and plan.md of the parent carry the dated resolution note
```
