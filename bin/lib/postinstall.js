'use strict'

// zbterm's single install-time script. It does two things, in order:
//
//   1. Prunes prebuilt binaries for platforms that are not this one.
//   2. Refuses the install if anything left behind links the host Node runtime.
//
// (1) is pure weight. Every package in the Holepunch stack ships one tarball
// carrying prebuilds for every target it supports - android, ios, win32,
// darwin, linux - so a linux-x64 install unpacks ~298 MB of prebuilds and uses
// ~47 MB of them. Deleting the rest is the same thing
// electron-forge-plugin-prune-prebuilds already does for the desktop builds
// (see forge.config.js), just moved to install time.
//
// (2) is correctness, and is explained in bin/lib/native-linkage.js.
const fs = require('fs')
const path = require('path')

const { scan, describe } = require('./native-linkage')

const APP_ROOT = path.join(__dirname, '..', '..')

// Which platform this install is FOR, which is not always the one it runs on.
// This has to agree exactly with electron/install.js, or the prune keeps the
// prebuilds for one target while Electron downloads the runtime for another:
// npm_config_platform/npm_config_arch win, and an x64 Node running under
// Rosetta on Apple silicon means arm64 unless the arch was pinned explicitly.
function target({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const wanted = env.npm_config_platform || platform
  let wantedArch = env.npm_config_arch || arch

  if (
    wanted === 'darwin' &&
    platform === 'darwin' &&
    wantedArch === 'x64' &&
    env.npm_config_arch === undefined
  ) {
    try {
      const translated = require('child_process')
        .execSync('sysctl -in sysctl.proc_translated')
        .toString()
        .trim()
      if (translated === '1') wantedArch = 'arm64'
    } catch {
      // Not under Rosetta, or sysctl is unavailable. Either way, keep x64.
    }
  }

  return wanted + '-' + wantedArch
}

// Keep this target, plus the fat darwin builds that carry both arches.
function keeps(wanted = target()) {
  return (name) => name === wanted || name.endsWith('-universal')
}

// Only prebuilds/ directories are touched, and only their per-platform
// subdirectories: a loose file directly under prebuilds/ is left alone rather
// than guessed at.
function prunePrebuilds(dir, keep, stats) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return stats
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = path.join(dir, entry.name)

    if (entry.name === 'prebuilds') {
      let targets = []
      try {
        targets = fs.readdirSync(full, { withFileTypes: true })
      } catch {
        continue
      }
      for (const target of targets) {
        if (!target.isDirectory() || keep(target.name)) continue
        try {
          fs.rmSync(path.join(full, target.name), { recursive: true, force: true })
          stats.removed++
        } catch {
          // A prebuild we cannot delete is a wasted megabyte, never an error.
        }
      }
      continue
    }

    prunePrebuilds(full, keep, stats)
  }

  return stats
}

// True only when zbterm is installed as somebody's dependency. In a checkout
// of the repo itself this is false, and pruning there would quietly break
// `electron-forge make` for every platform but the host - forge's own
// packaging plugins expect the full set of prebuilds to still be in
// node_modules.
// Returns the node_modules directory zbterm was installed into, or null when
// this is a checkout of the repo itself rather than an install. Pruning a
// checkout would quietly break `electron-forge make` for every platform but
// the host: forge's own packaging plugins expect the full set of prebuilds to
// still be in node_modules.
function installRoot(root = APP_ROOT) {
  let dir = path.dirname(root)
  // Scoped packages live one level deeper: node_modules/@scope/name.
  for (let i = 0; i < 2; i++) {
    if (path.basename(dir) === 'node_modules') return dir
    dir = path.dirname(dir)
  }
  return null
}

function main() {
  if (process.env.ZBTERM_SKIP_POSTINSTALL === '1') return 0

  const root = installRoot()
  if (root && process.env.ZBTERM_KEEP_ALL_PREBUILDS !== '1') {
    // Sweeping the whole node_modules covers hoisted siblings and zbterm's own
    // nested dependencies in one pass.
    const wanted = target()
    const stats = prunePrebuilds(root, keeps(wanted), { removed: 0 })
    if (stats.removed > 0) {
      process.stdout.write(
        'zbterm: pruned ' +
          stats.removed +
          ' prebuild director' +
          (stats.removed === 1 ? 'y' : 'ies') +
          ' for other platforms (keeping ' +
          wanted +
          ')\n'
      )
    }
  }

  if (process.env.ZBTERM_ALLOW_HOST_NODE_LINKAGE === '1') return 0

  let offenders = []
  try {
    offenders = scan()
  } catch {
    // A bug in the scanner must never be the reason an install fails.
    return 0
  }
  if (offenders.length === 0) return 0

  process.stderr.write(describe(offenders))
  return 1
}

module.exports = { prunePrebuilds, keeps, target, installRoot }

if (require.main === module) process.exit(main())
