# Non-Pear builds without the OTA updater — plan

**Closed 2026-09-19.** Both phases are retired (see [`CHANGELOG.md`](CHANGELOG.md)). A package
built without the Pear backend has no `hyperswarm`, `hyperdht`, `pear-runtime`,
`pear-runtime-updater` or `corestore` in the app's `node_modules` and no `workers/main.js`; it
runs with updates off. The engine worker is spawned through
`engine/spawn-worker.js::spawnWorker` (`bare-sidecar`) in every build. A Pear build keeps its
updater. Suite: 354 tests / 2132 asserts. `S-13` is fixed. Left open: [`open-issues.md`](open-issues.md).

**Opened 2026-09-19.** Parent: [`../260918_backend-abstraction/`](../260918_backend-abstraction/).
The WHAT is [`requirements.md`](requirements.md). Decision: `D-07`.

**Goal.** A package without the Pear backend ships no `hyperswarm`, `hyperdht`, `pear-runtime`
or `corestore`, runs with updates off, and a Pear build is unchanged. Two phases, `U0`–`U1`.

## Conventions every phase honours

- Repo root: the predecessor repository (frozen at commit `b856e15`). Plain CommonJS, no build step, except
  `tabby-plugin/` (TypeScript, `npm run build`).
- Baseline: 347 tests / 2053 asserts; lint exit 0 with at most 98 `require-await` warnings.
  `test/engine-extend.test.js` has a known intermittent failure (`S-03`): re-run and report both.
- Agent shells need `PATH=$HOME/.local/bin:$HOME/.cargo/bin:$PATH`.
- Ledgers `docs/register.md` (`S-nn`), `docs/decisions.md` (`D-nn`): append-only, next free id
  at landing time.
- Never write into the repo's `out/`; package with `ZBTERM_FORGE_OUT_DIR=<scratch>`.
- GUI only through uisolate with a unique `--storage`; `--ozone-platform=x11` in the `=` form.
  Never `pkill`/`killall` anything: the user runs this session inside ZBTerm.
- Correct inherited documents with dated blockquotes. Do not touch git.

## Phase order

```
U0 implement + verify   first
U1 close-out            last
```

## Out of scope

- Do not change behaviour of a build that has the Pear backend.
- Do not add an update channel. Do not trim package contents (`S-14`).
- Never weaken an assertion or re-bless a count. Do not touch git.

## Handoff notes

### U1
- **Decisions:** none. **Files touched:** this project's close-out files; dated blockquotes in `../260918_backend-abstraction/open-issues.md`, `plan.md` and `status--done.md`; rows in `docs/projects/README.md`. **Next free:** `S-17`, `D-08`. **Suite:** 354 / 2132 (not re-run; documents only).

### U0
- **Decisions:** no `D-nn`. `engine/spawn-worker.js::spawnWorker` spawns through `bare-sidecar` (0.4.5, the copy `pear-runtime` uses); `engine/client.js` and the updater-worker spawn in `electron/main.js` use it. `electron/updater-available.js` is the one host module that owns the updater; when it says no, `getWorker` is never called (the npm-channel path) and one line is logged. `pear-runtime` left `engine/package.json`; in the root it and `corestore` are `optionalDependencies`. `forge.config.js::pruneDroppedDependencies` runs from `packageAfterPrune`, removes the dropped dependencies and what only they needed, and does nothing for the default variant.
- **Gotchas hit:** the plan's gotcha was wrong: `@electron/packager` prunes from the **source** manifest while copying, so Forge does not prune dependencies the hook removed (`S-15`); B7's re-planning signal should have fired for this reason. The acceptance `find` is non-empty only under `tabby-plugin/node_modules`, which ships because of `S-14` (`S-16`); with `-not -path '*/tabby-plugin/*'` it is empty. `--no-updates` today still spawns the updater worker with `updates=false`; a build without the updater spawns none. A `Module._resolveFilename` stub for `bare-sidecar` has no effect (`S-12`); replace the `require.cache` entry. The first-run identity wizard shows `~/.ssh` key paths; dismiss it before any screenshot kept in `docs/`. GUI runs were halted by the orchestrator after the user's ZBTerm died (cause not tied to this work); both uisolate runs had already completed, and the orchestrator read both screenshots.
- **Measured:** 354 tests / 2132 asserts; lint exit 0, 98 warnings; Tabby build compiled. `none` package: no `hyperswarm`, `hyperdht`, `pear-runtime`, `pear-runtime-updater`, `corestore` in the app's `node_modules`, `workers/` empty, 175 top-level modules against 208 in the default; its run shows a live session, no Share/Local/Join, one "updates unavailable" log line, no stack trace. Default package: all modules and `workers/main.js` present; its run shows Share, Local, Join and a live session. Repo `out/` untouched.
- **Files touched:** new `engine/spawn-worker.js`, `electron/updater-available.js`, `test/spawn-worker.test.js`; edited `engine/client.js`, `electron/main.js`, `forge.config.js`, `package.json`, `engine/package.json`, `package-lock.json`, `test/backend-boundary.test.js`, `test/build-variants.test.js`, `test/backends/registry.test.js`, `README.md`, `docs/CORE-CONTRACT.md`, `docs/decisions.md`, `docs/register.md` (`S-13` fixed, `S-15`, `S-16`); `shots/u0-{none,default}.png`.
- **Next free:** `S-17`, `D-08`. **Suite:** 354 / 2132.

## Phase U0: Spawn helper, updater gating, variant pruning — ✅ done (see CHANGELOG)

## Phase U1: Close-out — ✅ done (see CHANGELOG)

> **2026-09-19 — follow-on and lesson.** [`../260919_no-updater-archive-tabby/`](../260919_no-updater-archive-tabby/)
> removed the updater from every build (`D-08`), so `electron/updater-available.js` and the
> "A Pear build keeps its updater" sentence above no longer describe the tree;
> `engine/spawn-worker.js::spawnWorker` stays. Lesson: the scope I took here without asking
> ("only non-Pear builds") cost a whole gating module and 14 assertions that lived for a few
> hours. When an owner says "give it up", ask "everywhere?" before building the conditional.
