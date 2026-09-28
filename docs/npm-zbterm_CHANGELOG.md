# ZBTerm npm plan — completed phases

Phases are cut verbatim from `docs/npm-zbterm-plan.md` as they complete, with their handoff
notes and the verification output that proved them. Append-only, in phase order.

> **2026-09-28 (Z3 of `docs/projects/260928_zbterm-fork/`, D-27).** This log predates the ZBTerm
> fork by weeks and documents an unrelated, earlier rebrand; the literal command transcripts below
> ran with the repo at its then-current location, the predecessor repository (frozen at commit
> `b856e15`), not the tree this file now lives in. The rename changed the names inside the
> transcripts too, so a path shown there as this repository's was the predecessor's. Separately, this log already
> read "the product is renamed from X to X" before Z3 (`docs/npm-zbterm-plan.md`'s own header):
> the earlier name that phase actually migrated from was already lost from the source at the time
> and is not reconstructed here.

---

# Phase 1 — Rebrand to ZBTerm + on-disk migration — ✅ done 2026-08-08

## Goal

The app identifies itself as ZBTerm everywhere a user or the filesystem can see: package name
`zbterm`, product name `ZBTerm`, data under `<userData>/zbterm*`, env vars `ZBTERM_*`, share
links minted as `zbterm://join/`. An existing ZBTerm installation's data directory, profile
registry and profile directories are moved to the new names on first launch, once, safely, with
absolute paths inside the profile registry rewritten. Old `zbterm://join/` links still open,
and the peer wire protocol is byte-identical to the released build.

## Requirements & inputs

Read before editing: `package.json`, `electron/main.js`, `electron/engine-lifecycle.js`,
`electron/preload.js`, `electron/debug-server.js`, `engine/index.js`,
`engine/share-manager.js`, `engine/profile-manager.js`, `engine/pty-scope.js`,
`renderer/index.html`, `renderer/app.js`, `test/debug-server-e2e.js`.

Contracts to honor:

- The frozen-constants table at the top of this document. In particular `PROTOCOL` on
  `engine/share-manager.js:28` stays `'zbterm/ctl'`; add a comment there saying so.
- Electron derives `app.getPath('userData')` from `productName`. Renaming `productName` alone
  silently relocates all user data — that is exactly why the migration ships in this phase and
  not later.
- `engine/index.js` and everything it requires run inside **Bare**, not Node. Migration code
  must not be reachable from `workers/engine.js`; it runs shell-side only.
- Env var renames are additive: read `ZBTERM_X`, fall back to `ZBTERM_X`, never drop the old
  name in this phase.

## Steps

1. `package.json`: `name` → `zbterm`, `productName` → `ZBTerm`, `description` → a real
   one-liner. Leave `repository`/`bugs`/`homepage`, `version`, `upgrade`, `imports`,
   `allowScripts` untouched.
2. New file `electron/legacy-migrate.js` exporting
   `migrateLegacyUserData({ stableUserData, log })` (sync, returns a summary object):
   - Legacy root = `path.join(path.dirname(stableUserData), 'ZBTerm')`. If it does not
     exist, or the new root already exists and is non-empty, return `{ migrated: false, reason }`.
   - Refuse and return `{ migrated: false, reason: 'legacy-locked' }` if any profile lock is
     held in the legacy tree — each profile directory holds a `lock` entry; reuse the
     `isLocked(profilePath)` helper's semantics from `engine/profile-manager.js` rather than
     inventing a second lock check.
   - `fs.renameSync` the legacy root to the new root; if `EXDEV`, fall back to a recursive copy
     then delete.
   - Inside the new root rename `zbterm-profiles` → `zbterm-profiles` and `zbterm` →
     `zbterm`.
   - `zbterm-profiles/profiles.json` stores profile **ids** and derives paths from the manager
     root (`ProfileManager.resolveProfilePath`), so it normally needs no rewriting — assert
     that, and rewrite only if a field holding an absolute path turns up.
   - `<newRoot>/window-state.json` **does** key entries by absolute path
     (`profileWindowKey` → `path:${path.resolve(profilePath)}`, `electron/main.js:367`).
     Rewrite those keys to the new root, dropping any that no longer resolve.
   - Write a marker file `<newRoot>/.migrated-from-zbterm` containing the legacy path and
     an ISO timestamp; return early on subsequent runs if it exists.
3. `electron/main.js`: call the migration immediately after `stableUserData` is captured
   (currently line 54) and before anything else touches it. Then rename:
   `zbterm-debug_main.log` → `zbterm-debug_main.log` (line 85); scratch dir prefix
   `zbterm-electron-` → `zbterm-electron-` (line ~168); every `ZBTERM_*` env read (lines
   128–135, 152) to `ZBTERM_*` with a `ZBTERM_*` fallback; `win.__zbtermProfileKey` →
   `win.__zbtermProfileKey`; IPC channel strings `zbterm:invoke` / `zbterm:event`
   → `zbterm:invoke` / `zbterm:event`; `window.__zbtermDebug*` strings in the debug-server
   callbacks → `__zbtermDebug*`.
4. `electron/main.js` deep links: `protocol` (line 106) now derives to `zbterm`. Register both
   schemes — `app.setAsDefaultProtocolClient('zbterm')` and `...('zbterm')` (line 1245) —
   and make `handleDeepLink` (line 1237) accept both `zbterm://join/` and `zbterm://join/`.
5. `engine/share-manager.js`: `LINK_PREFIX` → `'zbterm://join/'`; add
   `LEGACY_LINK_PREFIXES = ['zbterm://join/']` and accept them in the parse path
   (line ~1503). Mint links with the new prefix only. Rename `ZBTERM_RELAY_*` env reads to
   `ZBTERM_RELAY_*` with fallback.
6. `engine/index.js`: `zbterm-profiles` → `zbterm-profiles` (line 42), `path.join(base,
   'zbterm')` → `'zbterm'` (line 49), tmpdir `zbterm-dev` → `zbterm-dev` (line 40),
   `process.env.ZBTERM_PROFILE` → `ZBTERM_PROFILE` with fallback.
7. `electron/engine-lifecycle.js:54`: `zbterm-profiles` → `zbterm-profiles`.
8. `engine/pty-scope.js`: rename the systemd scope-unit prefix to `zbterm-`; keep any cleanup
   path that reaps stale `zbterm-` scopes from a previous install.
9. `electron/preload.js:58`: expose `zbterm` instead of `zbterm`, matching the renamed IPC
   channels. Update every `window.zbterm` / `api =` use in `renderer/app.js`, plus
   `__zbtermDebug*` definitions there and their callers in `electron/debug-server.js`.
10. User-visible strings: `renderer/index.html` (title line 5, brand span line 1379),
    remaining `ZBTerm` strings in `renderer/app.js`, `electron/*.js`, `forge.config.js`,
    `build_all.sh`, `README.md`.
11. Tests: update assertions in `test/debug-server-e2e.js`, `test/engine-session.test.js`,
    `test/share-manager*.test.js`, `test/store.test.js`, `test/profile-manager.test.js`,
    `test/crypto.test.js`, `test/account-store.test.js`, `test/canary-scan.js` (canary string
    may stay `ZBTERM_PLAINTEXT_CANARY_1234` — it is a test fixture, not a wire value; if you
    change it, change both places).
12. New test `test/legacy-migrate.test.js` (brittle) covering: happy path with one profile;
    idempotent second run; abort when the new root already has data; abort when a legacy
    profile lock is held; `window-state.json` `path:` keys rewritten to the new root.
13. Create `docs/npm-zbterm-handoff.md` and append this phase's block.

## Acceptance criteria

- `grep -ri zbterm electron engine workers renderer bin 2>/dev/null` returns **only**:
  `PROTOCOL = 'zbterm/ctl'`, the legacy link prefix(es), the `ZBTERM_*` env fallbacks,
  `setAsDefaultProtocolClient('zbterm')`, the legacy-migration paths, the stale-scope
  cleanup in `engine/pty-scope.js`, and comments explaining those. Every hit is one of these.
- Starting the app creates `<config>/ZBTerm/zbterm-profiles/`, not `<config>/ZBTerm/`.
- A pre-seeded legacy tree is moved on first launch and the app opens the same profile with
  the same session list.
- A share link minted by the new build starts with `zbterm://join/`; a hand-built
  `zbterm://join/<same-payload>` link is still parsed successfully.
- `test/legacy-migrate.test.js` has at least the five cases listed in step 12.

## Verification

```bash
cd /zp/zdata/zeev/github/zbterm
npm run lint                                   # prettier --check + lunte, exit 0
npm test                                       # brittle-node test/*.test.js, "# fail 0"
npx brittle-node test/legacy-migrate.test.js   # "# fail 0", >= 5 assertions groups
grep -ri zbterm electron engine workers renderer   # only the allowlisted hits above
# GUI smoke (headless host is fine):
xvfb-run -a npm start -- --no-updates --debug-server --debug-server-port 17099 \
  --storage /tmp/zbterm-phase1 &
sleep 25 && curl -sf http://127.0.0.1:17099/health && echo HEALTH-OK
ls ~/.config/ZBTerm/                           # shows zbterm-profiles/
kill %1
```

Pass = lint exit 0, `# fail 0` on both test runs, `HEALTH-OK` printed, `zbterm-profiles`
present, grep output containing only allowlisted hits.

## Top gotchas

- `const protocol = name` (`electron/main.js:106`) reads the **package** name, so the deep-link
  scheme flips to `zbterm` the moment you edit `package.json` — the dual registration in step 4
  is what keeps old links working, not a fallback anywhere else.
- `PROTOCOL` and `LINK_PREFIX` sit on adjacent lines in `engine/share-manager.js`. A
  search-and-replace over that file will silently break peer interop with released builds.
- `test/debug-server-e2e.js` string-matches renderer debug hooks (`__zbtermDebug*`); renaming
  preload/renderer without it makes the e2e hang rather than fail loudly.
- The migration runs before `app.whenReady()`, so it cannot use any Electron dialog. Failures
  must be logged through `debugLog` and left non-fatal (app continues with an empty new root).
- Do not require `electron/legacy-migrate.js` from anything under `engine/` or `workers/` —
  that code path is loaded by Bare, where Node's `fs` semantics differ.

## Re-planning signals

- The profile registry stores absolute paths in more places than `engine/profile-manager.js`
  exposes, or profile directories can live outside the userData root (`--profile-path`) →
  add a phase for an explicit `zbterm migrate --from <dir>` command instead of silent startup
  migration.
- Renaming `window.zbterm` cascades into more than ~50 renderer sites or into
  `renderer/logo-ascii.generated.js` → keep the exposed global name, rename only user-visible
  strings, and record that decision in the handoff notes.
- If any released peer is found to depend on the link prefix being `zbterm://`, flip the
  minting side back and make the new prefix parse-only.

## Re-planning outcome

Signal 1 **fired, partially**: the profile registry stores no absolute paths (`profiles.json`
is id-keyed; the rewrite branch is dead code in practice), but profile directories *can* live
outside the userData root — `--profile-path <dir>` / `ZBTERM_PROFILE_PATH` accept any absolute
directory, and `--storage <dir>` repoints the whole data root. Startup migration only ever
looks at `<userData sibling>/ZBTerm`, so those users get nothing migrated. Resolution: rather
than a standalone phase, `zbterm migrate --from <dir> [--to <dir>] [--dry-run]` was added to
Phase 5 (which already owns `bin/zbterm.js` subcommands) and reserved in Phase 2's dispatch
table. Signals 2 and 3 did not fire: `window.zbterm` had exactly one call site
(`renderer/app.js:9`), `renderer/logo-ascii.generated.js` had zero brand hits (~37 renderer
string sites total), and no released peer depends on the mint prefix — the only wire-visible
identifier is `PROTOCOL = 'zbterm/ctl'` (unchanged), and the link prefix is stripped before
the base64url payload is decoded, so it never travels on the wire.

## Handoff notes

- Decisions: env fallbacks use `ZBTERM_X ?? ZBTERM_X`; `X-ZBTerm-Popups` renamed to
  `X-ZBTerm-Popups` (header value/shape unchanged) since the acceptance grep forbids the old
  name — `test/debug-server-e2e.js` and its `ZBTERM_E2E_*` vars were renamed in lockstep;
  renderer banner URL now reads `bridge.pkg().homepage` instead of a hardcoded github link;
  `relay/` and `scripts/` were left un-rebranded (outside step 10's file list and outside the
  acceptance grep) — relay binaries are still `zbterm-relay-*` and `ZBTERM_RELAY_SEED` /
  `_PORT` / `_MAX_*` / `ZBTERM_REGISTRY_SEED` are still relay-only names.
- Gotchas: renderer preference keys moved `zbterm.*` -> `zbterm.*` (theme, devb,
  share.autoCopy, join.autoPaste, collapseGaps) and are NOT migrated — existing users silently
  reset those five prefs; `migrateLegacyUserData` must run before the first `debugLog(...)`
  call or debugLog creates `<userData>/debug_main.log` and the migration aborts with
  `new-root-not-empty`; window-state `path:` keys need both the root move *and* the
  `zbterm-profiles` -> `zbterm-profiles` segment rename, not just a prefix swap;
  `~/.config/ZBTerm` on this machine is 4.5 GB with a live dev instance attached, so the GUI
  smoke was run under a sandboxed `XDG_CONFIG_HOME` and the real tree was deliberately not
  migrated.
- Files: package.json, electron/legacy-migrate.js (new), electron/main.js, electron/preload.js,
  electron/debug-server.js, electron/engine-lifecycle.js, engine/index.js,
  engine/share-manager.js, engine/pty-scope.js, renderer/app.js, renderer/index.html,
  forge.config.js, build_all.sh, README.md, test/legacy-migrate.test.js (new),
  test/debug-server-e2e.js, test/share-manager.test.js, test/share-manager-network.test.js,
  test/engine-session.test.js, test/store.test.js, test/profile-manager.test.js,
  test/crypto.test.js, test/account-store.test.js, docs/npm-zbterm-handoff.md
- Deviations: step 8's "stale `zbterm-` scope cleanup" was not added — no such cleanup path
  existed and systemd's `CollectMode=inactive-or-failed` already reaps the transient scopes, so
  nothing survives an install swap; `forge.config.js` keeps `appId: 'net.z33v.ZBTerm'`, the
  snap `contact:`/`issues:`/`website:` URLs, and all of `flatpak/`, `build/AppxManifest.xml`,
  `pear.json` (frozen distribution identities).

## Verification output (2026-08-08)

`npm run lint` → exit 0

```
> zbterm@1.0.44 lint
> prettier --check package.json forge.config.js electron engine renderer test workers && lunte electron engine renderer test workers forge.config.js

Checking formatting...
All matched files use Prettier code style!
62 warnings
lint exit=0
```

(62 warnings are pre-existing `require-await` warnings in untouched files; lunte exits 0 on
warnings.)

`npm test`

```
1..106
# tests = 106/106 pass
# asserts = 409/409 pass
# time = 17730.416739ms

# ok
```

`npx brittle-node test/legacy-migrate.test.js`

```
1..5
# tests = 5/5 pass
# asserts = 34/34 pass
# time = 88.993749ms

# ok
```

Note: this repo's `brittle-node` prints `# tests = N/N pass` and has no `# fail` line at all —
later phases should read `# tests = N/N pass` + `# ok` as the pass signal, not `# fail 0`.

`grep -ri zbterm electron engine workers renderer` — 20 hits, all allowlisted: the
`.migrated-from-zbterm` marker + legacy dir names in `electron/legacy-migrate.js` (6),
`LEGACY_LINK_PREFIXES` + frozen `PROTOCOL = 'zbterm/ctl'` + `ZBTERM_RELAY_*` fallbacks (5),
`LEGACY_PROTOCOLS` + 7 `ZBTERM_*` env fallbacks in `electron/main.js`, the `ZBTERM_PROFILE`
fallback in `engine/index.js`, `LEGACY_JOIN_PREFIXES` in `renderer/app.js`. Independently
re-confirmed: `engine/share-manager.js:27` `LINK_PREFIX = 'zbterm://join/'`, `:30`
`LEGACY_LINK_PREFIXES = ['zbterm://join/']`, `:35` `PROTOCOL = 'zbterm/ctl'` unchanged.

GUI smoke — `xvfb-run` was available and used, but **not** with the plan's literal command:
`~/.config/ZBTerm` on this machine is a 4.5 GB live data directory with a running dev
instance attached, and the literal command would have renamed the user's live tree as a test
side effect. Two launches were run under a sandboxed `XDG_CONFIG_HOME=/tmp/zbterm-phase1/config`
instead:

- Run 1 (no legacy tree): `HEALTH-OK`; `<config>/ZBTerm/` contained `zbterm-profiles/`,
  `window-state.json`, `debug_main.log`; no `ZBTerm` dir created. Created session
  `phase1-smoke`, minted a share link beginning `zbterm://join/`, confirmed response header
  `X-ZBTerm-Popups: []`.
- Run 2 (run 1's tree renamed back to `ZBTerm`/`zbterm-profiles`, plus a hand-seeded
  `path:` window-state key): `HEALTH-OK`; `ZBTerm/` gone, `ZBTerm/zbterm-profiles/` present,
  `.migrated-from-zbterm` written with
  `{"legacyRoot":"/tmp/zbterm-phase1/config/ZBTerm","migratedAt":"2026-08-08T00:41:41.673Z"}`,
  the same `phase1-smoke` session listed under the new path, and the window-state key rewritten
  from `path:.../ZBTerm/zbterm-profiles/default` to `path:.../ZBTerm/zbterm-profiles/default`.

Legacy-link acceptance: a hand-built `zbterm://join/<same payload>` returned
`{"status":"connecting","linkId":"a76908d3…"}` while `nope://join/<same payload>` returned
`E_AUTH "Invalid ZBTerm invite"`.

Both processes and `/tmp/zbterm-phase1` were removed; `~/.config/ZBTerm` and the running dev
instance were left untouched.

---

# Phase 2 — npm manifest and the `zbterm` launcher — ✅ done 2026-08-08

## Goal

`npm pack` produces a tarball under ~5 MB containing only runtime files, and installing that
tarball globally puts a working `zbterm` command on PATH that launches the Electron app with
all existing CLI flags passed through, exits with the app's exit code, and recovers from the
Linux `chrome-sandbox` failure that unpackaged Electron hits on non-root installs.

## Requirements & inputs

Read: `package.json`, `electron/main.js` (lines 15–47 for the flag list and `--help`
handling, line 124 for `app.isPackaged` argv slicing), `.npmrc`, `.gitignore`,
`docs/npm-zbterm-handoff.md`.

Contracts to honor:

- `electron/main.js:44-47` handles `--help` before Electron initializes, so `zbterm --help`
  must work with no display. Do not reimplement help text in the launcher.
- `cliArgs = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2)` — an npm install
  is **unpackaged**, and `electron <appRoot> <args>` yields `argv = [electron, appRoot,
  ...args]`, so `slice(2)` is already correct. Verify, do not "fix".
- Flags the launcher must pass through untouched: everything in `CLI_OPTIONS`
  (`electron/main.js:15-42`).
- Reserve, but do not implement here, the subcommands `update` (Phase 4), `doctor`,
  `install-desktop`/`uninstall-desktop` and `migrate` (Phase 5). Build the dispatch table now
  with a single default branch.

## Steps

1. `package.json`:
   - Remove `"private": true`.
   - Add `"bin": { "zbterm": "bin/zbterm.js" }`.
   - Add `"engines": { "node": ">=20" }` and `"publishConfig": { "access": "public" }`.
   - Add a `files` allowlist: `["bin/", "electron/", "engine/", "workers/", "renderer/",
     "build/icon.png", "build/icon/", "README.md", "LICENSE", "LICENSE-APACHE",
     "LICENSE-COMMERCIAL"]`.
   - Move `electron` from devDependencies to dependencies (keep the `^40.2.1` range).
   - Move `brittle` from dependencies to devDependencies (only tests require it).
   - Leave `imports`, `main`, `allowScripts`, `upgrade` and all forge devDependencies alone.
2. New file `bin/zbterm.js`, `#!/usr/bin/env node`, mode 0755, LF line endings:
   - `const electronPath = require('electron')` → a string path; if it is not a string or the
     file is missing, print a fix hint (`npm rebuild electron`, `ELECTRON_MIRROR` for proxies)
     and exit 1. Respect `ELECTRON_OVERRIDE_DIST_PATH` if set.
   - App root = `path.join(__dirname, '..')`.
   - Dispatch table on `process.argv[2]`; only `--version`/`-v` (print `package.json` version,
     exit 0) and the default pass-through branch exist in this phase.
   - Spawn `electron [appRoot, ...process.argv.slice(2)]` with `stdio: ['inherit','inherit','pipe']`,
     tee child stderr to `process.stderr` while buffering the first 8 KB.
   - Forward `SIGINT`/`SIGTERM` to the child; exit with the child's code, or `128 + signal`.
   - Linux sandbox fallback: if the child exits non-zero within 10 s, `--no-sandbox` was not
     already passed, and the buffered stderr matches `/SUID sandbox|chrome-sandbox|namespace
     sandbox|Failed to move to new namespace/`, print one warning line to stderr and re-spawn
     once with `--no-sandbox` appended. Never retry more than once.
3. Add `.gitignore` entries for the pack artifacts (`*.tgz`).
4. Append the handoff block.

## Acceptance criteria

- `npm pack --dry-run` lists no path under `out/`, `node_modules/`, `test/`, `docs/`,
  `spikes/`, `assets/`, `relay/`, `flatpak/`, and does not list `forge.config.js`,
  `build_all.sh`, `package-lock.json`, or `roadmap_pixelated.png`.
- Packed tarball is < 5 MB.
- After a global install into a scratch prefix, `zbterm --help` exits 0 and prints
  `Usage: ZBTerm`, with no display available.
- `zbterm --debug-server --debug-server-port <port> --storage <dir>` under `xvfb-run` serves
  `GET /health` with HTTP 200.
- `zbterm --version` prints the same string as `node -p "require('./package.json').version"`
  without launching Electron (verify: no Electron process appears).
- Ctrl-C / `kill -TERM` on the launcher terminates the Electron process too (no orphan).

## Verification

```bash
cd /zp/zdata/zeev/github/zbterm
npm run lint && npm test
npm pack --dry-run 2>&1 | tee /tmp/zbterm-pack.txt
grep -E "out/|node_modules/|test/|docs/|spikes/|assets/|relay/|forge.config.js" /tmp/zbterm-pack.txt \
  && echo "FAIL: unwanted files" || echo "PACK-CLEAN"
npm pack
rm -rf /tmp/p2t-prefix && npm install -g --prefix /tmp/p2t-prefix ./zbterm-*.tgz
/tmp/p2t-prefix/bin/zbterm --version
/tmp/p2t-prefix/bin/zbterm --help | head -1        # "Usage: ZBTerm [options]"
xvfb-run -a /tmp/p2t-prefix/bin/zbterm --debug-server --debug-server-port 17098 \
  --storage /tmp/zbterm-phase2 &
sleep 30 && curl -sf http://127.0.0.1:17098/health && echo HEALTH-OK
kill %1; sleep 3; pgrep -f "zbterm" && echo "FAIL: orphan process" || echo "NO-ORPHANS"
```

Pass = `PACK-CLEAN`, both `--version` and `--help` exit 0, `HEALTH-OK`, `NO-ORPHANS`.

## Top gotchas

- A global install nests dependencies under `<prefix>/lib/node_modules/zbterm/node_modules/`,
  but `npx` and workspace layouts hoist them one level up. Anything resolved by **relative
  path** (as opposed to `require`) breaks in the hoisted layout — that is Phase 3's problem;
  do not paper over it here by adding path guesses to the launcher.
- `require('electron')` inside `bin/zbterm.js` returns the **binary path string**, not the
  Electron API. Requiring anything from `electron/main.js` in the launcher will throw.
- Installing globally as a non-root user leaves `chrome-sandbox` without its setuid bit; the
  failure message goes to stderr and the process exits ~1 immediately. That is why stderr is
  piped rather than inherited.
- `npm pack` ignores `.gitignore` once `files` exists, but still always excludes
  `node_modules/` and always includes `package.json`/`README`/`LICENSE`. Do not add
  `.npmignore` — two mechanisms will fight.
- On Linux, `npm install -g zbterm` compiles `node-pty` from source. If python3/g++ are
  missing, install fails at that point with a node-gyp error — note it for Phase 6's README.

## Re-planning signals

- If the packed tarball exceeds 5 MB, or `renderer/` needs assets that are not in the repo →
  pull Phase 3 forward before continuing.
- If the sandbox fallback fires on a normal desktop (not just scratch prefixes), promote
  `--no-sandbox` detection into a persisted preference and add a `doctor` check for it in
  Phase 5.
- If `app.isPackaged` turns out true for an npm install (Electron changing its heuristic),
  the argv slicing at `electron/main.js:124` needs a channel-aware branch — add it to Phase 4.

## Re-planning outcome

Signal 1 did **not** fire: tarball is 146.8 kB (44 files, 598.1 kB unpacked) and the renderer
reached `phase: "ready"` from the nested global layout, so Phase 3 stays in place. Signal 2 did
**not** fire: the sandbox fallback never triggers on this host (Fedora, unprivileged user
namespaces enabled, `chrome-sandbox` 0755 non-setuid → Chromium uses the namespace sandbox); it
was exercised by injecting a fake binary via `ELECTRON_OVERRIDE_DIST_PATH`. Signal 3 did **not**
fire: `app.isPackaged` is `false` for an npm install (`argv = [.../dist/electron, <appRoot>,
...args]`), so `slice(2)` is correct and Phase 4 needs no channel-aware argv branch.

**New signal, not anticipated by the plan:** moving `brittle` to devDependencies broke the Bare
engine worker. `package.json#imports` maps `crypto` → `bare-crypto`, and `bare-crypto` reached
`node_modules` only transitively via `brittle → bare-cov → bare-inspector → bare-ws`. A fresh
install died with `MODULE_NOT_FOUND: crypto` from `engine/share-manager.js` while `/health`
still answered **HTTP 200** with `{"ok":false,"engineReady":false}` — i.e. the phase's stated
acceptance criterion would have passed over a dead app. Fixed here by declaring
`"bare-crypto": "^1.15.3"` in dependencies. `bare-fs`, `bare-path`, `bare-os` and `bare-events`
are still undeclared and survive only via `pear-runtime`. Consequences pushed into later phases:
Phase 3 gains a step to declare those four explicitly, and every remaining health check in the
plan now asserts `engineReady: true` rather than HTTP 200.

## Handoff notes

- Decisions: `bare-crypto` added to `dependencies` (see above); `package-lock.json` regenerated
  with `npm install --package-lock-only`; `bin/` is NOT in the `lint`/`format` prettier+lunte
  globs, so run `npx prettier --write bin/zbterm.js && npx lunte bin` by hand.
- Gotchas: `app.isPackaged` is **false** for an npm/global install, so `slice(2)` is correct;
  `allowScripts` pins `electron@40.10.1` but npm resolves 40.10.6, so every install prints an
  allow-scripts warning and only the repo-local `.npmrc` (`ignore-scripts=false`) makes the
  electron/node-pty install scripts actually run — installing from another cwd will silently
  skip the Electron binary download; graceful shutdown with a live engine takes ~10–15 s, so the
  plan's `sleep 3` orphan check is far too short (poll until the PID is gone); the Linux sandbox
  fallback never fires on a host with unprivileged user namespaces enabled — exercise it with a
  fake binary via `ELECTRON_OVERRIDE_DIST_PATH`.
- Files: package.json, package-lock.json, bin/zbterm.js (new, 0755), .gitignore,
  docs/npm-zbterm-handoff.md
- Deviations: added the `bare-crypto` dependency and regenerated `package-lock.json`, neither of
  which the plan section listed; nothing else diverged.

## Verification output (2026-08-08)

`npm run lint && npm test` — exit 0

```
> zbterm@1.0.44 lint
> prettier --check package.json forge.config.js electron engine renderer test workers && lunte electron engine renderer test workers forge.config.js

Checking formatting...
All matched files use Prettier code style!
62 warnings
```

```
# tests = 106/106 pass
# asserts = 409/409 pass
# time = 19247.349234ms

# ok
```

`npm pack --dry-run` + grep

```
npm notice package size: 146.8 kB
npm notice unpacked size: 598.1 kB
npm notice total files: 44
--- grep ---
PACK-CLEAN
NO-EXTRAS          (build_all.sh|package-lock.json|roadmap_pixelated.png|flatpak/)
```

Tarball contents: `LICENSE, LICENSE-APACHE, LICENSE-COMMERCIAL, README.md, bin/zbterm.js,
build/icon.png, build/icon/*, electron/*, engine/*, package.json, renderer/*, workers/*`.

`npm pack` / global install

```
zbterm-1.0.44.tgz     (146817 bytes)
INSTALL EXIT: 0
added 161 packages in 29s
```

`--version` / `--help`

```
=== zbterm --version ===
1.0.44
exit=0
=== zbterm --help | head -1 ===
Usage: ZBTerm [options]
exit=0
```

`--version` spawns no child (`pgrep -P <launcher>` empty). `--help` ran with `DISPLAY` and
`WAYLAND_DISPLAY` unset and printed the full 14-flag option list.

`xvfb-run` + `/health`

```
HTTP 200
{"ok":true,"engineReady":true,"renderer":{"ok":true,"phase":"ready",...}}
HEALTH-OK
```

Orphan check (scoped to spawned PIDs; `kill -TERM <launcher>`)

```
NO-ORPHANS
```

Also verified with `SIGINT` — the whole Electron tree plus the `bare` engine worker and `Xvfb`
exit.

Sandbox fallback (fake binary via `ELECTRON_OVERRIDE_DIST_PATH`, since it cannot fire naturally
on this host)

```
zbterm: Chromium sandbox unavailable (chrome-sandbox is not setuid root); retrying with --no-sandbox
FAKE-ELECTRON argv: <appRoot> --storage /tmp/zzz
FAKE-ELECTRON argv: <appRoot> --storage /tmp/zzz --no-sandbox
```

Always-failing binary → exactly 2 spawns, 1 warning, exit 1. `--no-sandbox` already present → 1
spawn, no retry. Missing binary → hint text, exit 1.

All temp artifacts (`/tmp/p2t-prefix`, `/tmp/zbterm-phase2*`, `/tmp/p2t-probe`, `/tmp/p2t-fake`,
`zbterm-*.tgz`) were removed; every launch ran under `XDG_CONFIG_HOME=/tmp/zbterm-phase2-home`.


---

# Phase 3 — Self-contained renderer assets — ✅ done 2026-08-08

## Goal

The renderer loads xterm, its addons and Font Awesome from files inside the package
(`renderer/vendor/`), so the UI works under every npm layout (global, local, npx, hoisted)
instead of only when `node_modules` happens to sit next to `renderer/`.

## Requirements & inputs

Read: `renderer/index.html` (lines 6–7), `renderer/app.js` (lines ~490–510,
`loadScriptOnce`), `test/renderer-static.test.js`, `package.json` `files` list from Phase 2,
`docs/npm-zbterm-handoff.md`.

Assets that must be vendored (exact sources):

| Source | Destination |
| --- | --- |
| `node_modules/@xterm/xterm/lib/xterm.js` | `renderer/vendor/xterm/xterm.js` |
| `node_modules/@xterm/xterm/css/xterm.css` | `renderer/vendor/xterm/xterm.css` |
| `node_modules/@xterm/addon-fit/lib/addon-fit.js` | `renderer/vendor/xterm/addon-fit.js` |
| `node_modules/@xterm/addon-webgl/lib/addon-webgl.js` | `renderer/vendor/xterm/addon-webgl.js` |
| `node_modules/@fortawesome/fontawesome-free/css/all.min.css` | `renderer/vendor/fontawesome/css/all.min.css` |
| `node_modules/@fortawesome/fontawesome-free/webfonts/*.woff2` | `renderer/vendor/fontawesome/webfonts/` |

Contracts to honor:

- Font Awesome's CSS references `../webfonts/...`; the `css/` + `webfonts/` sibling layout
  above is required for those URLs to resolve. Do not flatten it.
- `@xterm/headless` and `@xterm/addon-serialize` are used by engine code through `require` —
  leave them as normal dependencies, do not vendor them.
- Copy only. No bundling, minification or version rewriting.

## Steps

1. New file `scripts/vendor-assets.js`: resolves each source via `require.resolve` (never a
   hardcoded `node_modules` path), copies to the destinations above, creates directories,
   is idempotent, and exits non-zero with the missing specifier named if a source is absent.
2. `renderer/index.html`: point the two `<link>` tags at `vendor/xterm/xterm.css` and
   `vendor/fontawesome/css/all.min.css`.
3. `renderer/app.js`: point the three `loadScriptOnce` calls at `vendor/xterm/xterm.js`,
   `vendor/xterm/addon-fit.js`, `vendor/xterm/addon-webgl.js`.
4. `package.json` scripts: add `"vendor:assets": "node scripts/vendor-assets.js"`, and run it
   from `"prepack"` and from `"pretest"` (so a fresh clone's tests exercise the same paths).
   Keep `start` working on a fresh clone — if `prestart` is easier than documenting, add it.
5. `.gitignore`: add `renderer/vendor/`. `package.json#files` already covers `renderer/`, so
   the generated directory ships in the tarball — confirm this after `npm pack`.
6. Extend `test/renderer-static.test.js` with a case asserting that neither
   `renderer/index.html` nor `renderer/app.js` contains the string `../node_modules`.
7. Declare the Bare runtime modules that today reach `node_modules` only transitively via
   `pear-runtime`: add `bare-fs`, `bare-path`, `bare-os` and `bare-events` to `dependencies`
   at the versions currently installed (`node -p "require('bare-fs/package.json').version"`
   etc.), and regenerate the lockfile with `npm install --package-lock-only`. Phase 2 hit the
   same class of bug with `bare-crypto` — a fresh install lost it and the engine died with
   `MODULE_NOT_FOUND` while `/health` still returned HTTP 200. Do not add any other dependency.
8. Append the handoff block.

## Acceptance criteria

- `grep -r "\.\./node_modules" renderer/` returns nothing.
- `tar -tzf zbterm-*.tgz | grep renderer/vendor` lists all six asset groups, including the
  `.woff2` files.
- The app renders a terminal with correct fonts and icons when launched from a global install
  whose `node_modules` has been renamed away (proves nothing resolves outside the package).
- `scripts/vendor-assets.js` run twice in a row produces identical output and exit 0.
- A normal global install (`node_modules` intact) reports `"engineReady":true` on `/health` —
  proving step 7's dependency declarations did not regress the engine.

## Verification

```bash
cd /zp/zdata/zeev/github/zbterm
node scripts/vendor-assets.js && node scripts/vendor-assets.js && echo VENDOR-IDEMPOTENT
grep -r "\.\./node_modules" renderer/ && echo "FAIL" || echo "NO-NODE_MODULES-REFS"
npm test                                    # includes the new renderer-static case
npm pack && tar -tzf zbterm-*.tgz | grep -c "renderer/vendor/"   # >= 9 entries
rm -rf /tmp/p2t-prefix && npm install -g --prefix /tmp/p2t-prefix ./zbterm-*.tgz
# 1) intact install must still boot the engine (guards step 7's dependency changes)
XDG_CONFIG_HOME=/tmp/p2t-home3 xvfb-run -a /tmp/p2t-prefix/bin/zbterm \
  --debug-server --debug-server-port 17096 --storage /tmp/zbterm-phase3a &
sleep 30
curl -s http://127.0.0.1:17096/health | grep '"engineReady":true' && echo ENGINE-READY
# 2) hidden node_modules proves the renderer resolves its own assets
mv /tmp/p2t-prefix/lib/node_modules/zbterm/node_modules /tmp/p2t-hidden-nm
XDG_CONFIG_HOME=/tmp/p2t-home3 xvfb-run -a /tmp/p2t-prefix/bin/zbterm \
  --debug-server --debug-server-port 17097 --storage /tmp/zbterm-phase3 &
sleep 30
curl -sf http://127.0.0.1:17097/renderer/terminal-display | head -c 200; echo
mv /tmp/p2t-hidden-nm /tmp/p2t-prefix/lib/node_modules/zbterm/node_modules
```

Pass = `VENDOR-IDEMPOTENT`, `NO-NODE_MODULES-REFS`, `# tests = N/N pass` + `# ok`, ≥ 9 vendored
entries, `ENGINE-READY`. The hidden-`node_modules` launch is expected to fail to boot the
**engine** (that legitimately needs `node_modules`); what must be observed is that the
renderer's own asset requests do not 404 — check the launcher's stderr for `ERR_FILE_NOT_FOUND`
on any `vendor/` path and treat any such line as a failure.

Signal each launcher by the PID you spawned and poll until it is gone (shutdown with a live
engine takes ~10–15 s); never `kill` a PID you did not start, and never let a launch touch the
real `~/.config`.

## Top gotchas

- `loadScriptOnce` paths are relative to `renderer/index.html`'s document URL, not to
  `app.js` — `vendor/xterm/xterm.js` (no `../`) is correct.
- The webgl addon fails soft on machines without GPU acceleration; a missing terminal is an
  asset problem, a fuzzy/slow terminal is not.
- `require.resolve('@fortawesome/fontawesome-free/css/all.min.css')` works only because that
  package has no restrictive `exports` map — if resolution throws, resolve the package's
  `package.json` and join from its directory rather than hardcoding `node_modules`.
- Adding `pretest` makes every `npm test` write into `renderer/vendor/`; make sure the script
  is quiet on success or the brittle output gets noisy enough to hide failures.

## Re-planning signals

- If Font Awesome's vendored footprint pushes the tarball over 5 MB, add a phase to subset the
  icon set (the repo uses a small number of `fa-` classes in `renderer/index.html`).
- If any renderer asset turns out to be generated rather than copied (e.g. `logo.svg`
  pipeline), fold that generator into `prepack` and note it — Phase 6's pack check must cover it.

## Re-planning outcome

Signal 1 did **not** fire: vendored Font Awesome is 347 KB unpacked (90 KB CSS + 257 KB across
4 `.woff2`), the whole tarball is 618 KB compressed — an order of magnitude under 5 MB, and the
largest vendored file is `xterm.js` (489 KB), not FA. No icon-subsetting phase needed.

Signal 2 **fired**: `renderer/logo-ascii.generated.js` is produced by `scripts/generate-icons.js`
(`npm run icons`), which needs the `sharp` **devDependency**. It is committed to git so it ships
today, but nothing regenerates or validates it at pack time. Folding `npm run icons` into
`prepack` would make packing depend on `sharp`. Resolution: Phase 6's pack-check script gains a
step asserting the committed file is present and non-empty in the tarball, and explicitly does
**not** regenerate it; `docs/RELEASE-NPM.md` records that regenerating it is a deliberate manual
step run only when the logo changes.

Two further observations recorded for later phases: `.lunteignore` did not exist and had to be
created (any future generated-into-`renderer/` output needs an entry there and in
`.prettierignore`), and `bare-*` packages block `require('<pkg>/package.json')` with
`ERR_PACKAGE_PATH_NOT_EXPORTED`, so version-probing them needs an absolute-path file read.

## Handoff notes

- Decisions: `vendor:assets` is wired to `prepack`, `pretest` AND `prestart` (fresh clone
  `npm start` works); `renderer/vendor` had to be added to a new `.lunteignore` and to
  `.prettierignore` or `npm run lint` fails on the minified xterm bundle;
  `scripts/vendor-assets.js` is quiet unless `--verbose`; the four `bare-*` deps were pinned at
  installed versions `bare-fs@^4.7.1`, `bare-path@^3.0.0`, `bare-os@^3.9.1`, `bare-events@^2.8.3`.
- Gotchas: `bare-*` packages have a restrictive `exports` map — `require('bare-fs/package.json')`
  throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, read the file by absolute path instead; the plan's
  hidden-`node_modules` check is unobservable — `electron/main.js` requires `pear-runtime` at
  load, so the whole main process dies before any window exists; hide only `@fortawesome` +
  `@xterm/{xterm,addon-fit,addon-webgl}` (keep `@xterm/headless` + `addon-serialize`) to actually
  exercise the renderer; a crashed Electron leaves a stray process holding the debug port and
  `xvfb-run`'s children survive killing the wrapper — kill the `electron/dist/electron` PID by
  cmdline match; `renderer/logo-ascii.generated.js` is generated by `npm run icons` (needs the
  `sharp` devDependency) but is committed, so it ships without a `prepack` step.
- Files: scripts/vendor-assets.js (new), renderer/index.html, renderer/app.js, package.json,
  package-lock.json, test/renderer-static.test.js, .gitignore, .prettierignore, .lunteignore
  (new), docs/npm-zbterm-handoff.md
- Deviations: added `.lunteignore` and a `.prettierignore` entry (not in the plan, required for
  `npm run lint` to exit 0) and a `prestart` script; the hidden-`node_modules` acceptance run was
  replaced by the targeted package-hiding variant described above.

## Verification output (2026-08-08)

```
$ node scripts/vendor-assets.js && node scripts/vendor-assets.js && echo VENDOR-IDEMPOTENT
VENDOR-IDEMPOTENT

$ grep -r "\.\./node_modules" renderer/ && echo "FAIL" || echo "NO-NODE_MODULES-REFS"
NO-NODE_MODULES-REFS

$ npm test
1..107
# tests = 107/107 pass
# asserts = 411/411 pass
# time = 19239.516246ms

# ok
      (new case:  ok 49 - renderer loads its assets from renderer/vendor, never from node_modules)

$ npm pack && tar -tzf zbterm-*.tgz | grep "renderer/vendor"
package/renderer/vendor/fontawesome/css/all.min.css
package/renderer/vendor/xterm/xterm.css
package/renderer/vendor/xterm/addon-fit.js
package/renderer/vendor/xterm/addon-webgl.js
package/renderer/vendor/xterm/xterm.js
package/renderer/vendor/fontawesome/webfonts/fa-brands-400.woff2
package/renderer/vendor/fontawesome/webfonts/fa-regular-400.woff2
package/renderer/vendor/fontawesome/webfonts/fa-solid-900.woff2
package/renderer/vendor/fontawesome/webfonts/fa-v4compatibility.woff2
$ tar -tzf zbterm-*.tgz | grep -c "renderer/vendor/"
9

$ npm install -g --prefix /tmp/p2t-prefix ./zbterm-1.0.44.tgz
added 161 packages in 30s

# launch 1 (node_modules intact), port 17096
$ curl -s http://127.0.0.1:17096/health
{"ok":true,"engineReady":true,"renderer":{"ok":true,"phase":"ready","app":{...,"terminalReady":true,"startupPhase":"ready","startupError":null}},...}
ENGINE-READY
$ grep -c "ERR_FILE_NOT_FOUND" /tmp/p2t-launch-a.log
0

# launch 2 (renderer packages hidden), port 17097
$ curl -s http://127.0.0.1:17097/health
{"ok":true,"engineReady":true,"renderer":{"ok":true,"phase":"ready","app":{...,"terminalReady":true,...}},...}
$ grep -n "ERR_FILE_NOT_FOUND\|Failed to load resource\|net::ERR" /tmp/p2t-launch-b.log
NONE
$ curl -s -X POST http://127.0.0.1:17097/sessions -d '{}'
{"sessionId":"dfde44fa...","name":"zeev @ zx1 #1",...,"active":true,...}

$ npm run lint
LINT-EXIT=0        (62 pre-existing require-await WARNINGs, 0 errors)

# failure path
$ cd /tmp/vtest && node scripts/vendor-assets.js
vendor-assets: cannot resolve @xterm/xterm/lib/xterm.js - is @xterm/xterm installed?
EXIT=1
```

Deviation on the hidden-`node_modules` run: the plan's literal command is unobservable, because
`electron/main.js` does `require('pear-runtime')` at load and the main process dies before any
BrowserWindow exists. The targeted variant — hiding `@fortawesome` and
`@xterm/{xterm,addon-fit,addon-webgl}` while keeping `@xterm/headless` + `addon-serialize` —
is a strictly stronger proof for this criterion: the app booted with `terminalReady: true`
(which is `!!state.term`, a live xterm `Terminal` instance), created a session successfully, and
logged zero `ERR_FILE_NOT_FOUND`. Everything was restored afterwards.

All temp artifacts removed; `~/.config` never touched; `xvfb-run` was available and used.


---

# Phase 4 — npm update channel, Pear OTA off — ✅ done 2026-08-08

## Goal

A build installed from npm knows it came from npm: it never starts the Pear OTA updater
worker, it checks the npm registry at most once a day for a newer `zbterm`, and it surfaces
"update available — run `npm i -g zbterm@latest`" in the existing update button, with
`zbterm update` running that command for the user. Packaged (forge/OTA) and dev builds behave
exactly as they do today.

## Requirements & inputs

Read: `electron/main.js` (`getWorker` at line 967, `ipcMain.handle('pear:startWorker')` at
1152, `handleAppInvoke` at 574, `pear:applyUpdate` at 1135), `renderer/app.js`
(`wireUpdater` at line 4383, `loadAppInfo` around line 282), `electron/preload.js`,
`workers/main.js`, `bin/zbterm.js`, `docs/npm-zbterm-handoff.md`.

Contracts to honor:

- `app.info` already returns `{ name, debugServer }` and the renderer reads it via
  `api.invoke('app.info')`. Extend that object; do not add a new IPC channel.
- The renderer's update button (`els.updateBtn`, `renderer/app.js:215`) is the only update UI.
  Reuse it; do not add new UI surfaces.
- Pear OTA must keep working unchanged on the packaged channel — `workers/main.js` and the
  `pear:applyUpdate` handler stay as they are.
- No new runtime dependencies. Use Node's `https` (or Electron's `net`) and a hand-written
  semver compare for `MAJOR.MINOR.PATCH`.

## Steps

1. New file `electron/update-channel.js` exporting:
   - `detectChannel({ appPath, isPackaged, env })` → `'npm' | 'packaged' | 'dev'`.
     Order: `env.ZBTERM_CHANNEL` wins if set; else `'npm'` when the app root path contains a
     `node_modules${path.sep}zbterm` segment; else `'packaged'` when `isPackaged`; else `'dev'`.
   - `checkForUpdate({ currentVersion, registryUrl, timeoutMs, cache })` → `{ available,
     latest, current, checkedAt }`. `registryUrl` defaults to
     `https://registry.npmjs.org/zbterm/latest`, `timeoutMs` to 5000. Any network/parse error
     resolves to `{ available: false, error: <message> }` — never throws, never blocks startup.
   - A 24 h TTL over the cached result, persisted through the caller-supplied `cache`
     getter/setter (backed by `preferences.json` via the existing
     `readPreferences`/`writePreferences` in `electron/main.js`).
2. `electron/main.js`:
   - Compute the channel once at startup; log it through `debugLog`.
   - When channel is `npm`: force the effective `updates` value to `false`, make
     `ipcMain.handle('pear:startWorker')` return `false` without calling `getWorker`, and make
     `pear:applyUpdate` reject with a clear message.
   - Extend `handleAppInvoke`'s `app.info` result with `channel` and `updateCheckEnabled`.
   - Add `app.updateCheck` to `handleAppInvoke` (async): returns `checkForUpdate(...)` on the
     npm channel, `{ available: false, reason: 'channel' }` otherwise. Honor
     `--no-update-check` (add it to `CLI_OPTIONS`) and `ZBTERM_NO_UPDATE_CHECK=1`.
3. `renderer/app.js` `wireUpdater()`: branch on `state.appInfo.channel`. On `npm`, skip
   `bridge.startWorker` entirely; call `api.invoke('app.updateCheck')`, and when
   `available` show `els.updateBtn` labelled with the new version. Clicking it copies
   `npm i -g zbterm@latest` to the clipboard (`bridge.writeClipboardText`) and sets the status
   line to that command. Keep the existing OTA path untouched for other channels.
4. `bin/zbterm.js`: implement the reserved `update` subcommand — spawn
   `npm install -g zbterm@latest` with `stdio: 'inherit'`, exit with its code. On Windows spawn
   `npm.cmd`.
5. New test `test/update-check.test.js` (brittle): serve a fake registry from
   `http.createServer`, pass its URL as `registryUrl`, assert newer/equal/older/malformed/
   timeout cases and that the TTL suppresses a second network call.
6. Append the handoff block.

## Acceptance criteria

- With `ZBTERM_CHANNEL=npm`, no Bare updater worker process is spawned (verify by process
  listing, or by asserting `pear:startWorker` returned `false`), and the app still reaches
  `ready`.
- With `ZBTERM_CHANNEL=packaged`, the updater worker still starts — the OTA path is unchanged.
- `app.info` includes `channel`, and `app.updateCheck` returns `available: true` against a
  fake registry serving a higher version, `false` for equal/lower.
- A registry that times out or returns garbage yields `{ available: false }` and adds no more
  than `timeoutMs` to the call — startup is never blocked by it.
- `zbterm update` invokes `npm install -g zbterm@latest` (assert on a stubbed PATH `npm`, not
  by actually installing).

## Verification

```bash
cd /zp/zdata/zeev/github/zbterm
npm run lint
npx brittle-node test/update-check.test.js      # "# tests = N/N pass" + "# ok"
npm test
# npm channel: no updater worker, app still healthy
ZBTERM_CHANNEL=npm xvfb-run -a npm start -- --debug-server --debug-server-port 17096 \
  --storage /tmp/zbterm-phase4 &
sleep 30
curl -sf http://127.0.0.1:17096/health && echo HEALTH-OK
curl -s http://127.0.0.1:17096/events | grep -c "pear:worker" # expect 0
pgrep -af "workers/main.js" && echo "FAIL: OTA worker running" || echo "NO-OTA-WORKER"
kill %1
# packaged channel still starts the updater worker
ZBTERM_CHANNEL=packaged xvfb-run -a npm start -- --storage /tmp/zbterm-phase4b &
sleep 30 && pgrep -af "workers/main.js" >/dev/null && echo "OTA-WORKER-OK" || echo "FAIL"
kill %1
```

Pass = `# tests = N/N pass` + `# ok`, `HEALTH-OK`, `NO-OTA-WORKER`, `OTA-WORKER-OK`.

## Top gotchas

- `getWorker` (`electron/main.js:967`) is also reachable from `pear:applyUpdate`; gating only
  `pear:startWorker` leaves a second path that spawns the updater.
- `wireUpdater()` currently runs unconditionally during renderer startup and sets the status
  line to `starting updater`; on the npm channel that string is now wrong — update it or the
  e2e's status assertions drift.
- The registry check must not run in tests or the e2e: default it off unless the channel is
  `npm` **and** the app is not running with `--debug-server`, or the e2e will make live network
  calls and flake offline.
- `npm view`/`registry.npmjs.org` returns 404 until the package is first published — treat 404
  as `{ available: false }`, not as an error banner.

## Re-planning signals

- If channel detection misfires for `npx zbterm` or for `npm link` development installs, add a
  postinstall-written marker file (`.npm-channel` next to `package.json`, listed in `files`)
  and detect on that instead — record the change for Phase 5's `doctor`.
- If the clipboard-only update flow tests badly, escalate to running `zbterm update` from the
  app via a spawned terminal — that needs a new IPC route and belongs in its own phase.

## Re-planning outcome

Signal 1 did **not** fire: a global install root (`.../node_modules/zbterm`) detects `npm`,
`node_modules/zbterm-tools` does not false-positive, and `app.isPackaged` stays `false` for npm
installs so `packaged` is never stolen. `npm link` symlinks `<prefix>/lib/node_modules/zbterm`
to the repo and `app.getAppPath()` resolves through the symlink, so a linked dev checkout
detects `dev` — the desired outcome. `npx zbterm` unpacks into
`~/.npm/_npx/<hash>/node_modules/zbterm`, which does contain the segment, so it detects `npm`
and would offer `npm i -g zbterm@latest` to someone who never installed it — mildly wrong but
harmless, since the button only copies a command. **No `.npm-channel` postinstall marker was
added**; Phase 5's `doctor` calls `detectChannel` directly.

Signal 2 did **not** fire: the clipboard-only flow is one IPC call with no failure mode, carried
by the existing button and status line. No spawned-terminal phase warranted.

**New signal, blocking, promoted into Phase 5 as step 1:** `npm start`, `npm run package` and
`npm run make` are **broken in this tree**. Phase 2 moved `electron` from `devDependencies` to
`dependencies`, and `@electron-forge/core-utils` reads the Electron version from
`devDependencies` only — every forge entry point now dies with `Error: Could not find any
Electron packages in devDependencies`. That contradicts locked decision 6 ("electron-forge
makers, flatpak/snap/MSIX packaging and the Pear OTA release path stay working and unchanged"),
so it is fixed at the next opportunity rather than deferred to Phase 6. All GUI verification in
this phase went through `node bin/zbterm.js` instead.

## Handoff notes

- Decisions: an unknown `ZBTERM_CHANNEL` value is ignored (falls through to detection) instead
  of becoming a fourth channel; `ZBTERM_REGISTRY_URL` overrides the registry **and** is the only
  way to keep the check on under `--debug-server` (default stays off there, so no live network
  in e2e); the 24 h cache lives in `preferences.json` under `zbterm.updateCheck`, is invalidated
  when `current` differs, and failures/timeouts are never cached (only 200 and 404 are).
- Gotchas: **`npm start` is broken in this tree** (see above) — every GUI run must go through
  `node bin/zbterm.js`; `--help` never exits (`main.js` calls `process.exit(0)` but the Electron
  child survives and `bin/zbterm.js` waits on it) — always run it under `timeout`;
  `handleAppInvoke` stayed sync and returns a promise for `app.updateCheck` (the `zbterm:invoke`
  handler awaits) — making it `async` would break its `!== null` fallthrough for every other
  method; running the app while `npm test` runs makes `test/engine-session.test.js` fail with
  `E_INTERNAL` (lock contention), so never overlap them.
- Files: electron/update-channel.js (new), electron/main.js, renderer/app.js, bin/zbterm.js,
  test/update-check.test.js (new), docs/npm-zbterm-handoff.md
- Deviations: added the `ZBTERM_REGISTRY_URL` escape hatch (not in the plan) so `app.updateCheck`
  is verifiable end to end; `update` was removed from `RESERVED_SUBCOMMANDS` in `bin/zbterm.js`
  now that it is implemented.

## Verification output (2026-08-08)

`npm run lint` — exit 0 (64 pre-existing `require-await` warnings, 0 errors)

```
> zbterm@1.0.44 lint
> prettier --check package.json forge.config.js electron engine renderer test workers && lunte electron engine renderer test workers forge.config.js

Checking formatting...
All matched files use Prettier code style!
64 warnings
```

`npx brittle-node test/update-check.test.js`

```
1..10
# tests = 10/10 pass
# asserts = 60/60 pass
# time = 881.55208ms

# ok
```

`npm test` (under a sandboxed `XDG_CONFIG_HOME`)

```
1..117
# tests = 117/117 pass
# asserts = 471/471 pass
# time = 20334.280027ms

# ok
```

npm channel — health + no OTA worker. `npm start` could not be used (see re-planning outcome);
launched via `node bin/zbterm.js` under `xvfb-run` + `setsid`:

```
{"ok":true,"engineReady":true,"renderer":{"ok":true,"phase":"ready","app":{...,"status":"ready",...}},...}
HEALTH-OK
```

```
2026-08-08T01:27:48.773Z [app:channel] {"channel":"npm","appPath":"/zp/zdata/zeev/github/zbterm","isPackaged":false,"updates":false,"updateCheckEnabled":false}
```

Process listing scoped to the spawned session id only:

```
--- workers/main.js within my session:
NO-OTA-WORKER
```

packaged channel — OTA worker still starts:

```
2600314 2599537 .../bare-sidecar/prebuilds/linux-x64/bare .../workers/main.js /tmp/zbterm-phase4b null false 1.0.44 pear://pzcjqmpoo6szkoc4bpkw65ib9ctnrq7b6mneeinbhbheihaq6p6o ZBTerm.AppImage
OTA-WORKER-OK
2026-08-08T01:30:06.563Z [app:channel] {"channel":"packaged",...,"updateCheckEnabled":false}
```

`app.updateCheck` end to end against a fake registry (extra runs beyond the plan's list).
Higher version served:

```
--- registry hits:
fake registry on 17190 serving 9.9.9
request /zbterm/latest
--- cached result in preferences.json:
{ "zbterm.updateCheck": { "available": true, "latest": "9.9.9", "current": "1.0.44", "checkedAt": 1786152557397 } }
```

Equal version served:

```
{ "zbterm.updateCheck": { "available": false, "latest": "1.0.44", "current": "1.0.44", "checkedAt": 1786152587318 } }
```

`--no-update-check` with a fake registry pointed at it: the registry log shows **no request**,
`updateCheckEnabled: false`. Help text carries
`--no-update-check   start without the npm registry update check (default: enabled on npm installs)`.

Timeout bound: `returned promptly (401ms)` for `timeoutMs: 400`; 404, 503, non-JSON, bad
version, unreachable host and bogus URL are all covered by the unit tests.
`zbterm update` against a stubbed PATH `npm` recorded `install -g zbterm@latest` and propagated
exit code 7 — no real install, no publish.

Everything spawned was killed by signalling only the agent's own session ids and polling to
zero; the user's live dev instance (pid 31417) was never touched; `/tmp/zbterm-phase4*` removed.


---

# Phase 5 — Desktop integration, `zbterm doctor`, `zbterm migrate` — ✅ done 2026-08-08

## Goal

`zbterm doctor` gives an actionable pass/fail report on everything an npm install can get
wrong (missing Electron binary, unbuildable `node-pty`, missing `bare` prebuild, no display,
sandbox trouble, unwritable data dir); `zbterm install-desktop` registers the app with the
Linux desktop so `zbterm://` and `zbterm://` links open it and it appears in the launcher;
and `zbterm migrate --from <dir>` migrates a ZBTerm data tree that startup migration cannot
reach because it lives outside the userData root.

## Requirements & inputs

Read: `bin/zbterm.js` (dispatch table from Phase 2), `electron/update-channel.js` (Phase 4),
`electron/legacy-migrate.js` (Phase 1 — exports `migrateLegacyUserData({ stableUserData, log })`),
`electron/main.js:1245` (protocol registration), `build/icon/` (icon sizes 16–256 exist),
`docs/npm-zbterm-handoff.md`.

Contracts to honor:

- `doctor` runs in **Node**, not Electron: it may `require('node-pty')` directly (N-API makes
  that valid) but must not require anything from `electron/main.js`.
- `electron/legacy-migrate.js` is Node-safe and must be reused as-is by `migrate` — do not
  fork a second migration implementation, and do not require it from `engine/`/`workers/`.
- Both URL schemes must be claimed — `x-scheme-handler/zbterm` and
  `x-scheme-handler/zbterm` (Phase 1 kept the legacy scheme alive).
- Desktop-file installation is user-scoped (`~/.local/share/...`). Never write to `/usr/share`
  and never require root.
- On macOS/Windows the subcommands must exit 0 with a one-line explanation rather than failing.

## Steps

1. **Restore electron-forge (regression from Phase 2, do this first).** Phase 2 moved
   `electron` from `devDependencies` to `dependencies`, and `@electron-forge/core-utils` reads
   the Electron version from `devDependencies` only, so `npm start`, `npm run package` and
   `npm run make` all die with `Error: Could not find any Electron packages in devDependencies`.
   Locked decision 6 says forge, the makers and the flatpak/snap/MSIX packaging must keep
   working unchanged, so fix it here: keep `electron` in `dependencies` (the npm package needs
   it at runtime) and make forge resolve a version again — the simplest working fix is to list
   the **same** `electron` range in `devDependencies` as well; if npm or forge objects to the
   duplicate, instead set an explicit Electron version for forge in `forge.config.js`. Do not
   remove `electron` from `dependencies` and do not restructure the makers. Verify with the
   commands below; do not run a full `npm run make`.
2. `bin/zbterm.js`: implement the reserved `doctor`, `install-desktop`, `uninstall-desktop`
   and `migrate` branches, delegating to a new `bin/lib/doctor.js`, `bin/lib/desktop.js` and
   `bin/lib/migrate.js`.
3. `bin/lib/doctor.js` — each check returns `{ name, ok, detail, fix }`:
   - Node version ≥ engines range.
   - `require('electron')` resolves and the binary exists and is executable.
   - `require('node-pty')` loads and `pty.spawn` of `/bin/true` (or `cmd /c exit`) succeeds.
   - `bare-sidecar` prebuild exists for `${process.platform}-${process.arch}`.
   - Data dir (`~/.config/ZBTerm` or platform equivalent) exists or is creatable + writable.
   - Linux only: `DISPLAY`/`WAYLAND_DISPLAY` present; `chrome-sandbox` ownership/mode check
     with the `--no-sandbox` hint as `fix`.
   - Channel (from `electron/update-channel.js`) and installed version reported as info.
   - Support `--json`; exit 0 if every check passes, 1 otherwise.
4. `bin/lib/desktop.js`:
   - `install()` on Linux: write `~/.local/share/applications/zbterm.desktop` with
     `Exec=<absolute path to the zbterm bin> %u`, `Terminal=false`, `Type=Application`,
     `Categories=Development;System;TerminalEmulator;`,
     `MimeType=x-scheme-handler/zbterm;x-scheme-handler/zbterm;`, `Icon=zbterm`.
     Copy `build/icon/icon-<n>x<n>.png` into
     `~/.local/share/icons/hicolor/<n>x<n>/apps/zbterm.png` for every size present. Then best-
     effort run `update-desktop-database`, `xdg-mime default zbterm.desktop
     x-scheme-handler/zbterm` and the same for `zbterm`, ignoring missing binaries.
   - `uninstall()` removes exactly the files `install()` wrote.
   - Non-Linux: print the platform's story (Electron registers schemes at runtime) and exit 0.
5. `bin/lib/migrate.js` — `zbterm migrate --from <dir> [--to <dir>] [--dry-run]`. Phase 1's
   startup migration only ever looks at `<userData sibling>/ZBTerm`, so trees created with
   `--storage <dir>` or `--profile-path <dir>` are never migrated. This command closes that gap:
   - `--from` is required and must be an existing directory; `--to` defaults to the Electron
     userData root for `ZBTerm` on this platform (`~/.config/ZBTerm` on Linux).
   - Call `migrateLegacyUserData` from `electron/legacy-migrate.js` with the resolved roots
     rather than reimplementing the move, lock check, `zbterm-profiles` → `zbterm-profiles`
     rename, `window-state.json` `path:` rewrite or `.migrated-from-zbterm` marker. If its
     signature only accepts `stableUserData`, add an optional `legacyRoot` parameter there
     (defaulting to today's derived path) — that is the one edit permitted in that file.
   - `--dry-run` prints the planned source → destination moves and exits 0, touching nothing.
   - Print the returned summary as human-readable lines; exit 1 with the `reason` when
     `migrated` is false for any reason other than `already-migrated`.
6. `package.json#files`: confirm `bin/` covers `bin/lib/`; add `build/icon/` if Phase 2 omitted it.
7. New test `test/doctor.test.js` (brittle): run each check function with injected fakes
   (missing binary path, unwritable dir, absent prebuild) and assert `ok` and `fix` strings;
   plus a `desktop.js` test writing into a temp `HOME` and asserting the exact file set,
   including idempotent install and clean uninstall; plus a `migrate.js` test over two temp
   dirs covering `--dry-run` (no filesystem change), a successful explicit-root migration, and
   a non-existent `--from` exiting non-zero.
8. Append the handoff block.

## Acceptance criteria

- `zbterm doctor` on a healthy machine exits 0; with `ELECTRON_OVERRIDE_DIST_PATH` pointed at
  a nonexistent directory it exits 1 and names the electron check.
- `zbterm doctor --json` emits parseable JSON with one entry per check.
- `HOME=<tmp> zbterm install-desktop` creates exactly `applications/zbterm.desktop` plus one
  icon per size in `build/icon/`, and the desktop file contains both `x-scheme-handler`
  entries; running it twice changes nothing further; `uninstall-desktop` leaves the tmp HOME
  with none of those files.
- `desktop-file-validate ~/.local/share/applications/zbterm.desktop` passes (skip the check,
  with a printed note, if that tool is absent).
- `zbterm migrate --from <seeded-legacy-dir> --to <empty-dir> --dry-run` exits 0 and leaves
  both directories byte-identical; without `--dry-run` the destination ends up with
  `zbterm-profiles/` and `.migrated-from-zbterm`, and a second run exits 0 as a no-op.
- `zbterm migrate --from /nonexistent` exits non-zero and names the missing directory.
- electron-forge resolves an Electron version again: `npm start` launches the app (it must
  reach the debug server's `/health` with `"engineReady":true`) and forge's version lookup
  succeeds, while `electron` remains in `dependencies` so the npm tarball still installs a
  runnable app.

## Verification

```bash
cd /zp/zdata/zeev/github/zbterm
# step 1: forge resolves Electron again, and electron stays a runtime dependency
node -p "require('@electron-forge/core-utils').getElectronVersion(process.cwd(), require('./package.json'))" \
  | tail -1                                           # prints a version, no throw
node -p "!!require('./package.json').dependencies.electron"   # true
npx electron-forge package --help >/dev/null && echo FORGE-OK
npm run lint && npx brittle-node test/doctor.test.js   # "# tests = N/N pass" + "# ok"
node bin/zbterm.js doctor; echo "exit=$?"              # exit=0
node bin/zbterm.js doctor --json | python3 -m json.tool >/dev/null && echo JSON-OK
ELECTRON_OVERRIDE_DIST_PATH=/nonexistent node bin/zbterm.js doctor; echo "exit=$?"  # exit=1
export FAKEHOME=$(mktemp -d)
HOME=$FAKEHOME node bin/zbterm.js install-desktop
find $FAKEHOME -type f | sort
grep -c "x-scheme-handler" $FAKEHOME/.local/share/applications/zbterm.desktop   # 1 line, 2 handlers
desktop-file-validate $FAKEHOME/.local/share/applications/zbterm.desktop && echo DESKTOP-VALID
HOME=$FAKEHOME node bin/zbterm.js install-desktop     # idempotent
HOME=$FAKEHOME node bin/zbterm.js uninstall-desktop
find $FAKEHOME -type f | wc -l                        # 0
# explicit-root migration
export LEG=$(mktemp -d)/ZBTerm DST=$(mktemp -d)/ZBTerm
mkdir -p $LEG/zbterm-profiles/default && echo '{}' > $LEG/zbterm-profiles/profiles.json
node bin/zbterm.js migrate --from $LEG --to $DST --dry-run; echo "dry=$?"   # dry=0
test -d $LEG/zbterm-profiles && echo DRY-RUN-UNTOUCHED
node bin/zbterm.js migrate --from $LEG --to $DST; echo "mig=$?"             # mig=0
ls $DST/zbterm-profiles $DST/.migrated-from-zbterm
node bin/zbterm.js migrate --from /nonexistent; echo "bad=$?"               # bad!=0
rm -rf $(dirname $LEG) $(dirname $DST) $FAKEHOME
```

Then confirm `npm start` works again (it is currently broken):

```bash
XDG_CONFIG_HOME=/tmp/p2t-home5 xvfb-run -a npm start -- \
  --debug-server --debug-server-port 17095 --storage /tmp/zbterm-phase5 &
sleep 40
curl -s http://127.0.0.1:17095/health | grep '"engineReady":true' && echo NPM-START-OK
```

Signal only the PIDs you spawned and poll until they are gone (~10–15 s); never `kill` a PID you
did not start, and never let a launch touch the real `~/.config`.

Pass = `# tests = N/N pass` + `# ok`, the exit codes above, `JSON-OK`, `DESKTOP-VALID` (or the
skip note), 0 files left after uninstall, `DRY-RUN-UNTOUCHED`, the two migrated paths listed,
`FORGE-OK` and `NPM-START-OK`.

## Top gotchas

- `Exec=` must be the **resolved absolute path** of the installed bin (follow symlinks from
  `process.argv[1]`), not `zbterm` — desktop launches do not inherit the user's PATH.
- `migrate` must refuse when the destination root already has data — Phase 1's
  `migrateLegacyUserData` returns `{ migrated: false, reason: 'new-root-not-empty' }` in that
  case, and merging two trees is not supported. Do not add a `--force` that bypasses it.
- On this machine `~/.config/ZBTerm` is a 4.5 GB live tree with a running dev instance;
  never point a test or a demo `migrate` at the real `~/.config`.
- `zbterm --help` never exits: `electron/main.js` prints help and calls `process.exit(0)`, but
  the Electron child survives and `bin/zbterm.js` waits on it. Pre-existing — run any `--help`
  invocation under `timeout`, and do not try to fix it in this phase.
- Running the app while `npm test` runs makes `test/engine-session.test.js` fail with
  `E_INTERNAL` (profile lock contention). Never overlap a GUI launch with the test suite.
- The `%u` field code is required for scheme handling; without it the app launches with no
  link argument and the user sees a blank session.
- `node-pty`'s probe spawn leaks a PTY if not killed — always `kill()` in a `finally`.
- Electron's `app.setAsDefaultProtocolClient` on Linux writes a desktop entry pointing at the
  **electron binary** for unpackaged apps, which is wrong; `install-desktop` is the supported
  path and its file must win. Do not remove the runtime call (macOS/Windows need it).
- Doctor's `chrome-sandbox` check must not fail the run on systems using the unprivileged
  user-namespace sandbox — report it as a warning with `ok: true` unless the launcher's
  fallback actually fired.

## Re-planning signals

- If `xdg-mime`/`update-desktop-database` are commonly absent on target distros, add a phase
  for a `--print-only` mode that emits instructions instead of mutating the desktop database.
- If `doctor` needs to inspect anything only Electron can answer (GPU, sandbox at runtime),
  add a `--deep` mode that launches the app with `--debug-server` and queries `/health` —
  that is a separate phase, not an extension of this one.

## Re-planning outcome

Signal 1 (`--print-only`) fired, but not for the stated reason. `xdg-mime` and
`update-desktop-database` are both **present** on this Fedora/KDE host — they just lie:
`xdg-mime` needs `qtpaths` under KDE (absent here: `xdg-mime: line 885: qtpaths: command not
found`), it refuses to create `$XDG_CONFIG_HOME` itself, and it **exits 0 after failing to write
`mimeapps.list`**. Hook exit codes are therefore worthless as a success signal, which is the
same failure the signal was written to catch. Resolution: a new **Phase 7** covers
`install-desktop --print-only` plus verifying `mimeapps.list` content instead of trusting `$?`.

Signal 2 (`--deep` doctor) did **not** fire — everything the spec asked for was answerable from
Node and nothing blocked this phase. Recorded but **not scheduled**: `app.getGPUFeatureStatus()`,
whether Chromium's sandbox actually engaged at runtime (vs the launcher's `--no-sandbox` retry
firing), whether `setAsDefaultProtocolClient` returned true, and the *real*
`app.getPath('userData')` (doctor recomputes it from `productName`, so a divergence would go
unnoticed) are all Electron-only. Add a `--deep` phase only if a support case needs them.

Six observations were pushed into Phase 6's steps: lockfile-freshness gate, the `electron`
duplicate across `dependencies`/`devDependencies`, `doctor --json` as the smoke health gate,
tarball assertions for `bin/lib/*.js` and `build/icon/icon-*.png`, README/RELEASE-NPM content,
and the harmless `xdg-mime: application argument missing` stderr noise that log greps must not
treat as failure.

## Handoff notes

- Decisions: forge was fixed by listing the *same* `electron: ^40.2.1` range in
  `devDependencies` as well as `dependencies` (npm accepts the duplicate, `getElectronVersion`
  resolves 40.10.1, `package-lock.json` regenerated); `userDataRoot()` lives in
  `bin/lib/migrate.js` and doctor imports it rather than a third helper file; doctor emits 9
  entries (7 checks + `version`/`channel` as `info:true`) and `chrome-sandbox` is a `WARN`
  (ok:true) whenever `/proc/sys/user/max_user_namespaces > 0`; `migrate --from <gone> --to
  <migrated>` exits 0 (the source is *moved*, so re-running the exact command must be a no-op)
  while `--from /nonexistent` with an unmigrated `--to` still exits 1.
- Gotchas: `os.homedir()` just echoes `$HOME`, so "is this the real account home?" must use
  `os.userInfo().homedir` — needed because `xdg-mime` on KDE runs `kbuildsycoca6`, which drops a
  `~/.cache/ksycoca6_*` file that no uninstall should own (install now redirects
  `XDG_CACHE_HOME` to a throwaway dir whenever HOME is not the account home); `xdg-mime` will not
  create `$XDG_CONFIG_HOME` itself and *still exits 0* after failing to write `mimeapps.list`, so
  hook exit codes prove nothing; brittle teardowns run FIFO, so a `chmod` restore registered
  after the `rmSync` teardown never fires; prettier reformats `bin/` into shapes lunte's `curly`
  rule rejects, so run `npx prettier --write bin/ && npx lunte bin` and re-check.
- Files: package.json, package-lock.json, bin/zbterm.js, bin/lib/doctor.js (new),
  bin/lib/desktop.js (new), bin/lib/migrate.js (new), electron/legacy-migrate.js,
  test/doctor.test.js (new), docs/npm-zbterm-handoff.md
- Deviations: `uninstall-desktop` also strips the two `x-scheme-handler/*` lines from
  `mimeapps.list` and deletes `applications/mimeinfo.cache` when no `.desktop` files remain
  (needed for the "0 files left" acceptance; `install()` did not literally write them);
  `RESERVED_SUBCOMMANDS` in `bin/zbterm.js` became `SUBCOMMANDS` now that the list is empty of
  unimplemented names; `package.json#files` already covered `bin/` and `build/icon/`, so step 6
  was a no-op.

## Verification output (2026-08-08)

Step 1 — forge resolves Electron again:

```
$ node -p "require('@electron-forge/core-utils').getElectronVersion(process.cwd(), require('./package.json'))" | tail -1
Promise { '40.10.1' }

$ node -p "!!require('./package.json').dependencies.electron"
true

$ npx electron-forge package --help >/dev/null && echo FORGE-OK
FORGE-OK
```

Lint + new test:

```
$ npm run lint   -> exit 0 (79 pre-existing require-await warnings only)
$ npx brittle-node test/doctor.test.js
1..15
# tests = 15/15 pass
# asserts = 150/150 pass
# time = 117.621253ms

# ok
```

doctor:

```
$ node bin/zbterm.js doctor; echo "exit=$?"
zbterm doctor

  PASS  node           v24.18.0 (engines.node: >=20)
  PASS  electron       /zp/zdata/zeev/github/zbterm/node_modules/electron/dist/electron
  PASS  node-pty       spawned /bin/true (pid 2647691)
  PASS  bare-sidecar   linux-x64: .../node_modules/bare-sidecar/prebuilds/linux-x64/bare
  PASS  data-dir       /home/zeev/.config/ZBTerm (missing, creatable under /home/zeev/.config)
  PASS  display        WAYLAND_DISPLAY=wayland-0 DISPLAY=:1
  WARN  chrome-sandbox .../electron/dist/chrome-sandbox is not setuid root (uid 1000, mode 755); falling back to the unprivileged user-namespace sandbox
        fix: launch with `zbterm --no-sandbox` (the launcher retries automatically), or: sudo chown root:root ... && sudo chmod 4755 ...
  INFO  version        zbterm 1.0.44
  INFO  channel        dev (/zp/zdata/zeev/github/zbterm)

all checks passed
exit=0

$ node bin/zbterm.js doctor --json | python3 -m json.tool >/dev/null && echo JSON-OK
JSON-OK

$ ELECTRON_OVERRIDE_DIST_PATH=/nonexistent node bin/zbterm.js doctor; echo "exit=$?"
  FAIL  electron       Electron binary is missing: /nonexistent/electron
        fix: npm rebuild electron (behind a proxy: ELECTRON_MIRROR=... ; or point ELECTRON_OVERRIDE_DIST_PATH at an existing Electron dist)
1 of 9 checks failed
exit=1
```

install-desktop / uninstall-desktop (`HOME=$FAKEHOME`):

```
$ find $FAKEHOME -type f | sort
/tmp/tmp.1xpTNWTKtq/.config/mimeapps.list
/tmp/tmp.1xpTNWTKtq/.local/share/applications/mimeinfo.cache
/tmp/tmp.1xpTNWTKtq/.local/share/applications/zbterm.desktop
/tmp/tmp.1xpTNWTKtq/.local/share/icons/hicolor/128x128/apps/zbterm.png
/tmp/tmp.1xpTNWTKtq/.local/share/icons/hicolor/16x16/apps/zbterm.png
/tmp/tmp.1xpTNWTKtq/.local/share/icons/hicolor/256x256/apps/zbterm.png
/tmp/tmp.1xpTNWTKtq/.local/share/icons/hicolor/300x300/apps/zbterm.png
/tmp/tmp.1xpTNWTKtq/.local/share/icons/hicolor/32x32/apps/zbterm.png
/tmp/tmp.1xpTNWTKtq/.local/share/icons/hicolor/64x64/apps/zbterm.png

$ grep -c "x-scheme-handler" .../zbterm.desktop
1

$ desktop-file-validate .../zbterm.desktop && echo DESKTOP-VALID
.../zbterm.desktop: hint: value "Development;System;TerminalEmulator;" for key "Categories" contains more than one main category
DESKTOP-VALID
   (a "hint", not a warning/error; desktop-file-validate exits 0)

$ HOME=$FAKEHOME node bin/zbterm.js install-desktop   # second run: identical file list, byte-identical
$ HOME=$FAKEHOME node bin/zbterm.js uninstall-desktop
$ find $FAKEHOME -type f | wc -l
0
```

Desktop entry written (7 files: entry + 6 icon sizes 16/32/64/128/256/300):

```
Exec=/zp/zdata/zeev/github/zbterm/bin/zbterm.js %u
MimeType=x-scheme-handler/zbterm;x-scheme-handler/zbterm;
```

`mimeapps.list` contains `x-scheme-handler/zbterm=zbterm.desktop` and
`x-scheme-handler/zbterm=zbterm.desktop`.

migrate:

```
$ node bin/zbterm.js migrate --from $LEG --to $DST --dry-run; echo "dry=$?"
zbterm migrate (dry run) - nothing will be written
  /tmp/.../ZBTerm -> /tmp/.../ZBTerm
  /tmp/.../ZBTerm/zbterm-profiles -> /tmp/.../ZBTerm/zbterm-profiles
dry=0
DRY-RUN-UNTOUCHED

$ node bin/zbterm.js migrate --from $LEG --to $DST; echo "mig=$?"
[legacy-migrate] migrated /tmp/.../ZBTerm -> /tmp/.../ZBTerm
from: ... / to: ... / migrated: true / reason: ok / renamed: zbterm-profiles
mig=0

$ ls $DST/zbterm-profiles $DST/.migrated-from-zbterm
/tmp/.../ZBTerm/.migrated-from-zbterm
/tmp/.../ZBTerm/zbterm-profiles: default  profiles.json

$ node bin/zbterm.js migrate --from $LEG --to $DST; echo "second=$?"
nothing to do: .../ZBTerm was migrated already, and .../ZBTerm is gone
second=0

$ node bin/zbterm.js migrate --from /nonexistent; echo "bad=$?"
zbterm migrate: --from directory does not exist: /nonexistent
bad=1
```

`npm start` (previously broken):

```
$ curl -s http://127.0.0.1:17095/health | grep '"engineReady":true' && echo NPM-START-OK
{"ok":true,"engineReady":true,"renderer":{"ok":true,"phase":"ready",...}}
NPM-START-OK
```

Shut down with SIGTERM to the one Electron PID started (2659689), polled until gone. The
pre-existing dev instance on port 17069 was left untouched. `xvfb-run` and
`desktop-file-validate` are both available on this host.

Full suite:

```
$ npm test
1..132
# tests = 132/132 pass
# asserts = 621/621 pass
# ok
```


---

# Phase 6 — Release shell scripts and documentation — ✅ done 2026-08-08

## Goal

A maintainer can go from a clean tree to a published `zbterm` with three shell commands, each
of which fails loudly before doing anything irreversible; publishing requires an explicit
flag. The README tells users how to install, what Linux build prerequisites they need, and how
to update. No CI configuration is involved.

## Requirements & inputs

Read: `package.json` (post-Phase-2/3 scripts and `files`), `bin/zbterm.js`, `README.md`
(current install section starts at line 79), `build_all.sh` (existing shell-script
conventions to match), `docs/npm-zbterm-handoff.md`.

Contracts to honor:

- Scripts are POSIX-ish bash with `set -euo pipefail`, live in `scripts/`, take `--help`, and
  are runnable from any cwd (resolve the repo root from `$0`).
- Nothing in these scripts may touch `forge.config.js`, the makers, `pear.json`, or
  `build_all.sh` behavior.
- `npm publish` runs only from `scripts/release-npm.sh` and only when `--publish` is passed.
  Default behavior is a dry run.

## Steps

1. `scripts/npm-pack-check.sh`: runs `npm run lint`, `npm test`, `npm pack`; asserts the
   tarball contains `bin/zbterm.js`, `electron/main.js`, `renderer/vendor/` and **not**
   `out/`, `node_modules/`, `test/`, `docs/`, `spikes/`, `assets/`, `relay/`,
   `forge.config.js`; asserts `renderer/logo-ascii.generated.js` is present and non-empty in the
   tarball **without regenerating it** (it is produced by `npm run icons`, which needs the
   `sharp` devDependency, and is committed to git — do not add `icons` to `prepack`); prints the
   tarball size and fails if > 5 MB; asserts `bin/lib/doctor.js`, `bin/lib/desktop.js`,
   `bin/lib/migrate.js` and at least one `build/icon/icon-*.png` are present (`install-desktop`
   silently installs zero icons if `build/icon/` is missing from the tarball); gates on lockfile
   freshness with `npm install --package-lock-only && git diff --exit-code package-lock.json`
   (the lockfile has gone stale twice during this work); leaves the tarball path on stdout as the
   last line. Note `electron` is deliberately listed in **both** `dependencies` and
   `devDependencies` (forge reads only the latter) — do not flag that duplicate as an error.
2. `scripts/npm-smoke-install.sh [tarball]`: installs into `$(mktemp -d)` as a global prefix,
   runs `zbterm --version`, `zbterm doctor --json`, and — when `DISPLAY` is set or `xvfb-run`
   exists — launches with `--debug-server` on a free port under a sandboxed
   `XDG_CONFIG_HOME`, and polls `GET /health` for up to 60 s until the body contains
   `"engineReady":true`. **HTTP 200 alone is not a pass** — `/health` answers 200 with
   `{"ok":false,"engineReady":false}` when the Bare engine failed to load, which is exactly how
   a missing `bare-*` dependency manifests. Then terminate only the PIDs the script spawned,
   polling until they are gone (shutdown takes ~10–15 s), and assert no orphans. Cleans up the
   prefix on exit (trap), including on failure. Also run `zbterm doctor --json` as the primary
   health gate — it is the cheapest end-to-end proof and exits non-zero on a broken install — and
   assert the installed tree still has a runtime `electron` (global installs drop
   `devDependencies`, so the duplicate listing must not be the only copy). Ignore
   `xdg-mime: application argument missing` on stderr: Electron's own
   `setAsDefaultProtocolClient` emits it on every Linux launch and it is harmless. Any `--help`
   invocation must be wrapped in `timeout` — `zbterm --help` never exits (`electron/main.js`
   calls `process.exit(0)` but the Electron child survives and the launcher waits on it).
3. `scripts/release-npm.sh <patch|minor|major|x.y.z> [--publish] [--otp <code>] [--yes]`:
   - Guards, each evaluated and reported by name: clean `git status --porcelain`; current branch
     printed with a confirmation prompt unless `--yes`; `npm whoami` succeeds; `npm view zbterm
     version` compared against the target so a duplicate version fails early.
   - Runs `npm-pack-check.sh` then `npm-smoke-install.sh` on the produced tarball.
   - **Guard failures are reported, not fatal, on a dry run.** Without `--publish` the script
     always prints the exact commands it *would* run, then a `BLOCKERS:` section listing every
     failed guard; it exits **0** when there are none and **3** when there are, leaving the tree
     and git refs untouched either way. This matters because the repo's own working tree is
     intentionally dirty while this plan is being executed — a dry run must still be runnable and
     must still tell the maintainer exactly what stands between them and a release.
   - With `--publish`: any failed guard aborts non-zero **before** anything irreversible happens.
     Then `npm version <target>` (creates the commit + tag), `npm publish --access public`
     (passing `--otp` when given), then prints the `git push --follow-tags` command rather than
     running it.
4. `package.json` scripts: `"pack:check": "bash scripts/npm-pack-check.sh"`,
   `"smoke:install": "bash scripts/npm-smoke-install.sh"`, `"release:npm": "bash
   scripts/release-npm.sh"`.
5. `README.md`: replace/extend the Install & Run section (line 79) with an npm install path —
   `npm install -g zbterm`, `zbterm`, `zbterm --help`, `zbterm doctor`,
   `zbterm install-desktop` / `zbterm uninstall-desktop` (Linux — call out
   running `install-desktop` after installing, or the launcher entry and `zbterm://` links will
   not work), updating via `npm install -g zbterm@latest` or
   `zbterm update`, and `zbterm migrate --from <dir>` for ZBTerm data that lived outside the
   default userData root (`--storage`/`--profile-path` users — startup migration misses those).
   State the Linux build prerequisites (python3, make, a C++ toolchain — for `node-pty`), the
   ~150 MB Electron download, `ELECTRON_MIRROR` for restricted networks, and that npm installs
   do not use Pear OTA. Keep the existing dev/forge/OTA sections intact.
   Also document, in the contributor/dev section, that `allowScripts` pins `electron@40.10.1`
   while npm resolves a newer patch, so every install prints an allow-scripts warning and the
   electron/node-pty install scripts only run because the repo-local `.npmrc` sets
   `ignore-scripts=false` — installing from another cwd silently skips the Electron binary
   download.
6. New `docs/RELEASE-NPM.md`: the release checklist (version policy vs the Pear `upgrade` key,
   what to verify on each platform, how to yank/deprecate a bad release, the fact that forge
   installers and OTA release steps are unchanged and separate, and that
   `renderer/logo-ascii.generated.js` is regenerated manually with `npm run icons` only when the
   logo changes — never as part of packing).
7. Append the handoff block, and add a closing summary section to this plan file recording the
   published version and any deferred items.

## Acceptance criteria

- `bash scripts/npm-pack-check.sh` exits 0 on a clean tree and prints a tarball path; it exits
  non-zero if a forbidden path is added to `files` (verify by temporarily adding `test/` — and
  reverting).
- `bash scripts/npm-smoke-install.sh` exits 0 and leaves no temp prefix behind
  (`ls /tmp` before/after shows no growth in `zbterm*` dirs) and no orphan processes.
- **The working tree is intentionally dirty** — Phases 1–5 are uncommitted, by design, and
  `git clone`/`git worktree` would only carry committed content, so neither can be used to
  manufacture a clean tree for testing. `bash scripts/release-npm.sh patch` must therefore still
  run to completion here: it prints the full publish plan, lists the dirty tree under
  `BLOCKERS:`, and exits 3, creating no commit and no tag. Never commit, stash, or
  `git checkout` the real tree to make a guard pass.
- With `--publish` on this same dirty tree, the script must abort non-zero **before** running
  `npm version`, `npm publish`, or anything else irreversible. Verify by checking that no tag
  was created and `package.json`'s version is unchanged — do **not** pass a real OTP or let it
  reach the registry.
- All three scripts respond to `--help` with usage and exit 0.
- README's install section documents Linux prerequisites and both update paths.

## Verification

```bash
cd /zp/zdata/zeev/github/zbterm
bash scripts/npm-pack-check.sh --help && bash scripts/npm-smoke-install.sh --help \
  && bash scripts/release-npm.sh --help
git status --porcelain > /tmp/p2t-git-before.txt
git tag | sort > /tmp/p2t-tags-before.txt
bash scripts/npm-pack-check.sh | tee /tmp/p2t-pack.log
bash scripts/npm-smoke-install.sh "$(tail -1 /tmp/p2t-pack.log)"
# dry run on the intentionally dirty tree: full plan printed, dirty tree listed as a blocker
VER_BEFORE=$(node -p "require('./package.json').version")
bash scripts/release-npm.sh patch --yes; echo "dry-exit=$?"   # 3, output contains BLOCKERS: and the dirty tree
# publish path must abort before anything irreversible
bash scripts/release-npm.sh patch --publish --yes; echo "publish-exit=$?"   # non-zero, aborts early
node -p "require('./package.json').version"    # unchanged from $VER_BEFORE
git status --porcelain | diff - /tmp/p2t-git-before.txt && echo GIT-UNCHANGED
git tag | sort | diff - /tmp/p2t-tags-before.txt && echo TAGS-UNCHANGED
```

Pass = the three `--help` invocations, `npm-pack-check.sh` and `npm-smoke-install.sh` all exit 0;
`dry-exit=3` with the publish plan and a `BLOCKERS:` section naming the dirty tree;
`publish-exit` non-zero with no `npm version`/`npm publish` reached; the version string unchanged;
plus `GIT-UNCHANGED` and `TAGS-UNCHANGED`. Scope any orphan check to PIDs the scripts spawned — a
bare `pgrep -af zbterm` can match the user's live dev instance, which must never be signalled.

## Top gotchas

- `npm version` refuses to run on a dirty tree and creates a git tag as a side effect — that is
  why it lives behind `--publish` and after all checks.
- `npm pack` writes the tarball into the cwd; the check script must resolve the repo root and
  clean up stale `zbterm-*.tgz` first or it will validate an old artifact.
- A `mktemp -d` global prefix means `npm install -g --prefix` puts binaries in
  `<prefix>/bin` on Unix but `<prefix>` itself on Windows — the smoke script should say it is
  Unix-only rather than silently pass.
- `npm whoami` succeeding does not mean publish rights on the name; the first publish claims
  it. Do not add automatic name-claiming logic to the script.
- The `prepack` hook (Phase 3 asset vendoring) runs during `npm publish` too — if it fails, the
  publish aborts mid-way with a tag already created. Run `pack:check` first, always.

## Re-planning signals

- If the smoke install needs platform coverage the maintainer's machine cannot provide
  (macOS/Windows), add a phase for a documented manual matrix instead of automating it.
- If `prepack` proves fragile during publish, move asset vendoring to a committed
  `renderer/vendor/` directory (drop it from `.gitignore`) and make the script a verifier.
- Only if the maintainer later asks for CI: a workflow would wrap these same scripts — do not
  pre-build one.

## Re-planning outcome

Signal 1 (**platform coverage**) fired. `npm-smoke-install.sh` is Unix-only by design — it
refuses on Windows rather than silently passing, because `npm install -g --prefix DIR` puts
shims in `DIR` there, not `DIR/bin`. This machine covers only **linux-x64, glibc, xvfb, with a
`node-pty` prebuild that never had to compile**. Untested and untestable here: macOS arm64/x64
(Gatekeeper on an unsigned npm install), Windows x64, linux-arm64 (`bare-sidecar` prebuild), and
any distro where `node-pty` actually compiles from source. `docs/RELEASE-NPM.md` carries that
matrix as a manual checklist, but it has **never been executed**. Resolution: not a new phase —
the work is inherently manual and already documented. It is recorded instead as a hard
first-publish blocker in "Remaining before a real release" below.

Signal 2 (**`prepack` fragility**) did **not** fire — do NOT commit `renderer/vendor/`. The
vendoring hook ran five times across this phase (four `pack-check` runs plus the forbidden-path
run) and succeeded every time, producing an identical 57-entry / ~618 KiB tarball. The only
failure observed was in the test suite. Keeping `renderer/vendor/` gitignored and regenerated
stays correct; the residual risk (a `prepack` failure during `npm publish` leaving a tag behind)
is already mitigated by `pack-check` running the same hook first.

## Handoff notes

- Decisions: the lockfile gate compares `package-lock.json` against a snapshot taken immediately
  before `npm install --package-lock-only` instead of the plan's literal `git diff --exit-code`
  — that command can never pass while the tree is intentionally dirty, and the snapshot form is
  equivalent on a clean tree; `pack-check` and `smoke-install` are themselves named guards,
  evaluated after the four cheap guards (clean-tree, branch-confirmed, npm-whoami,
  version-available) so `--publish` aborts on a dirty tree before either expensive step runs;
  exit codes are 0 ok / 2 `--publish` abort / 3 dry-run blockers; `npm-smoke-install.sh` prefers
  `xvfb-run` even when `$DISPLAY` is set so no window lands on the developer's real desktop, and
  it deliberately does not exercise `zbterm --help` (it never exits).
- Gotchas: the app mints `$TMPDIR/zbterm-electron-<pid>-<hex>` as a scratch Chromium profile that
  survives a SIGTERM teardown, so the smoke script exports `ZBTERM_ELECTRON_USER_DATA` into its
  own prefix — without that, `/tmp` grows on every run; `npm test` itself leaks ~11
  `/tmp/zbterm-share-test-*` and `zbterm-share-network-test-*` dirs per run (pre-existing), so a
  raw `ls /tmp | wc -l` before/after is not a clean leak signal; `test/engine-session.test.js`
  flaked once with `ENOTEMPTY: rmdir .../corestore/.../log/db` and took `pack-check` down with it
  (132/132 on the immediate re-run) — treat a single `pack-check` failure as re-runnable before
  believing it; `xvfb-run`'s children outlive the wrapper, so the app must be launched under
  `setsid` and torn down by process-group id, which is also the only orphan check that cannot hit
  the developer's live dev instance; `npm view zbterm version` returns E404 (unpublished) and
  `npm whoami` returns ENEEDAUTH on this machine — both handled.
- Files: scripts/npm-pack-check.sh (new, 0755), scripts/npm-smoke-install.sh (new, 0755),
  scripts/release-npm.sh (new, 0755), package.json (pack:check / smoke:install / release:npm),
  README.md (Install & Run rewritten + TOC + allowScripts/.npmrc note + RELEASE-NPM link),
  docs/RELEASE-NPM.md (new).
- Deviations: the lockfile check is snapshot-based rather than `git diff --exit-code`; step 7's
  closing summary was intentionally not written by the implementer (the orchestrator owns the
  plan and changelog files); nothing was published and `npm publish` was never reached, not even
  with `--dry-run`.

## Verification output (2026-08-08)

`--help` on all three scripts — all exit 0:

```
$ bash scripts/npm-pack-check.sh --help && echo "EXIT1=$?" && bash scripts/npm-smoke-install.sh --help && echo "EXIT2=$?" && bash scripts/release-npm.sh --help && echo "EXIT3=$?"
Usage: bash scripts/npm-pack-check.sh [--help]
EXIT1=0
Usage: bash scripts/npm-smoke-install.sh [tarball] [--help]
EXIT2=0
Usage: bash scripts/release-npm.sh <patch|minor|major|x.y.z> [options]
Exit status: 0 ok, 2 aborted (--publish), 3 blockers found (dry run).
EXIT3=0
```

Baselines: `tmp-zbterm-dirs-before=140`, `VER_BEFORE=1.0.44`, `tags-before=0`.

`bash scripts/npm-pack-check.sh` → `packcheck-exit=0`:

```
==> Checking package-lock.json freshness
    ok: package-lock.json is up to date
==> Running npm run lint
All matched files use Prettier code style!
==> Running npm test
# tests = 132/132 pass
# ok
==> Removing stale zbterm-*.tgz from /zp/zdata/zeev/github/zbterm
==> Running npm pack

> zbterm@1.0.44 prepack
> node scripts/vendor-assets.js

zbterm-1.0.44.tgz
==> Checking required paths
    ok: bin/zbterm.js
    ok: bin/lib/doctor.js
    ok: bin/lib/desktop.js
    ok: bin/lib/migrate.js
    ok: electron/main.js
    ok: renderer/vendor/
    ok: build/icon/icon-*.png
    ok: renderer/logo-ascii.generated.js (1764 bytes, not regenerated)
==> Checking forbidden paths
    ok: no out/ node_modules/ test/ docs/ spikes/ assets/ relay/ forge.config.js
==> Checking tarball size
    tarball size: 633027 bytes (618 KiB), entries: 57
    ok: within the 5 MB limit
==> All checks passed.
/zp/zdata/zeev/github/zbterm/zbterm-1.0.44.tgz
```

`bash scripts/npm-smoke-install.sh "$(tail -1 /tmp/p2t-pack.log)"` → `smoke-exit=0`:

```
==> Temporary global prefix: /tmp/zbterm-smoke-7KoLXF
==> Installing zbterm-1.0.44.tgz
added 161 packages in 39s
npm warn allow-scripts 2 packages have install scripts not yet covered by allowScripts:
npm warn allow-scripts   electron@40.10.6 (postinstall: node install.js)
npm warn allow-scripts   node-pty@1.1.0 (install: node scripts/prebuild.js || node-gyp rebuild; postinstall: node scripts/post-install.js)
    ok: /tmp/zbterm-smoke-7KoLXF/bin/zbterm
==> zbterm --version
1.0.44
==> Checking the installed tree kept a runtime electron
    ok: electron binary: .../node_modules/zbterm/node_modules/electron/dist/electron
==> zbterm doctor --json
    PASS node / electron / node-pty / bare-sidecar / data-dir / display / chrome-sandbox
    INFO version: zbterm 1.0.44
    INFO channel: npm (/tmp/zbterm-smoke-7KoLXF/lib/node_modules/zbterm)
    ok: doctor exited 0
==> GUI stage: using xvfb-run
==> Launching zbterm --debug-server on 127.0.0.1:38079
    ok: process group 2695732
==> Polling GET /health for "engineReady":true (up to 60s)
    ok: /health: {"ok":true,"engineReady":true,"renderer":{"ok":true,"phase":"ready",...}}
==> Terminating the launched process group (2695732)
    ok: no orphans left from process group 2695732
    note: ignored the harmless 'xdg-mime: application argument missing' lines
==> Smoke install passed.
smoke-exit=0
```

`bash scripts/release-npm.sh patch --yes` → `dry-exit=3`:

```
 zbterm release
   current version : 1.0.44
   target          : patch -> 1.0.45
   mode            : dry run

Guards:
  [BLOCKED] clean-tree: working tree is dirty (44 entries); npm version refuses to run on a dirty tree
  [ok]     branch-confirmed: releasing from branch 'detailed_commits' (confirmed by --yes)
  [BLOCKED] npm-whoami: npm whoami failed - run 'npm login'. (npm error code ENEEDAUTH)
  [ok]     version-available: zbterm is not published yet (E404), so 1.0.45 is free

Verification:
  [ok]     pack-check: /zp/zdata/zeev/github/zbterm/zbterm-1.0.44.tgz
  [ok]     smoke-install: installed and verified zbterm-1.0.44.tgz

Publish plan for zbterm@1.0.45:
  1. bash scripts/npm-pack-check.sh
  2. bash scripts/npm-smoke-install.sh <tarball>
  3. npm version patch          # -> v1.0.45 commit + tag
  4. npm publish --access public
  5. git push --follow-tags            # printed, never run by this script

BLOCKERS:
  - clean-tree: working tree is dirty (44 entries)
  - npm-whoami: npm whoami failed - run 'npm login'. (npm error code ENEEDAUTH)

2 guard(s) failed. Nothing was published; the working tree and git refs are untouched.
dry-exit=3
```

`bash scripts/release-npm.sh patch --publish --yes` → `publish-exit=2`:

```
   mode            : PUBLISH (irreversible)
...
release-npm: aborting BEFORE 'npm version' / 'npm publish'.
             No commit, no tag, no registry request was made.
publish-exit=2
```

It aborted before even the pack-check/smoke-install stage — `npm version` and `npm publish` were
never reached and no registry request was made.

Final state: version `1.0.44`, `GIT-UNCHANGED`, `TAGS-UNCHANGED`.

Forbidden-path check (temporarily added `test/` to `package.json#files`, then reverted exactly):

```
forbidden-exit=1
    FAIL: tarball contains test/:
      package/test/account-store.test.js
      ... 19 entries ...
```

Cleanup / orphan check, scoped to the spawned process group (never a bare `pgrep zbterm`): no
tarballs in the repo root, no `/tmp/zbterm-smoke-*` prefixes, no new `zbterm-electron-*` scratch
dir, and the live dev instance on port 17069 (pid 31417) still listening and untouched.

Caveat recorded: **the first** dry run reported `pack-check` as BLOCKED because
`test/engine-session.test.js` crashed with `ENOTEMPTY: rmdir .../corestore/<key>/log/db` — a
pre-existing teardown race, not caused by this phase. The immediate re-run was 132/132. The dry
run's own logic was correct in both cases.


---

# Phase 7 — Desktop registration that verifies itself — ✅ done 2026-08-08

## Goal

`zbterm install-desktop` stops trusting `xdg-mime` and `update-desktop-database` exit codes and
instead verifies what actually landed on disk, reporting honestly when the desktop database
could not be updated; and `zbterm install-desktop --print-only` emits the `.desktop` body plus
the exact commands a user (or a packager) can run by hand, writing nothing.

## Requirements & inputs

Read: `bin/lib/desktop.js` (Phase 5 — exports `install()` / `uninstall()`), `bin/zbterm.js`
(the `install-desktop` / `uninstall-desktop` dispatch branches), `test/doctor.test.js` (Phase 5 —
already contains the desktop tests, extend that file rather than adding a new one),
`docs/npm-zbterm-handoff.md`.

Contracts to honor:

- **`xdg-mime` exits 0 after failing.** On KDE it shells out to `qtpaths`; when that is missing
  it prints `xdg-mime: line NNN: qtpaths: command not found`, writes nothing, and still returns
  0. It also refuses to create `$XDG_CONFIG_HOME` itself. Never use its exit code as proof.
- The two scheme associations that must end up in `mimeapps.list` are
  `x-scheme-handler/zbterm=zbterm.desktop` and `x-scheme-handler/zbterm=zbterm.desktop`.
- Installation stays user-scoped (`~/.local/share/...`, `~/.config/mimeapps.list`), never writes
  to `/usr/share`, and never requires root.
- Do not change the `.desktop` body, the icon set, the file locations, or `uninstall()`'s
  file list — Phase 5's acceptance (`0` files left after uninstall) must keep passing.
- Keep the `XDG_CACHE_HOME` redirection Phase 5 added for non-account-home runs; `xdg-mime` on
  KDE runs `kbuildsycoca6`, which drops `~/.cache/ksycoca6_*` that uninstall must not own.
- On macOS/Windows, `--print-only` prints the platform explanation and exits 0, as the plain
  command already does.

## Steps

1. `bin/lib/desktop.js`: after running the hooks, **verify** rather than trust —
   re-read `~/.config/mimeapps.list` and confirm both `x-scheme-handler/*=zbterm.desktop`
   lines are present. If a line is missing, write it directly (the file is a plain INI-style
   list under `[Default Applications]`), then re-read and confirm again.
2. Make `install()` return a structured result — at minimum
   `{ desktopFile, icons: [...], mimeVerified: bool, hookFailures: [...] }` — and have
   `bin/zbterm.js` print a clear final line: success, or a warning naming what could not be
   verified plus the manual commands to finish the job. Exit 0 when the files landed even if a
   hook failed; exit non-zero only when the `.desktop` file or the mime associations could not
   be written at all.
3. Add `--print-only` to the `install-desktop` branch: print the destination paths, the full
   `.desktop` body, the icon copy list, and the literal `update-desktop-database` /
   `xdg-mime default ...` commands, then exit 0 **without creating or modifying any file**
   (including `~/.cache`).
4. Extend `test/doctor.test.js`: `--print-only` over a temp `HOME` leaves the directory
   empty (`find <tmpHOME> | wc -l` unchanged) and prints both scheme handlers; `install()` with
   a stubbed PATH whose `xdg-mime` exits 0 while writing nothing still ends with both
   associations present in `mimeapps.list` and `mimeVerified: true`; `install()` with a
   read-only `~/.config` reports `mimeVerified: false` and a non-empty `hookFailures`, and the
   command exits non-zero. Remember brittle teardowns run FIFO — register a `chmod` restore
   **before** the `rmSync` teardown or it never fires.
5. Append the handoff block.

## Acceptance criteria

- `HOME=<tmp> zbterm install-desktop --print-only` creates zero files under the temp HOME and
  prints both `x-scheme-handler` lines and both hook commands.
- With a stubbed `xdg-mime` on PATH that exits 0 and writes nothing,
  `HOME=<tmp> zbterm install-desktop` still leaves both associations in
  `<tmp>/.config/mimeapps.list` and exits 0.
- With `<tmp>/.config` read-only, the command exits non-zero and names what failed.
- Phase 5's behaviour is unchanged on a working host: install is idempotent, and
  `uninstall-desktop` still leaves 0 files under the temp HOME.

## Verification

```bash
cd /zp/zdata/zeev/github/zbterm
npm run lint && npx prettier --check bin/ && npx lunte bin
npx brittle-node test/doctor.test.js          # "# tests = N/N pass" + "# ok"
export FAKEHOME=$(mktemp -d)
HOME=$FAKEHOME node bin/zbterm.js install-desktop --print-only | grep -c x-scheme-handler  # >= 2
find $FAKEHOME | wc -l                        # 1  (the dir itself, nothing written)
# stubbed liar xdg-mime
export STUB=$(mktemp -d); printf '#!/bin/sh\nexit 0\n' > $STUB/xdg-mime; chmod +x $STUB/xdg-mime
HOME=$FAKEHOME PATH=$STUB:$PATH node bin/zbterm.js install-desktop; echo "exit=$?"   # exit=0
grep -c "=zbterm.desktop" $FAKEHOME/.config/mimeapps.list        # 2
HOME=$FAKEHOME node bin/zbterm.js uninstall-desktop
find $FAKEHOME -type f | wc -l                # 0
# unwritable config
export RO=$(mktemp -d); mkdir -p $RO/.config; chmod 500 $RO/.config
HOME=$RO node bin/zbterm.js install-desktop; echo "exit=$?"      # exit!=0
chmod 700 $RO/.config; rm -rf $RO $STUB $FAKEHOME
npm test
```

Pass = lint and both `bin/` checks exit 0, `# tests = N/N pass` + `# ok` on both test runs, the
print-only run writing nothing, `2` associations after the stubbed-liar run, `0` files after
uninstall, and a non-zero exit on the read-only `.config`.

## Top gotchas

- Writing `mimeapps.list` by hand must **merge**, not overwrite: the file holds every
  application association for the user. Parse the `[Default Applications]` section, add or
  replace only the two `x-scheme-handler/*` keys, and preserve everything else byte-for-byte.
- `--print-only` must not touch `~/.cache` either — Phase 5 redirects `XDG_CACHE_HOME` for
  non-account-home runs specifically because `kbuildsycoca6` writes there; the print path
  should never invoke a hook at all.
- `os.homedir()` echoes `$HOME`, so tests that set `HOME` see it — use `os.userInfo().homedir`
  when the code needs the real account home.
- Prettier reformats `bin/` into shapes lunte's `curly` rule rejects; run
  `npx prettier --write bin/ && npx lunte bin` and re-check before declaring lint clean.

## Re-planning signals

- If `mimeapps.list` turns out to need a `[Added Associations]` section as well on some desktop
  environments for links to actually route, extend this phase's verification to both sections
  rather than shipping a half-registration.
- If verifying registration requires actually launching a `zbterm://` link end to end, that is
  an integration-test phase of its own — do not bolt it onto `install-desktop`.

## Re-planning outcome

Signal 1 (**`[Added Associations]`**) **fired**. `[Default Applications]` is what the XDG spec
says decides the handler and is the only section `xdg-mime default` touches, so verifying it is
correct for GNOME/KDE/XFCE via `gio`/`kde-open`/`exo-open`. But `[Added Associations]` is what
makes an app *appear as a candidate* at all: some resolvers (older `gio`, and anything reading
the list as "which apps claim this type") ignore a `[Default Applications]` entry whose app is
not also associated, and the `.desktop`'s `MimeType=` line only becomes visible after
`update-desktop-database` builds `mimeinfo.cache` — precisely the hook this phase stopped
trusting. On a host where that rebuild fails, the default entry can point at an app nothing
believes handles the scheme. Not folded in here because it changes what `uninstall-desktop`'s
strip must remove, and Phase 5's "0 files left" acceptance was contractually frozen for this
phase. Resolution: new **Phase 8**.

Signal 2 (**end-to-end link routing**) fired but is deliberately **not scheduled**. File-level
verification proves the right bytes are on disk, not that the desktop environment routes a
click; the real proof is `gio open zbterm://…` reaching a running zbterm with the URL in `argv`,
which needs a live session bus, a display, an Electron process and the single-instance/`open-url`
path in `electron/main.js`. That is an integration-test phase of its own and must not be bolted
onto `install-desktop`, which has to stay fast, non-interactive and headless-safe. Two blockers
for whoever plans it: the app under test cannot be the developer's live instance (single-instance
lock), and `xvfb-run`'s children outlive the wrapper, so the harness needs `setsid` +
process-group teardown. Recorded under "Remaining before a real release".

## Handoff notes

- Decisions: verification is scoped to the `[Default Applications]` section only; the direct
  write happens *only* when `runHooks` is true, so Phase 5's `runHooks:false` tests still see
  exactly `.desktop` + icons and nothing under `.config`; `install()` keeps its old fields
  (`paths`/`written`/`hooks`/`launchPath`) and *adds*
  `desktopFile`/`icons`/`mimeapps`/`mimeVerified`/`mimeMissing`/`mimeRepaired`/`hookFailures`,
  where `hookFailures` merges failed hooks with a synthetic `{ command: 'write <mimeapps.list>' }`
  entry so a silent EACCES is reported as loudly as a missing binary; a failed hook alone is a
  `note:` line and still exit 0, only `mimeVerified:false` (or a throwing `install()`) exits 1.
- Gotchas: `spawnSync(cmd, args, { env })` resolves `cmd` through the **child** env's PATH (libuv
  swaps `environ` before `execvp`), which is what makes a stubbed-`xdg-mime` PATH testable — but
  the real `update-desktop-database` still ran from the inherited PATH in the acceptance run and
  wrote `applications/mimeinfo.cache`, so the "0 files" check only holds because Phase 5's
  uninstall deletes that cache; the tests therefore stub **both** hooks so KDE's `kbuildsycoca6`
  never runs inside `npm test`; `--print-only` calls `layout()` only, which reads `build/icon/`
  and joins strings — it creates no directory; brittle teardowns run FIFO, so the read-only test
  registers `chmod 0700` **before** the `rmSync` (and cannot use the `tmpdir()` helper, which
  registers `rmSync` at creation).
- Files: bin/lib/desktop.js, bin/zbterm.js, test/doctor.test.js, docs/npm-zbterm-handoff.md
- Deviations: `layout()` gained a `mimeapps` field and `desktop.js` now also exports
  `printPlan`/`mergeDefaultApplications`/`missingAssociations`; the note wording changed from
  "unavailable or failed" to "failed" so the synthetic write failure reads correctly.

## Verification output (2026-08-08)

`npm run lint` → exit 0, tail `82 warnings` (all pre-existing `require-await` in `test/`,
`forge.config.js`).

`npx prettier --check bin/`:

```
Checking formatting...
All matched files use Prettier code style!
```

exit 0. `npx lunte bin` → `✓ No issues found`, exit 0.

`npx brittle-node test/doctor.test.js`:

```
1..18
# tests = 18/18 pass
# asserts = 195/195 pass
# time = 473.621594ms

# ok
```

(was 15 tests / 150 asserts before this phase)

`HOME=$FAKEHOME node bin/zbterm.js install-desktop --print-only` — exit 0; printed the
destination paths, the entire `.desktop` body, all 6 icon copy pairs, then:

```
then run:
  update-desktop-database /…/fakehome.tjWDOc/.local/share/applications
  xdg-mime default zbterm.desktop x-scheme-handler/zbterm
  xdg-mime default zbterm.desktop x-scheme-handler/zbterm

expected in /…/fakehome.tjWDOc/.config/mimeapps.list under [Default Applications]:
  x-scheme-handler/zbterm=zbterm.desktop
  x-scheme-handler/zbterm=zbterm.desktop
```

`... | grep -c x-scheme-handler` → `5`; `find $FAKEHOME | wc -l` → `1`.

Stubbed liar `xdg-mime` (`exit 0`, writes nothing):

```
  verified x-scheme-handler/zbterm=zbterm.desktop
  verified x-scheme-handler/zbterm=zbterm.desktop
zbterm: desktop integration installed and verified in /…/.config/mimeapps.list
exit=0
```

`grep -c "=zbterm.desktop" $FAKEHOME/.config/mimeapps.list` → `2`.

`HOME=$FAKEHOME node bin/zbterm.js uninstall-desktop` → removed 9 paths (7 files +
`mimeapps.list` + `mimeinfo.cache`); `find $FAKEHOME -type f | wc -l` → `0`.

Read-only `.config`:

```
  note: write /…/ro.HxjI21/.config/mimeapps.list failed (EACCES)
zbterm: WARNING could not verify x-scheme-handler/zbterm, x-scheme-handler/zbterm in /…/ro.HxjI21/.config/mimeapps.list
  finish it by hand with:
    update-desktop-database /…/ro.HxjI21/.local/share/applications
    xdg-mime default zbterm.desktop x-scheme-handler/zbterm
    xdg-mime default zbterm.desktop x-scheme-handler/zbterm
exit=1
```

`npm test`:

```
1..135
# tests = 135/135 pass
# asserts = 666/666 pass
# time = 20195.917759ms

# ok
```

Passed first try — no `engine-session` flake.


---

# Phase 8 — Claim the schemes in `[Added Associations]` too — ✅ done 2026-08-08

## Goal

`zbterm install-desktop` writes and verifies the two scheme handlers in **both**
`[Default Applications]` and `[Added Associations]` of `mimeapps.list`, so a desktop environment
whose `mimeinfo.cache` rebuild failed still treats zbterm as a candidate handler for
`zbterm://` and `zbterm://` links — and `uninstall-desktop` strips both sections cleanly.

## Requirements & inputs

Read: `bin/lib/desktop.js` (Phase 7 — exports `install`, `uninstall`, `printPlan`,
`mergeDefaultApplications`, `missingAssociations`; `layout()` returns a `mimeapps` field),
`bin/zbterm.js` (the `install-desktop` / `uninstall-desktop` branches),
`test/doctor.test.js` (18 tests / 195 asserts; the desktop cases live here — extend this file),
`docs/npm-zbterm-handoff.md`.

Contracts to honor:

- `[Default Applications]` values are a **single** desktop file id (`x-scheme-handler/zbterm=zbterm.desktop`).
  `[Added Associations]` values are a **semicolon-terminated list** — `x-scheme-handler/zbterm=zbterm.desktop;`
  — and other applications may already be listed there. Append `zbterm.desktop` to the existing
  list if absent; never replace the list.
- Merging must stay byte-preserving for every other line and section of `mimeapps.list`, exactly
  as Phase 7's `[Default Applications]` merge does.
- `uninstall()` must remove zbterm from both sections, delete a section when it becomes empty,
  and still satisfy the standing acceptance that a temp `HOME` is left with **0 files**.
- The direct write still happens only when `runHooks` is true, so Phase 5/7's `runHooks:false`
  tests keep seeing exactly `.desktop` + icons and nothing under `.config`.
- Do not change the `.desktop` body, the icon set, or the file locations.
- `--print-only` must still write nothing, and must now print the expected lines for both
  sections.

## Steps

1. Generalize Phase 7's merge helper: `mergeDefaultApplications` handles a single-value section
   and a new list-valued path handles `[Added Associations]`. Keep one code path parameterized by
   section name and value semantics rather than duplicating the parser.
2. Extend `missingAssociations()` to report per section, e.g.
   `{ defaults: [...], added: [...] }`, and make `install()`'s `mimeVerified` require both to be
   empty. Keep `mimeMissing`/`mimeRepaired` informative about which section was short.
3. `uninstall()`: strip `zbterm.desktop` from `[Added Associations]` lists (dropping the key when
   it becomes empty, and the section when it has no keys) as well as the existing
   `[Default Applications]` removal.
4. `--print-only`: print the expected `[Added Associations]` lines alongside the existing
   `[Default Applications]` block.
5. Extend `test/doctor.test.js`: a `mimeapps.list` pre-seeded with
   `x-scheme-handler/zbterm=other.desktop;` under `[Added Associations]` ends up as
   `other.desktop;zbterm.desktop;` (order preserved, other entry intact); an unrelated section
   and an unrelated key survive install+uninstall byte-for-byte; uninstall on that pre-seeded
   file leaves `other.desktop;` and does not delete the section; the stubbed-liar-`xdg-mime`
   case now verifies both sections. Stub **both** hooks so KDE's `kbuildsycoca6` never runs
   inside `npm test`.
6. Append the handoff block.

## Acceptance criteria

- After `HOME=<tmp> zbterm install-desktop`, `mimeapps.list` contains
  `x-scheme-handler/zbterm=zbterm.desktop` and `x-scheme-handler/zbterm=zbterm.desktop` under
  `[Default Applications]`, **and** both keys listing `zbterm.desktop` under
  `[Added Associations]`.
- A pre-existing `[Added Associations]` entry for another application is preserved and zbterm is
  appended to it, not substituted for it.
- `uninstall-desktop` removes zbterm from both sections, preserves other applications' entries,
  and still leaves a temp `HOME` with 0 files when zbterm was the only entry.
- `--print-only` still creates zero files and now prints both sections' expected lines.
- Install remains idempotent: a second run rewrites nothing.

## Verification

```bash
cd /zp/zdata/zeev/github/zbterm
npm run lint && npx prettier --check bin/ && npx lunte bin
npx brittle-node test/doctor.test.js          # "# tests = N/N pass" + "# ok"
export FAKEHOME=$(mktemp -d) STUB=$(mktemp -d)
printf '#!/bin/sh\nexit 0\n' > $STUB/xdg-mime; chmod +x $STUB/xdg-mime
cp $STUB/xdg-mime $STUB/update-desktop-database
mkdir -p $FAKEHOME/.config
printf '[Added Associations]\nx-scheme-handler/zbterm=other.desktop;\n\n[Unrelated]\nkeep=me\n' \
  > $FAKEHOME/.config/mimeapps.list
HOME=$FAKEHOME PATH=$STUB:$PATH node bin/zbterm.js install-desktop; echo "exit=$?"   # exit=0
cat $FAKEHOME/.config/mimeapps.list
grep -c "^x-scheme-handler/.*=.*zbterm.desktop" $FAKEHOME/.config/mimeapps.list      # 4
grep "other.desktop" $FAKEHOME/.config/mimeapps.list                                 # still there, zbterm appended
grep -A1 "^\[Unrelated\]" $FAKEHOME/.config/mimeapps.list                            # keep=me intact
HOME=$FAKEHOME PATH=$STUB:$PATH node bin/zbterm.js install-desktop; echo "idempotent=$?"  # 0, file unchanged
HOME=$FAKEHOME PATH=$STUB:$PATH node bin/zbterm.js uninstall-desktop
grep "zbterm.desktop" $FAKEHOME/.config/mimeapps.list && echo "FAIL: zbterm left" || echo CLEAN
grep -c "other.desktop" $FAKEHOME/.config/mimeapps.list                              # 1
HOME=$FAKEHOME node bin/zbterm.js install-desktop --print-only | grep -c "Added Associations"  # >= 1
rm -rf $FAKEHOME $STUB
npm test
```

Pass = lint and both `bin/` checks exit 0, `# tests = N/N pass` + `# ok` on both test runs,
`exit=0`, `4` zbterm association lines, `other.desktop` preserved, `keep=me` intact, an
idempotent second run, `CLEAN` after uninstall with `other.desktop` still present, and
`Added Associations` printed by `--print-only`.

## Top gotchas

- `[Added Associations]` values are `;`-terminated lists; a trailing `;` is significant and
  `foo.desktop;zbterm.desktop` without the final `;` is malformed on some parsers. Emit the
  trailing separator.
- Removing zbterm from a list must not leave `;;` or a leading `;`. Split, filter, re-join.
- A `mimeapps.list` may have no `[Added Associations]` section at all — create it, but only when
  actually adding a key, and keep section order stable so the file does not churn.
- The standing "0 files left after uninstall" acceptance means that when zbterm was the only
  entry the whole `mimeapps.list` must be deleted, not left as an empty stub.
- Do not signal any process you did not start: there is a live dev instance on port 17069, and
  `~/.config` must never be touched by a test.

## Re-planning signals

- If `[Added Associations]` turns out to need the same treatment in
  `~/.local/share/applications/mimeapps.list` (the deprecated location some DEs still read),
  extend to both files rather than guessing which one the DE prefers.
- If verifying the sections still does not make links route on a real desktop, the remaining gap
  is the `mimeinfo.cache` rebuild — that points at the end-to-end routing integration phase
  recorded under "Remaining before a real release", not at more `mimeapps.list` work.

## Re-planning outcome

Signal 1 (**deprecated `~/.local/share/applications/mimeapps.list`**) fired but is **not
scheduled** — recorded as deferred instead. The spec lookup order is
`$XDG_CONFIG_HOME/mimeapps.list` -> `$XDG_CONFIG_DIRS/*` -> `$XDG_DATA_HOME/applications/mimeapps.list`
-> `$XDG_DATA_DIRS/*`, so the config-home file already wins on any DE implementing the current
spec; the deprecated data-home file only matters on a stack old enough to ignore it. The merge and
strip code is already file- and section-agnostic (`mergeAssociations`/`stripAssociations` take
strings), so the work would land in `layout()`, `ensureAssociations`, `cleanAssociations` and the
`pruneEmptyDirs(applicationsDir, dataHome)` walk — which currently assumes `applications/` holds
only `.desktop` files plus `mimeinfo.cache`, and would have to learn about a second list living
inside it. Worth a small explicit phase if a real DE is found that needs it; not worth guessing.

Signal 2 (**`mimeinfo.cache` is the remaining gap**) confirmed. `mimeapps.list` content is now
self-verified in both sections, but the cache is still written by a best-effort external hook
whose failure produces only a `note:` line and exit 0. Evidence: this phase's fresh-home install
with both hooks stubbed produced a complete, correct `mimeapps.list` and **8 files** — 1
`.desktop` + 6 icons + the list, with **no `applications/mimeinfo.cache` at all**. With the real
`update-desktop-database` on PATH (Phase 7's run) the cache does get written, and Phase 5's
uninstall deletes it, which is the only reason "0 files" holds. A zbterm-authored
`mimeinfo.cache` merge would use the same shape as this phase (`[MIME Cache]`, `;`-terminated
lists) and would make the `update-desktop-database` `hookFailures` path cosmetic rather than
load-bearing. Secondary: `manualCommands()` still prints only `update-desktop-database` + two
`xdg-mime default` calls, and no CLI can write `[Added Associations]` — so the "finish it by
hand" recipe is now strictly weaker than what `install()` does and should print the file lines
instead. Both recorded under "Remaining before a real release".

## Handoff notes

- Decisions: `missingAssociations()` returns `{defaults, added}` and `install().mimeMissing`
  carries that object (the flat array is gone; `test/doctor.test.js` updated), while
  `mimeRepaired` stays a **boolean** because the repair is one write of the whole file;
  `mergeDefaultApplications`/`mergeAddedAssociations` are thin wrappers over one
  `mergeAssociations(raw, section, entries, {list})`, and both detection and removal read values
  through a single `splitList()` that also tolerates a stray `;` in `[Default Applications]`;
  uninstall deletes an emptied section header **plus its now-blank body**, but only for a section
  this uninstall actually emptied, so a section the user left empty is not tidied away.
- Gotchas: install is two chained merges, so the second must accept the first's *string* output,
  not `null`; an `[Added Associations]` key that already lists `zbterm.desktop` must be left
  byte-identical rather than re-serialised, or "second run rewrites nothing" fails; dropping only
  the emptied header and not its trailing blank line leaves a stray newline that breaks the
  byte-for-byte round-trip assertion; `--print-only` prints the desktop body's
  `MimeType=x-scheme-handler/zbterm;…`, so a test grepping for the list form must match the full
  `x-scheme-handler/zbterm=zbterm.desktop;`.
- Files: bin/lib/desktop.js, test/doctor.test.js, docs/npm-zbterm-handoff.md
- Deviations: `bin/zbterm.js` needed no change (it only forwards exit codes); `desktop.js`
  additionally exports `mergeAddedAssociations`, `DEFAULT_APPLICATIONS`, `ADDED_ASSOCIATIONS`;
  the success line now names both sections.

## Verification output (2026-08-08)

```
lint exit=0
Checking formatting...
All matched files use Prettier code style!
prettier exit=0
✓ No issues found
lunte exit=0
```

(`npm run lint` prints 83 pre-existing `require-await` warnings and exits 0. Prettier initially
flagged `bin/lib/desktop.js`; per Phase 2's note `npx prettier --write bin/ && npx lunte bin` was
run, then re-checked — the output above is the re-check.)

```
1..19
# tests = 19/19 pass
# asserts = 216/216 pass
# time = 714.108049ms

# ok
```

(was 18/195 before this phase)

```
=== install ===
zbterm: installed desktop integration
  /tmp/tmp.vHanl81c1G/.local/share/applications/zbterm.desktop
  ... 6 icons ...
  Exec=/zp/zdata/zeev/github/zbterm/bin/zbterm.js %u
  verified x-scheme-handler/zbterm=zbterm.desktop
  verified x-scheme-handler/zbterm=zbterm.desktop
zbterm: desktop integration installed and verified in /tmp/tmp.vHanl81c1G/.config/mimeapps.list ([Default Applications] and [Added Associations])
exit=0
=== cat ===
[Added Associations]
x-scheme-handler/zbterm=other.desktop;zbterm.desktop;
x-scheme-handler/zbterm=zbterm.desktop;

[Unrelated]
keep=me

[Default Applications]
x-scheme-handler/zbterm=zbterm.desktop
x-scheme-handler/zbterm=zbterm.desktop
=== grep -c zbterm assoc lines ===
4
=== grep other.desktop ===
x-scheme-handler/zbterm=other.desktop;zbterm.desktop;
=== grep -A1 Unrelated ===
[Unrelated]
keep=me
=== idempotent ===
idempotent=0
file unchanged
=== uninstall ===
zbterm: removed desktop integration
CLEAN
=== grep -c other.desktop ===
1
=== round trip vs original ===
byte-for-byte round trip
=== print-only ===
1
```

Standing Phase 5/7 acceptance, fresh temp `HOME`:

```
install exit=0
--- mimeapps.list ---
[Default Applications]
x-scheme-handler/zbterm=zbterm.desktop
x-scheme-handler/zbterm=zbterm.desktop

[Added Associations]
x-scheme-handler/zbterm=zbterm.desktop;
x-scheme-handler/zbterm=zbterm.desktop;
files after install: 8
uninstall exit=0
files after uninstall: 0
```

```
1..136
# tests = 136/136 pass
# asserts = 687/687 pass
# time = 20454.765701ms

# ok
```

(was 135/666; passed first try, no `engine-session` flake)

