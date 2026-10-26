// The host half of the Rust `zxterm-core` sidecar's spawn (K9 of
// zxterm-core, in `zevix/zxterm`). The Rust `zxterm-core` sidecar is a
// separate binary; it is unrelated to ZBTerm's own JS worker package,
// `zbterm-core` (`engine/package.json`).
//
// `engine/` may not spawn processes (`test/core-boundary.test.js`), so the
// host supplies both halves of "start the sidecar": where the binary is
// and how to spawn it. This file is that supply. It runs inside the Bare
// worker: `EngineClient` passes its absolute path as the worker's 6th
// argument, and `engine/worker.js` requires it and hands its exports to
// `engine/zxterm/core.js::setCoreHost`. It also runs under Node, where a
// test or a script injects it the same way.
//
// The binary is the `zxterm-core-prebuilds` package's
// `prebuilds/<platform>-<arch>/zxterm-core[.exe]` (X-13): a plain
// `dependency`, pruned per target by the prebuilds Forge plugins, which
// rename `darwin-<arch>` to `darwin-universal` on macOS. `ZXTERM_CORE_BIN`
// overrides it.
'use strict'

const IS_BARE = typeof Bare !== 'undefined'
const fs = IS_BARE ? require('bare-fs') : require('fs')
const path = IS_BARE ? require('bare-path') : require('path')
const proc = IS_BARE ? require('bare-process') : process

const PACKAGE = 'zxterm-core-prebuilds'

function executableName(platform = proc.platform) {
  return platform === 'win32' ? 'zxterm-core.exe' : 'zxterm-core'
}

// Where the binary may be, in the order they are tried.
function candidates(platform = proc.platform, arch = proc.arch) {
  let pkgDir
  try {
    pkgDir = path.dirname(require.resolve(`${PACKAGE}/package.json`))
  } catch {
    return []
  }
  const exe = executableName(platform)
  return [`${platform}-${arch}`, `${platform}-universal`].map((dir) =>
    path.join(pkgDir, 'prebuilds', dir, exe)
  )
}

// The binary to run, or a named error saying where it looked.
function bin() {
  const override = proc.env && proc.env.ZXTERM_CORE_BIN
  if (override) return override
  const tried = candidates()
  for (const file of tried) {
    if (fs.existsSync(file)) return file
  }
  throw new Error(
    `zxterm-core sidecar binary not found for ${proc.platform}-${proc.arch}` +
      (tried.length
        ? ` (looked in ${tried.join(', ')})`
        : ` (the ${PACKAGE} package is not installed)`)
  )
}

// `bare-subprocess` under Bare: a direct dependency of `engine/`'s package
// (ZBTerm D-31) and of this app's root `package.json`, so a packaged app
// (production dependencies only) carries it (ZBTerm S-39).
function bareSubprocess() {
  return require('bare-subprocess')
}

// stdin is a pipe nobody writes to: the sidecar runs with
// `--exit-on-stdin-eof`, so it exits when this process goes away.
function spawn(file, args) {
  const opts = { stdio: ['pipe', 'ignore', 'inherit'] }
  if (IS_BARE) return bareSubprocess().spawn(file, args, opts)
  return require('child_process').spawn(file, args, { ...opts, windowsHide: true })
}

module.exports = { spawn, bin, candidates, executableName, PACKAGE }
