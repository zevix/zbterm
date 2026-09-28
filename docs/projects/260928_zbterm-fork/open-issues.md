# zbterm-fork — open issues

What this project left open on purpose, at close on 2026-09-28.

## For the owner

- **Commit and push.** Nothing is committed; `HEAD` is still `931a836` on `main`. Two options are
  in [`owner-steps.md`](owner-steps.md): A keeps `931a836`; B rebuilds `main` from `72710d1` and
  force-pushes. Only B meets `Z-1`/`Z-3` ("not in zbterm's published history"), because
  `931a836` holds this folder as it was before `Z5`, with the former name in it.
  > **2026-09-28.** Done by option B, at the owner's go-ahead: `main` = the template history up
  > to `72710d1` plus one commit, `664cb4a`, force-pushed with a lease on `931a836`. The checks of
  > `owner-steps.md` passed before the push. `931a836` stays only in the local reflog.
- **`A-4`**: the forge contact address is now `zbterm@1zk.net`
  (`forge.config.js`, the Flatpak metainfo). Confirm that the mailbox exists, or name another.
- **`A-2`**: `package.json#author` is unchanged, and the startup logo is text only
  (`scripts/logo.js`). New art is the owner's to supply.
- **`A-3`**: `hetzner-deb16` still runs the predecessor's Freenet node recipe;
  `scripts/infra/freenet_host.py` now names the new paths and units, and has not been run
  against the host.
- **`T0`**, the optional text-client spike (`plan.md` `T0`, question `Q-6`), was not run.
- **`S-37`**: a predecessor invite whose scheme was rewritten to `zbterm://join/` fails only at
  `JOIN_TIMEOUT_MS` (30 s), with the generic "host was not found" message. A protocol check at the
  handshake would make it fail fast with the cause. That is a behaviour change, so the owner
  decides.

## Known flakes and limits (register)

- `S-03` (an assert in `test/engine-extend.test.js`) and `S-36` (an `fd-lock` crash in
  `test/engine-attach.test.js`, seen twice after the `Z2` module update): re-run once, report
  both runs.
- `S-25`: `bare-sidecar` 0.5.7 still has no `_final`, so `engine/client.js::EngineClient.close`
  waits 5 s. A packaged app sent SIGTERM took 15–50 s to exit.
- Under uisolate, `/health` reports the renderer as "WebGL2 not supported"; boot proof is
  `engineReady: true`. The predecessor had the same limit, recorded in the backend-abstraction
  project's `open-issues.md`.
- `uisolate stop` left the packaged app running three times; it was stopped by its exact PID.

## Docs

- `docs/npm-zbterm-plan.md` says "renamed from X to X". It already did before `Z3`; the name it
  migrated from is lost from the sources, and a dated note says so.
- Links into `archive/` and into the moved zxterm-core folder do not resolve here. Each carries
  a dated note (`README.md`, `docs/CORE-CONTRACT.md`, `docs/decisions.md`,
  `docs/projects/README.md`).
- `engine/package.json` pins `protomux` `^3.11.0`, which 3.12.1 satisfies; the root does not
  pin it.
