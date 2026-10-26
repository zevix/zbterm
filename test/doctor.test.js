const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const doctor = require('../bin/lib/doctor')
const desktop = require('../bin/lib/desktop')

const REPO_ROOT = path.join(__dirname, '..')
const ICON_SOURCE_DIR = path.join(REPO_ROOT, 'build', 'icon')

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Collects everything a `run()` would have printed so the TAP stream stays
// clean and the text itself can be asserted on.
function collector() {
  const lines = []
  const sink = (...parts) => lines.push(parts.join(' '))
  return {
    log: sink,
    error: sink,
    get text() {
      return lines.join('\n')
    }
  }
}

function listFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(path.relative(root, full))
    }
  }
  walk(root)
  return out.sort()
}

test('doctor: node version check follows the engines range', async (t) => {
  const good = doctor.checkNode({ version: 'v22.4.0', range: '>=20' })
  t.is(good.ok, true)
  t.is(good.fix, null)

  const bad = doctor.checkNode({ version: 'v18.19.0', range: '>=20' })
  t.is(bad.ok, false)
  t.ok(bad.detail.includes('v18.19.0'))
  t.ok(bad.fix.includes('nvm install 20'))
})

test('doctor: electron check fails on a missing or non-executable binary', async (t) => {
  const dir = tmpdir(t, 'zbterm-doctor-electron-')

  const missing = doctor.checkElectron({ resolveBinary: () => path.join(dir, 'nope', 'electron') })
  t.is(missing.ok, false)
  t.ok(missing.detail.startsWith('Electron binary is missing:'))
  t.ok(missing.fix.includes('npm rebuild electron'))

  const unresolved = doctor.checkElectron({ resolveBinary: () => null })
  t.is(unresolved.ok, false)
  t.ok(unresolved.fix.includes('npm rebuild electron'))

  const threw = doctor.checkElectron({
    resolveBinary: () => {
      throw new Error('Cannot find module electron')
    }
  })
  t.is(threw.ok, false)
  t.ok(threw.detail.includes('Cannot find module electron'))

  const notExecutable = path.join(dir, 'electron')
  fs.writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 })
  const denied = doctor.checkElectron({ resolveBinary: () => notExecutable })
  t.is(denied.ok, false)
  t.ok(denied.detail.startsWith('Electron binary is not executable:'))
  t.ok(denied.fix.startsWith('chmod +x '))

  fs.chmodSync(notExecutable, 0o755)
  const fine = doctor.checkElectron({ resolveBinary: () => notExecutable })
  t.is(fine.ok, true)
  t.is(fine.fix, null)
})

test('doctor: node-pty check spawns a real pty and reports load failures', async (t) => {
  const broken = doctor.checkNodePty({
    load: () => {
      throw new Error('invalid ELF header')
    }
  })
  t.is(broken.ok, false)
  t.ok(broken.detail.includes('invalid ELF header'))
  // The fix must never prescribe `npm rebuild node-pty`: a source build on a
  // shared-libnode distro links -lnode and segfaults under Electron. The pty
  // binary is an optional per-platform dependency, so the real fix is getting
  // that package installed. See bin/lib/native-linkage.js.
  t.absent(broken.fix.includes('npm rebuild'), 'never prescribes a rebuild')
  t.ok(broken.fix.includes('--omit=optional'))

  const spawnFailed = doctor.checkNodePty({
    load: () => ({
      spawn() {
        throw new Error('forkpty(3) failed')
      }
    })
  })
  t.is(spawnFailed.ok, false)
  t.ok(spawnFailed.detail.includes('forkpty(3) failed'))

  let killed = 0
  const probe = doctor.checkNodePty({
    load: () => ({
      spawn: () => ({
        pid: 4242,
        kill() {
          killed++
        }
      })
    })
  })
  t.is(probe.ok, true)
  t.is(killed, 1, 'the probe pty is always killed')

  if (process.platform !== 'win32') {
    const real = doctor.checkNodePty()
    t.is(real.ok, true, 'node-pty loads and spawns under plain Node')
  }
})

test('doctor: bare-sidecar prebuild check', async (t) => {
  const dir = tmpdir(t, 'zbterm-doctor-prebuilds-')
  fs.mkdirSync(path.join(dir, 'linux-x64'))
  fs.writeFileSync(path.join(dir, 'linux-x64', 'bare'), 'x')

  const present = doctor.checkBarePrebuild({ prebuildsDir: dir, platform: 'linux', arch: 'x64' })
  t.is(present.ok, true)
  t.ok(present.detail.startsWith('linux-x64:'))

  const absent = doctor.checkBarePrebuild({ prebuildsDir: dir, platform: 'linux', arch: 'riscv64' })
  t.is(absent.ok, false)
  t.ok(absent.detail.includes('no bare prebuild for linux-riscv64'))
  t.ok(absent.detail.includes('present: linux-x64'))
  t.ok(absent.fix.includes('npm rebuild bare-sidecar'))
})

test('doctor: data dir check on existing, creatable and unwritable roots', async (t) => {
  const dir = tmpdir(t, 'zbterm-doctor-data-')

  const existing = doctor.checkDataDir({ dir })
  t.is(existing.ok, true)
  t.ok(existing.detail.includes('exists, writable'))

  const creatable = doctor.checkDataDir({ dir: path.join(dir, 'a', 'b', 'ZBTerm') })
  t.is(creatable.ok, true)
  t.ok(creatable.detail.includes('missing, creatable under'))

  const asFile = path.join(dir, 'file')
  fs.writeFileSync(asFile, '')
  const clash = doctor.checkDataDir({ dir: asFile })
  t.is(clash.ok, false)
  t.ok(clash.detail.includes('is not a directory'))

  // root ignores the mode bits, so the unwritable case is unobservable there.
  if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
    const locked = path.join(dir, 'locked')
    fs.mkdirSync(locked, { mode: 0o500 })
    const denied = doctor.checkDataDir({ dir: path.join(locked, 'ZBTerm') })
    // Restored immediately: the teardown that removes `dir` runs before any
    // teardown registered here, and rmSync cannot descend into mode 0500.
    fs.chmodSync(locked, 0o700)
    t.is(denied.ok, false)
    t.ok(denied.detail.includes('is not writable'))
    t.ok(denied.fix.includes('chmod u+rwx'))
  }
})

test('doctor: display and chrome-sandbox checks', async (t) => {
  t.is(doctor.checkDisplay({ env: { DISPLAY: ':0' } }).ok, true)
  t.is(doctor.checkDisplay({ env: { WAYLAND_DISPLAY: 'wayland-0' } }).ok, true)

  const headless = doctor.checkDisplay({ env: {} })
  t.is(headless.ok, false)
  t.ok(headless.fix.includes('xvfb-run'))

  const dir = tmpdir(t, 'zbterm-doctor-sandbox-')
  const electronBinary = path.join(dir, 'electron')
  fs.writeFileSync(electronBinary, '')
  fs.writeFileSync(path.join(dir, 'chrome-sandbox'), '', { mode: 0o755 })

  // Not setuid root, but the kernel offers user namespaces: a warning, and the
  // run must still pass.
  const warn = doctor.checkSandbox({ electronBinary, maxUserNamespaces: 15000 })
  t.is(warn.ok, true)
  t.ok(warn.detail.includes('is not setuid root'))
  t.ok(warn.fix.includes('--no-sandbox'))

  const fail = doctor.checkSandbox({ electronBinary, maxUserNamespaces: 0 })
  t.is(fail.ok, false)
  t.ok(fail.detail.includes('unprivileged user namespaces are disabled'))
  t.ok(fail.fix.includes('chmod 4755'))

  const skipped = doctor.checkSandbox({ electronBinary: null, maxUserNamespaces: 0 })
  t.is(skipped.ok, true)
  t.is(skipped.fix, null)
})

test('doctor: run() reports every check and exits 0 on this machine', async (t) => {
  const out = collector()
  const code = doctor.run([], out)
  t.is(code, 0)
  for (const name of ['node', 'electron', 'node-pty', 'bare-sidecar', 'data-dir']) {
    t.ok(out.text.includes(name), 'reports ' + name)
  }

  const json = collector()
  t.is(doctor.run(['--json'], json), 0)
  const parsed = JSON.parse(json.text)
  t.is(parsed.ok, true)
  t.is(parsed.checks.length, doctor.runChecks().length)
  for (const check of parsed.checks) {
    t.is(typeof check.name, 'string')
    t.is(typeof check.ok, 'boolean')
    t.is(typeof check.detail, 'string')
  }
})

test('desktop: install writes exactly the desktop entry plus one icon per size', async (t) => {
  if (process.platform !== 'linux') {
    t.pass('desktop integration is Linux-only')
    return
  }

  const home = tmpdir(t, 'zbterm-desktop-home-')
  const sizes = fs
    .readdirSync(ICON_SOURCE_DIR)
    .map((name) => /^icon-(\d+)x(\d+)\.png$/.exec(name))
    .filter((match) => match && match[1] === match[2])
    .map((match) => match[1] + 'x' + match[2])

  const expected = [
    path.join('.local', 'share', 'applications', 'zbterm.desktop'),
    ...sizes.map((size) =>
      path.join('.local', 'share', 'icons', 'hicolor', size, 'apps', 'zbterm.png')
    )
  ].sort()

  const first = desktop.install({
    home,
    launchPath: '/opt/zbterm/bin/zbterm.js',
    runHooks: false
  })
  t.alike(listFiles(home), expected)
  t.is(first.written.length, expected.length)

  const contents = fs.readFileSync(path.join(home, expected[0]), 'utf8')
  t.ok(contents.includes('Exec=/opt/zbterm/bin/zbterm.js %u'), 'absolute Exec with %u')
  t.ok(contents.includes('Type=Application'))
  t.ok(contents.includes('Terminal=false'))
  t.ok(contents.includes('Icon=zbterm'))
  t.ok(contents.includes('Categories=Development;System;TerminalEmulator;'))
  t.ok(contents.includes('MimeType=x-scheme-handler/zbterm;'), 'claims the scheme on one line')
  t.is(contents.split('\n').filter((line) => line.startsWith('MimeType=')).length, 1)

  // Idempotent: a second install changes nothing.
  const before = listFiles(home).map((rel) => [rel, fs.readFileSync(path.join(home, rel))])
  desktop.install({ home, launchPath: '/opt/zbterm/bin/zbterm.js', runHooks: false })
  const after = listFiles(home).map((rel) => [rel, fs.readFileSync(path.join(home, rel))])
  t.is(after.length, before.length)
  for (let i = 0; i < before.length; i++) {
    t.is(after[i][0], before[i][0])
    t.ok(after[i][1].equals(before[i][1]))
  }

  const removed = desktop.uninstall({ home })
  t.is(removed.removed.length, expected.length)
  t.alike(listFiles(home), [], 'uninstall leaves no files behind')

  const again = desktop.uninstall({ home })
  t.is(again.removed.length, 0, 'uninstall is idempotent')
})

test('desktop: uninstall also drops the scheme associations install caused', async (t) => {
  if (process.platform !== 'linux') {
    t.pass('desktop integration is Linux-only')
    return
  }

  const home = tmpdir(t, 'zbterm-desktop-mime-')
  desktop.install({ home, launchPath: '/opt/zbterm/bin/zbterm.js', runHooks: false })

  const mimeapps = path.join(home, '.config', 'mimeapps.list')
  fs.mkdirSync(path.dirname(mimeapps), { recursive: true })
  fs.writeFileSync(
    mimeapps,
    [
      '[Default Applications]',
      'text/html=firefox.desktop',
      'x-scheme-handler/zbterm=zbterm.desktop',
      ''
    ].join('\n')
  )

  desktop.uninstall({ home })
  const kept = fs.readFileSync(mimeapps, 'utf8')
  t.ok(kept.includes('text/html=firefox.desktop'), 'other associations survive')
  t.absent(kept.includes('x-scheme-handler/zbterm'))
})

// A PATH whose `xdg-mime` and `update-desktop-database` are the liars this
// phase exists for: exit 0, write nothing. It also keeps the real desktop
// tooling (and KDE's kbuildsycoca6) out of the test run entirely.
function stubHooks(t) {
  const dir = tmpdir(t, 'zbterm-desktop-stub-')
  for (const name of ['xdg-mime', 'update-desktop-database']) {
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  return { ...process.env, PATH: dir + path.delimiter + process.env.PATH }
}

function runCli(args, env) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'zbterm.js'), ...args], {
    env,
    encoding: 'utf8'
  })
}

test('desktop: --print-only writes nothing and prints the whole recipe', async (t) => {
  if (process.platform !== 'linux') {
    t.pass('desktop integration is Linux-only')
    return
  }

  const home = tmpdir(t, 'zbterm-desktop-print-')
  const run = runCli(['install-desktop', '--print-only'], { ...process.env, HOME: home })

  t.is(run.status, 0)
  t.alike(listFiles(home), [], '--print-only creates no file under HOME')
  t.ok(run.stdout.includes(path.join(home, '.local', 'share', 'applications', 'zbterm.desktop')))
  t.ok(run.stdout.includes(path.join(home, '.config', 'mimeapps.list')))
  t.ok(run.stdout.includes('Exec='), 'prints the desktop entry body')
  t.ok(run.stdout.includes('MimeType=x-scheme-handler/zbterm;'))
  t.ok(run.stdout.includes(path.join('.local', 'share', 'icons', 'hicolor')), 'prints icon targets')
  t.ok(
    run.stdout.includes(
      'update-desktop-database ' + path.join(home, '.local', 'share', 'applications')
    )
  )
  t.ok(run.stdout.includes('xdg-mime default zbterm.desktop x-scheme-handler/zbterm'))
  t.ok(run.stdout.includes('x-scheme-handler/zbterm=zbterm.desktop'))
  t.ok(run.stdout.includes('[Default Applications]'), 'names the section it verifies')
  t.ok(run.stdout.includes('[Added Associations]'), 'and the candidate-handler section')
  t.ok(run.stdout.includes('x-scheme-handler/zbterm=zbterm.desktop;'), 'in its list form')
})

test('desktop: install verifies mimeapps.list even when the hooks lie', async (t) => {
  if (process.platform !== 'linux') {
    t.pass('desktop integration is Linux-only')
    return
  }

  const home = tmpdir(t, 'zbterm-desktop-liar-')
  const env = stubHooks(t)

  // A pre-existing list, with a second section, that must survive intact.
  const mimeapps = path.join(home, '.config', 'mimeapps.list')
  fs.mkdirSync(path.dirname(mimeapps), { recursive: true })
  const before = [
    '[Default Applications]',
    'text/html=firefox.desktop',
    '',
    '[Added Associations]',
    'text/html=firefox.desktop;',
    ''
  ].join('\n')
  fs.writeFileSync(mimeapps, before)

  const result = desktop.install({ home, launchPath: '/opt/zbterm/bin/zbterm.js', env })
  t.is(result.mimeVerified, true, 'the associations are on disk, whatever the hooks claimed')
  t.alike(result.mimeMissing, { defaults: [], added: [] }, 'neither section is short')
  t.is(result.mimeRepaired, true, 'written directly because the stub xdg-mime wrote nothing')
  t.is(result.desktopFile, path.join(home, '.local', 'share', 'applications', 'zbterm.desktop'))
  t.ok(result.icons.length > 0)

  const after = fs.readFileSync(mimeapps, 'utf8')
  t.is(after.split('\n').filter((line) => line.trim() === '[Default Applications]').length, 1)
  t.is(after.split('\n').filter((line) => line.trim() === '[Added Associations]').length, 1)
  t.ok(after.includes('text/html=firefox.desktop'), 'other defaults survive')
  t.ok(after.includes('[Added Associations]\ntext/html=firefox.desktop;'), 'other sections survive')
  t.ok(after.includes('x-scheme-handler/zbterm=zbterm.desktop'))

  // Both sections, checked through the parser rather than by substring: the
  // `;`-terminated list form is what [Added Associations] has to end up in.
  t.alike(desktop.missingAssociations(after), { defaults: [], added: [] })
  t.ok(after.includes('x-scheme-handler/zbterm=zbterm.desktop;'), 'list form under added')

  // Idempotent: nothing is added the second time round.
  const second = desktop.install({ home, launchPath: '/opt/zbterm/bin/zbterm.js', env })
  t.is(second.mimeVerified, true)
  t.is(second.mimeRepaired, false, 'already verified, so nothing is rewritten')
  t.is(fs.readFileSync(mimeapps, 'utf8'), after)

  const cli = runCli(['install-desktop'], { ...env, HOME: home })
  t.is(cli.status, 0, 'a lying hook is not a failure once the file is verified')
  t.ok(cli.stdout.includes('verified x-scheme-handler/zbterm=zbterm.desktop'))

  desktop.uninstall({ home })
  t.alike(listFiles(home), [path.join('.config', 'mimeapps.list')], 'only the user list survives')
  const cleaned = fs.readFileSync(mimeapps, 'utf8')
  t.absent(cleaned.includes('zbterm.desktop'), 'the associations install added are gone')
  t.ok(cleaned.includes('text/html=firefox.desktop'))
})

test('desktop: an existing [Added Associations] list is appended to, not replaced', async (t) => {
  if (process.platform !== 'linux') {
    t.pass('desktop integration is Linux-only')
    return
  }

  const home = tmpdir(t, 'zbterm-desktop-added-')
  const env = stubHooks(t)

  // Another application already claims zbterm://, and a section this code has
  // no business touching sits after it.
  const mimeapps = path.join(home, '.config', 'mimeapps.list')
  fs.mkdirSync(path.dirname(mimeapps), { recursive: true })
  const before = [
    '[Added Associations]',
    'x-scheme-handler/zbterm=other.desktop;',
    '',
    '[Unrelated]',
    'keep=me',
    ''
  ].join('\n')
  fs.writeFileSync(mimeapps, before)

  const result = desktop.install({ home, launchPath: '/opt/zbterm/bin/zbterm.js', env })
  t.is(result.mimeVerified, true)
  t.alike(result.mimeMissing, { defaults: [], added: [] })

  const after = fs.readFileSync(mimeapps, 'utf8')
  t.ok(
    after.includes('x-scheme-handler/zbterm=other.desktop;zbterm.desktop;'),
    'appended in order, the other application first'
  )
  t.ok(
    after.includes('[Default Applications]\nx-scheme-handler/zbterm=zbterm.desktop'),
    'the missing section and its key are added'
  )
  t.ok(after.includes('[Unrelated]\nkeep=me'), 'the unrelated section survives')
  t.is(
    after.split('\n').filter((line) => /^x-scheme-handler\/.*zbterm\.desktop/.test(line)).length,
    2,
    'the scheme in both sections'
  )
  t.alike(desktop.missingAssociations(after), { defaults: [], added: [] })

  // Idempotent: the list is not appended to twice.
  desktop.install({ home, launchPath: '/opt/zbterm/bin/zbterm.js', env })
  t.is(fs.readFileSync(mimeapps, 'utf8'), after, 'a second install rewrites nothing')

  desktop.uninstall({ home })
  const cleaned = fs.readFileSync(mimeapps, 'utf8')
  t.absent(cleaned.includes('zbterm.desktop'), 'zbterm is gone from both sections')
  t.ok(
    cleaned.includes('x-scheme-handler/zbterm=other.desktop;'),
    "the other application's entry is left, terminator and all"
  )
  t.ok(
    cleaned.includes('[Added Associations]'),
    'a section that still has entries is not deleted with it'
  )
  t.is(cleaned, before, 'install + uninstall is byte-for-byte a round trip')
  t.alike(listFiles(home), [path.join('.config', 'mimeapps.list')])
})

test('desktop: an unwritable ~/.config is reported, not swallowed', async (t) => {
  if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0) {
    t.pass('mode bits are unobservable as root')
    return
  }

  // Teardowns run FIFO, so the chmod restore has to be registered *before* the
  // rmSync that needs it - rmSync cannot descend into mode 0500.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zbterm-desktop-ro-'))
  const config = path.join(home, '.config')
  fs.mkdirSync(config, { mode: 0o500 })
  t.teardown(() => fs.chmodSync(config, 0o700))
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }))

  const env = stubHooks(t)
  const result = desktop.install({ home, launchPath: '/opt/zbterm/bin/zbterm.js', env })
  t.is(result.mimeVerified, false)
  t.alike(result.mimeMissing, { defaults: ['zbterm'], added: ['zbterm'] })
  t.ok(result.hookFailures.length > 0, 'the failed write is reported')
  t.ok(result.hookFailures.some((failure) => failure.detail === 'EACCES'))
  t.ok(fs.existsSync(result.desktopFile), 'the desktop entry itself still landed')

  const cli = runCli(['install-desktop'], { ...env, HOME: home })
  t.not(cli.status, 0, 'the command exits non-zero')
  t.ok(cli.stdout.includes('could not verify'))
  t.ok(cli.stdout.includes('x-scheme-handler/zbterm'))
  t.ok(cli.stdout.includes('xdg-mime default zbterm.desktop x-scheme-handler/zbterm'))
})

test('desktop: non-Linux platforms explain themselves and exit 0', async (t) => {
  for (const platform of ['darwin', 'win32']) {
    const out = collector()
    t.is(desktop.runInstall([], { ...out, platform }), 0)
    t.ok(out.text.includes('Linux-only'))

    const printOnly = collector()
    t.is(desktop.runInstall(['--print-only'], { ...printOnly, platform }), 0)
    t.ok(printOnly.text.includes('Linux-only'))
    t.absent(printOnly.text.includes('[Desktop Entry]'), 'no entry to print off Linux')

    const off = collector()
    t.is(desktop.runUninstall([], { ...off, platform }), 0)
    t.ok(off.text.includes('uninstall-desktop is Linux-only'))
  }
})

test('userDataRoot matches Electron per platform', async (t) => {
  t.is(
    doctor.userDataRoot({ platform: 'linux', env: { HOME: '/home/x' } }),
    path.join('/home/x', '.config', 'ZBTerm')
  )
  t.is(
    doctor.userDataRoot({ platform: 'linux', env: { HOME: '/home/x', XDG_CONFIG_HOME: '/cfg' } }),
    path.join('/cfg', 'ZBTerm')
  )
  t.is(
    doctor.userDataRoot({ platform: 'darwin', env: { HOME: '/Users/x' } }),
    path.join('/Users/x', 'Library', 'Application Support', 'ZBTerm')
  )
  t.is(
    doctor.userDataRoot({ platform: 'win32', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } }),
    path.join('C:\\Users\\x\\AppData\\Roaming', 'ZBTerm')
  )
})
