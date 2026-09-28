# zbterm-fork — CHANGELOG

Retired phases, cut verbatim from [`plan.md`](plan.md), each with its handoff note and
verification output.

## Z0 — Freeze the predecessor

1. Done by the owner: the pending work is committed on `freenet` as `b337e48`. The doc updates
   that record `D-25`–`D-28` and the baseline are committed on top before the tag. After `Z0`
   the predecessor repo is not touched again (`D-28`).
2. Merge `freenet` into `main` (fast-forward if possible). Tag it locally at its final commit.
3. Baseline: `npm test` count and asserts, `npm run lint`, and the `S-03` flake rule (re-run once,
   report both runs). Write `baseline.md` beside this plan.

Gate: `main` = the predecessor's final commit `b856e15`, suite green, baseline recorded.

### Handoff note

- **Decisions:** none new (`D-25`–`D-28` were recorded with this phase's doc commit).
- **Gotchas hit:** with a long `TMPDIR` the SSH-agent test cannot listen (the socket path passes
  the 108-byte Unix limit, `EINVAL`); every later gate keeps `TMPDIR` short.
- **Measured:** predecessor `main` fast-forwarded to `b856e15`, tagged at that commit
  (annotated); suite 461/461 tests, 2977/2977 asserts, twice; lint exit 0 with 98
  `require-await` warnings.
- **Files touched:** the predecessor's `docs/decisions.md` (`D-25`–`D-28`) and this folder
  (`baseline.md`), committed there as `b856e15`.
- **Next free:** `S-36`, `D-29`. Baseline: 461 tests / 2977 asserts.

### Verification output

From [`baseline.md`](baseline.md), 2026-09-28:

```
npm test (brittle-node, own HOME, short TMPDIR), run 1: # tests = 461/461 pass  # asserts = 2977/2977 pass  exit 0  ≈ 4 min 5 s
npm test, run 2:                                          # tests = 461/461 pass  # asserts = 2977/2977 pass  exit 0  ≈ 4 min 5 s
npm run lint: exit 0, 98 require-await warnings
git rev-parse main <predecessor's final-commit tag> → b856e15… b856e15…
```

## Z1 — Import the tree

> **2026-09-28.** Rewritten before dispatch for the exec template (no git, see the header). The
> resulting tree is the one a planned squash-merge of the predecessor's `main` gives: a trial of
> that merge in a scratch clone on 2026-09-28 conflicted in `README.md`, `electron/main.js`,
> `package.json`, `package-lock.json` and (add/add) the four files of this folder, and otherwise
> differed from the predecessor's final commit only in the paths of step 3 below. The `upstream`
> remote and a remote for the predecessor repository are the owner's to add, if wanted.

**Goal.** zbterm's working tree holds the predecessor's tree at its final commit `b856e15` plus
the template additions listed below, without `archive/` and without the zxterm-core folder;
`docs/decisions.md` holds `D-29` and `D-30`; dependencies are installed and the suite and lint
match the baseline. Nothing is committed.

**Requirements & inputs.**
- `SRC`: the predecessor repository, frozen (`D-28`). Read it only through
  `git -C "$SRC" archive|show|rev-parse` at its final commit; never write there, never run npm
  there. `git -C "$SRC" rev-parse` at its final commit = `b856e15555bad1c98b0b107bbceb917ee83805c1`.
- `DST=/zp/zdata/zeev/github/zbterm`: branch `main` at `931a836c3bdc9271b9f678964e106818fe454711`
  (template history up to `72710d1` plus the owner's commit of this folder). At start,
  `git -C "$DST" status --porcelain` lists only paths under `docs/projects/260928_zbterm-fork/`
  (the coordinator's edits); `node_modules/` does not exist.
- `ad23048` is the common ancestor of the two trees (in `DST`'s history).
- `SCR`: a fresh scratch directory given in the brief. Test `TMPDIR`: `/tmp/zbt-z1`.
- `D-28` (squash, no predecessor history), `D-29`/`D-30` (texts in `QnA_assumptions.md` `Q-8`),
  `D-08` (why `archive/` is dropped).
- Measured 2026-09-28 in a trial: the predecessor's `package-lock.json` already has the entry
  `node_modules/@electron/node-gyp` (transitive, resolved from
  `git+ssh://git@github.com/electron/node-gyp.git#06b29aa…`); `npm install --package-lock-only
  --ignore-scripts` on the merged `package.json` changes only the lock's root package: `+`
  `"@electron/node-gyp"` in `devDependencies`, `−` `"node-datachannel": "0.33.4"` in
  `dependencies` (it is an `optionalDependency` in `package.json`). Global npm config
  `ignore-scripts` is `false`.

**Steps.**
1. Check the preconditions above; stop on any mismatch.
2. `mkdir "$SCR/pf" && git -C "$SRC" archive <the predecessor's final commit> | tar -x -C "$SCR/pf"`. Build the
   result in `"$SCR/result"` as a copy of `"$SCR/pf"` (`cp -a`).
3. Apply, in `"$SCR/result"`:
   a. Remove `archive/` and `docs/projects/260928_zxterm-core/` (the latter lives in
      `zevix/zxterm`, `D-30`).
   b. Replace `docs/projects/260928_zbterm-fork/` with `DST`'s working copy of it, whole.
   c. Copy `AGENTS.md` and `agent_docs/` from `DST`, unchanged (`Z4` merges them).
   d. `.github/workflows/build-release.yml`: `git merge-file -p` with ours = `DST`'s file, base =
      `git -C "$DST" show ad23048:.github/workflows/build-release.yml`, theirs = `pf`'s file.
      It must merge cleanly (exit 0); it adds the template's `node-base-extended` and
      `run-npm-script` steps.
   e. `.npmrc`: keep `pf`'s (`ignore-scripts=false`; the template deleted it, but the
      predecessor's `postinstall` needs scripts). The template's `--ignore-scripts` install path
      is `Z2`'s to weigh.
   f. `package.json`: `pf`'s, plus the template's seven scripts `install:all`, `install:mac`,
      `postinstall:all`, `postinstall:mac`, `install:electron`, `install:macos-alias`,
      `install:fs-xattr` (values from `git -C "$DST" show HEAD:package.json`), appended after
      `build:relay` in that order, and the devDependency `@electron/node-gyp` with the template's
      value, placed in alphabetical order. Written as 2-space JSON with a final newline.
   g. `electron/main.js` and `README.md`: `pf`'s. Save `DST`'s current `README.md` (the
      template's) as `docs/template-README.md` for `Z4`. The template's Windows `AppData/Local`
      change sits in its `getWorker`, which the predecessor does not have: `Z2` checks the
      predecessor's own Windows storage path.
   h. `docs/projects/README.md`: `pf`'s, then: the `260928_zxterm-core/` row links to
      `https://github.com/zevix/zxterm/tree/main/docs/projects/260928_zxterm-core`, says it moved
      there (`D-30`) and runs in parallel with this project (`D-29`) instead of "Starts after";
      the `260928_zbterm-fork/` row gets status `in progress`, "runs in parallel with
      zxterm-core (`D-29`)" instead of "Comes before", and "Next: Z2." instead of "Next: finish
      Z0."; and a dated blockquote under the 2026-09-19 one: "**2026-09-28.** `archive/` was not
      carried into this repository (`Z1` of `260928_zbterm-fork`); the files it held stay
      readable in the predecessor repository, frozen at its final commit `b856e15`."
   i. `docs/decisions.md`: append rows `D-29` and `D-30` after the `D-28` row, `against` =
      ``Q-8 (`projects/260928_zbterm-fork`)``, one line each from `QnA_assumptions.md` `Q-8`
      (`D-29` says it supersedes `D-24`'s order, its "current Pear stack" standing); set
      "Next free id" to `D-31`; append a prose section `## D-29, D-30 (against Q-8 of
      `260928_zbterm-fork`) — two projects in parallel, zxterm in its own repository` quoting the
      owner as `Q-8` does.
4. Tree check (before any install): `diff -rq "$SCR/pf" "$SCR/result"` lists exactly: only in
   `pf`: `archive`, `docs/projects/260928_zxterm-core`, and files of this folder that `DST` no
   longer has (`status--proposal.md`); only in `result`: `AGENTS.md`,
   `agent_docs`, `docs/template-README.md`, and files of this folder that `pf` lacks; differ:
   `.github/workflows/build-release.yml`, `package.json`, `docs/projects/README.md`,
   `docs/decisions.md`, and files of this folder.
5. Sync into `DST`: `rsync -a --delete --exclude=/.git --exclude=/node_modules "$SCR/result/"
   "$DST/"`. The template files the predecessor deleted (`CHANGELOG.md`, `pear.json`,
   `workers/`, `flatpak/com.pears.HelloPear.*`, …) go.
6. In `DST`: `npm install --package-lock-only --ignore-scripts`, then `npm ci`.
7. Run the verification.

**Acceptance criteria.**
- The tree check of step 4 lists exactly the paths named there.
- `diff "$SCR/pf/package-lock.json" "$DST/package-lock.json"` shows only the two root-package
  lines measured above.
- `git -C "$DST" diff --stat HEAD -- docs/projects/260928_zbterm-fork` is empty except the
  coordinator's own edits (the folder came through unchanged).
- `docs/decisions.md` has rows `D-29`, `D-30`, their prose section, and "Next free id: `D-31`".
- `npm run lint` exits 0 with 98 warnings; the suite gives 461/461 tests and 2977/2977 asserts,
  or each difference is named test by test with its cause.
- No git state changed in either repository: `git -C "$DST" rev-parse HEAD` = `931a836…`,
  `git -C "$DST" stash list` and `git -C "$DST" remote` unchanged (`origin` only);
  `git -C "$SRC" status --porcelain` empty.

**Verification.**
```
cd "$DST"
npm run lint 2>&1 | tail -3                       # exit 0, "98 warnings", 0 errors
npm run vendor:assets
mkdir -p /tmp/zbt-z1 "$SCR/home"
HOME="$SCR/home" TMPDIR=/tmp/zbt-z1 ./node_modules/.bin/brittle-node test/*.test.js test/backends/*.test.js 2>&1 | tail -6
                                                  # "# tests = 461/461 pass", "# asserts = 2977/2977 pass"
git -C "$DST" status --porcelain | head -40; git -C "$DST" rev-parse HEAD; git -C "$SRC" status --porcelain
```

**Gotchas.**
- `rsync --delete` into `DST`: the two excludes are mandatory; run it once, from the checked
  `result`.
- `@electron/node-gyp` resolves over `git+ssh` to github.com. The predecessor installed it on
  this machine, so `npm ci` should reach it; if it cannot, stop and report. Do not change the
  specifier (a dependency change needs the owner).
- `npm ci` runs the predecessor's `postinstall` (`bin/lib/postinstall.js`: prunes foreign
  prebuilds, refuses host-Node-linked natives). A refusal there is a red, not something to skip.
- Keep `TMPDIR` short. Nothing in this phase starts the app or a GUI.

**Re-planning signals.**
- Test or assert counts differ from the baseline: the cause (a test reading `archive/`, a
  ledger pin, a template file) goes into the note, and `Z2`'s gate inherits the new count only
  with the owner's sign-off.
- The lock diff is larger than two lines, or `npm ci` needs network access to more than the
  registry and github.com: `Z2`'s module update must start from what was found.
- The merged `build-release.yml` or the template's `install:*` scripts break lint: `Z4` owns
  reconciling CI with the predecessor's workflows.

### Handoff note

- **Z1** (2026-09-28). Decisions: none new; `D-29`/`D-30` landed in `docs/decisions.md` from
  `Q-8`; `.npmrc` kept (the predecessor's `postinstall` needs scripts). Gotchas hit: none in the
  phase; the coordinator's edits to this folder during the run were reverted by the phase's
  `rsync --delete` and re-applied, so never edit this folder while a phase that syncs it runs.
  Measured: tree check and lock diff exactly as predicted (lock: `+@electron/node-gyp`,
  `−node-datachannel` in the root package); `npm ci` reached `@electron/node-gyp` over
  `git+ssh`, `postinstall` passed; suite 461/461, 2977/2977 (subagent run and gate re-run, both
  ≈ 215 s); lint 0 errors, 98 warnings. Files touched: zbterm's whole working tree (uncommitted,
  `HEAD` still `931a836`); at retirement the coordinator added a dated note to `AGENTS.md` (its
  updater statements no longer hold). Next free: `S-36`, `D-31`. Baseline: 461 / 2977.

### Verification output

```
$ npm run lint 2>&1 | tail -1          → 98 warnings   (exit 0, 0 ERROR lines)
$ HOME=<scratch>/g1home TMPDIR=/tmp/zbt-g1 ./node_modules/.bin/brittle-node test/*.test.js test/backends/*.test.js
1..461
# tests = 461/461 pass
# asserts = 2977/2977 pass
# time = 215641.804619ms
# ok
$ diff -rq <predecessor> <zbterm> -x .git -x node_modules   (renderer/vendor = generated, ignored)
only in predecessor: archive, docs/projects/260928_zxterm-core, 260928_zbterm-fork/status--proposal.md
only in zbterm: AGENTS.md, agent_docs, docs/template-README.md, 260928_zbterm-fork/{CHANGELOG.md,status--in-progress.md}
differ: .github/workflows/build-release.yml, docs/decisions.md, docs/projects/README.md, package.json,
        package-lock.json, 260928_zbterm-fork/{QnA_assumptions.md,plan.md,requirements.md}
$ diff <predecessor>/package-lock.json package-lock.json
43d42
<         "node-datachannel": "0.33.4",
57a57
>         "@electron/node-gyp": "git+ssh://git@github.com/electron/node-gyp.git#06b29aafb7708acef8b3669835c8a7857ebc92d2",
$ git -C zbterm rev-parse HEAD → 931a836c3bdc9271b9f678964e106818fe454711 ; git remote → origin ; predecessor status → clean
```

## Z2 — Current Pear stack

> **2026-09-28.** Reshaped before dispatch for the exec template (no git, see the header); the
> steps are the ones first written here, with facts measured on 2026-09-28.

**Goal.** zbterm runs the latest Holepunch modules and `bare-sidecar` 0.5.x, with the Bare
runtime that ships inside it; `hyperbee` stays 2.x; `AGENTS.md` says the template's updater
contracts do not apply; no Pear v3-removed surface is used. The suite, lint, a packaged build
booting with a fresh profile, and the Pear conformance suite on a local `hyperdht` testnet are
all green.

**Requirements & inputs.**
- `DST=/zp/zdata/zeev/github/zbterm`, working tree as `Z1` left it (dependencies installed; see
  the `Z1` handoff note). `SRC` is not read in this phase.
- `D-25` (no updater; keep `bare-sidecar` and `test/no-updater.test.js`), `D-26` (`hyperbee` 2.x),
  `D-08` (why there is no `workers/`, `pear.json` or `package.json#upgrade`).
- Installed → latest on npm, 2026-09-28: `hypercore` 11.33.5 → 11.37.0, `hyperswarm` 4.17.0 →
  4.17.2 and `hyperdht` 6.32.0 → 6.34.0 (both `optionalDependencies`), `protomux` 3.11.0 →
  3.12.1 (transitive), `compact-encoding` 3.3.0 → 3.5.2, `bare-sidecar` 0.4.5 → 0.5.7, `hyperbee`
  2.27.3 (latest). Re-read with `npm view <pkg> version` at landing time.
- The Bare runtime is `bare-sidecar`'s own `prebuilds/<platform>-<arch>/bare` (its
  `package.json#imports["#bare"]`), so it moves with `bare-sidecar`. 0.5.x dropped its `bare-os`
  dependency and moved `bare-module` ^6 → ^7 (`npm view`).
- `engine/spawn-worker.js::spawnWorker` calls `new Sidecar(entrypoint, args, opts)`; list every
  `opts` key the code passes (`grep -rn spawnWorker engine electron`).
- Register rows that name these modules: `S-25` (`bare-sidecar` 0.4.5's `Sidecar` has no
  `_final`, so `EngineClient.close` waits 5 s), `S-28` (option A's virtual peer uses `hypercore`
  internals; "any `hypercore` bump must re-run" `spikes/freenet/p9-virtual-peer.js`), `S-26`/`S-27`
  (node-datachannel, not updated here). Ledger: `docs/register.md`, append-only, next free id on
  its "Next free id" line.
- The template's Windows `AppData/Local` change (`72710d1` `electron/main.js::getWorker`) does
  not apply: the predecessor's storage defaults to Electron's user data dir (`electron/main.js`
  `--storage` help text) and there is no `getWorker`. Nothing changes; record that in `AGENTS.md`'s
  note.
- CLI flags for a test instance (`electron/main.js::CLI_OPTIONS`): `--storage <dir>`,
  `--electron-user-data <dir>`, `--debug-server`, `--debug-server-port <port>` (default 17077;
  always pass one, never 17069/17070), `--no-updates`. `GET /health` on the debug server answers
  once the app is up (`electron/debug-server.js`).
- Packaging: the pre-`Z3` forge-output-dir variable set to `<scratch>/pkg` with
  `npx electron-forge package` writes outside the repo (`forge.config.js`); never write
  `DST/out/`.
- GUI: only `PYTHONPATH=/ubitron/dev python3 -m ubitron.envs.uisolate run --name <n> --new --
  <cmd>` (verbs `start`, `stop`, `screenshot NAME path`, `ls`). Stop sessions with `uisolate stop`,
  never by signal.

**Steps.**
1. Diff `bare-sidecar` 0.4.5 against 0.5.7 (`npm pack` both into scratch, diff `index.js`,
   `lib/`, README). Write down every change that touches the `opts` keys the code passes, the
   IPC pipe, exit/kill semantics and `_final` (`S-25`).
2. In `DST`: `npm install hypercore@^11.37.0 compact-encoding@^3.5.2 bare-sidecar@^0.5.7
   hyperbee@^2.27.3` and `npm install --save-optional hyperswarm@^4.17.2 hyperdht@^6.34.0`, so
   `package.json` keeps each in its section; then check that `protomux` resolved to 3.12.1
   (`npm ls protomux`). No other package is added, removed or bumped on purpose; report what the
   lock moved beyond these.
3. Adapt `engine/spawn-worker.js` (or its callers) only as far as step 1 requires. If
   `S-25` is fixed by 0.5.x, measure `EngineClient.close` again (`scripts/measure-history.js`)
   and append an `S-25` update row; otherwise leave `S-25`.
4. Re-run `node spikes/freenet/p9-virtual-peer.js` (`S-28`); append an `S-28` update row with the
   result on the new `hypercore`.
5. `AGENTS.md`: add one dated blockquote at the top of "Contracts" saying ZBTerm has no OTA
   updater (`D-08`, `D-25`): the six-arg spawn argv, the pipe strings `updating`/`updated`/
   `pear:applyUpdate`/`pear:updateApplied`, `pear.json#multisig`, `package.json#upgrade`, the
   Windows `AppData/Local` store and the "OTA updater does not run in Electron" key fact do not
   apply; the worker is spawned by `engine/spawn-worker.js` through `bare-sidecar`. `Z4` merges
   the rest. Do not rewrite other lines.
6. Search the tree (excluding `node_modules/`, `docs/`) for `global.Pear`, `Pear.config`,
   `Pear.updates`, `Pear.teardown`, `pear run`, `pear sidecar`; expect no hit in code. Report hits.
7. Run the verification.

**Acceptance criteria.**
- `npm ls hypercore hyperswarm hyperdht protomux compact-encoding bare-sidecar hyperbee` shows
  the versions of step 2 (or the latest at landing time), no `invalid`/`missing`.
- Suite 461/461 and 2977/2977 (or the `Z1` note's count if the owner signed a change), lint exit 0
  with the baseline's warning count; a new warning or failing id is a red.
- The packaged app boots under uisolate with fresh `HOME`, `--storage`, `--electron-user-data`
  in scratch and its own debug port: `GET /health` answers ok, and the worker is up (no
  `engine:error` in the app log).
- `test/backends/conformance-pear.test.js` (a local `hyperdht` testnet) passes on its own.
- `AGENTS.md` carries the note; register rows for `S-25`/`S-28` as steps 3–4 say; no git state
  changed (`git -C "$DST" rev-parse HEAD` unchanged, `git -C "$DST" stash list` empty).

**Verification.**
```
cd "$DST"
npm ls hypercore hyperswarm hyperdht protomux compact-encoding bare-sidecar hyperbee
npm run lint 2>&1 | tail -3
npm run vendor:assets
HOME="$SCR/home" TMPDIR=/tmp/zbt-z2 ./node_modules/.bin/brittle-node test/*.test.js test/backends/*.test.js 2>&1 | tail -6
HOME="$SCR/home" TMPDIR=/tmp/zbt-z2 ./node_modules/.bin/brittle-node test/backends/conformance-pear.test.js 2>&1 | tail -4
<the pre-Z3 forge-output-dir variable>="$SCR/pkg" npx electron-forge package 2>&1 | tail -3
# boot: uisolate run --name zbt-z2 --new -- env HOME="$SCR/home" <pkg>/<App>-linux-x64/<binary> \
#   --storage "$SCR/s" --electron-user-data "$SCR/u" --debug-server --debug-server-port 17191 --no-updates
curl -s http://127.0.0.1:17191/health
```

**Gotchas.**
- `npm install` only for the packages named in step 2; never in `SRC`; never `npm audit fix`.
- `bare-sidecar` 0.x minors may change spawn options; step 1 comes before any upgrade.
- The packaged worker resolves modules differently from dev (`AGENTS.md`): a pass under
  `brittle-node` does not prove the packaged worker boots; the `Z2` gate needs both.
- Keep `TMPDIR` short; start the app only through uisolate and stop it with `uisolate stop`.

**Re-planning signals.**
- `bare-sidecar` 0.5 changes spawn or exit semantics the engine relies on: the fix is this
  phase's, but if it needs more than `engine/spawn-worker.js` and `engine/client.js`, stop and
  report.
- `p9-virtual-peer.js` fails on the new `hypercore`: `S-28`'s option A is no longer proven;
  record it, do not pin `hypercore` back without the owner.
- Any new `require-await` or other lint warning, or a changed test count: `Z3` inherits it only
  with the owner's sign-off.

### Handoff note

- **Z2** (2026-09-28). Decisions: none new. Gotchas hit: `bare-sidecar` 0.5.7 has no `_final`
  either, so `S-25` stands (a SIGTERM'd app takes ≈ 15–40 s to exit); a targeted `npm install`
  left `protomux` at 3.11.0 until `npm update protomux` (re-dispatch); `engine/package.json` (the
  core's own manifest) must carry the root's ranges, and `test/spawn-worker.test.js` pins the
  `bare-sidecar` one; under uisolate the app needs `--ozone-platform=x11` (with `=`), and
  `/health` says `ok: false` for the renderer ("WebGL2 not supported", the predecessor's known
  uisolate limit), so boot proof is `engineReady: true` plus no `engine:error`; `uisolate stop`
  left the app running twice, so stop it by its exact PID after checking its command line
  carries the scratch path. Measured: `hypercore` 11.37.0, `hyperswarm` 4.17.2, `hyperdht`
  6.34.0, `protomux` 3.12.1, `compact-encoding` 3.5.2, `bare-sidecar` 0.5.7 (bundled Bare 1.27.0 →
  1.34.0), `hyperbee` 2.27.3; `p9-virtual-peer.js` still "A works" (`S-28` row); v3-removed
  surface: only the guarded `globalThis.Pear.teardown` fallback in `engine/worker.js` and a test
  fixture; suite 461/461, 2977/2977 (subagent: one red fixed, one crash filed as `S-36`, then
  green twice; gate re-run green); `conformance-pear` 15 tests, 107 asserts; lint 98 warnings;
  packaged build boots with a fresh profile. Files touched: `package.json`,
  `package-lock.json`, `engine/package.json`, `AGENTS.md`, `docs/register.md` (`S-28` update,
  `S-36`). Next free: `S-37`, `D-31`. Baseline: 461 / 2977.

### Verification output

```
$ npm ls hypercore hyperswarm hyperdht protomux compact-encoding bare-sidecar hyperbee   (top level)
├── bare-sidecar@0.5.7   ├── compact-encoding@3.5.2   ├── hyperbee@2.27.3   ├─┬ hypercore@11.37.0
│ └── protomux@3.12.1 deduped   ├─┬ hyperdht@6.34.0   ├─┬ hyperswarm@4.17.2   (blind-relay → protomux@3.12.1)
$ npm run lint 2>&1 | tail -1 → 98 warnings (exit 0)
$ full suite (gate re-run): # tests = 461/461 pass  # asserts = 2977/2977 pass  # time = 215307ms  # ok
$ brittle-node test/backends/conformance-pear.test.js → # ok (107/107 asserts, local hyperdht testnet)
$ <the pre-Z3 forge-output-dir variable>=<scratch>/pkg npx electron-forge package → ✔ Running postPackage hook (exit 0); repo out/ absent
$ uisolate run --name zbt-g2 --new -- env HOME=<scratch> <pkg>/<the pre-Z3 packaged binary> --ozone-platform=x11 --storage <scratch> \
    --electron-user-data <scratch> --debug-server --debug-server-port 17193 --no-updates
$ curl -s http://127.0.0.1:17193/health → {"ok":false,"engineReady":true,"renderer":{"ok":false,"reason":"WebGL2 not supported …"}}
  app log: one engine:ready, no engine:error; screenshot shows the main window and the identity dialog ("No SSH keys found")
```

## Z3 — Rename

> **2026-09-28.** Reshaped before dispatch for the exec template (no git, see the header). "One
> commit each" becomes "one category at a time, each ending green"; the owner may commit between
> categories. The name test reads the working tree, not `git grep`: most of the tree is still
> untracked, and `git grep` searches tracked files only.

> **2026-09-28, after `Z2`.** Boot proof under uisolate is `engineReady: true` in `/health` plus
> no `engine:error` in the app log (the renderer reports "WebGL2 not supported" there; `Z2` note);
> the app needs `--ozone-platform=x11`; if `uisolate stop` leaves the app running, stop it by its
> exact PID after checking that its command line carries the scratch path, and wait up to 60 s
> (`S-25`). `engine/package.json`'s own name, description and URLs are part of category `b`.
> Next free: `S-37`, `D-31`.

**Goal.** Every file of zbterm outside the two exempt paths calls the product ZBTerm: names,
paths, variables, storage, link scheme, wire and signature strings, UI and docs, historical
records included (`D-27`). A test pins it. Behaviour does not change except for the names.

**Requirements & inputs.**
- `DST=/zp/zdata/zeev/github/zbterm`, working tree as `Z2` left it (see its handoff note).
  `SRC` is not read.
- `D-27` (no old name anywhere, records included), `D-23` (no compatibility: old invites, claims,
  profiles need not work), `D-10` (contracts ship as committed `.wasm`, BLAKE3-pinned), `A-2`
  (author and logo art are the owner's), `A-3` (`hetzner-deb16` is not touched).
- Exempt until `Z5`: `scripts/rename-to-zbterm.js` and `docs/projects/260928_zbterm-fork/`.
- Measured 2026-09-28 (after `Z1`): the former name, in any case, on 1 880 lines outside
  `node_modules/`, `.git/`, `renderer/vendor/`; commonest forms: the bare name 488 times, its
  capitalized form 330, its `.js` filename 84, its `.desktop` filename 71, its link-scheme prefix
  36, its `_BUILD_BACKENDS` environment variable 36, its `/ctl` wire domain 31, its `_BACKEND`
  environment variable 28, and camelCase identifiers built from it. Files named for it: the
  executable, the flatpak manifests, the npm plan/handoff docs and the npm CHANGELOG. Binary
  hits: `engine/backends/freenet/contracts/{signalling,pointer}-v1.wasm` (their domain strings).
- Contracts: crates `engine/backends/freenet/contracts/src/{signalling,pointer}/` (package names
  before this phase, renamed by it to `zbterm-signalling`, `zbterm-pointer`; `const DOMAIN` in
  each `src/lib.rs`), built by `scripts/build-contracts.sh` (copied
  `target/wasm32-unknown-unknown/release/<old-name>_<name>.wasm`, renamed to `zbterm_<name>.wasm`;
  writes `contracts/hashes.json`; needs `cargo` 1.95.0, target `wasm32-unknown-unknown`,
  `~/.local/bin/fdev`, all present 2026-09-28), fixtures by `scripts/contract-fixtures.js`, pin
  test `test/backends/freenet-contracts.test.js`.
- Name mapping, case kept: every case-variant of the former name (all caps, capitalized, and
  lower case) became the matching case-variant of `zbterm` (also inside identifiers, e.g. a
  `Backends` suffix).
- Not mechanical (write each by hand, listed in the note):
  - References to the predecessor repository (its local path, `github.com/zevix/…` where it
    means the old repo, its final-commit tag, and `archive/tabby-…` paths, which exist only
    there) become "the predecessor repository", with its final commit `b856e15` where a revision
    matters. Package URLs (`repository`, `bugs`, `homepage`, forge `website`/`issues`) become
    `zevix/zbterm`.
  - Sentences whose subject is the name itself (the rows and prose of `D-21`–`D-30` in
    `docs/decisions.md`, the owner's quotes there, "ZBTerm (the former name, renamed, …)" in
    `docs/projects/README.md`) say "the former name" instead, so they still make sense.
  - `forge.config.js`'s contact address changed to `zbterm@1zk.net` (`A-4`: the owner confirms
    that address).
  - `build/AppxManifest.xml`: `Identity Name`, `DisplayName` and `Executable` change;
    `Publisher="CN=z33v.net"` does not (it must match the signing certificate).
  - `package.json#author` stays (`A-2`).
- Contract versions (`A-5`): the rebuilt contracts keep the file names `signalling-v1.wasm`,
  `pointer-v1.wasm`; no ZBTerm link was ever made, so there is no key to keep (`D-23`). The pin
  test's comment says a moved contract is a new `-v2`: add a dated line there citing `A-5`; the
  assertion itself does not change.

**Steps.**
1. Write `scripts/rename-to-zbterm.js`: `node scripts/rename-to-zbterm.js <category> [--dry]`
   applies one category of the table below to the working tree (file list from `git ls-files
   -co --exclude-standard`, minus the exempt paths and binary files), prints each file and count
   changed; `--dry` changes nothing. `node scripts/rename-to-zbterm.js --report` prints the
   remaining hits per file.
2. For each category in order: dry run, apply, then lint and the full suite (and the category's
   extra check); on a red, fix within the category before the next one. Record per category the
   files and lines changed and the suite result.

   | # | category | scope | extra check |
   |---|---|---|---|
   | a | files | the six files named above renamed (`bin/zbterm.js`, `flatpak/net.z33v.zbterm.*`, `docs/npm-zbterm-*`), and every reference to their paths | `node bin/zbterm.js --help` runs |
   | b | package metadata | `name` `zbterm`, `productName` `ZBTerm`, `bin` `zbterm`; `engine/package.json` `zbterm-core`; URLs → `zevix/zbterm`; forge `appId`, flatpak ids `net.z33v.zbterm`; AppxManifest as above; CI artifact and tarball names (`.github/workflows/*.yml`) | `npm run pack:check` if it runs offline, else reported |
   | c | variables | every old environment-variable prefix → `ZBTERM_*`, no aliases | none |
   | d | storage | `~/.zbterm-<profile>`, `zbterm-profiles`, `zbterm-dev`, log and temp names, `electron/pty-scope.js` scope names, `zbterm.desktop` | none |
   | e | links | the old link scheme → `zbterm://`, desktop registration included | none |
   | f | wire and signatures | SSHSIG namespace `zbterm-identity`, `zbterm-identity-claim/v1`, `zbterm-identity-challenge/v1`, `zbterm/fnet-signal/1`, `zbterm/fnet-payload/1`, `zbterm/fnet-pointer/1`, `zbterm/fnet-bootstrap`, `zbterm/history`, `zbterm/ctl`, and every string a topic or key is derived from; crates `zbterm-signalling`/`zbterm-pointer`, `DOMAIN` consts, the build script's `zbterm_<name>.wasm`; then `bash scripts/build-contracts.sh` (its `fdev get-contract-id` and `verify-merge` checks must pass) and `node scripts/contract-fixtures.js` if the fixtures embed the domain | `test/backends/freenet-contracts.test.js` green with the new pins; report old and new BLAKE3 and sizes |
   | g | code and UI | remaining identifiers, window titles, menus, dialogs, CLI help, `scripts/logo.js` (a text logo "ZBTerm"; art is the owner's, `A-2`) | none |
   | h | docs | every `.md` outside the exempt folder, living and historical, with the hand-written cases above | every relative link in `docs/` still resolves (write a small check) |
   | i | infra | `scripts/infra/freenet_host.py` remote paths and unit names, `relay/` service names; nothing is run against `hetzner-deb16` (`A-3`) | `python3 -m py_compile scripts/infra/freenet_host.py` |

3. Write `test/name.test.js`: lists files with `git ls-files -co --exclude-standard` (read-only),
   reads each (binary included), and fails naming every file outside the exempt paths whose
   bytes match the former name, case-insensitively. It must fail if a hit is planted outside them
   (check once by hand, then remove the plant).
4. Run the verification.

**Acceptance criteria.**
- `node scripts/rename-to-zbterm.js --report` prints no hit outside the exempt paths;
  `test/name.test.js` is green and fails on a planted hit.
- Suite: the `Z2` count plus the name test (462 tests if `Z2` held 461); assert count reported;
  lint exit 0 with the baseline warning count.
- The contracts are rebuilt reproducibly: a second `bash scripts/build-contracts.sh` gives the
  same `hashes.json`.
- The packaged app boots under uisolate with a fresh profile and shows ZBTerm wherever the UI
  names the product (window title, about/credits, CLI `--help`); a screenshot is kept in
  scratch, not in the repo.
- No git state changed (`git -C "$DST" rev-parse HEAD` unchanged, `stash list` empty).

**Verification.**
```
cd "$DST"
node scripts/rename-to-zbterm.js --report | tail -3
npm run lint 2>&1 | tail -1
npm run vendor:assets
HOME="$SCR/home" TMPDIR=/tmp/zbt-z3 ./node_modules/.bin/brittle-node test/*.test.js test/backends/*.test.js 2>&1 | tail -6
# after category f: cp engine/backends/freenet/contracts/hashes.json "$SCR/hashes-1.json"; then:
bash scripts/build-contracts.sh && diff "$SCR/hashes-1.json" engine/backends/freenet/contracts/hashes.json && echo reproducible
ZBTERM_FORGE_OUT_DIR="$SCR/pkg" npx electron-forge package 2>&1 | tail -3
# boot under uisolate as in Z2 (fresh HOME/--storage/--electron-user-data in $SCR, --debug-server-port 17192, --no-updates)
curl -s http://127.0.0.1:17192/health
```

**Gotchas.**
- Replace longest tokens first and keep case; a blind substitution of the old name inside the
  predecessor references and name-as-subject sentences is wrong (see the hand-written list).
- After `c`, the forge out-dir variable is `ZBTERM_FORGE_OUT_DIR`; the pre-`Z3` one is ignored and
  packaging would write `DST/out/`.
- Profile and storage dirs change in `d`: test instances must still get scratch `HOME` and
  `--storage`, and nothing may read or write the owner's predecessor profile directories.
- The contract rebuild writes `target/` dirs inside the crates; they are gitignored, leave them.
- Keep `TMPDIR` short; any GUI through uisolate, stopped with `uisolate stop`.

**Re-planning signals.**
- A test pins an old-name string on purpose (a fixture from a real predecessor invite or
  claim): stop and report; `Z4` stores such fixtures encoded.
- `build-contracts.sh` is not reproducible on this machine, or `fdev` checks fail: stop; `D-10`
  needs the owner.
- The suite count moves by more than the name test: name each difference.

### Handoff note

- **Z3** (2026-09-28). Decisions: none new (`A-4`, `A-5` taken before dispatch). Gotchas hit:
  categories do not split the tree cleanly. A test that greps a producer's strings
  (`test/renderer-static.test.js`, `test/backends/registry.test.js`, `test/build-variants.test.js`,
  `test/identity-claim.test.js`, `test/backends/freenet-backend.test.js`) went red until moved
  with its producer. `bin/lib/doctor.js` hard-codes its own `PRODUCT_NAME`. Three files join
  `'bin'`, `'<name>.js'` as separate path segments, and `scripts/npm-pack-check.sh` escapes the
  dot in a regex. `test/share-manager-seam.test.js`'s `GOLDEN_CHALLENGE_SIGNATURE` was
  recomputed, because the signed magic changed. `archive/tabby-*` paths now read
  `archive/tabby-plugin/`. `docs/npm-zbterm-plan.md` already said "renamed from X to X" before
  `Z3`, noted in a dated blockquote. `S-36` recurred once, then green. `uisolate stop` again left
  the app running; it was stopped by its exact PID. Measured: contracts rebuilt reproducibly,
  new pins `signalling-v1` `ec7f3c12…` (240 972 B), `pointer-v1` `f9c348bf…` (187 368 B), and
  `fdev` id and merge checks passed. Contract fixtures were regenerated. Suite 462/462,
  2979/2979 (the name test is new; gate re-run green). Lint 98 warnings. The packaged
  `ZBTerm-linux-x64/ZBTerm` boots with `engineReady: true` and shows "ZBT…" in the header.
  `bin/zbterm.js --help` prints `Usage: ZBTerm`. Files touched: 327 across the tree; new
  `scripts/rename-to-zbterm.js` and `test/name.test.js`. The coordinator corrected one sentence
  of the dated note in `docs/npm-zbterm_CHANGELOG.md`. Next free: `S-37`, `D-31`. Baseline:
  462 / 2979.

### Verification output

```
$ git ls-files -co --exclude-standard -z | xargs -0 grep -il "$(printf 'p%sterm' ear)" | grep -v <exempt>   → (nothing)
$ node scripts/rename-to-zbterm.js --report | tail -2   → total hits: 0 / no hit outside the exempt paths
$ npm run lint 2>&1 | tail -1   → 98 warnings (exit 0)
$ full suite (gate re-run): # tests = 462/462 pass  # asserts = 2979/2979 pass  # time = 215435ms  # ok
$ bash scripts/build-contracts.sh; diff <hashes before> hashes.json   → reproducible (exit 0)
$ ZBTERM_FORGE_OUT_DIR=<scratch>/pkg npx electron-forge package   → exit 0, <scratch>/pkg/ZBTerm-linux-x64; repo out/ absent
$ curl -s http://127.0.0.1:17194/health   → {"ok":false,"engineReady":true,"renderer":{"ok":false,"reason":"WebGL2 not supported …"}}
  app log: engine:ready 1, engine:error 0; screenshot: header "ZBT…", identity dialog, "ready"
name test planted-hit check (subagent): README.md plant → not ok 1; plant removed → green
```

## Z4 — Clean-break checks and docs

> **2026-09-28.** Reshaped before dispatch for the exec template (no git, see the header).
> The steps are the ones first written here. Former-name fixtures are made from the pre-`Z3`
> snapshot, not from the predecessor repository. The "old peer" join is a scratch probe,
> reported and not gated, because old code cannot live in the tree (`test/name.test.js`).

> **2026-09-28, after `Z3`.** Baseline 462 / 2979. `S-36` (an `fd-lock` crash in
> `test/engine-attach.test.js`) is a known one-off, like `S-03`: re-run once and report both.
> The package is `<scratch>/pkg/ZBTerm-linux-x64/ZBTerm`, packaged with `ZBTERM_FORGE_OUT_DIR`.
> Next free: `S-37`, `D-31`.

**Goal.** Tests prove that ZBTerm refuses an invite and a signed claim made under the former
name, and that it says why. Two ZBTerms share over Pear and over Freenet on local networks.
`AGENTS.md`, `agent_docs/` and `README.md` describe ZBTerm, not the template or the predecessor.
Every citation into the predecessor repository says so. zxterm's links into this repo resolve.

**Requirements & inputs.**
- `DST=/zp/zdata/zeev/github/zbterm`, working tree as `Z3` left it (see its handoff note). The
  pre-`Z3` tree snapshot (`<scratch>/z3/pre-z3-tree.tgz`, given in the brief) holds the code as
  it was under the former name.
- `Z-4` in `requirements.md`: an invite from the predecessor given to ZBTerm is refused, with a
  message that says so, within the join timeout; it never hangs. `D-23` (no compatibility),
  `D-28` (commit hashes cited in docs point into the predecessor repository, final commit
  `b856e15`).
- Code: `engine/invite.js::decodeLink` (throws `E_AUTH` "Invalid ZBTerm invite" for any URI
  without `LINK_PREFIX`), `engine/share-manager.js::join` (calls `decodeLink` first),
  `engine/identity/claim.js` (`NAMESPACE`, `CLAIM_MAGIC`, `CHALLENGE_MAGIC`; SSHSIG verify in
  `engine/identity/verify.js`).
- Local networks: `test/backends/conformance-pear.test.js` (a `hyperdht` testnet) and
  `test/backends/conformance-freenet.test.js` (a throwaway local-mode node from
  `test/helpers/freenet-node.js`; it *skips* when no `freenet` binary is on `PATH`, and a skip
  is a red here).
- Docs: the template's `AGENTS.md` (with the dated notes of `Z1`/`Z2` at its top and in
  "Contracts"), `agent_docs/{architecture,updates,packaging,releases}.md`,
  `docs/template-README.md` (the template's README, kept by `Z1`), the app's `README.md`,
  `docs/projects/README.md` (project layout rules), and the process-safety rules in this plan's
  conventions.
- zxterm's docs link here as `https://github.com/zevix/zbterm/{blob,tree}/main/<path>` (files in
  `/zp/zdata/zeev/github/zxterm/docs/`, read only); the paths they name, measured 2026-09-28:
  `docs/decisions.md`, `docs/ARCHITECTURE.md`, `docs/identity-providers_plan.md`,
  `docs/projects/260918_backend-abstraction/freenet-backend-design.md`,
  `docs/projects/260924_freenet-backend/`, `docs/projects/260928_zbterm-fork/`.

**Steps.**
1. Fixtures: extract the snapshot into scratch, point its `node_modules` at `DST`'s (a symlink
   in scratch), and write with the old code a Pear invite, a Freenet invite and an identity
   claim signed with a throwaway test SSH key (made in scratch, never the owner's). Store them
   in `test/fixtures/former-name/` as hex (or base64), with a `README.md` saying how they were
   made. The name test must stay green, so no raw former-name bytes.
2. `test/former-name.test.js`: decoding each invite (`decodeLink`) and `ShareManager.join` on it
   fail at once (well under `JOIN_TIMEOUT_MS`) with `E_AUTH` and a message that names the cause.
   If today's text does not say it is not a ZBTerm link, change `decodeLink`'s message to say so,
   quoting the scheme it got. That is the only behaviour change. The claim does not verify under
   ZBTerm's namespace, and the error says why.
3. Scratch probe, reported and not gated: a host started from the snapshot's engine and a
   ZBTerm viewer on one local `hyperdht` testnet; the viewer is given the host's invite with its
   scheme rewritten to `zbterm://join/`. Record whether the join ends, how, and after how long.
   If it hangs past `JOIN_TIMEOUT_MS`, that is a re-planning signal.
4. Run both conformance files on their own and report both, with the Freenet one not skipped.
5. Docs:
   - `AGENTS.md` becomes ZBTerm's: what it is, commands (`npm test` with its own `HOME` and a
     short `TMPDIR`, lint, package with `ZBTERM_FORGE_OUT_DIR`), the real contracts (the
     Bare-worker spawn in `engine/spawn-worker.js`, the `package.json#imports` Bare map, the
     `BACKEND_*` frames, the contract pins of `D-10`, `productName` ↔ AppxManifest ↔ artifacts ↔
     storage dirs), the boundaries (process safety as in this plan's conventions, the ledgers
     and `docs/projects/` layout, "never publish"), and routing to `agent_docs/`. Drop what does
     not apply (the updater, `pear.json`, the forge upgrade gate), with no dated blockquotes
     left behind: this is the merge.
   - `agent_docs/*.md`: fix each statement that is false for ZBTerm. `updates.md` becomes a short
     note that there is no updater (`D-08`, `D-25`), or goes, with the routing line updated.
   - `README.md`: the app's README, with anything useful from `docs/template-README.md`
     (building, signing, Flatpak); then delete `docs/template-README.md`.
   - Every commit hash in `docs/` that points into the predecessor's history says "in the
     predecessor repository". Find them with a hex-hash scan and check each with `git -C
     <the predecessor repository> cat-file -e <hash>` (read only).
6. Check that every path zxterm's docs name exists in `DST`.
7. Run the verification.

**Acceptance criteria.**
- `test/former-name.test.js` is green, and fails if `LINK_PREFIX` or `NAMESPACE` is set back
  (check once by hand, then revert).
- Suite: the `Z3` count plus the new tests, all green. Lint: exit 0 with the baseline's warning
  count. Name test green.
- The conformance files: Pear 15 tests green; Freenet run, not skipped, green.
- `AGENTS.md` and `agent_docs/` say nothing false about the updater, `workers/`, `pear.json` or
  `pear-runtime`. A grep for those words lists only statements that they are absent.
- Every relative link in `AGENTS.md`, `README.md`, `agent_docs/` and `docs/` resolves. Every
  `D-nn` and `S-nn` cited in the living docs exists in the ledgers.
- The probe result is recorded in the handoff note. No git state changed.

**Verification.**
```
cd "$DST"
HOME="$SCR/home" TMPDIR=/tmp/zbt-z4 ./node_modules/.bin/brittle-node test/former-name.test.js 2>&1 | tail -4
HOME="$SCR/home" TMPDIR=/tmp/zbt-z4 ./node_modules/.bin/brittle-node test/backends/conformance-pear.test.js 2>&1 | tail -3
HOME="$SCR/home" TMPDIR=/tmp/zbt-z4 ./node_modules/.bin/brittle-node test/backends/conformance-freenet.test.js 2>&1 | grep -c "skip"; … | tail -3
npm run lint 2>&1 | tail -1
npm run vendor:assets
HOME="$SCR/home" TMPDIR=/tmp/zbt-z4 ./node_modules/.bin/brittle-node test/*.test.js test/backends/*.test.js 2>&1 | tail -6
node <scratch>/check-links.js   # relative links + D-nn/S-nn citations + zxterm paths; prints "0 broken"
```

**Gotchas.**
- The fixture maker runs old code: give it a scratch `HOME` and storage. It must never touch
  the owner's predecessor profile directories or SSH keys. Make a throwaway key with
  `ssh-keygen -f <scratch>/k -N ''`.
- The probe's old host uses the old protocol names; start both on a testnet, not the public
  DHT. Signal only PIDs this phase started.
- `docs/projects/260928_zbterm-fork/` is edited by the coordinator only.

**Re-planning signals.**
- A former-name invite with its scheme rewritten makes a ZBTerm join hang past the join
  timeout: `Z-4` is not met. Report it; the fix (a protocol-version check at the handshake) is
  a behaviour change that needs the owner.
- The Freenet conformance file skips (no `freenet` binary): stop; the gate needs the owner.

### Handoff note

- **Z4** (2026-09-28). Decisions: none new. `decodeLink`'s message now names the cause and
  quotes the scheme it got; this is the phase's one behaviour change. Gotchas hit:
  `ShareManager.join` resolves at once with `connecting`, and the outcome arrives later as a
  `join:changed` event. The name test scans untracked files too, so the fixture maker stays in
  scratch and the fixtures are hex; `claim-message.hex` keeps the signed bytes, so that a
  reverted `NAMESPACE` is not hidden behind the `CLAIM_MAGIC` change. Links into `archive/` and
  into the moved zxterm-core folder got dated notes. At the gate the coordinator fixed two slips
  in the merged `AGENTS.md`: a wrong `D-06` citation, and the lint command described as
  `prettier --check .`. Measured: the probe (a rewritten-scheme predecessor invite) ended at
  30 002 ms at the join timeout, with a generic message; filed as `S-37`. Suite 469/469,
  3002/3002 (the subagent's run and the gate re-run). `test/former-name.test.js` 7 tests, 23
  asserts, and it goes red when `LINK_PREFIX` is reverted (checked at the gate). Conformance: Pear
  15 tests, 107 asserts; Freenet 15 tests, 105 asserts, not skipped (`freenet` 0.2.139). Lint 98
  warnings. The link check found 0 broken links (4 known, dated-noted); zxterm's 6 paths exist.
  Files touched: `engine/invite.js`, `test/former-name.test.js`, `test/fixtures/former-name/`,
  `AGENTS.md`, `agent_docs/*.md`, `README.md`, `docs/CORE-CONTRACT.md`, `docs/decisions.md`
  (dated notes), `docs/register.md` (`S-37`), and `docs/template-README.md` (deleted). Next
  free: `S-38`, `D-31`. Baseline: 469 / 3002.

### Verification output

```
$ full suite (gate re-run): # tests = 469/469 pass  # asserts = 3002/3002 pass  # time = 214730ms  # ok
$ brittle-node test/former-name.test.js → 23/23 asserts, 0 skips
$ brittle-node test/backends/conformance-pear.test.js → 107/107 asserts, 0 skips
$ brittle-node test/backends/conformance-freenet.test.js → 105/105 asserts, 0 skips (42.5 s, local-mode node)
$ LINK_PREFIX set back to the former scheme → former-name.test.js exit 1, "not ok 1 - sanity: the fixtures are not ZBTerm-scheme links"; file restored (cmp equal)
$ npm run lint 2>&1 | tail -1 → 98 warnings (exit 0)
$ node <scratch>/z4/check-links.js → 4 KNOWN (archive/, zxterm-core moved; each dated-noted), 6 zxterm paths OK, "0 broken"
probe (subagent, scratch): rewritten-scheme invite → failed E_AUTH unreachable after 30 002 ms (JOIN_TIMEOUT_MS 30 000)
```

## Z5 — Close-out

> **2026-09-28.** No git in any phase (header), so the squash, the `git log`/`git tag`/remote
> checks and the push are the owner's. This phase prepares the tree and writes the commands.
> `main` already carries `931a836` (this folder, pushed), whose files name the predecessor. So
> `Z-1` and `Z-3` ("not in zbterm's published history") hold only if the owner rebuilds `main`
> from `72710d1` before the squash and force-pushes it. That is the owner's call.
> Reshaped before dispatch for the exec template.

> **2026-09-28, after `Z4`.** Baseline 469 / 3002. Next free: `S-38`, `D-31`. The former-name
> fixtures (`test/fixtures/former-name/`) are hex and stay; they are not hits.

**Goal.** The tree holds no former-name bytes at all: the rename script is gone and the name
test allows no path (`D-27`). This folder describes the project without the former name. The
owner has a checked list of the git commands that make zbterm's `main`: the template history
plus one squashed commit (`D-28`). zxterm-core may then land ZBTerm-side stages (`D-29`).

**Requirements & inputs.**
- `DST=/zp/zdata/zeev/github/zbterm`, working tree as `Z4` left it (see its handoff note).
- `scripts/rename-to-zbterm.js` and `test/name.test.js` (its two exempt paths are this script
  and `docs/projects/260928_zbterm-fork/`).
- This folder: `requirements.md`, `QnA_assumptions.md`, `plan.md`, `CHANGELOG.md`,
  `baseline.md`, `status--in-progress.md`. On 2026-09-28 they named the former product on
  roughly 100 lines, the predecessor's local path, its tag, and the owner's live-instance
  profile directory.
- `D-27`, `D-28`, `D-29`; `requirements.md` `Z-1`, `Z-3`; `HEAD` = `931a836` on `main`, origin
  `git@github.com:zevix/zbterm.git`, no other remote.

**Steps.**
1. Rewrite this folder by hand (not with the script): the product's old name becomes "the former
   name", or "the predecessor" for the app. The predecessor's path and tag become "the
   predecessor repository" and its final commit `b856e15`. The owner's live instance becomes
   "the owner's live predecessor instance (ports 17069/17070 and its profile directory)". The
   facts and numbers stay the same. Old environment-variable prefixes and the old link scheme,
   quoted as old values, become `ZBTERM_*`, `zbterm://`, or "the former `…` value", whichever
   keeps the sentence true.
2. Delete `scripts/rename-to-zbterm.js`. Narrow `test/name.test.js` to no exempt path, and
   update its comment.
3. Write `docs/projects/260928_zbterm-fork/owner-steps.md`: the exact git commands for the owner,
   in order, each with what it checks.
   - Option A: keep `931a836`. Commit the tree on `main` as one commit.
   - Option B, which `Z-1`/`Z-3` need: a new `main` from `72710d1` plus one commit holding the
     tree, then a force-push.
   - Checks for either: the message does not use the old name; `git grep -il` on the old name at
     the new `HEAD` finds nothing; `git log` shows only template commits (plus `931a836` under
     A); `git remote` shows `origin` only; `git tag` holds no predecessor tag.
   Build the grep so the file itself holds no raw old-name bytes (for example, "the former
   name's 8 letters, lower case" plus a `printf` that assembles it).
4. Run the verification.

**Acceptance criteria.**
- No file in `git ls-files -co --exclude-standard` matches the former name, case-insensitively,
  binaries included.
  The name test is green with no exempt path, and fails on a planted hit.
- Suite: `Z4`'s count, green. Lint: exit 0, baseline warnings.
- `owner-steps.md` exists, and its commands are correct when read against `git status` and
  `git log`. Nothing is committed; no git state changed.

**Verification.**
```
cd "$DST"
git ls-files -co --exclude-standard -z | xargs -0 grep -il "$(printf 'p%sterm' ear)" ; echo "hits: $?"   # exit 1 = none
npm run lint 2>&1 | tail -1
npm run vendor:assets
HOME="$SCR/home" TMPDIR=/tmp/zbt-z5 ./node_modules/.bin/brittle-node test/*.test.js test/backends/*.test.js 2>&1 | tail -6
git -C "$DST" rev-parse HEAD; git -C "$DST" remote; git -C "$DST" tag
```

**Gotchas.**
- The folder's own handoff notes and CHANGELOG are records: rewrite names, never numbers,
  hashes or results.
- `git ls-files -c` still lists the template files deleted in `Z1`. `grep` on a missing file only
  warns, so read the exit status and not the warnings.

**Re-planning signals.** None expected. A former-name hit that cannot be reworded (a hash, a
signature, a binary) is reported, not forced.

### Handoff note

- **Z5** (2026-09-28). Decisions: none new. Gotchas hit: `xargs` reports exit 123 when every
  batched `grep` found nothing, so the check reads the printed names, not the exit status; `git
  ls-files -c` still lists the six template files `Z1` deleted. The folder rewrite was mostly by
  hand: the app becomes "the predecessor", the name becomes "the former name", paths and tags
  become "the predecessor repository" and `b856e15`, and records of commands run before `Z3`
  keep placeholders instead of names they never used. Measured: 130 former-name occurrences in
  this folder before the phase, 0 in the tree after; the name test has no exempt path and fails
  on a planted hit; suite 469/469, 3002/3002 (the subagent's run and the gate re-run); lint 98
  warnings; `git add -A` would stage 339 entries, with the crates' `target/` and `build/` dirs
  ignored. Files touched: this folder (rewritten, plus the new `owner-steps.md`),
  `scripts/rename-to-zbterm.js` (deleted), `test/name.test.js`. Next free: `S-38`, `D-31`.
  Baseline: 469 / 3002.

### Verification output

```
$ git ls-files -co --exclude-standard -z | xargs -0 grep -il "$(printf 'p%sterm' ear)" 2>/dev/null   → (no names printed)
$ npm run lint 2>&1 | tail -1 → 98 warnings (exit 0)
$ full suite (gate re-run): # tests = 469/469 pass  # asserts = 3002/3002 pass  # time = 214097ms  # ok
$ git rev-parse HEAD → 931a836c3bdc9271b9f678964e106818fe454711 ; git remote → origin ; git tag → (none)
$ git status --porcelain --ignored → ignored: node_modules/, renderer/vendor/, contracts/src/*/{build,target}/
name test planted-hit check (subagent): README.md plant → not ok 1; removed → green, README byte-identical to the pre-Z5 snapshot
```
