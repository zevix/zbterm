# Freenet share backend — questions and assumptions

Phases cite these ids and do not relitigate them. `Q-n` was asked and answered by the owner on
2026-09-24, one at a time, recommendation first. `A-n` was taken without asking.

## Questions

### Q-1 How do we test on the real Freenet network?

**Answer: option 2, plus a recipe-built second host.** The owner's network-mode node on
`127.0.0.1:7509` may be used for this project's test contracts, `Put` included (consent to publish
small, meaningless test data; withdraws `S-04`'s block for this project). The second host is
`hetzner-deb16` (ssh alias; `46.224.69.75`; also `hetzner-deb16-root`). It is provisioned by a ubitron
fabric recipe (`/ubitron/dev/ubitron/envs/doc/ubitron_fabric_skill.md`), written for Debian and Fedora,
tested only on Debian, run with `/zp/zdata/work/ubitron/dev/.venv/bin/python`. On any remote machine
everything lives under `~/work/zbterm`.

Other options offered: a second local node with its own ports plus a second host (recommended, not
chosen); local-mode only, nothing measured on the network; decide when F0 is reached.

### Q-2 Where does the Freenet code run inside ZBTerm?

**Answer: option 1, `D-06` stands.** The contract client runs in the Bare worker beside the Pear
backend; the WebRTC half runs in the host (Electron) process on `node-datachannel`, behind new
`BACKEND_*` frames, the `engine/pty-remote.js::PtyRemote` pattern. Recorded as `D-09` (owner's
confirmation of the executor's `D-06`).

Other options offered: the whole backend in the Electron process; a separate Node helper process;
compiling a WebRTC library for Bare.

### Q-3 How do we ship the contract, and who compiles it?

**Answer: option 1.** The compiled `.wasm` of every contract version the build supports is committed
with its BLAKE3 hash, a test pins the hashes, the Rust sources and lockfile stay in the repo with a
build script, and the pointer record (design §5.2) is in scope: the invite carries `ptr`. Recorded as
`D-10`.

Other options offered: build at install time; a third-party generic contract; commit bytes but no
pointer record.

### Q-4 Which STUN servers by default?

**Answer: option 1, Google and Cloudflare acceptable.** Default list
`stun:stun.l.google.com:19302`, `stun:stun.cloudflare.com:3478`; `ZBTERM_ICE_SERVERS`, a flag and a
settings field replace it; the empty string disables STUN; the README states that a Freenet share
discloses the public address to the STUN provider. No TURN. Recorded as `D-11`.

Other options offered: no default; a STUN server we run; STUN plus a public TURN.

### Q-5 Does ZBTerm manage the Freenet node?

**Answer: option 1, no.** ZBTerm detects a node at a configured address and, when none answers,
reports `freenet` as unavailable with "no Freenet node at <address>" and points at the README's
install section. It never installs, spawns, supervises or updates the node. Design phase F9 is out.
Tests may start their own local-mode node. Recorded as `D-12`.

Other options offered: spawn a user-installed node; bundle the node binary; embed the node (not
possible).

### Q-6 What happens to offline history?

**Answer: option 1.** Ship with design §8.2 option D (`HISTORY_OFFLINE_HOST` and
`HISTORY_EVENTUAL_MERGE` cleared, `historyRouteFor` → `null`) and keep one time-boxed probe
(≤ 2 working days) of option A, the virtual peer. Success opens a follow-on; failure is recorded and
option B (neutral segments) is opened as its own project. Recorded as `D-13`.

Other options offered: option D with no probe; option A as a deliverable; option B as a deliverable.

### Q-7 What does "done" look like in the release and the default build?

**Answer: option 2, Freenet in the default package.** `DEFAULT_BUILD_BACKENDS` becomes
`'pear,freenet'`; the experimental switch is removed; the share dialog shows the picker; a user without
a node sees the Freenet entry disabled with the reason; the licence question (Q-8) becomes a close-out
gate; installers grow by the SDK and `node-datachannel`. Recorded as `D-14`.

Other options offered: opt-in at build time with the default package Pear-only (recommended, not
chosen); tests only, behind the experimental switch; a separate Freenet-only package.

### Q-8 How do we handle the licence of the Freenet client library?

**Answer: option 1.** Ship `@freenetorg/freenet-stdlib` unmodified in its own `node_modules` folder;
add `THIRD-PARTY-NOTICES.md` (SDK under both declared licences with the LGPL-3.0 text and a source
link; `node-datachannel` and libdatachannel MPL-2.0; the `freenet-stdlib` crate); draft and file an
upstream issue asking Freenet to reconcile the npm and repository licence metadata. The project closes
when the notices are in place and the issue is filed, not when upstream answers. Recorded as `D-15`.
Not legal advice; an engineering assessment the owner accepted.

Other options offered: block close-out on an upstream answer; write our own client for the node's
WebSocket protocol; a formal legal opinion.

### Q-9 Where does the implementation happen, given that it needs new npm packages?

**Answer: in place, in the predecessor repository.** The owner: "I allow you for this work
only to change the modules under [the predecessor repository]. The ~/work/[repo] is the path for
remote test machines only." So `npm install` of the new packages is allowed in this working tree for
this project (it will also drop the 18 extraneous packages of `S-18`); no clone; git is still not
touched. Remote machines use `~/work/zbterm` for everything.

Other options offered: a clone at `~/work/zbterm` (recommended, rejected); hand-unpacked tarballs;
the owner moving the live ZBTerm off the tree first; packages under `engine/` only.

## Assumptions

- **A-1** Project directory `docs/projects/260924_freenet-backend/`, a sibling of the parent (the
  precedent of `260919_*`), phase prefix `F`, `F0`–`F11`. Other option: a sub-directory inside the
  closed parent.
- **A-2** The fabric recipe lives at `scripts/infra/freenet_host.py` and is run as
  `PYTHONPATH=/ubitron/dev /zp/zdata/work/ubitron/dev/.venv/bin/python scripts/infra/freenet_host.py
  <host> [flags]`. It imports from `ubitron.envs.rt.fabric` only. Other option: under `spikes/`
  (throwaway) or `test/` (shipped in packages either way, `S-14`).
- **A-3** On the remote, Freenet and `fdev` come from the GitHub release tarballs pinned to the
  owner's node version (`0.2.136`), verified against `SHA256SUMS.txt`, into `~/work/zbterm/bin/`;
  Node.js comes from the nodejs.org tarball pinned to the local major (24), verified against
  `SHASUMS256.txt`, into `~/work/zbterm/node/`. Distro packages are used only for `curl`, `tar`,
  `xz`, `rsync`, `ca-certificates` (apt on Debian, dnf on Fedora). Other option: `cargo install`
  (10+ minutes, a full toolchain) or distro packages (none exist).
- **A-4** The remote node runs as a **system** systemd unit `/etc/systemd/system/freenet-node.service`
  with `User=zeev`, because `Linger=no` would end a user unit with the ssh session. It runs
  `freenet network` with `--config-dir`, `--data-dir`, `--log-dir` under `~/work/zbterm/freenet/`,
  `--ws-api-port 7509`, `--network-port 31337`, and auto-update disabled so the pinned version
  survives the project. That unit file and the distro packages are the only writes outside
  `~/work/zbterm` on the remote.
- **A-5** The owner's node is used as a WebSocket client only: never stopped, restarted or
  reconfigured; `~/.config/freenet` and `~/.local/share/freenet` are never written. Test contracts
  put through it carry a fresh random nonce per run and no identity of the owner.
- **A-6** Under Node ≥ 22 the global `WebSocket` exists, so the client needs no `ws` package; under
  Bare it uses `bare-ws` behind the same browser-shaped shim the probe used
  (`spikes/freenet/lib/bare-shims.js`). `ws` stays in the boundary test's forbidden set.
- **A-7** Tests that need a node start their own `freenet local` on a free port with directories
  under `os.tmpdir()`, through one helper `test/helpers/freenet-node.js`, and stop it by its exact
  pid. When the `freenet` binary is not on `PATH` those tests skip with a message naming the
  binary; the gate on this machine must show them run. Other option: fail hard (breaks CI without a
  node).
- **A-8** In tests under Node, the backend is given an in-process `RtcHost` (the same object the
  Electron host injects) instead of the worker-side proxy; the proxy path is covered by its own seam
  tests and by the end-to-end runs. Other option: every backend test through a real sidecar worker
  (slow, and it cannot run the negative cases deterministically).
- **A-9** The WebRTC dependency is `node-datachannel@0.33.4` with its platform package
  `@node-datachannel/linux-x64-gnu` (what npm installs on this host). Other platforms' packages are
  not added; recorded in `open-issues.md`.
- **A-10** `ShareManager.revokeLink` gains a `backend.withdraw(linkId)` call (parent `open-issues.md`
  item 6). On Pear this leaves the link's topic and nothing else (`D-04`); the conformance case that
  covers revocation is unchanged.
- **A-11** The "no node" state is discovered at `share.backends` time by a bounded probe (a WebSocket
  open with a 2 s cap), not by the static `availability()` hook, and is reported as `state:'broken'`
  with a `detail` naming the address, so the existing renderer notice and picker can show it.
- **A-12** Per-link admission limits (design §7): 30 answered offers per minute and 8 concurrent
  half-open connections per link; per-viewer-key quota 16 live entries; host share 64 of the
  512-entry cap. Constants, named in code, changeable without a decision.
- **A-13** The upstream licence issue is drafted by F9 and filed by the owner (or by the executor
  with the owner's go-ahead in the F9 report); the close-out records the URL or "drafted, awaiting
  the owner".
- **A-14** The GUI proof uses this machine only (two isolated instances through uisolate, both on
  the owner's node), because `hetzner-deb16` has no display; the cross-machine proof is at the
  backend level with the shipped code (R-13).
- **A-15** `~/work/zbterm/repo` on the remote is an `rsync` of this tree without `node_modules`,
  `out`, `archive`, `.git` and `spikes/*/node_modules`, followed by `npm ci` there. Nothing on the
  remote is a git checkout.
