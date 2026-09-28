# zbterm-fork — the former name becomes ZBTerm, a hard fork on the current Pear stack

Status: PROPOSAL 2026-09-28. `D-23` and `D-24` in [`../../decisions.md`](../../decisions.md) are
agreed (zeev, 2026-09-28); so are `D-25`–`D-30`. Questions and assumptions: [`QnA_assumptions.md`](QnA_assumptions.md).
Plan (HOW): [`plan.md`](plan.md). Sibling project: `260928_zxterm-core` in its own repository,
`zevix/zxterm` ([`docs/projects/260928_zxterm-core/`](https://github.com/zevix/zxterm/tree/main/docs/projects/260928_zxterm-core); locally `/zeev/github/zxterm`),
which runs in parallel with this one (`D-29`, `D-30`).

This folder moved here from the predecessor repository on 2026-09-28, before `Z1`. Until `Z1`
imports the ledgers, `../../decisions.md` and every `D-nn` / `S-nn` resolve only in the predecessor
repository at its final commit `b856e15` (`plan.md` Conventions).

## 1. The user story

The owner opens `github.com/zevix/zbterm` and finds the predecessor's code, tests and docs
under the name ZBTerm ("Zeev's Bloated Terminal"). It sits on the current hello-pear-electron
template and current Holepunch modules, so upstream fixes merge in with `git merge upstream/main`.
It shares nothing with the predecessor at run time: its own profiles, links, invites and wire, so a
ZBTerm can run next to the owner's live predecessor instance (ports 17069/17070 and its profile
directory) without touching it. The predecessor repository freezes at its final commit `b856e15`
and keeps the predecessor's full history.

## 2. Where we start from (measured 2026-09-28)

| area | fact |
|---|---|
| the new repo | `/zeev/github/zbterm` = `git@github.com:zevix/zbterm.git`, a clone of `holepunchto/hello-pear-electron` at `72710d1` (2026-09-11); package `hello-pear-electron`, product `HelloPear`, `pear-runtime` ^1.1.4 with `hello-pear-worker`, OTA updater on |
| common ancestor | the predecessor branched from the template at `ad23048` "move to worker module" (2026-07-07). The template has 8 commits since: Windows update storage in `AppData/Local`, `install:*` scripts, `@electron/node-gyp`, socket firewall in CI, `AGENTS.md` and `agent_docs/`, docs |
| trial merge | the predecessor's `freenet` branch into a scratch clone of zbterm: 4 conflicted files — `README.md` (4 hunks), `package.json` (2), `package-lock.json` (2), `electron/main.js` (1) |
| predecessor state | branch `freenet` is 4 commits ahead of `main`; the working tree has uncommitted fixes (engine, renderer, tests, `engine/rpc/pipe.js`) and the new project docs |
| "Pear's new version" | Pear v3 (announced as "Pear Revolution", July 2026): `pear run` is removed, apps embed `pear-runtime`, deploys use `pear stage` / `provision` / `multisig`. The predecessor uses none of the removed surface: no `global.Pear`, no `pear run`; it spawns its worker with `bare-sidecar` directly (`engine/spawn-worker.js`), which is what `PearRuntime.run` does outside Bare. `D-08` removed the OTA updater. No new Hypercore / HyperDHT wire version is announced; `hyperdht` 6.33.0 dropped its internal `global.Pear` reference |
| module versions | installed → latest on npm: `hypercore` 11.33.5 → 11.37.0, `hyperswarm` 4.17.0 → 4.17.2, `hyperdht` 6.32.0 → 6.34.0, `protomux` 3.11.0 → 3.12.1, `bare-sidecar` ^0.4.5 → 0.5.7, `hyperbee` 2.27.3 (latest; `hyperbee2` 2.18.0 is "the next major version for hyperbee", not yet released as one), `keet-identity-key` 3.2.0 (latest) |
| name in the tree | the former name, in any case, on 2 347 lines of 189 tracked files: `docs` 992, `archive` 570, `test` 253, `README.md` 98, `scripts` 94, `electron` 77, `engine` 60, `bin` 56, `renderer` 52, `relay` 22, `spikes` 21, `flatpak` 15, `forge.config.js` 13, others 26 |
| files named for it | `bin/zbterm.js`, `flatpak/net.z33v.zbterm.{yml,metainfo.xml}`, `docs/npm-zbterm-{plan,handoff}.md`, `docs/npm-zbterm_CHANGELOG.md`, and all of the predecessor's `archive/tabby-plugin/` |
| names that reach the outside | npm `zbterm` and `zbterm-core` (neither published), app id `net.z33v.zbterm`, link scheme `zbterm://`, 52 `ZBTERM_*` variables, profile dirs `~/.zbterm-<profile>`, SSHSIG namespace `zbterm-identity`, wire domains `zbterm/fnet-*`, `zbterm/history`, `zbterm/ctl`, contract crates `zbterm-signalling` and `zbterm-pointer` (`.wasm` BLAKE3-pinned, `D-10`) |
| free names | npm `zbterm`, `zbterm-core`, `zbterm-tty`; crates `zxterm`, `zxterm-core`, `zxterm-tty` (all unclaimed on 2026-09-28) |
| a Pear TUI | `holepunchto/hello-pear-bare-tui` holds one commit, a README only. `holepunchto/hello-pear-bare` is the working boilerplate: a Bare CLI, `pear-runtime` in a worker, `bare-build --standalone` per platform. `node-pty` does not run under Bare (`ARCHITECTURE.md` §1, `spikes/pty-bare/`), and no Bare PTY module is on npm |

## 3. Requirements

- **Z-1 History (`D-28`).** zbterm's `main` is the template's history plus one squashed commit
  holding the renamed tree; no commit or tag from the predecessor, and no trace of the old name,
  is in it. The predecessor's full history stays in its own repository, at its final commit
  `b856e15`, and is not touched again.
- **Z-2 Current Pear stack.** ZBTerm is based on the template at `72710d1` or later, keeps
  `upstream` as a remote, and runs current Holepunch modules. Nothing uses a surface Pear v3
  removed. The OTA updater does not come back (`D-25`).
- **Z-3 One name (`D-27`).** The former name, in any case, appears nowhere in the tree, historical
  records included, pinned by a test that greps the tracked files. It is not in zbterm's
  published history either (`Z-1`).
- **Z-4 A clean break (`D-23`).** ZBTerm uses no predecessor storage, profile, link scheme,
  variable, discovery topic, wire domain, signature namespace or contract. A predecessor invite
  given to ZBTerm is refused with a message that says so, within the join timeout; it never hangs.
- **Z-5 Nothing lost.** The suite passes with the baseline count, or the delta is listed test by
  test. Lint passes. A packaged build boots with a fresh profile (under `uisolate`). A Pear share
  between two ZBTerms on a local `hyperdht` testnet and a Freenet share against a local-mode node
  both pass the conformance suite.
- **Z-6 The core is a package.** `engine/` is published as `zbterm-core` and is usable without
  Electron, as it is today. A text client is decided by spike T0 (`plan.md`), not by this project.
- **Z-7 The owner's live predecessor instance (ports 17069/17070 and its profile directory) is
  never touched** (the process-safety rules in `plan.md`).

## 4. Out of scope

- zxterm-core and any Rust: its own project and repository, run in parallel (`D-29`, `D-30`).
- New features, UI redesign, protocol redesign. Names change, behaviour does not.
- Publishing anything: npm, Pear links, GitHub releases, `v*` tags, the flatpak manifest. The
  owner does these.
- Migrating the predecessor's profiles or recordings (`D-23`).
