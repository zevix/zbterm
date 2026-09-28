# ZBTerm — npm package implementation plan

> **2026-09-28 (Z3 of `docs/projects/260928_zbterm-fork/`, D-27).** This plan predates the ZBTerm
> fork and documents an unrelated, earlier rebrand of the predecessor repository; "The product is
> renamed from ZBTerm to ZBTerm" below already read "from [former name] to [former name]" before
> Z3 touched it — the earlier name that rebrand actually migrated from was already lost from the
> source, and is not reconstructed here.

Goal of the whole effort: `npm install -g zbterm` installs this Electron app and puts a
`zbterm` command on PATH; `npm install -g zbterm@latest` updates it. The product is renamed
from ZBTerm to ZBTerm, with a one-time on-disk data migration. The npm build never
self-updates over Pear OTA — npm is its update channel.

Repo facts an implementer needs (verified 2026-08-07):

- Electron shell: `electron/main.js` (1317 lines) → `electron/engine-lifecycle.js` →
  `electron/engine-client.js`, which spawns the engine as a **Bare** worker
  (`workers/engine.js`) via `PearRuntime.run`. `bare-sidecar` ships prebuilt `bare` binaries
  for linux/darwin/win32 x64+arm64, so nothing has to be compiled for the worker.
- `node-pty` 1.1.0 runs in the **Electron main process** (`engine/pty-host.js` →
  `engine/pty-session.js`). It is built on `node-addon-api` (N-API), so one binary works in
  both Node and Electron — **no `@electron/rebuild` step is needed**. Prebuilds exist for
  darwin-{arm64,x64} and win32-{arm64,x64}; **Linux compiles from source at install time**
  (needs python3 + a C++ toolchain).
- `sodium-native` ships prebuilds for every target platform and only loads inside the Bare
  worker. Unaffected by this work.
- The renderer loads xterm's CSS **and JS** at runtime by relative path into `node_modules`
  (`renderer/index.html:6-7`, `renderer/app.js:495-501`). That breaks under npx/hoisted
  layouts — see Phase 3.
- `zbterm` is unclaimed on npm (checked with `npm view zbterm`). `zbterm` is also unpublished.
- Tests: `npm test` → `brittle-node test/*.test.js`. Lint: `npm run lint` (prettier + lunte).
  A full app e2e exists: `npm run test:debug-server` (`test/debug-server-e2e.js`, launches the
  app via `npm start`, drives the REST debug server).

## Decisions already made — do not relitigate

1. The npm package ships the **Electron GUI**. `electron` moves from devDependencies to
   dependencies. No headless/TUI frontend, no engine refactor.
2. Full rebrand: package `name` = `zbterm`, `productName` = `ZBTerm`, env vars `ZBTERM_*`,
   data dirs `zbterm*`, deep links `zbterm://join/`.
3. Old data is **migrated**, not abandoned; old `zbterm://join/` links keep working
   (parsed, and the URL scheme stays registered).
4. Updates for npm installs come from npm only. Pear OTA is disabled on that channel.
5. Release automation is **shell scripts** in `scripts/`. Do not add or edit GitHub Actions
   workflows. Publishing is always an explicit, opt-in command.
6. electron-forge makers, flatpak/snap/MSIX packaging and the Pear OTA release path stay
   working and unchanged.

### Frozen constants — superseded 2026-08-08

**These are no longer frozen.** Every entry below was frozen on the assumption
that released ZBTerm builds existed in the field. The app was never actually
registered or distributed, so there is no install base to stay compatible with,
and all ZBTerm-era compatibility was stripped on 2026-08-08:

| Was | Now |
| --- | --- |
| `PROTOCOL = 'zbterm/ctl'` | `PROTOCOL = 'zbterm/ctl'` |
| `'zbterm://join/'` accepted as a legacy link prefix | removed; only `zbterm://join/` parses |
| `zbterm://` registered as a legacy scheme handler | removed; only `zbterm://` is claimed |
| `ZBTERM_*` env fallbacks | removed; only `ZBTERM_*` is read |
| on-disk migration from a ZBTerm data root | removed (`electron/legacy-migrate.js`, `zbterm migrate`) |
| flatpak/MSIX app ids `net.z33v.ZBTerm` | `net.z33v.zbterm` / `ZBTerm` |
| `pear.json` namespace `zbterm/zbterm` | `zevix/zbterm` |

The corestore / catalog / snapshot on-disk layout, `engine/schema.js` and
`engine/rpc/schema.js` were never part of the rename and are unchanged.

## Phase order and dependencies

1. **Phase 1 — Rebrand + on-disk migration** (no dependencies; riskiest, so first)
2. **Phase 2 — npm manifest + `bin/zbterm.js` launcher** (needs Phase 1 names)
3. **Phase 3 — Self-contained renderer assets** (needs Phase 2's `files` allowlist)
4. **Phase 4 — npm update channel, Pear OTA off** (needs Phase 1 env names + Phase 2 bin dispatch)
5. **Phase 5 — Desktop integration + `zbterm doctor` + `zbterm migrate`** (needs Phase 2 bin dispatch)
6. **Phase 6 — Release shell scripts + docs** (needs all of 1–5)
7. **Phase 7 — Desktop registration that verifies itself** (added after Phase 5; needs Phase 5's
   `bin/lib/desktop.js`. Independent of Phase 6 — may run before or after it.)
8. **Phase 8 — Claim the schemes in `[Added Associations]` too** (added after Phase 7; needs
   Phase 7's merge/verify helpers in `bin/lib/desktop.js`. Last phase.)

Reorderable: 3 may run before 2 if `renderer/vendor/` is added to `files` when 2 lands.
4 and 5 are independent of each other and may swap or run in parallel. 1 and 2 may not swap.

## Out of scope

- No headless/CLI frontend, no `zbterm share`-style subcommands beyond those Phases 4–5 define.
- No `@electron/rebuild`, `node-gyp` postinstall, or prebuild hosting for `node-pty`
  (it is N-API; Linux source builds are documented, not automated).
- No bundler/minifier/TypeScript for the renderer — Phase 3 copies files, nothing more.
- No removal or restructuring of `forge.config.js`, makers, `flatpak/`, `build/AppxManifest.xml`,
  `build_all.sh`, `pear.json`, or `relay/`.
- No changes to the debug-server REST contract in `electron/debug-server.js` (only identifier
  renames in Phase 1 and one new route-free handler in Phase 4).
- No GitHub Actions workflow files (`.github/workflows/*`) touched in any phase.
- No `npm publish` from any phase except by explicitly running the Phase 6 script with its
  publish flag. Never publish to validate a phase.
- Do not "fix" `spikes/`, `docs/abstract-arch.md`, or `docs/terminal-share-requirements.md`
  branding — untracked/experimental material stays as-is.

## Handoff-notes contract

After finishing a phase, append a block to `docs/npm-zbterm-handoff.md` (create it in Phase 1).
Exactly 2–5 lines, this shape:

```
## Phase N — <name> (done <YYYY-MM-DD>)
- Decisions: <anything the plan left open that you resolved, and how>
- Gotchas: <what bit you that the next phase would also hit>
- Files: <comma-separated paths added/modified>
- Deviations: <where you diverged from the plan section, or "none">
```

Every later phase reads this whole file before starting. Do not record narrative or status —
only facts that change what the next implementer types. The same block is mirrored into the
"Handoff notes (accumulated)" section below so this plan file is self-sufficient.

## Handoff notes (accumulated)

### Phase 1 — Rebrand to ZBTerm + on-disk migration (done 2026-08-08)

- Decisions: env fallbacks use `ZBTERM_X ?? ZBTERM_X`; `X-ZBTerm-Popups` renamed to
  `X-ZBTerm-Popups` (header value/shape unchanged), with `test/debug-server-e2e.js` and its
  `ZBTERM_E2E_*` vars renamed in lockstep; renderer banner URL now reads
  `bridge.pkg().homepage` instead of a hardcoded github link; `relay/` and `scripts/` were left
  un-rebranded — relay binaries are still `zbterm-relay-*` and `ZBTERM_RELAY_SEED`/`_PORT`/
  `_MAX_*`/`ZBTERM_REGISTRY_SEED` are still relay-only names.
- Gotchas: this repo's `brittle-node` prints `# tests = N/N pass` + `# ok` and has **no
  `# fail` line at all** — read that as the pass signal, not `# fail 0`; renderer preference
  keys moved `zbterm.*` -> `zbterm.*` (theme, devb, share.autoCopy, join.autoPaste,
  collapseGaps) and are NOT migrated; `migrateLegacyUserData` must run before the first
  `debugLog(...)` call or debugLog creates `<userData>/debug_main.log` and the migration aborts
  with `new-root-not-empty`; `~/.config/ZBTerm` on this machine is a 4.5 GB live tree with a
  running dev instance attached (`--storage ~/.zbterm-zeev-dev`) — **never** run a smoke test
  that touches the real `~/.config`, sandbox it with `XDG_CONFIG_HOME`.
- Files: package.json, electron/legacy-migrate.js (new), electron/main.js, electron/preload.js,
  electron/debug-server.js, electron/engine-lifecycle.js, engine/index.js,
  engine/share-manager.js, engine/pty-scope.js, renderer/app.js, renderer/index.html,
  forge.config.js, build_all.sh, README.md, test/legacy-migrate.test.js (new), and 7 other
  test files.
- Deviations: step 8's stale-`zbterm-`-scope cleanup was not added (no such path existed;
  systemd `CollectMode=inactive-or-failed` already reaps the transient scopes);
  `forge.config.js` keeps `appId: 'net.z33v.ZBTerm'` and the snap contact/issues/website URLs
  (frozen distribution identities).
- Re-planning: profile dirs **can** live outside userData (`--profile-path`, `--storage`), so
  startup migration misses them → `zbterm migrate --from` added to Phase 5, reserved in Phase 2.

### Phase 2 — npm manifest and the `zbterm` launcher (done 2026-08-08)

- Decisions: `bare-crypto` had to be added to `dependencies` — `package.json#imports` maps
  `crypto` → `bare-crypto` for the Bare engine worker, and it only ever reached `node_modules`
  transitively via `brittle`, so moving `brittle` to devDependencies killed the engine
  (`MODULE_NOT_FOUND: crypto` from `engine/share-manager.js`) in a fresh install;
  `package-lock.json` was regenerated with `npm install --package-lock-only`; `bin/` is **not**
  in the `lint`/`format` prettier+lunte globs, so run
  `npx prettier --write bin/zbterm.js && npx lunte bin` by hand.
- Gotchas: **`GET /health` answers HTTP 200 even when the engine is dead** (`{"ok":false,
  "engineReady":false}`) — always assert `engineReady: true`, never just the status code;
  `app.isPackaged` is **false** for an npm/global install so `slice(2)` is correct;
  `allowScripts` pins `electron@40.10.1` but npm resolves 40.10.6, and only the repo-local
  `.npmrc` (`ignore-scripts=false`) makes the electron/node-pty install scripts run — installing
  from another cwd silently skips the Electron binary download; graceful shutdown with a live
  engine takes ~10–15 s, so poll until the PID is gone instead of `sleep 3`; the Linux sandbox
  fallback never fires on a host with unprivileged user namespaces — exercise it with a fake
  binary via `ELECTRON_OVERRIDE_DIST_PATH`.
- Files: package.json, package-lock.json, bin/zbterm.js (new, 0755), .gitignore.
- Deviations: added the `bare-crypto` dependency and regenerated `package-lock.json`; nothing
  else diverged.
- Re-planning: `bare-fs`/`bare-path`/`bare-os`/`bare-events` are still undeclared and arrive
  only via `pear-runtime` — Phase 3 now declares them; every remaining health check asserts
  `engineReady: true`.

### Phase 3 — Self-contained renderer assets (done 2026-08-08)

- Decisions: `vendor:assets` is wired to `prepack`, `pretest` AND `prestart`; `renderer/vendor`
  is listed in a new `.lunteignore` and in `.prettierignore` (otherwise `npm run lint` fails on
  the minified xterm bundle); `scripts/vendor-assets.js` is quiet unless `--verbose`; the four
  Bare deps are pinned at `bare-fs@^4.7.1`, `bare-path@^3.0.0`, `bare-os@^3.9.1`,
  `bare-events@^2.8.3`.
- Gotchas: `bare-*` packages have a restrictive `exports` map — `require('bare-fs/package.json')`
  throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, read the file by absolute path; hiding the **whole**
  `node_modules` proves nothing because `electron/main.js` requires `pear-runtime` at load and
  the main process dies before any window exists — hide only the renderer's own packages; a
  crashed Electron leaves a stray process holding the debug port and `xvfb-run`'s children
  survive killing the wrapper, so kill the `electron/dist/electron` PID by cmdline match;
  `renderer/logo-ascii.generated.js` is generated by `npm run icons` (needs the `sharp`
  devDependency) but is committed, so it ships without a `prepack` step.
- Files: scripts/vendor-assets.js (new), renderer/index.html, renderer/app.js, package.json,
  package-lock.json, test/renderer-static.test.js, .gitignore, .prettierignore, .lunteignore
  (new).
- Deviations: `.lunteignore` + `.prettierignore` entries and a `prestart` script were added
  beyond the plan (required for lint to pass); the hidden-`node_modules` run used the targeted
  package-hiding variant.

### Phase 4 — npm update channel, Pear OTA off (done 2026-08-08)

- Decisions: an unknown `ZBTERM_CHANNEL` value is ignored (falls through to detection);
  `ZBTERM_REGISTRY_URL` overrides the registry and is the only way to keep the check on under
  `--debug-server` (default off there, so no live network in e2e); the 24 h cache lives in
  `preferences.json` under `zbterm.updateCheck`, is invalidated when `current` differs, and only
  200/404 responses are cached. No `.npm-channel` marker file was added — `detectChannel` is
  reliable, so `doctor` can call it directly.
- Gotchas: **`npm start`/`npm run package`/`npm run make` are broken in this tree** — Phase 2
  moved `electron` to `dependencies` and `@electron-forge/core-utils` only reads
  `devDependencies` (`Could not find any Electron packages in devDependencies`); until Phase 5
  step 1 fixes it, every GUI run must go through `node bin/zbterm.js`. `--help` never exits
  (`main.js` calls `process.exit(0)` but the Electron child survives and the launcher waits on
  it) — always run it under `timeout`. Running the app while `npm test` runs makes
  `test/engine-session.test.js` fail with `E_INTERNAL` (lock contention) — never overlap them.
- Files: electron/update-channel.js (new), electron/main.js, renderer/app.js, bin/zbterm.js,
  test/update-check.test.js (new).
- Deviations: added the `ZBTERM_REGISTRY_URL` escape hatch so `app.updateCheck` is verifiable end
  to end; `update` was removed from `RESERVED_SUBCOMMANDS` now that it is implemented.

### Phase 5 — Desktop integration, `zbterm doctor`, `zbterm migrate` (done 2026-08-08)

- Decisions: forge was fixed by listing the *same* `electron: ^40.2.1` range in
  `devDependencies` as well as `dependencies` (npm accepts the duplicate, `getElectronVersion`
  resolves 40.10.1); `userDataRoot()` lives in `bin/lib/migrate.js` and doctor imports it; doctor
  emits 9 entries (7 checks + `version`/`channel` as `info:true`) and `chrome-sandbox` is a
  `WARN` (ok:true) when `/proc/sys/user/max_user_namespaces > 0`; `migrate --from <gone> --to
  <migrated>` exits 0, `--from /nonexistent` exits 1.
- Gotchas: **`xdg-mime` exits 0 even when it fails to write `mimeapps.list`** (it needs `qtpaths`
  under KDE and will not create `$XDG_CONFIG_HOME`) — never trust its exit code, verify the file;
  `os.homedir()` just echoes `$HOME`, so use `os.userInfo().homedir` to detect the real account
  home; brittle teardowns run FIFO, so a `chmod` restore registered after an `rmSync` teardown
  never fires; **prettier reformats `bin/` into shapes lunte's `curly` rule rejects** — run
  `npx prettier --write bin/ && npx lunte bin` and re-check; Electron's own
  `setAsDefaultProtocolClient` prints `xdg-mime: application argument missing` twice to stderr on
  every GUI launch — harmless, log greps must not treat it as failure.
- Files: package.json, package-lock.json, bin/zbterm.js, bin/lib/doctor.js (new),
  bin/lib/desktop.js (new), bin/lib/migrate.js (new), electron/legacy-migrate.js,
  test/doctor.test.js (new).
- Deviations: `uninstall-desktop` also strips the two `x-scheme-handler/*` lines from
  `mimeapps.list` and deletes `applications/mimeinfo.cache` when no `.desktop` files remain;
  `RESERVED_SUBCOMMANDS` became `SUBCOMMANDS`; `package.json#files` already covered `bin/` and
  `build/icon/`, so step 6 was a no-op.
- Re-planning: desktop hooks lie about success → new **Phase 7** (`install-desktop --print-only`
  + verify `mimeapps.list` rather than `$?`). A `--deep` Electron-backed doctor was considered
  and deliberately **not** scheduled.

### Phase 6 — Release shell scripts and documentation (done 2026-08-08)

- Decisions: the lockfile gate snapshots `package-lock.json` before `npm install
  --package-lock-only` and compares, because the plan's literal `git diff --exit-code` can never
  pass while the tree is intentionally dirty; `pack-check` and `smoke-install` are themselves
  named guards, run *after* the four cheap guards so `--publish` aborts early; exit codes are
  **0 ok / 2 `--publish` abort / 3 dry-run blockers**; `npm-smoke-install.sh` prefers `xvfb-run`
  even when `$DISPLAY` is set, and deliberately never runs `zbterm --help`.
- Gotchas: the app mints `$TMPDIR/zbterm-electron-<pid>-<hex>` that survives SIGTERM teardown —
  the smoke script sets `ZBTERM_ELECTRON_USER_DATA` into its own prefix or `/tmp` grows every
  run; `npm test` leaks ~11 `/tmp/zbterm-share*-test-*` dirs per run (pre-existing), so `ls /tmp`
  counts are not a leak signal; **`test/engine-session.test.js` has an intermittent `ENOTEMPTY:
  rmdir .../corestore/.../log/db` teardown race that takes `pack:check` down with it** — re-run
  once before believing a failure; `xvfb-run`'s children outlive the wrapper, so launch under
  `setsid` and tear down by process-group id.
- Files: scripts/npm-pack-check.sh (new), scripts/npm-smoke-install.sh (new),
  scripts/release-npm.sh (new), package.json, README.md, docs/RELEASE-NPM.md (new).
- Deviations: snapshot-based lockfile check; the plan-file closing summary was left to the
  orchestrator; `npm publish` was never reached, not even with `--dry-run`.
- Re-planning: the per-platform matrix in `docs/RELEASE-NPM.md` has never been executed and
  cannot be from this host — recorded as a first-publish blocker, not a new phase. `prepack` was
  stable across five runs, so `renderer/vendor/` stays gitignored.

### Phase 7 — Desktop registration that verifies itself (done 2026-08-08)

- Decisions: verification is scoped to `[Default Applications]`; the direct `mimeapps.list` write
  happens only when `runHooks` is true; `install()` keeps its old fields and adds
  `desktopFile`/`icons`/`mimeapps`/`mimeVerified`/`mimeMissing`/`mimeRepaired`/`hookFailures`, the
  last merging failed hooks with a synthetic `{ command: 'write <mimeapps.list>' }` so a silent
  EACCES is as loud as a missing binary; a failed hook alone is a `note:` and still exit 0, only
  `mimeVerified:false` exits 1. `desktop.js` now also exports `printPlan`,
  `mergeDefaultApplications`, `missingAssociations`; `layout()` gained a `mimeapps` field.
- Gotchas: `spawnSync(cmd, args, { env })` resolves `cmd` through the **child** env's PATH, which
  is what makes a stubbed `xdg-mime` testable — but the real `update-desktop-database` still runs
  from the inherited PATH and writes `applications/mimeinfo.cache`, so "0 files after uninstall"
  only holds because uninstall deletes that cache; stub **both** hooks in tests so KDE's
  `kbuildsycoca6` never runs during `npm test`; brittle teardowns run FIFO, so a `chmod` restore
  must be registered **before** the `rmSync` — and the `tmpdir()` helper cannot be used there
  because it registers `rmSync` at creation.
- Files: bin/lib/desktop.js, bin/zbterm.js, test/doctor.test.js.
- Deviations: note wording changed from "unavailable or failed" to "failed"; nothing else.
- Re-planning: `[Added Associations]` is needed for some resolvers to treat zbterm as a candidate
  at all → **Phase 8**. End-to-end `gio open zbterm://…` routing is a separate integration phase,
  recorded under "Remaining before a real release" and deliberately not scheduled.

### Phase 8 — Claim the schemes in `[Added Associations]` too (done 2026-08-08)

- Decisions: `missingAssociations()` returns `{defaults, added}` and `install().mimeMissing`
  carries that object; `mimeRepaired` stays a boolean (one write of the whole file);
  `mergeDefaultApplications`/`mergeAddedAssociations` wrap one
  `mergeAssociations(raw, section, entries, {list})`, with a shared `splitList()`; uninstall drops
  an emptied section header **and its blank body**, but only for a section it actually emptied.
- Gotchas: install is two chained merges, so the second must take the first's *string* output;
  an `[Added Associations]` key already listing `zbterm.desktop` must be left byte-identical or
  the idempotence acceptance fails; leaving the emptied header's trailing blank line breaks the
  byte-for-byte round trip.
- Files: bin/lib/desktop.js, test/doctor.test.js.
- Deviations: `bin/zbterm.js` needed no change; `desktop.js` also exports
  `mergeAddedAssociations`, `DEFAULT_APPLICATIONS`, `ADDED_ASSOCIATIONS`.
- Re-planning: the deprecated `~/.local/share/applications/mimeapps.list` and a zbterm-authored
  `mimeinfo.cache` are both deferred, not scheduled — see "Remaining before a real release".

---

## Phase 1: Rebrand to ZBTerm + on-disk migration — ✅ done (see CHANGELOG)

## Phase 2: npm manifest and the `zbterm` launcher — ✅ done (see CHANGELOG)

## Phase 3: Self-contained renderer assets — ✅ done (see CHANGELOG)

## Phase 4: npm update channel, Pear OTA off — ✅ done (see CHANGELOG)

## Phase 5: Desktop integration, `zbterm doctor`, `zbterm migrate` — ✅ done (see CHANGELOG)

## Phase 6: Release shell scripts and documentation — ✅ done (see CHANGELOG)

## Phase 7: Desktop registration that verifies itself — ✅ done (see CHANGELOG)

## Phase 8: Claim the schemes in `[Added Associations]` too — ✅ done (see CHANGELOG)

**All phases are complete.** What remains below are maintainer actions, not phases.

# Remaining before a real release (not phases — maintainer actions)

Nothing has been published. `npm view zbterm version` returns **E404**: the name `zbterm` is
unclaimed, and the first successful publish claims it. `package.json#version` is still `1.0.44`,
and since nothing is published the first release need not be a bump —
`bash scripts/release-npm.sh 1.0.44 --publish` is valid.

1. **Commit phases 1–6.** They are deliberately uncommitted; the `clean-tree` guard blocks every
   release path until then.
2. **`npm login` on the release machine.** `npm whoami` is currently `ENEEDAUTH`. Being logged in
   still does not equal publish rights on the name.
3. **Run the per-platform matrix in `docs/RELEASE-NPM.md`.** It has never been executed. This
   host only proves linux-x64/glibc with a `node-pty` prebuild that never compiled. macOS
   (Gatekeeper on an unsigned npm install), Windows x64, linux-arm64 (`bare-sidecar` prebuild)
   and any source-compiling distro are unverified.
4. **`test/engine-session.test.js` teardown race** (`ENOTEMPTY` on `corestore/.../log/db`) will
   randomly fail `pack:check` and therefore randomly block releases. Pre-existing and unrelated
   to npm packaging, but worth fixing before release automation is trusted.
5. `npm test` leaks ~11 `/tmp/zbterm-share*-test-*` directories per run (pre-existing).
6. No CI exists and none was added — publishing stays a manual, opt-in maintainer command.
7. **End-to-end link routing is unverified.** Every check so far proves the right bytes are on
   disk, not that a desktop environment routes a click. Real proof is `gio open zbterm://…`
   reaching a running zbterm with the URL in `argv`, which needs a live session bus, a display,
   an Electron process and the single-instance/`open-url` path in `electron/main.js`. It is an
   integration-test phase of its own; two blockers for whoever plans it: the app under test
   cannot be the developer's live instance (single-instance lock), and `xvfb-run`'s children
   outlive the wrapper, so the harness needs `setsid` + process-group teardown.
8. **`mimeinfo.cache` is still written only by a best-effort external hook.** `mimeapps.list` is
   now self-verified in both sections, but if `update-desktop-database` fails, the cache is never
   written and the failure is only a `note:` line. A zbterm-authored merge would use the same
   shape as Phase 8 (`[MIME Cache]`, `;`-terminated lists). Related: `manualCommands()` prints a
   recipe strictly weaker than what `install()` does — no CLI can write `[Added Associations]` —
   so it should print the file lines instead.
9. **The deprecated `~/.local/share/applications/mimeapps.list` is not written.** The config-home
   file wins on any spec-compliant DE, so this only matters on older stacks. Deferred rather than
   guessed at; the merge/strip code is already file-agnostic, so the work would be in `layout()`,
   `ensureAssociations`, `cleanAssociations` and the dir-pruning walk.
10. **Licensing.** The project relicensed to `ZBTerm License v1.0` (source-available,
    non-commercial, rebrand-on-redistribution). Open items: governing law/venue in `LICENSE` §11
    are placeholders; upstream provenance from the `hello-pear-electron` boilerplate needs
    resolving (see §9/§10); and there is no CLA/DCO for contributors. The §3(e) attribution URL
    is settled — every repo URL now points at `github.com/zevix/zbterm`, matching the git
    remote.
11. **Contact addresses are unverified.** `LICENSE`/`LICENSE-COMMERCIAL` name
    `zbterm-license@passcall.com` and the snap `contact:` is `zbterm@1zk.net`. Both were renamed
    off the ZBTerm-era addresses without confirming a mailbox exists behind either.
12. **`build/AppxManifest.xml` still has `Publisher="CN=z33v.net"`.** Everything else in that
    manifest was rebranded, but the publisher string has to match the code-signing certificate
    subject, so it was left for whoever owns the cert.
