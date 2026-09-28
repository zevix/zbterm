# zbterm-fork — plan

**Closed 2026-09-28.** `Z0`–`Z5` are done (see [`CHANGELOG.md`](CHANGELOG.md)). zbterm's working
tree holds the predecessor's code, tests and docs under the name ZBTerm. It runs on the current
Pear stack (`hypercore` 11.37.0, `bare-sidecar` 0.5.7, and the rest in the `Z2` note), has its own
names, storage, link scheme, wire strings and rebuilt contracts, and holds no former-name byte
(`test/name.test.js`). Suite 469/469, 3002/3002; lint 98 warnings; the packaged app boots with a
fresh profile. Nothing is committed: the owner's commands are in [`owner-steps.md`](owner-steps.md).
`T0` (the optional text-client spike) was not run; it and everything else left open is in
[`open-issues.md`](open-issues.md).

**Opened 2026-09-28.** The WHAT is [`requirements.md`](requirements.md) (`Z-1`…`Z-7`); questions
and assumptions are [`QnA_assumptions.md`](QnA_assumptions.md). Decisions agreed at opening:
`D-23` (hard fork, no compatibility with the predecessor) and `D-24` (this project first, on the
current Pear stack). Answered since: `D-25` (no OTA updater), `D-26` (stay on `hyperbee` 2.x),
`D-27` (the old name is removed everywhere, historical records included), `D-28` (the
predecessor's git history is squashed, not carried over), `D-29` (zxterm-core runs in parallel,
in its own repository) and `D-30` (`zevix/zxterm` holds its workspace and its own `X-nn` ledger);
both are recorded in `QnA_assumptions.md` `Q-8` and enter the ledger in `Z1`. No question is open.

**Goal.** The predecessor's code, tests and docs live in `/zeev/github/zbterm` under the name
ZBTerm, on the current template and modules, and share nothing with the predecessor at run time. Six
phases, `Z0`–`Z5`, and one optional spike, `T0`.

> **2026-09-28, execution starts.** The owner runs this plan by the exec template
> (`/ubitron/dev/docs/templates/exec.md`): one subagent per phase (model sonnet) with a clean
> context, the gate re-run by the coordinator, a handoff note per phase, and each green phase
> cut into [`CHANGELOG.md`](CHANGELOG.md). That template says "DO NOT touch git", so the git
> steps of this plan change. No phase runs a git command that changes a repository's state: no
> `remote`, `fetch`, `branch`, `checkout`, `merge`, `commit`, `tag`, `mv` or `rm`. Read-only git
> (`status`, `diff`, `show`, `archive`, `rev-parse`, `log`) is allowed, and so is `git merge-file`
> on scratch copies. Each phase leaves its result in zbterm's working tree, and the owner commits
> when and where they choose. A local `fork` branch would keep the per-phase history `D-28`
> assumed; the one squashed commit on `main` (`Z5`) is the owner's. Before `Z1` the owner
> committed and pushed this folder on `main` as `931a836`. The go-ahead to execute covers
> `Z1`'s lock-only `npm install` and the `npm ci` its gate needs in zbterm.

## Conventions every phase honours

- Source repo: the predecessor repository (read-only after `Z0`; `D-nn` and `S-nn` cited
  before `Z1` resolve there, at its final commit `b856e15`). Target repo: `/zeev/github/zbterm`.
  Plain CommonJS, Node ≥ 20, no build step.
- This folder moved into the target repo on 2026-09-28, before `Z1`, and is not yet committed;
  the zxterm-core folder moved to `/zeev/github/zxterm` (`D-29`, `D-30`).
- One phase, one or more commits on the zbterm branch `fork`; each phase ends green. No phase
  mixes moving code with renaming it, so any regression bisects to one kind of change.
- Ledgers `docs/register.md` (`S-nn`) and `docs/decisions.md` (`D-nn`) are append-only and move
  to zbterm in `Z1`; numbering continues there. Take the next free id at landing time.
- A number written into a ledger or README is pinned by a named test or marked "reported, not
  gated".
- **Git.** Commits only on zbterm's `fork` branch, and only when the owner has approved the phase.
  Nothing is pushed, no tag is pushed and nothing is published (npm, `pear stage`/`provision`/
  `multisig`/`seed`, GitHub releases, `v*` tags); the owner does these. `Z0` commits on the
  predecessor only with the owner's explicit go-ahead.

  > **2026-09-28.** Superseded for execution (exec template): no phase runs a git command that
  > changes a repository's state (`remote`, `fetch`, `branch`, `checkout`, `merge`, `commit`,
  > `tag`, `mv`, `rm`, `stash`, `add`). Read-only git (`status`, `diff`, `show`, `archive`,
  > `rev-parse`, `log`) and `git merge-file` on scratch copies are allowed. Each phase leaves its
  > result in zbterm's working tree; the owner commits. This folder is committed on `main` as
  > `931a836` (the owner's commit, pushed), so the bullet above saying it is not yet committed
  > no longer holds.
- **Process safety — the owner runs the live predecessor instance (ports 17069/17070 and its
  profile directory) from the source tree.** Never `pkill`, `killall`, `kill` by
  pattern or `fuser -k`; signal only a PID this session started, after checking that its command
  line carries the scratch path. Never touch ports 17069/17070 or the predecessor's profile
  directory. Never run
  `npm start`, `npm install`, `npm ci` or `npm prune` in the source tree. In the target tree,
  `npm install` runs only after the owner allows it for this project. Every test instance gets
  its own storage, Electron `userData`, `HOME`, a debug port other than 17069/17070, and
  `--no-updates`. Any GUI runs only under `uisolate`. Package only with the forge output directory
  set to a scratch directory outside both repos. Copy these rules into every subagent brief.
- **Baseline** (`baseline.md`, `Z0`): 461/461 tests, 2977/2977 asserts, no failing ids; lint exit
  0 with 98 `require-await` warnings. `S-03` is a known flake: on a red, re-run once and report
  both runs. Tests run with their own `HOME` and a short `TMPDIR` (under 20 characters, e.g.
  `/tmp/zbt-z1`): a long one breaks the SSH-agent test (108-byte socket path limit).
- **Next free** at `Z1` start: `S-36`, `D-29` (`D-31` once `Z1` lands `D-29`/`D-30`). Read them from
  the "Next free id" line of each ledger at landing time.
- Corrections to inherited docs are dated blockquotes, never rewrites. Never lower a tolerance,
  weaken an assertion or re-bless a count to get green.
- **Handoff notes.** After each phase, append 2–5 bullets under `## Handoff notes`: Decisions,
  Gotchas hit, Measured, Files touched, Next free `S-nn`/`D-nn`, and the baseline count. A green
  phase is then cut verbatim into `CHANGELOG.md` with its note and verification output, leaving
  `## Phase Zn: <title> — ✅ done (see CHANGELOG)`.

## Phase order

```
Z0 freeze the predecessor    first; needs the owner's go-ahead to commit
Z1 import the tree           after Z0 (D-28)
Z2 current Pear stack        after Z1 (D-25, D-26)
Z3 rename                    after Z2 (D-27)
Z4 clean-break checks, docs  after Z3
Z5 close-out                 last
T0 zbterm-tty spike          optional, after Z3; outcome is Q-6
```

## Phase Z0: Freeze the predecessor — ✅ done (see CHANGELOG)

## Phase Z1: Import the tree — ✅ done (see CHANGELOG)

## Phase Z2: Current Pear stack — ✅ done (see CHANGELOG)

## Phase Z3: Rename — ✅ done (see CHANGELOG)

## Phase Z4: Clean-break checks and docs — ✅ done (see CHANGELOG)

## Phase Z5: Close-out — ✅ done (see CHANGELOG)

## Phase T0: zbterm-tty spike (optional, after Z3)

A Pear-network text client can only be JavaScript: `zxterm-core` has no Hyperswarm (no Rust
implementation exists), so without it a TUI cannot join a Pear share. Shape: the
`hello-pear-bare` boilerplate (Bare CLI, `bare-build --standalone`), `zbterm-core` in its worker,
`bare-tty` for the terminal, `@xterm/headless` (already used by the engine under Bare) to crop a
larger host grid.

- Gates: a viewer joins a Pear share from the Electron ZBTerm on a local testnet and shows live
  output; a host grid larger than the local terminal is cropped and pans; it runs from a
  standalone binary.
- Measures: binary size, RSS, echo latency against the Electron viewer.
- Known gap: hosting or recording a local shell needs a PTY, and `node-pty` does not run under
  Bare. Either a Bare PTY addon (none on npm) or a Node build of the client; that choice is part
  of `Q-6`.

## Out of scope

- Any behaviour change beyond names, the module updates of `Z2` and `Q-3`'s answer.
- Rust, zxterm-core, and the `pv: 2` protocol (`zevix/zxterm`, `D-30`).
- Publishing anything.
- Migrating the predecessor's profiles, recordings or claims (`D-23`).

## Handoff notes

- **Z0** (2026-09-28). Decisions: none new. Gotchas hit: a long `TMPDIR` breaks the SSH-agent
  test. Measured: predecessor `main` = final commit `b856e15`; 461/461 tests, 2977/2977
  asserts twice; lint 0 errors, 98 warnings. Files touched: predecessor `docs/decisions.md`,
  this folder. Next free: `S-36`, `D-29`. Baseline: 461 / 2977.
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
