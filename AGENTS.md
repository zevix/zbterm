# AGENTS.md

ZBTerm: secure terminal recording, playback and peer-to-peer sharing, built on the
Electron/Pear stack. A host runs a local PTY-backed shell, records encrypted terminal
history to Hypercore, shares live output over Hyperswarm (backend `pear`) or a local
Freenet node (backend `freenet`), and authorizes viewers by identity, device, link,
capability and epoch keys. `engine/` (published separately as `zbterm-core`) is the
host-independent core: it runs in a Bare sidecar, owns storage, crypto, sharing and identity, and works without Electron.
`electron/` is a thin shell: windows, renderer IPC, native PTY processes, and spawning
the Bare sidecar. Stack: Electron ^40 + Forge ^7.11 (CommonJS), `bare-sidecar`,
prettier + lunte. [README](README.md) is the human manual (install, sharing, the
debug server, environment variables); [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
is the full design reference.

ZBTerm has no OTA updater, no `pear.json`, and no forge upgrade gate: it is a hard
fork of Holepunch's `hello-pear-electron` template with the updater removed
(`D-08`, `D-25`). A packaged build installs and updates like any other desktop app
(a newer package, or `npm install -g zbterm@latest` for the npm distribution) —
see [README's Updating section](README.md#install-update).

## Commands

npm only — pnpm breaks `forge.config.js` (undeclared hoisted deps).

```sh
npm test                                          # full suite (brittle)
HOME=<scratch> TMPDIR=<short-dir> npm test         # isolated run (see Process safety)
npm run lint                                       # prettier + lunte on package.json, forge.config.js, electron/, engine/, renderer/, test/  (= CI)
npm run format                                     # the same files, --write / --fix
npm run vendor:assets                              # regenerates vendored renderer assets (pretest/prepack/prestart)
npm start                                          # dev (electron-forge start -- --no-updates)
npm run package                                    # → out/<ProductName>-<platform>-<arch>/
ZBTERM_FORGE_OUT_DIR=<dir> npm run package         # package into a scratch dir instead of out/
npm run make                                       # → installers in out/make/
./build_all.sh                                     # relay executables (all platforms) + GUI package/make
```

Always give a test run its own `HOME` and a short `TMPDIR` (under 20 characters): a
long `TMPDIR` breaks the SSH-agent test (108-byte socket path limit). `--no-updates`
is still accepted everywhere for compatibility and does nothing — there is nothing
left to disable.

## Contracts: editing one side breaks the other, often silently

- Bare-worker spawn (`engine/client.js::_spawnWorker` → `engine/spawn-worker.js`
  → `bare-sidecar`): argv `[userData, profileId, profilePath, backend, hostCaps]`
  (empty strings, never `undefined`, for the four optional ones), frozen in
  [`docs/CORE-CONTRACT.md`](docs/CORE-CONTRACT.md). The pipe speaks the framed
  binary protocol of `engine/rpc/schema.js` (`INVOKE`/`PTY_*`/`EVENT_*`/`BACKEND_*`
  frames, `engine/rpc/pipe.js`), not plain strings.
- `BACKEND_*` frames (`engine/client.js`, `engine/rpc/pipe.js`): the seam the split
  Freenet adapter crosses — its contract client runs in the Bare worker, its WebRTC
  half (`node-datachannel`) runs in the host process (`electron/rtc-host.js`),
  `D-06`/`D-09`.
- `package.json#imports` Bare map lives in **`engine/package.json`** (the published
  `zbterm-core` manifest), not the root one: Bare has no `events`/`fs`/`path`/`os`/
  `crypto`, so each needs a `{"bare": "bare-<name>", "default": "<name>"}` entry.
  `engine/package.json`'s own dependency ranges must track the root's (`Z2`
  handoff) — a targeted `npm install` there can drift a transitive version
  (`protomux` did, once) until `npm update` catches it up.
- Contract pins (`D-10`): the Freenet contracts ship as committed raw `.wasm`
  bytes with BLAKE3 hashes pinned by a test (`engine/backends/freenet/contracts/
hashes.json`); nothing compiles at install or package time. Rust sources,
  lockfile and `scripts/build-contracts.sh` stay in the repo for reproducing them.
- `productName` (`package.json`) ↔ `AppxManifest.xml` Identity ↔ CI artifact names
  ↔ storage dirs.
- `AppxManifest.xml` Publisher CN ↔ Windows signing cert (stable across builds).
- `package.json#version` ↔ generated package metadata (AppImage/Snap/MSIX/Flatpak)
  ↔ release metadata (`flatpak/*.metainfo.xml` `<release>`, Flatpak URLs + sha512).
- The invite scheme (`zbterm://join/`, `engine/invite.js::LINK_PREFIX`) and the
  identity SSHSIG namespace (`engine/identity/claim.js::NAMESPACE`) are a clean
  break from the predecessor's own (`D-23`): a predecessor link or claim must be
  refused, not silently misread — see `test/former-name.test.js`.

## Boundaries

You are a tool assisting the maintainer, not a substitute for them. Exceptions to
any rule here are the human's call: when a task seems to require one, stop and
surface the conflict instead of working around it. Exceptions are expected to be
rare.

- ✅ **Always:** if your change makes a _descriptive_ statement in AGENTS.md or
  `agent_docs/` false, update the doc and flag it in your summary; if it conflicts
  with a contract or boundary, stop and ask instead — never rewrite a rule to
  legalize your own change.
- ✅ **Always:** check worker changes in a packaged build (`npm run package`,
  output to a scratch `ZBTERM_FORGE_OUT_DIR` outside the repo) — Bare resolves
  modules differently there than in dev, so `npm start` passing proves nothing
  about the sidecar booting for a user. Work is done when lint passes and, for
  worker/`engine/` changes, the packaged app boots.
- ✅ **Always:** process safety. Never run tests, dev instances or packaged
  builds against the maintainer's own data: give every instance its own storage,
  `HOME`/profile/`userData`, and a debug/relay port that isn't one the
  maintainer's live instances use; never signal a process by name or pattern,
  only a PID this session started, after checking its command line carries the
  scratch path; any GUI runs only under an isolated display (`uisolate`).
- ✅ **Always:** ledgers (`docs/register.md` for `S-nn`, `docs/decisions.md` for
  `D-nn`) are append-only — take the next free id at landing time, never
  renumber or edit past rows. New project work lives under `docs/projects/<id>/`
  per [`docs/projects/README.md`](docs/projects/README.md).
- ⚠️ **Ask first:** `AppxManifest.xml` identity/publisher, new deps, Electron
  bumps, anything touching `docs/decisions.md`'s existing rows.
- 🚫 **Never:** publish or deploy (`npm publish`, pushing a `v*` tag — that
  triggers npm publish via `.github/workflows/publish.yml` — `pear stage`,
  `provision`, `multisig`, `seed`, a GitHub release), unless the user explicitly
  asked for exactly that in this session.
- 🚫 **Never:** enable asar (breaks Bare sidecar spawning); add CLI flags/launch
  surfaces without declaring them to paparam in `electron/main.js` (unknown argv
  crashes the packaged app); commit secrets or real key material.

## Topic docs — match your task, read the doc BEFORE editing that area

Each `agent_docs/` file holds only code-verified facts you cannot deduce from this
repo's sources (cross-package contracts, failure semantics, dependency behavior);
each opens with its own scope statement. Routing:

- Editing `electron/`, `renderer/`, or `engine/` (spawn/IPC/startup, the sidecar
  seam) → [`agent_docs/architecture.md`](agent_docs/architecture.md)
- Adding P2P data or a share backend, or debugging a missing/broken share
  → [`agent_docs/updates.md`](agent_docs/updates.md) (there is no OTA updater;
  this file is now a pointer, not update-flow documentation)
- Touching `forge.config.js`, `build/`, `flatpak/`, rebranding, or signing
  → [`agent_docs/packaging.md`](agent_docs/packaging.md)
- Touching `.github/`, or cutting/troubleshooting a release
  → [`agent_docs/releases.md`](agent_docs/releases.md)
