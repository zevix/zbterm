# No OTA updater

> Index: [AGENTS.md](../AGENTS.md).

ZBTerm has no peer-to-peer OTA updater (`D-08`, `D-25` in
[`docs/decisions.md`](../docs/decisions.md)). The Bare worker that this template's
updater used to live in is now `engine/`, spawned through `bare-sidecar`
(`engine/spawn-worker.js`); there is no `workers/main.js`, no `pear.json`, no
`package.json#upgrade`, no `pear-runtime` dependency and no forge upgrade gate.

A packaged build updates the way any other desktop app does: install a newer
package (deb/rpm/AppImage/Flatpak/Snap/dmg/msix), or, for the npm distribution,
`npm install -g zbterm@latest` (`zbterm update` checks the npm registry and
prints that command). `--no-updates` is still accepted everywhere, for
compatibility with old launchers, and does nothing.

Adding P2P data to the Bare worker, or a new share backend, is covered by
[`agent_docs/architecture.md`](architecture.md) (the sidecar spawn contract)
and `docs/CORE-CONTRACT.md`/`docs/ARCHITECTURE.md` (the sharing protocol
itself) — not by this file.
