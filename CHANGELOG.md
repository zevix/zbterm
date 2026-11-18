# Changelog

Notable changes to ZBTerm. The format follows [Keep a Changelog](https://keepachangelog.com/),
and the project uses [semantic versioning](https://semver.org/) as described in
[`docs/RELEASING.md`](docs/RELEASING.md).

## Unreleased

### Added

- First public open-source release, and the first release published to npm (`npm install -g zbterm`).
- Interactive PTY-backed shells with encrypted local recording and playback with a time scrubber.
- Peer-to-peer live sharing over Hyperswarm, with single-user and group invite links, per-link
  permission caps, host approval, keyboard sharing and key rotation on join and leave.
- Optional relay fallback for NAT traversal, discovered through a DHT record.
- Experimental Freenet share backend, through the `zxterm-core` sidecar.
- Multiple profiles and multiple concurrent sessions.
- `zbterm doctor`, `zbterm install-desktop` / `uninstall-desktop`, and a localhost debug REST API.
- The Rust `zxterm-core` sidecar, built from the `zxterm/` submodule and shipped as one optional
  npm package per platform (`@zbterm/zxterm-core-<platform>-<arch>`).

- [`docs/OVERVIEW.md`](docs/OVERVIEW.md), a tour of every feature and key binding for a new user,
  and `./demo.sh` ([`docs/demo.md`](docs/demo.md)), a guided walk-through that drives the real app
  on scratch data: one window first, then two side by side sharing a terminal.
- Debug server: real input (`POST /input/key`, `/input/text`, `/input/mouse`, sent as Chromium
  input events), `POST /window/focus`, `GET /window/screenshot`, and the `demo-*` renderer
  commands (captions, key badges, a drawn pointer) the walk-through is built on.

### Changed

- The logo is now the left half of the Freenet rabbit and the right half of the Pear pear, and the
  splash screen credits "Written by Zeev Kotzer".
- `docs/` updated to the current architecture: both share backends, the `zxterm-core` sidecar,
  and distribution without an OTA updater.
