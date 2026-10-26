#!/usr/bin/env node
// Builds standalone executables for relay/server.js - the headless blind-relay
// NAT-traversal fallback server. It's plain Node (no Electron), so it doesn't
// need the app packaging pipeline in forge.config.js; this bundles it with its
// own Node runtime via @yao-pkg/pkg so it can be dropped on a VPS with nothing
// preinstalled.
//
// Usage:
//   node scripts/build-relay.js               # build for this host's platform/arch
//   node scripts/build-relay.js --all          # build for all supported targets
//   node scripts/build-relay.js linux-x64 win-x64
'use strict'

const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'out', 'relay')
const PKG_NODE_RANGE = 'node24'
const { version } = require(path.join(ROOT, 'package.json'))

// prebuilds/<prebuildify-platform> -> pkg target platform/arch
const TARGETS = {
  'linux-x64': { prebuild: 'linux-x64', pkg: `${PKG_NODE_RANGE}-linux-x64`, ext: '' },
  'linux-arm64': { prebuild: 'linux-arm64', pkg: `${PKG_NODE_RANGE}-linux-arm64`, ext: '' },
  'macos-x64': { prebuild: 'darwin-x64', pkg: `${PKG_NODE_RANGE}-macos-x64`, ext: '' },
  'macos-arm64': { prebuild: 'darwin-arm64', pkg: `${PKG_NODE_RANGE}-macos-arm64`, ext: '' },
  'win-x64': { prebuild: 'win32-x64', pkg: `${PKG_NODE_RANGE}-win-x64`, ext: '.exe' }
}

const ENTRYPOINTS = {
  'zbterm-relay': path.join(ROOT, 'relay', 'server.js'),
  'zbterm-relay-registry-publish': path.join(ROOT, 'relay', 'registry-publish.js')
}

// macOS executables must be signed (even ad-hoc) or the kernel kills them on
// launch. pkg tries `codesign` first (present on a real Mac host), then
// falls back to `ldid` on PATH. Building macOS targets from Linux/Windows
// has neither, so fetch a static ldid build for the *host* (not target)
// platform and prepend it to PATH for that one build.
const LDID_VERSION = 'v2.1.5-procursus7'
const LDID_ASSETS = {
  'linux-x64': 'ldid_linux_x86_64',
  'linux-arm64': 'ldid_linux_aarch64',
  'darwin-x64': 'ldid_macosx_x86_64',
  'darwin-arm64': 'ldid_macosx_arm64'
}

function hasCommand(cmd) {
  try {
    execFileSync(cmd, ['--help'], { stdio: 'ignore' })
    return true
  } catch (err) {
    return err.code !== 'ENOENT'
  }
}

function ensureLdid() {
  if (hasCommand('codesign') || hasCommand('ldid')) return null // host can already sign

  const hostKey = `${process.platform}-${process.arch}`
  const asset = LDID_ASSETS[hostKey]
  if (!asset) {
    console.warn(`No prebuilt ldid for host ${hostKey} - macOS output will be unsigned.`)
    return null
  }

  const dir = path.join(ROOT, '.cache', 'ldid')
  const dest = path.join(dir, 'ldid')
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dir, { recursive: true })
    const url = `https://github.com/ProcursusTeam/ldid/releases/download/${LDID_VERSION}/${asset}`
    console.log(`Fetching ldid (${asset} ${LDID_VERSION}) for ad-hoc macOS signing...`)
    execFileSync('curl', ['-L', '-sS', '-o', dest, url], { stdio: 'inherit' })
    fs.chmodSync(dest, 0o755)
  }
  return dir
}

function parseArgs(argv) {
  if (argv.includes('--all')) return Object.keys(TARGETS)
  const named = argv.filter((a) => !a.startsWith('--'))
  if (named.length === 0) return [`${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`]
  for (const name of named) {
    if (!TARGETS[name]) {
      console.error(`Unknown target "${name}". Valid: ${Object.keys(TARGETS).join(', ')}`)
      process.exit(1)
    }
  }
  return named
}

function build(targetName, entryName, entryFile) {
  const target = TARGETS[targetName]
  if (!target) {
    console.error(`Unsupported host target "${targetName}" - pass one of: ${Object.keys(TARGETS).join(', ')}`)
    process.exit(1)
  }

  const outputName = `${entryName}-${version}-${targetName}${target.ext}`
  const outputPath = path.join(OUT_DIR, outputName)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log(`Building ${outputName} (${target.pkg})...`)

  // Only the current target's sodium-native prebuild - keeps each binary to
  // one platform's native addon instead of bundling all of them. --config
  // wants a file path, so write one to a scratch location per build.
  const configPath = path.join(OUT_DIR, `.pkg-config-${targetName}.json`)
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      assets: [`node_modules/sodium-native/prebuilds/${target.prebuild}/**/*`]
    })
  )

  const env = { ...process.env }
  if (targetName.startsWith('macos-')) {
    const ldidDir = ensureLdid()
    if (ldidDir) env.PATH = `${ldidDir}${path.delimiter}${env.PATH}`
  }

  try {
    execFileSync(
      path.join(ROOT, 'node_modules', '.bin', 'pkg'),
      [
        entryFile,
        '--targets',
        target.pkg,
        '--output',
        outputPath,
        '--compress',
        'Brotli',
        '--config',
        configPath
      ],
      { cwd: ROOT, stdio: 'inherit', env }
    )
  } finally {
    fs.rmSync(configPath, { force: true })
  }
}

const targets = parseArgs(process.argv.slice(2))
for (const targetName of targets) {
  for (const [entryName, entryFile] of Object.entries(ENTRYPOINTS)) {
    build(targetName, entryName, entryFile)
  }
}

console.log(`\nDone. Executables in ${path.relative(ROOT, OUT_DIR)}/`)
