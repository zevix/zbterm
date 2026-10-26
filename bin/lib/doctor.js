'use strict'

// `zbterm doctor` - one actionable line per thing an npm install can get
// wrong. It runs in plain Node, never under Electron: requiring anything from
// electron/main.js here would need an Electron process, which is exactly what
// half of these checks exist to prove is missing. node-pty is N-API, so it
// loads fine in Node and can be probed directly - but note what that probe
// does NOT prove: an addon linked against a shared host libnode loads happily
// here and segfaults inside Electron. That failure class is caught at install
// time by bin/lib/native-linkage.js, and end to end by the Electron boot in
// scripts/npm-smoke-install.sh; it is deliberately not re-litigated here.
//
// Every check is a pure-ish function returning { name, ok, detail, fix } and
// takes its inputs as injectable options so the tests can fake a missing
// binary, an unwritable directory or an absent prebuild.
const fs = require('fs')
const os = require('os')
const path = require('path')

const pkg = require('../../package.json')
const { detectChannel } = require('../../electron/update-channel')

const APP_ROOT = path.join(__dirname, '..', '..')

const PRODUCT_NAME = 'ZBTerm'

// Mirrors Electron's `app.getPath('userData')` for productName "ZBTerm".
function userDataRoot({ platform = process.platform, env = process.env, home = null } = {}) {
  const resolvedHome = home || env.HOME || os.homedir()
  if (platform === 'darwin') {
    return path.join(resolvedHome, 'Library', 'Application Support', PRODUCT_NAME)
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(resolvedHome, 'AppData', 'Roaming')
    return path.join(appData, PRODUCT_NAME)
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(resolvedHome, '.config'), PRODUCT_NAME)
}

const ELECTRON_FIX = [
  'npm rebuild electron',
  '(behind a proxy: ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm rebuild electron;',
  'or point ELECTRON_OVERRIDE_DIST_PATH at an existing Electron dist)'
].join(' ')

// Nothing here compiles: @lydell/node-pty ships its binary as a per-platform
// optional dependency, so the only way this check fails is that the binary is
// absent - `--no-optional`/`--omit=optional`, or a platform with no package.
// Deliberately NOT `npm rebuild node-pty`: a source build against a Node that
// is a shared library links -lnode and segfaults the moment Electron dlopen()s
// it, so prescribing a rebuild would hand the user the command that breaks
// them. See bin/lib/native-linkage.js.
const NODE_PTY_FIX = [
  'reinstall so the platform-specific binary is fetched:',
  '`npm install -g zbterm@' + pkg.version + '`.',
  'Do not pass --no-optional or --omit=optional - the pty binary ships as an',
  'optional per-platform dependency, and skipping those leaves it with none.',
  'If this platform has no package, it is not supported yet.'
].join(' ')

function resolveElectronBinary() {
  // The `electron` package exports the binary path as a string in Node. It
  // honours ELECTRON_OVERRIDE_DIST_PATH, so an override at a nonexistent
  // directory is caught by the existence check below, not by require().
  const value = require('electron')
  return typeof value === 'string' ? value : null
}

function safeResolveElectronBinary() {
  try {
    const binary = resolveElectronBinary()
    return typeof binary === 'string' && binary ? binary : null
  } catch {
    return null
  }
}

function statOrNull(p) {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

function checkNode({
  version = process.version,
  range = (pkg.engines && pkg.engines.node) || ''
} = {}) {
  const wanted = /(\d+)/.exec(range)
  const min = wanted ? Number(wanted[1]) : 0
  const major = Number(String(version).replace(/^v/, '').split('.')[0])
  const ok = Number.isFinite(major) && major >= min
  return {
    name: 'node',
    ok,
    detail: version + ' (engines.node: ' + (range || 'unset') + ')',
    fix: ok ? null : 'install Node ' + range + ' - e.g. `nvm install ' + min + '`'
  }
}

function checkElectron({ resolveBinary = resolveElectronBinary } = {}) {
  let binary = null
  try {
    binary = resolveBinary()
  } catch (err) {
    return {
      name: 'electron',
      ok: false,
      detail: 'require("electron") failed: ' + err.message,
      fix: ELECTRON_FIX
    }
  }

  if (typeof binary !== 'string' || !binary) {
    return {
      name: 'electron',
      ok: false,
      detail: 'the electron package did not resolve to a binary path',
      fix: ELECTRON_FIX
    }
  }

  const stat = statOrNull(binary)
  if (!stat || !stat.isFile()) {
    return {
      name: 'electron',
      ok: false,
      detail: 'Electron binary is missing: ' + binary,
      fix: ELECTRON_FIX
    }
  }

  try {
    fs.accessSync(binary, fs.constants.X_OK)
  } catch {
    return {
      name: 'electron',
      ok: false,
      detail: 'Electron binary is not executable: ' + binary,
      fix: 'chmod +x ' + binary
    }
  }

  return { name: 'electron', ok: true, detail: binary, fix: null }
}

function checkNodePty({
  load = () => require('@lydell/node-pty'),
  command = process.platform === 'win32' ? 'cmd.exe' : '/bin/true',
  args = process.platform === 'win32' ? ['/c', 'exit'] : []
} = {}) {
  let pty = null
  try {
    pty = load()
  } catch (err) {
    return {
      name: 'node-pty',
      ok: false,
      detail: 'require("node-pty") failed: ' + err.message,
      fix: NODE_PTY_FIX
    }
  }

  let child = null
  try {
    child = pty.spawn(command, args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      env: process.env
    })
  } catch (err) {
    return {
      name: 'node-pty',
      ok: false,
      detail: 'pty.spawn(' + command + ') failed: ' + err.message,
      fix: NODE_PTY_FIX
    }
  } finally {
    // An unkilled probe leaks the pty master fd for the life of the process.
    if (child) {
      try {
        child.kill()
      } catch {}
    }
  }

  return {
    name: 'node-pty',
    ok: true,
    detail: 'spawned ' + command + ' (pid ' + child.pid + ')',
    fix: null
  }
}

function defaultPrebuildsDir() {
  const candidates = []
  try {
    candidates.push(path.join(path.dirname(require.resolve('bare-sidecar')), 'prebuilds'))
  } catch {}
  candidates.push(path.join(APP_ROOT, 'node_modules', 'bare-sidecar', 'prebuilds'))
  for (const candidate of candidates) {
    const stat = statOrNull(candidate)
    if (stat && stat.isDirectory()) return candidate
  }
  return candidates[candidates.length - 1]
}

function checkBarePrebuild({
  prebuildsDir = defaultPrebuildsDir(),
  platform = process.platform,
  arch = process.arch
} = {}) {
  const target = platform + '-' + arch
  const dir = path.join(prebuildsDir, target)

  let entries = null
  try {
    entries = fs.readdirSync(dir)
  } catch {
    entries = null
  }

  if (!entries || entries.length === 0) {
    let available = []
    try {
      available = fs.readdirSync(prebuildsDir)
    } catch {}
    return {
      name: 'bare-sidecar',
      ok: false,
      detail:
        'no bare prebuild for ' +
        target +
        ' in ' +
        prebuildsDir +
        (available.length ? ' (present: ' + available.join(', ') + ')' : ' (directory is empty)'),
      fix:
        'reinstall so the bare-sidecar prebuilds are restored: `npm rebuild bare-sidecar`, ' +
        'or reinstall zbterm on a supported platform/arch'
    }
  }

  return {
    name: 'bare-sidecar',
    ok: true,
    detail: target + ': ' + path.join(dir, entries[0]),
    fix: null
  }
}

function checkDataDir({ dir = userDataRoot() } = {}) {
  const stat = statOrNull(dir)
  if (stat && !stat.isDirectory()) {
    return {
      name: 'data-dir',
      ok: false,
      detail: dir + ' exists but is not a directory',
      fix: 'move or remove ' + dir
    }
  }

  // A missing data dir is fine as long as the nearest existing ancestor is
  // writable - Electron creates it on first run.
  let probe = dir
  while (!statOrNull(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe)

  try {
    fs.accessSync(probe, fs.constants.W_OK | fs.constants.X_OK)
  } catch {
    return {
      name: 'data-dir',
      ok: false,
      detail: probe + ' is not writable',
      fix:
        'make it writable (`chmod u+rwx ' +
        probe +
        '`) or point HOME/XDG_CONFIG_HOME at a writable location'
    }
  }

  return {
    name: 'data-dir',
    ok: true,
    detail: stat ? dir + ' (exists, writable)' : dir + ' (missing, creatable under ' + probe + ')',
    fix: null
  }
}

function checkDisplay({ env = process.env } = {}) {
  const display = env.DISPLAY || env.WAYLAND_DISPLAY || ''
  return {
    name: 'display',
    ok: !!display,
    detail: display
      ? (env.WAYLAND_DISPLAY ? 'WAYLAND_DISPLAY=' + env.WAYLAND_DISPLAY : '') +
        (env.WAYLAND_DISPLAY && env.DISPLAY ? ' ' : '') +
        (env.DISPLAY ? 'DISPLAY=' + env.DISPLAY : '')
      : 'neither DISPLAY nor WAYLAND_DISPLAY is set',
    fix: !display ? 'run inside a graphical session, or headless: `xvfb-run -a zbterm`' : null
  }
}

function readMaxUserNamespaces() {
  try {
    return Number(fs.readFileSync('/proc/sys/user/max_user_namespaces', 'utf8').trim())
  } catch {
    return 0
  }
}

// Deliberately a warning, not a failure, whenever the kernel offers
// unprivileged user namespaces: Chromium uses that sandbox and never looks at
// chrome-sandbox's setuid bit, so failing here would red-flag a perfectly
// healthy install (which is most modern Linux distros).
function checkSandbox({
  electronBinary = safeResolveElectronBinary(),
  maxUserNamespaces = readMaxUserNamespaces()
} = {}) {
  const name = 'chrome-sandbox'
  if (!electronBinary) {
    return { name, ok: true, detail: 'skipped: no Electron binary to inspect', fix: null }
  }

  const sandbox = path.join(path.dirname(electronBinary), 'chrome-sandbox')
  const usernsOk = Number(maxUserNamespaces) > 0
  const fix =
    'launch with `zbterm --no-sandbox` (the launcher retries automatically), or: ' +
    'sudo chown root:root ' +
    sandbox +
    ' && sudo chmod 4755 ' +
    sandbox
  const stat = statOrNull(sandbox)

  if (!stat) {
    return {
      name,
      ok: usernsOk,
      detail: usernsOk
        ? sandbox + ' is missing; the unprivileged user-namespace sandbox is available'
        : sandbox + ' is missing and unprivileged user namespaces are disabled',
      fix
    }
  }

  const mode = (stat.mode & 0o7777).toString(8)
  if (stat.uid === 0 && (stat.mode & 0o4000) !== 0) {
    return { name, ok: true, detail: 'setuid root (mode ' + mode + '): ' + sandbox, fix: null }
  }

  return {
    name,
    ok: usernsOk,
    detail:
      sandbox +
      ' is not setuid root (uid ' +
      stat.uid +
      ', mode ' +
      mode +
      ')' +
      (usernsOk
        ? '; falling back to the unprivileged user-namespace sandbox'
        : ' and unprivileged user namespaces are disabled'),
    fix
  }
}

function checkVersion({ version = pkg.version } = {}) {
  return { name: 'version', ok: true, info: true, detail: 'zbterm ' + version, fix: null }
}

function checkChannel({ appPath = APP_ROOT, env = process.env } = {}) {
  const channel = detectChannel({ appPath, isPackaged: false, env })
  return {
    name: 'channel',
    ok: true,
    info: true,
    detail: channel + ' (' + appPath + ')',
    fix: null
  }
}

function runChecks({ platform = process.platform, env = process.env } = {}) {
  const checks = [
    checkNode(),
    checkElectron(),
    checkNodePty(),
    checkBarePrebuild({ platform }),
    checkDataDir()
  ]
  if (platform === 'linux') {
    checks.push(checkDisplay({ env }))
    checks.push(checkSandbox())
  }
  checks.push(checkVersion())
  checks.push(checkChannel({ env }))
  return checks
}

function label(check) {
  if (check.info) return 'INFO'
  if (!check.ok) return 'FAIL'
  return check.fix ? 'WARN' : 'PASS'
}

function run(argv, { log = console.log } = {}) {
  const json = argv.includes('--json')
  const checks = runChecks()
  const ok = checks.every((check) => check.ok)

  if (json) {
    log(JSON.stringify({ ok, version: pkg.version, checks }, null, 2))
    return ok ? 0 : 1
  }

  log('zbterm doctor')
  log('')
  for (const check of checks) {
    log('  ' + label(check).padEnd(5) + ' ' + check.name.padEnd(14) + ' ' + check.detail)
    if (check.fix) log('        fix: ' + check.fix)
  }
  log('')
  const failed = checks.filter((check) => !check.ok)
  log(
    failed.length ? failed.length + ' of ' + checks.length + ' checks failed' : 'all checks passed'
  )

  return ok ? 0 : 1
}

module.exports = {
  run,
  runChecks,
  checkNode,
  checkElectron,
  checkNodePty,
  checkBarePrebuild,
  checkDataDir,
  checkDisplay,
  checkSandbox,
  checkVersion,
  checkChannel,
  userDataRoot
}
