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
//   node scripts/build-relay.js --all --jobs 4 # up to 4 targets at once
'use strict'

const path = require('path')
const fs = require('fs')
const { execFileSync, spawn } = require('child_process')

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

// --jobs N / -j N / -jN: how many targets build at once (default 1).
function parseJobs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const m = /^(?:--jobs=|-j)(\d+)$/.exec(argv[i])
    if (m) return Math.max(1, Number(m[1]))
    if (argv[i] === '--jobs' || argv[i] === '-j') return Math.max(1, Number(argv[i + 1]) || 1)
  }
  return 1
}

function parseArgs(argv) {
  if (argv.includes('--all')) return Object.keys(TARGETS)
  const named = argv.filter((a, i) => !a.startsWith('-') && !['--jobs', '-j'].includes(argv[i - 1]))
  if (named.length === 0)
    return [`${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`]
  for (const name of named) {
    if (!TARGETS[name]) {
      console.error(`Unknown target "${name}". Valid: ${Object.keys(TARGETS).join(', ')}`)
      process.exit(1)
    }
  }
  return named
}

async function build(targetName, entryName, entryFile, { ldidDir, prefix }) {
  const target = TARGETS[targetName]
  if (!target) {
    console.error(
      `Unsupported host target "${targetName}" - pass one of: ${Object.keys(TARGETS).join(', ')}`
    )
    process.exit(1)
  }

  const outputName = `${entryName}-${version}-${targetName}${target.ext}`
  const outputPath = path.join(OUT_DIR, outputName)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log(`${prefix}Building ${outputName} (${target.pkg})...`)

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
  if (targetName.startsWith('macos-') && ldidDir)
    env.PATH = `${ldidDir}${path.delimiter}${env.PATH}`

  try {
    await run(
      path.join(ROOT, 'node_modules', '.bin', 'pkg'),
      [
        entryFile,
        '--targets',
        target.pkg,
        '--output',
        outputPath,
        '--compress',
        'Brotli',
        // V8 bytecode is made by running the target's Node, which can't run
        // for another arch (arm64 from an x64 host): there, ship plain
        // sources instead of trying file by file. --fallback-to-source keeps
        // pkg from silently leaving out a file whose bytecode fails anyway.
        ...(targetArch(target) === process.arch
          ? []
          : ['--no-bytecode', '--public', '--public-packages', '*']),
        '--fallback-to-source',
        '--config',
        configPath
      ],
      { cwd: ROOT, env, prefix }
    )
  } finally {
    fs.rmSync(configPath, { force: true })
  }
}

// Like execFileSync with stdio inherited, but async, and with every output
// line prefixed so parallel builds stay readable.
function targetArch(target) {
  return target.pkg.split('-').pop()
}

const children = new Set()
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal)
    process.exit(1)
  })
}

function run(cmd, args, { prefix, ...opts }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    child.on('exit', () => children.delete(child))
    for (const [from, to] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr]
    ]) {
      let rest = ''
      from.setEncoding('utf8')
      from.on('data', (chunk) => {
        const lines = (rest + chunk).split('\n')
        rest = lines.pop()
        for (const line of lines) to.write(`${prefix}${line}\n`)
      })
      from.on('end', () => rest && to.write(`${prefix}${rest}\n`))
    }
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${prefix}${path.basename(cmd)} exited with ${code}`))
    )
  })
}

async function main() {
  const argv = process.argv.slice(2)
  const targets = parseArgs(argv)
  const jobs = Math.min(parseJobs(argv), targets.length)
  // Once, up front: parallel macOS builds would otherwise race to fetch it.
  const ldidDir = targets.some((t) => t.startsWith('macos-')) ? ensureLdid() : null
  const width = Math.max(...targets.map((t) => t.length))

  // A target's entrypoints build one after another (they share its pkg-fetch
  // Node download); up to `jobs` targets build at once.
  const queue = [...targets]
  const worker = async () => {
    for (let targetName; (targetName = queue.shift()); ) {
      const prefix = jobs > 1 ? `[${targetName.padEnd(width)}] ` : ''
      for (const [entryName, entryFile] of Object.entries(ENTRYPOINTS)) {
        await build(targetName, entryName, entryFile, { ldidDir, prefix })
      }
    }
  }
  // allSettled: on a failure, let the other builds finish rather than
  // exiting under them.
  const results = await Promise.allSettled(Array.from({ length: jobs }, worker))
  const failed = results.find((r) => r.status === 'rejected')
  if (failed) throw failed.reason

  console.log(`\nDone. Executables in ${path.relative(ROOT, OUT_DIR)}/`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
