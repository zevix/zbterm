# Projects

One directory per project: `<YYMMDD>_<slug>/` while it is alive, `_done/<slug>/` once it is
finished. Each holds `requirements.md` or `design.md` (the WHAT), `plan.md` (the HOW),
`QnA_assumptions.md`, `CHANGELOG.md` (from the first retired phase) and a `status--<state>.md`
file. That file *is* the status, so `ls` shows it.

Findings and decisions are area-wide and append-only: [`../register.md`](../register.md)
(`S-nn`) and [`../decisions.md`](../decisions.md) (`D-nn`).

Plans written before 2026-09-18 are flat files in `docs/` (`<slug>_plan.md` with
`<slug>_CHANGELOG.md`). They stay where they are.

> **2026-09-19.** Two of them moved: `docs/tabby-plugin_plan.md` and
> `docs/tabby-plugin_CHANGELOG.md` are now `archive/tabby-plugin/docs/tabby-plugin_plan.md` and
> `archive/tabby-plugin/docs/tabby-plugin_CHANGELOG.md`, archived with the Tabby plugin
> (see [`../../archive/README.md`](../../archive/README.md)). The other flat plans stay in `docs/`.

> **2026-09-28.** `archive/` was not carried into this repository (`Z1` of `260928_zbterm-fork`);
> the files it held stay readable in the predecessor repository, frozen at its final commit
> `b856e15`.

| project | status | what it is |
|---|---|---|
| [`260918_backend-abstraction/`](260918_backend-abstraction/) | **done** | Opened and closed 2026-09-18. Spike: share networking now sits behind one `ShareBackend` interface (`engine/backends/types.js`) with Pear, an in-memory loopback and a Freenet stub; a registry, `--backend` / `ZBTERM_BACKEND`, `share.backends`, build variants (`ZBTERM_BUILD_BACKENDS`) and UI gating. Freenet was probed (`probes.md`) and its adapter designed (`freenet-backend-design.md`, `D-06`); a working Freenet backend is the follow-on (phases F0–F9 there). The `S-13` exception was resolved on 2026-09-19 by `260919_nonpear-no-updater/`; see `open-issues.md`. |
| [`260919_nonpear-no-updater/`](260919_nonpear-no-updater/) | **done** | Opened and closed 2026-09-19. Implements `D-07`: a build without the Pear backend drops the Pear OTA updater, so `hyperswarm`, `hyperdht`, `pear-runtime` and `corestore` leave the app's `node_modules`; the worker is spawned through `bare-sidecar` (`engine/spawn-worker.js`). Fixes `S-13`. |
| [`260919_no-updater-archive-tabby/`](260919_no-updater-archive-tabby/) | **done** | Opened and closed 2026-09-19. `D-08`: the Pear OTA updater is removed from every build (`workers/`, `pear.json`, `pear-runtime`, `corestore`, `package.json#upgrade` gone; `--no-updates` is a no-op). The Tabby plugin moved to `archive/tabby-plugin/` and is not built, tested or packaged. Fixes `S-16`, `S-17`; reduces `S-14`. |
| [`260924_freenet-backend/`](260924_freenet-backend/) | **done** | Opened and closed 2026-09-24. The working Freenet share backend `D-03` promised: `engine/backends/freenet/` runs the contract client in the Bare worker against a Freenet node the user runs (`D-12`), with the WebRTC half in the host on `node-datachannel` (`electron/rtc-host.js`) behind the `BACKEND_*` frames (`FrameKind` 15–21); contracts ship as committed `.wasm` (`D-10`); signed, encrypted signalling, channels with back-pressure and admission limits, and live history through the seam. It passes the conformance suite unchanged, shared and joined between this machine and `hetzner-deb16` (built by `scripts/infra/freenet_host.py`), and ships in the default package `pear,freenet` (`D-14`, `D-11` STUN list, `THIRD-PARTY-NOTICES.md`). Offline history by option A worked in a probe and is the follow-on (`S-28`). Pending the owner: `D-16`, F1's named exception and the upstream licence issue (drafted, not filed); see `open-issues.md`. |
| [`260928_zxterm-core/`](https://github.com/zevix/zxterm/tree/main/docs/projects/260928_zxterm-core) | proposal | Opened 2026-09-28. `zxterm-core`, the Rust core of the ZXTerm family (`D-20`), owns everything ZBTerm (the former name, renamed, `D-21`) puts on the Freenet wire (`D-17`) and all SSH-key and GitHub identity code (`D-22`): identity (stage C0), transport wire-compatible with today's JS peers (C1), session protocol (C2), segment history live and offline (C3, `D-18`), then `zxterm-tty` and a headless host (C4, `D-19`). ZBTerm keeps the GUI, the PTY and the Pear backend. Moved to `zevix/zxterm` (`D-30`); runs in parallel with this project (`D-29`); then spikes S1–S4 in `design.md` §6. |
| [`260928_zbterm-fork/`](260928_zbterm-fork/) | **done** | Opened 2026-09-28. The former name becomes ZBTerm, a hard fork in `github.com/zevix/zbterm` on the current hello-pear-electron template and Holepunch modules (`D-23`–`D-28`): freeze the predecessor repository (Z0), import its tree into zbterm as a squash (Z1), update the Pear stack (Z2), rename everything, wire strings and historical records included (Z3), clean-break checks and docs (Z4), close-out (Z5); optional zbterm-tty spike (T0). Closed 2026-09-28: suite 469/469, no former-name byte (`test/name.test.js`); uncommitted, the owner commits per `owner-steps.md`; open items in `open-issues.md`; `T0` not run. zxterm-core ran in parallel (`D-29`) and may now land ZBTerm-side stages. |
