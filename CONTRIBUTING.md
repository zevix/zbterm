# Contributing to ZBTerm

Thanks for your interest. Bug reports, fixes and focused improvements are welcome.

## Getting started

Use **npm** (pnpm and yarn are not supported) and Node.js 20 or newer. Always run npm from the
repository root: the repo-local `.npmrc` is what lets the Electron and `node-pty` install scripts
run.

```sh
git clone https://github.com/zevix/zbterm.git
cd zbterm
npm install
npm test
npm start
```

On Linux, `node-pty` may compile from source and needs `python3`, `make` and a C++ toolchain; see
[Prerequisites](README.md#install-prereqs).

## Running the tests safely

The tests start real PTYs, storage and network peers. Give each run its own home directory and a
short temporary directory (under 20 characters, because of the SSH-agent socket path limit), so
they never touch your own ZBTerm data:

```sh
HOME=$(mktemp -d) TMPDIR=/tmp/zbt npm test
```

A few tests are timing-sensitive. If one fails, re-run it once before investigating.

## Before you open a pull request

- `npm run lint` passes (`npm run format` fixes most issues).
- `npm test` passes.
- Changes to `engine/` or the worker are checked in a packaged build (`npm run package`), not
  only with `npm start`: the Bare sidecar resolves modules differently once packaged.
- New behaviour comes with a test, and user-visible changes with a line in
  [`CHANGELOG.md`](CHANGELOG.md) under "Unreleased".
- Keep each pull request to one change, and explain the why in its description.

For larger changes (new dependencies, protocol or storage format changes, a new share backend),
please open an issue first so we can agree on the approach.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the design reference, and
[`docs/CORE-CONTRACT.md`](docs/CORE-CONTRACT.md) documents the frozen contract between the app
and its core. [`AGENTS.md`](AGENTS.md) lists the cross-file contracts that are easy to break.

## Security issues

Please don't report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), as described in its section 5.
