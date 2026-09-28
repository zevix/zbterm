# Decisions

Decisions that outlive the project that took them. **Append-only.** Take the next free id at
landing time; never reserve one. `against` cites the `S-nn` or question a decision answers.

Opened 2026-09-18 by [`projects/260918_backend-abstraction/`](projects/260918_backend-abstraction/).

**Next free id: `D-31`.**

| id | against | in one line |
|---|---|---|
| D-01 | Q-1 | The Freenet backend is hybrid: contracts for invites, rendezvous, membership, rekey and durable history; a contract-signalled WebRTC data channel for live output and viewer input. |
| D-02 | Q-2 | "Pear backend" means network sharing only. Local Hypercore storage, the Bare sidecar, crypto and the Pear OTA updater stay in every build. |
| D-03 | Q-3 | The backend-abstraction spike delivers the interface in code, a conformance suite, the Pear adapter, selection + build variants + UI gating, and Freenet probes. A working Freenet backend is a follow-on project. |
| D-04 | S-08 | `ShareBackend.withdraw` ends discovery of a route, not reachability of the host. Refusing a join on a withdrawn or revoked link is ShareManager's job, on every backend. |
| D-05 | S-11 | The registry lists `pear` and `freenet` only. The loopback backend is never listed; an injected backend (`opts.shareBackend`) bypasses the registry and the launch limit and serves an invite of any `b`. |
| D-06 | S-06 | The Freenet adapter is split: the contract client (Freenet SDK) runs in the Bare worker; the WebRTC half runs in the host process on `node-datachannel`, behind new `BACKEND_*` frames, the `engine/pty-remote.js::PtyRemote` pattern. |
| D-07 | S-13 | Revises `D-02`: a build without the Pear backend also drops the Pear OTA updater, so `hyperswarm`, `hyperdht`, `corestore` and `pear-runtime` leave it. The worker is then spawned through `bare-sidecar`. |
| D-08 | Q-1 (`projects/260919_no-updater-archive-tabby`) | Supersedes `D-07`'s scope and the last clause of `D-02`: no build has the Pear OTA updater. `pear-runtime`, `corestore`, the `pear-link` use, `package.json#upgrade`, `pear.json` and `workers/main.js` are gone; `--no-updates` stays as an accepted no-op; the npm registry check stays. |
| D-09 | Q-2 (`projects/260924_freenet-backend`) | The owner confirms `D-06`: the Freenet adapter stays split, contract client in the Bare worker, WebRTC in the host process on `node-datachannel` behind `BACKEND_*` frames. |
| D-10 | Q-3 (`projects/260924_freenet-backend`) | Contracts ship as committed raw `.wasm` bytes with BLAKE3 hashes pinned by a test; Rust sources, lockfile and a build script stay in the repo; nothing compiles at install or package time; the pointer-record contract is in scope and the invite carries `ptr`. |
| D-11 | Q-4 (`projects/260924_freenet-backend`) | Default ICE servers `stun:stun.l.google.com:19302` and `stun:stun.cloudflare.com:3478`, read by the host process; `ZBTERM_ICE_SERVERS`, `--ice-servers` and a settings field replace the list, the empty string disables STUN; `RELAY` is claimed only with a `turn:` URL; ZBTerm runs no TURN; the README states the disclosure. |
| D-12 | Q-5 (`projects/260924_freenet-backend`) | ZBTerm never installs, spawns, supervises or updates the Freenet node. It detects one at a configured address and reports `freenet` as `broken` with "no Freenet node at <address>" otherwise. Design phase F9 (node lifecycle) is out. |
| D-13 | Q-6 (`projects/260924_freenet-backend`) | Offline history stays out: `HISTORY_OFFLINE_HOST` and `HISTORY_EVENTUAL_MERGE` are cleared and `historyRouteFor` returns `null`. One time-boxed (≤ 2 days) probe of design §8.2 option A; its failure opens option B as its own project. |
| D-14 | Q-7 (`projects/260924_freenet-backend`) | Freenet ships in the default package: `forge.config.js::DEFAULT_BUILD_BACKENDS` becomes `'pear,freenet'`; `ZBTERM_FREENET_EXPERIMENTAL` is removed; the share dialog shows the backend picker with broken backends disabled and their reason; the licence question (`D-15`) gates close-out. |
| D-15 | Q-8 (`projects/260924_freenet-backend`) | `@freenetorg/freenet-stdlib` ships unmodified in its own `node_modules` folder; `THIRD-PARTY-NOTICES.md` lists it under both declared licences (npm `MIT+APACHE-2.0`, repository LGPL-3.0, with the LGPL text and a source link), `node-datachannel`/libdatachannel (MPL-2.0) and the crates linked into the WASM; an upstream issue asking Freenet to reconcile the metadata is filed. Close-out needs the notices and the filed issue, not an answer. |
| D-16 | `S-20` (`projects/260924_freenet-backend` F6) | Revocation is backend-defined above one shared guarantee. `ShareManager.revokeLink` awaits `backend.withdraw(linkId)` (`A-10` stands). The guarantee (`D-04`) is: after `revokeLink`, a late join with the same invite ends `failed`, the host confirms nothing, and no bootstrap or session data reaches the peer. **How** it fails is the backend's: Pear and the loopback stay reachable by peer key after `withdraw` (withdraw ends discovery only), so the host denies in-band (`host:join-deny invalid-or-revoked`); Freenet becomes unreachable, so the join ends in a backend error (`E_HOST_UNREACHABLE` or the join timeout). The conformance case accepts either outcome and asserts the guarantee in full in both; a backend without in-band denial must still end the join within the case's bound. |
| D-17 | Q-1 (`projects/260928_zxterm-core`) | One Rust program, `ptcore`, owns everything ZBTerm puts on the Freenet wire: transport, session protocol and history format. The Electron app reaches it through a local seam; the Pear backend stays in JS. Supersedes `D-06`/`D-09` once that project's stage C1 lands. |
| D-18 | Q-2 (`projects/260928_zxterm-core`) | Freenet sessions stop using Hypercore for history: `ptcore`'s segment format, live over a channel and offline through a segment contract. Revises `D-13` for Freenet (option A dropped, option B is the design). Local-only sessions and Pear shares are unaffected. |
| D-19 | Q-3 (`projects/260928_zxterm-core`) | The Electron GUI stays the general-purpose terminal. The Rust text client and `ptcore serve` are a second client for headless hosts, remote-desktop hosts and recording on a terminal of fixed size; a viewer grid smaller than the host's is cropped and panned. |
| D-20 | Q-8 (`projects/260928_zxterm-core`) | The Rust terminal family is ZXTerm: `zxterm-core` is the shared core (the `ptcore` of `D-17`–`D-19`), `zxterm-tty` the text UI (the `pt` of `D-19`), `zxterm` the Rust GUI, a later project. |
| D-21 | Q-9 (`projects/260928_zxterm-core`) | The former name is renamed ZBTerm, because it is no longer Pear-only. The rename is its own project. Wire and signature strings (`zbterm-identity`, `zbterm/fnet-*`, …) keep their bytes. |
| D-22 | Q-10 (`projects/260928_zxterm-core`) | One implementation of SSH keys and GitHub identity, in `zxterm-core`: key discovery, ssh-agent, SSHSIG, the `.keys` fetch and cache, claims, challenges and identity records. ZBTerm uses it for every backend, Pear included, so the core ships in every build; the formats are kept byte for byte. |
| D-23 | Q-1 (`projects/260928_zbterm-fork`) | ZBTerm is a hard fork in `github.com/zevix/zbterm` (a fork of `holepunchto/hello-pear-electron`) with the predecessor repository's history merged in. No compatibility with the former name: sessions, invites, links, claims, profiles, variables and wire formats may break, in the fork and again when moving to `zxterm-core`. Supersedes `D-21`'s "wire and signature strings keep their bytes" and `D-22`'s "byte for byte". |
| D-24 | Q-2 (`projects/260928_zbterm-fork`) | The fork comes before any zxterm work, and ZBTerm tracks the current Pear stack: Pear v3 (the hello-pear-electron template at `72710d1` or later) and current Holepunch modules. |
| D-25 | Q-3 (`projects/260928_zbterm-fork`) | The Pear OTA updater does not come back in the fork. The worker keeps being spawned with `bare-sidecar`; an updater, if wanted, is its own project once ZBTerm has a release channel. `D-08` stands. |
| D-26 | Q-4 (`projects/260928_zbterm-fork`) | ZBTerm stays on `hyperbee` 2.x; `hyperbee2` is revisited when it ships as the next major. |
| D-27 | Q-5 (`projects/260928_zbterm-fork`) | The former name is removed everywhere, historical records included: the ledgers, closed projects, CHANGELOGs and handoffs are rewritten to say ZBTerm. The name was never published. The name test allows no path once the fork closes. |
| D-28 | Q-7 (`projects/260928_zbterm-fork`) | The predecessor repository's git history is not carried into zbterm: zbterm's `main` is the template's history plus one squashed commit holding the renamed tree. The full history stays in the predecessor repository, frozen at its final commit `b856e15` and not touched again. Supersedes `260928_zbterm-fork` `Z-1`'s merged history. |
| D-29 | Q-8 (`projects/260928_zbterm-fork`) | The two projects run in parallel: this folder lives in `zevix/zbterm`, zxterm-core's in `zevix/zxterm`; zxterm-core's stages that change ZBTerm code land in zbterm only after `Z5`, so the rename and the core swap never edit the same files at once. Supersedes `D-24`'s order; its "current Pear stack" standing stays. |
| D-30 | Q-8 (`projects/260928_zbterm-fork`) | The `zxterm` Cargo workspace is its own repository, `zevix/zxterm`, from the start; its new decisions go into that repository's `docs/decisions.md` as `X-nn`, so the two ledgers never share an id. |

## D-01 (against Q-1) — Freenet is a hybrid backend

**Q.** Freenet has no peer-to-peer duplex stream. How does its backend carry live PTY output
and viewer input?

Signed by the project owner on 2026-09-18. Freenet's app API is contract
`Put`/`Get`/`Update`/`Subscribe` only. Writing viewer input into contract state would store it,
which the default security policy forbids (`abstract-arch.md` §23.6). A data channel keeps
input ephemeral. Rejected: contract-only, read-only viewers, and deferring the choice to the
end of the spike.

## D-02 (against Q-2) — scope of the Pear backend

**Q.** Holepunch code also provides local storage, the process model and OTA updates. What
does a build without the Pear backend exclude?

Signed 2026-09-18. Only network sharing: hyperswarm, hyperdht, protomux use, the relay lookup
and Hypercore replication to peers. `protomux` stays installed regardless, because hypercore
depends on it. Rejected: also excluding the OTA updater, and excluding all Holepunch code.

> **2026-09-19.** "Rejected: also excluding the OTA updater" no longer holds for builds without
> the Pear backend: see `D-07`. The owner had read this question as being about live session
> updates. `D-02` stands for local Hypercore storage, the Bare sidecar and crypto.

> **2026-09-19 (`D-08`).** The Pear OTA updater no longer stays in any build, with or without
> the Pear backend: see `D-08`. `D-02` still stands for local Hypercore storage, the Bare
> sidecar and crypto.

## D-03 (against Q-3) — depth of the spike

**Q.** How far does the spike go?

Signed 2026-09-18. Interface, conformance suite, Pear adapter with every existing test green,
selection, build variants, UI gating, and Freenet probes. Rejected: both adapters working end
to end, and documents only.

## D-04 (against S-08) — what `withdraw` promises

**Q.** The B5 conformance case "after `withdraw` a new dial fails" is red on Pear: a peer that
holds the host key still connects through `swarm.joinPeer`, because the swarm server keeps
listening after `swarm.leave(topic)`. What does `withdraw` promise?

Taken 2026-09-18 by the plan orchestrator during B5, under the B5 re-planning signal. It
preserves today's Pear behaviour, which the plan forbids changing: before the spike, revoking a
link left the topic but a peer with the host key could still open a socket, and the control
protocol refused the join because the link record was revoked. So `withdraw(linkId)` stops
announcing the route and nothing more. A backend **may** refuse later dials (loopback does); it
need not. The guarantee that matters for security, "a join on a withdrawn or revoked link is
refused and receives no session data", is asserted at ShareManager level against every backend.
Rejected: gating Pear's firewall on "something is announced" (breaks an inherited assertion and
still admits a dial by key while another link is announced), and dropping the case.

> **2026-09-18 (B5 gate).** One sentence above is wrong: before the spike, revoking a link did
> **not** leave the topic. At HEAD the only `swarm.leave` in `engine/share-manager.js` is the
> viewer's join settle, and `revokeLink` never left the topic; the host keeps announcing and
> the control protocol refuses the join (`host:join-deny`, `invalid-or-revoked`). ShareManager
> therefore does not call `backend.withdraw` today, and B5 did not add the call. The decision
> stands; the new conformance case proves the refusal on both backends while the host is still
> announcing.

## D-05 (against S-11) — what the registry lists, and what injection means

Taken 2026-09-18 in B6.

- `engine/backends/index.js::KNOWN` is `pear` and `freenet`. The in-process loopback
  (`engine/backends/loopback.js`) is a test backend and is **not** registered, so it can never
  appear in `share.backends` and no `--backend` / `ZBTERM_BACKEND` value can select it. A
  limit only removes backends; an id the build lacks selects nothing.
- A backend handed in through `new ShareManager(engine, {backend})` or
  `SessionEngine({shareBackend})` **bypasses the registry and the limit**. It is active from
  construction (B4 behaviour, unchanged), it is the only entry `share.backends` reports, and it
  serves `createLink` and `join` whatever `backend` / `b` they name. The last point is needed,
  not just convenient: the conformance suite forges v1-shaped invites (implicit `b: 'pear'`)
  and joins them over the loopback.
- The loopback keeps its `{topic}` route spelling by default for the same reason (the forged
  invite is built from `link.topic`). `LoopbackBackend({routeKey})` makes the route opaque;
  ShareManager then stores `link.route` in place of `link.topic` and the invite is v2. That
  resolves B5's `TEMPORARY(until B6)` marker.
- ShareManager compares backend ids only to select (`_ensureBackend`); it never branches
  behaviour on one. Which invite shape a backend gets is `engine/invite.js`'s call: `b:'pear'`
  keeps the v1 fields, any other `b` is always v2.
- `limitedBy` in `share.backends` is the limit value in force (`'none'`, `'pear'`, …) or
  `null`. The flag-versus-env source stays in the host; only the value crosses the spawn seam.

## D-06 (against S-06) — topology of the Freenet adapter

**Q.** R-13 offers four topologies for the Freenet adapter: in-worker, a host-process adapter
over new `BACKEND_*` frames, a Node sidecar, or a Rust sidecar. Which one?

Taken 2026-09-18 by the plan executor in B9, from the B8 measurements; **open to the owner's
revision**. The B8 re-planning signal "P-3 fails under Bare" fired, and it fired for the WebRTC
half only:

- The SDK half works in the worker. P-1 round-trips `Put`/`Get`/`Subscribe`/`Update` under
  pear-runtime's Bare 1.27.0 (update→notification p50 37 / p95 44 ms, n = 20) with four shims.
- The WebRTC half does not. No library's JS loads under Bare, and node-datachannel's raw
  binding delivers every binary frame as zero bytes (`"hex":"00000000"`, expected `706f6e67`)
  on Bare 1.30.3 and 1.27.0 (`S-06`).

So: `engine/backends/freenet/` keeps the contract client, the route, the signed signalling
entries, admission and the `ShareBackend` surface in the worker. Peer connections and data
channels live in the host process on `node-datachannel` 0.33.4 (offer→connected 114 ms through
the contract, 12.87 MiB/s Hypercore replication, the only library whose `onBufferedAmountLow`
fired every time). The two halves talk over new `FrameKind.BACKEND_*` frames appended after
`PTY_DETACH` (14), the way `engine/pty-remote.js::PtyRemote` and
`engine/client.js::EngineClient._onFrame` carry the PTY. Rejected: both halves in the host
process (it moves the SDK out of the worker for no measured reason and puts ShareManager's
backend behind an asynchronous seam for every call, not just channel I/O); a Node sidecar (a
third process, where the host process already runs Node); a Rust sidecar (nothing measured
calls for it, A-4); base64 over text frames under Bare (+33 % bytes, throughput unmeasured, and
it builds on a binding whose binary path is known broken). Design:
[`projects/260918_backend-abstraction/freenet-backend-design.md`](projects/260918_backend-abstraction/freenet-backend-design.md).

## D-07 (against S-13) — no Pear backend means no Pear OTA updater

**Q.** `D-02` kept the OTA updater in every build, which forces `hyperswarm` and `hyperdht`
into the `none` and Freenet-only packages (`S-13`). Keep the updater, or the clean dependency
set?

Signed by the project owner on 2026-09-19: "I prefer to give it up to remove the dependency."
The owner had read the `D-02` question as being about live session updates, not the app's OTA
updater. Scope taken by the executor, open to revision: the updater is dropped only from builds
**without** the Pear backend; a build with Pear ships `hyperswarm` anyway, so its updater stays.
`pear-runtime` requires `hyperswarm` at load, and its `run` is only
`new (require('bare-sidecar'))(entrypoint, args, opts)`, so a non-Pear build spawns the engine
worker through `bare-sidecar` directly. `D-02` stands for local Hypercore storage, the Bare
sidecar and crypto. Implemented by
[`projects/260919_nonpear-no-updater/`](projects/260919_nonpear-no-updater/).

> **2026-09-19 (`D-08`).** "a build with Pear ships `hyperswarm` anyway, so its updater stays"
> was the executor's scope and the owner revised it: the updater is removed from every build
> (`D-08`). What stands from `D-07`: the worker is spawned through `bare-sidecar`
> (`engine/spawn-worker.js::spawnWorker`), and a package without the Pear backend loses
> `hyperswarm` and `hyperdht` (`forge.config.js::pruneDroppedDependencies`). "its `run` is only
> `new (require('bare-sidecar'))(…)`" can no longer be checked against an installed
> `pear-runtime`; `test/spawn-worker.test.js` pins the helper's own source instead.

## D-08 (against Q-1 of `260919_no-updater-archive-tabby`) — no Pear OTA updater in any build

**Q.** The `260919_nonpear-no-updater` report said: "I assumed the updater should stay in builds
that include Pear. Tell me if you want it removed from every build."

Signed by the project owner on 2026-09-19: "feel free to remove all the pears update and archive
the Tabby work - it did not go well". Supersedes the scope the executor took in `D-07` (updater
dropped only from builds without the Pear backend) and the clause of `D-02` that kept "the Pear
OTA updater" in every build. Deleted: `workers/main.js` and `workers/`,
`electron/updater-available.js`, `pear.json`, `package.json#upgrade`, the `pear-runtime` and
`corestore` dependencies, the `pear-link` and `UPGRADE_KEY` use in `forge.config.js`, the
`upgrade-key` input of `.github/workflows/build-release.yml` (the reused
`holepunchto/actions/make-pear-app@v1` declares `upgrade_key` `required: false`), and the updater
code in `electron/main.js`, `electron/preload.js` and `renderer/app.js`. Kept, by assumption
(`A-3`, `A-4`): `--no-updates` is still an accepted flag and does nothing, so `npm start`,
`scripts/npm-smoke-install.sh` and the owner's launcher keep working; the npm registry check
(`electron/update-channel.js`, `renderer/app.js::wireNpmUpdater`, `app.updateCheck`) is not a Pear
update and is unchanged. `forge.config.js::BUILD_BACKENDS.pear` is now `hyperswarm` and
`hyperdht` with no files. Not provided: a replacement update channel for installer builds.
Pinned by `test/no-updater.test.js`, `test/backend-boundary.test.js` and
`test/build-variants.test.js`. Implemented by
[`projects/260919_no-updater-archive-tabby/`](projects/260919_no-updater-archive-tabby/) phase V1.

## D-09 … D-15 (against Q-2 … Q-8 of `260924_freenet-backend`) — the Freenet backend's shape

Signed by the project owner on 2026-09-24, one question at a time, recommendation first
([`projects/260924_freenet-backend/QnA_assumptions.md`](projects/260924_freenet-backend/QnA_assumptions.md)).
The table rows above are the decisions; the questions, the options offered and the reasoning are
in that file. Two answers went against the recommendation: `D-14` (the owner chose Freenet in the
default package over an opt-in build variant) and Q-9 there (work in place, not in a clone; Q-9 is
a working rule, not a decision that outlives the project). `D-09` turns the executor's `D-06` into
the owner's. Implemented by [`projects/260924_freenet-backend/`](projects/260924_freenet-backend/)
phases `F3`–`F9`.

## D-16 (against `S-20`, F6 of `260924_freenet-backend`) — revocation semantics per backend

Taken by the orchestrator on 2026-09-24 during execution, not asked of the owner (an executor
decision under the plan's handoff contract; the owner may overturn it). `A-10` assumed the revocation
conformance case would be unchanged by `revokeLink` calling `withdraw`. It is not: the loopback
dropped the route on `withdraw`, so the late peer's dial never reached the host and the case waited
out `JOIN_TIMEOUT_MS` instead of seeing `host:join-deny`; Freenet, by design, is unreachable after
`withdraw` too. Two ways out were open — keep every backend reachable after `withdraw` (impossible for
Freenet without a presence record that would need refreshing under the contract's TTL), or let the
guarantee be backend-neutral and the mechanism backend-defined. `D-16` takes the second: the security
property of `D-04` (refused, nothing confirmed, no data) is asserted the same way for every backend;
the in-band denial is asserted only where the backend can deliver it. The loopback gains Pear's
reachability-by-peer-key after `withdraw` so its run keeps exercising the in-band path; the Freenet
run exercises the unreachable path (`F7`).

## D-17 … D-19 (against Q-1 … Q-3 of `260928_zxterm-core`) — a Rust core for Freenet

Agreed by the project owner on 2026-09-28, in conversation. The owner proposed one Rust Freenet core
shared by the JavaScript app and a Rust client, for compatibility and interoperability (`D-17`), and
named where a text-only client fits and where it does not (`D-19`). The owner accepted that
Freenet sessions in the JavaScript app stop using Hypercore for history (`D-18`), without which the
two clients could share live output but not history. The design, its open questions and its spikes
are in [`projects/260928_zxterm-core/design.md`](projects/260928_zxterm-core/design.md).

> **2026-09-28.** `260928_zxterm-core` moved to its own repository, `zevix/zxterm`, from the
> start (`D-30`): the link just above does not resolve in this repository. See it at
> `https://github.com/zevix/zxterm/tree/main/docs/projects/260928_zxterm-core/design.md`, or the
> project row in [`docs/projects/README.md`](projects/README.md).

## D-20 … D-22 (against Q-8 … Q-10 of `260928_zxterm-core`) — names, the rename, identity in the core

Set by the project owner on 2026-09-28, in conversation, the same day as `D-17`–`D-19`. The owner
named the Rust family ZXTerm and its three crates (`D-20`), renamed the former name to ZBTerm
(`D-21`), and required that SSH keys and GitHub identity be handled by one implementation that ZBTerm shares
(`D-22`). That identity lives in `zxterm-core` and that the rename leaves wire and signature bytes
alone are consequences recorded with the design: a renamed SSHSIG namespace or signalling domain
would stop every existing claim and invite from verifying. See
[`projects/260928_zxterm-core/design.md`](projects/260928_zxterm-core/design.md) §3, §4.6, §4.9.

> **2026-09-28.** Same as the note under `D-17` … `D-19`: this link does not resolve here either,
> for the same reason (`D-30`).

## D-23, D-24 (against Q-1, Q-2 of `260928_zbterm-fork`) — the hard fork

Set by the project owner on 2026-09-28, in conversation, after `D-20`–`D-22`: "I have no problem
with breaking compatibility", start with the rename ("or more correctly - hard fork") into the
new repository, and base it on Pear's new version because the old one is being retired. `D-23`
removes the compatibility consequences recorded with `D-21` and `D-22` and makes the zxterm-core
design's wire-compatible stage a convenience rather than a requirement. `D-24` orders the work.
Pear's new version was found to be Pear v3 (July 2026); the predecessor repository already sat on
the post-v3 template (see [`projects/260928_zbterm-fork/requirements.md`](projects/260928_zbterm-fork/requirements.md) §2).

## D-25 … D-27 (against Q-3 … Q-5 of `260928_zbterm-fork`) — updater, hyperbee, the old name

Set by the project owner on 2026-09-28, in conversation. The owner took the recommendations for
Q-3 and Q-4, and went against the recommendation for Q-5: "lets remove the former name and
rewrite history - it was not publish yet and the former name is unknown". `D-27` means the
records describe the product under its one name. The earlier recommendation to keep historical
records as written was rejected, because the old name has no readers who would look for it.
Whether the git commit history is rewritten as well is Q-7 of that project, answered by `D-28`.

## D-28 (against Q-7 of `260928_zbterm-fork`) — squash, do not rewrite

Set by the project owner on 2026-09-28, in conversation: "better than rewrite - squash it in the
new repo, we have history in the predecessor repo which we won't touch anymore". The recommendation
had been to rewrite the history with `git filter-repo`. The owner's way needs no rewriting tool
and no remapped hashes: the old name never enters zbterm's published history, because the only
commit derived from the predecessor repository on `main` is made after the rename. Commit hashes
cited in the docs keep pointing into the predecessor repository.

## D-29, D-30 (against Q-8 of `260928_zbterm-fork`) — two projects in parallel, zxterm in its own repository

Set by the project owner on 2026-09-28, in conversation: "I want to move the project to ../zbterm/ -
please move the rename and merge project there under docs/projects … and the zxterm project to
../zxterm/ so I can start them in parallel". This supersedes the order `D-24` set (its "on the
current Pear stack" standing stays) and answers zxterm-core's `Q-11` (where the workspace lives)
with its own repository. `D-29` keeps the two projects from touching the same files: zxterm-core's
stages that change ZBTerm code land here only after `Z5`. `D-30` keeps their ledgers from sharing
an id: zxterm-core's decisions are `X-nn` in `zevix/zxterm`'s own `docs/decisions.md`.

