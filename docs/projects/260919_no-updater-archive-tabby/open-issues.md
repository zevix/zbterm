# Open issues — left deliberately

- **No update channel for installers.** AppImage, dmg, msix, flatpak and snap builds now have no
  way to learn of a new version; only the npm channel asks the registry
  (`electron/update-channel.js::checkForUpdate`). `#update-btn` stays hidden elsewhere.
- **Working tree `node_modules` not pruned (`A-6`, `S-18`).** 18 packages (`pear-runtime`,
  `pear-runtime-updater`, `corestore`, `pear-link`, …) are still installed but are in neither
  lockfile. Run `npm prune` (or a clean `npm ci`) when no ZBTerm is running from this tree.
  Until then "it resolves here" proves nothing; the tests scan source for that reason.
- **Not run:** the app itself. No phase launched a GUI (owner's live instance runs from this
  tree). The checks are static (`test/no-updater.test.js`, `node --check`, a resolve check of every
  bare `require` in the packaged default app). First real start after this change is the owner's.
- **`--no-updates` is a permanent no-op** (`electron/main.js::CLI_OPTIONS`); `package.json::scripts.start`
  and `scripts/npm-smoke-install.sh` still pass it.
- **Release workflow not exercised.** `.github/workflows/build-release.yml` lost its `upgrade-key`
  input; `holepunchto/actions/make-pear-app@v1` declares it optional (read from its `action.yml`),
  but no CI run has confirmed the build without it. Whoever calls the workflow with `upgrade-key`
  must drop the argument.
- **Already-installed OTA builds** keep following the old `pear://` drive; nothing new will be
  staged there. Not addressed.
- **Retired documents still describe OTA and the plugin as live:** `docs/npm-zbterm-plan.md`,
  `docs/npm-zbterm-handoff.md`, `docs/npm-zbterm_CHANGELOG.md`, and everything under
  `archive/`. History; not corrected.
- **`S-14` still open:** `spikes/` (280 MB), `test/`, `docs/`, `scripts/` ship in every package.
- **`brittle` glob race:** `npm test` can die before running if a `.git/*.lock` file vanishes
  during `globbie`'s walk (seen once in V3). Re-run; not ours to fix.
- **Core seams kept (`A-2`):** the attach path and `docs/CORE-CONTRACT.md` stay although their
  only in-repo consumer is archived. `archive/tabby-plugin` was built against the core of
  2026-09-19 and will drift.

> **2026-09-19, after close — the "Not run" item is resolved.** On the owner's request the two
> V3 linux-x64 packages were run under uisolate (private displays, own `--storage`,
> `--electron-user-data`, debug ports 17391–17393, `--no-updates`; ended by uisolate's timeout,
> no signals sent). Default build, two instances: `share.backends` lists `pear` as `available`;
> host session → `POST /sessions/:id/share` → `POST /join` on the client → the client shows the
> session as `owner: "joined"` with the host's output, live, including a line typed after the
> join; host diagnostics show 1 connection. `none` build: `share.backends` is `[]`, a session
> records and echoes, no Share/Join/Host control. No `Cannot find module`, no updater line, no
> stack trace in any log; the only `ERROR` lines are Chromium's at the timeout teardown.
> Reported, not gated. Screenshots were kept out of `docs/` (the first-run identity dialog shows
> `~/.ssh` key paths). Still not run: macOS, Windows and arm64 packages, and `npm start`.
