#!/usr/bin/env node
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const pkg = require('../package.json')

const APP_ROOT = path.join(__dirname, '..')

// Chromium's sandbox failure text arrives on stderr and the process dies
// within a second, so stderr is piped (not inherited) and the first chunk of
// it kept around long enough to recognise the failure and retry.
const STDERR_BUFFER_BYTES = 8 * 1024
const SANDBOX_RETRY_WINDOW_MS = 10_000
const SANDBOX_FAILURE_PATTERN =
  /SUID sandbox|chrome-sandbox|namespace sandbox|Failed to move to new namespace/

// The dispatch table is the one place that decides what is a subcommand and
// what is passed through to the app untouched. Every name here is handled by
// `main()` below and never reaches Electron.
const SUBCOMMANDS = ['update', 'doctor', 'install-desktop', 'uninstall-desktop']

function fail(message) {
  process.stderr.write(message + '\n')
  process.exit(1)
}

function resolveElectron() {
  let electronPath = null

  try {
    // The `electron` package exports the binary path as a string. It never
    // exports the Electron API here - this is a plain Node process.
    electronPath = require('electron')
  } catch {
    electronPath = null
  }

  if (typeof electronPath !== 'string' || !electronPath || !fs.existsSync(electronPath)) {
    fail(
      [
        'zbterm: could not find the Electron binary.',
        '',
        'Electron ships as a post-install download, so this usually means the',
        'download was skipped or interrupted. Try:',
        '',
        '  npm rebuild electron',
        '',
        'Behind a proxy or firewall, point the download at a mirror first:',
        '',
        '  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm rebuild electron',
        '',
        'If Electron already lives somewhere else, set ELECTRON_OVERRIDE_DIST_PATH',
        'to the directory holding the binary.'
      ].join('\n')
    )
  }

  return electronPath
}

function signalExitCode(signal) {
  const number = os.constants.signals[signal]
  return typeof number === 'number' ? 128 + number : 1
}

function printVersion() {
  process.stdout.write(pkg.version + '\n')
  process.exit(0)
}

// `zbterm update` is a thin wrapper: npm owns the install, so it also owns the
// upgrade. Everything (progress, prompts, errors, exit code) is npm's.
function runUpdate() {
  const isWindows = process.platform === 'win32'
  const npm = isWindows ? 'npm.cmd' : 'npm'
  const child = spawn(npm, ['install', '-g', 'zbterm@latest'], {
    stdio: 'inherit',
    // Node refuses to spawn a .cmd shim directly on Windows.
    shell: isWindows
  })

  child.on('error', (err) => {
    fail('zbterm: failed to run `npm install -g zbterm@latest`: ' + err.message)
  })

  child.on('exit', (code, signal) => {
    if (signal) process.exit(signalExitCode(signal))
    process.exit(code === null ? 1 : code)
  })
}

function run(electronPath, args, { onSandboxFailure }) {
  const child = spawn(electronPath, [APP_ROOT, ...args], {
    stdio: ['inherit', 'inherit', 'pipe']
  })

  const startedAt = Date.now()
  let stderrHead = ''
  let stderrHeadBytes = 0

  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
    if (stderrHeadBytes >= STDERR_BUFFER_BYTES) return
    const room = STDERR_BUFFER_BYTES - stderrHeadBytes
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk
    stderrHeadBytes += kept.length
    stderrHead += kept.toString('utf8')
  })

  const forward = (signal) => child.kill(signal)
  process.on('SIGINT', forward)
  process.on('SIGTERM', forward)

  child.on('error', (err) => {
    fail('zbterm: failed to start Electron: ' + err.message)
  })

  child.on('exit', (code, signal) => {
    process.removeListener('SIGINT', forward)
    process.removeListener('SIGTERM', forward)

    const failedFast =
      code !== 0 && code !== null && Date.now() - startedAt < SANDBOX_RETRY_WINDOW_MS

    if (failedFast && SANDBOX_FAILURE_PATTERN.test(stderrHead) && onSandboxFailure) {
      onSandboxFailure()
      return
    }

    if (signal) process.exit(signalExitCode(signal))
    process.exit(code === null ? 1 : code)
  })
}

function main() {
  const argv = process.argv.slice(2)
  const subcommand = argv[0]

  switch (subcommand) {
    case '--version':
    case '-v':
      return printVersion()
    case 'update':
      return runUpdate()
    // The three below run in plain Node - no Electron process is started, so
    // `doctor` can honestly report a missing or broken Electron binary.
    case 'doctor':
      return process.exit(require('./lib/doctor').run(argv.slice(1)))
    // Exits 1 when the desktop entry or the scheme associations could not be
    // written; a failed hook alone is a warning, not a failure. `--print-only`
    // prints the entry and the hook commands and writes nothing.
    case 'install-desktop':
      return process.exit(require('./lib/desktop').runInstall(argv.slice(1)))
    case 'uninstall-desktop':
      return process.exit(require('./lib/desktop').runUninstall(argv.slice(1)))
    default:
      // Everything else is handed to the app untouched.
      break
  }

  const electronPath = resolveElectron()
  const alreadyUnsandboxed = argv.includes('--no-sandbox')

  run(electronPath, argv, {
    // Installing globally as a non-root user leaves chrome-sandbox without
    // its setuid bit, which kills unpackaged Electron on Linux. Retry exactly
    // once, never again.
    onSandboxFailure: alreadyUnsandboxed
      ? null
      : () => {
          process.stderr.write(
            'zbterm: Chromium sandbox unavailable (chrome-sandbox is not setuid root); retrying with --no-sandbox\n'
          )
          run(electronPath, [...argv, '--no-sandbox'], { onSandboxFailure: null })
        }
  })
}

module.exports = { SUBCOMMANDS }

main()
