// bin/zbterm.js retries a Chromium sandbox failure once with --no-sandbox.
// The Electron binary is a stand-in script (ELECTRON_OVERRIDE_DIST_PATH),
// which fails the way Chromium does when chrome-sandbox is not setuid root.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const test = require('brittle')

const LAUNCHER = path.join(__dirname, '..', 'bin', 'zbterm.js')

function fakeElectron(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbt-electron-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'electron'), '#!/bin/sh\n' + body, { mode: 0o755 })
  return dir
}

function launch(dist) {
  return spawnSync(process.execPath, [LAUNCHER], {
    env: { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: dist },
    encoding: 'utf8',
    timeout: 20000
  })
}

const SANDBOX_FATAL =
  'echo "FATAL:setuid_sandbox_host.cc] The SUID sandbox helper binary was found, but is not configured correctly." >&2'

test('launcher: a sandbox crash by signal is retried with --no-sandbox', (t) => {
  if (process.platform !== 'linux') {
    t.comment('SKIP:', 'the stand-in Electron path is the Linux one')
    return
  }
  const dist = fakeElectron(
    t,
    `case " $* " in *" --no-sandbox "*) echo retried; exit 0 ;; esac\n${SANDBOX_FATAL}\nkill -TRAP $$\n`
  )
  const result = launch(dist)
  t.is(result.status, 0, 'the retry ran and exited cleanly')
  t.ok(result.stdout.includes('retried'), 'the second run had --no-sandbox')
  t.ok(result.stderr.includes('retrying with --no-sandbox'), 'it says why')
})

test('launcher: a sandbox failure with an exit code is retried too', (t) => {
  if (process.platform !== 'linux') {
    t.comment('SKIP:', 'the stand-in Electron path is the Linux one')
    return
  }
  const dist = fakeElectron(
    t,
    `case " $* " in *" --no-sandbox "*) echo retried; exit 0 ;; esac\n${SANDBOX_FATAL}\nexit 1\n`
  )
  const result = launch(dist)
  t.is(result.status, 0)
  t.ok(result.stdout.includes('retried'))
})

test('launcher: a crash that is not the sandbox is not retried', (t) => {
  if (process.platform !== 'linux') {
    t.comment('SKIP:', 'the stand-in Electron path is the Linux one')
    return
  }
  const dist = fakeElectron(
    t,
    'case " $* " in *" --no-sandbox "*) echo retried; exit 0 ;; esac\necho "something else broke" >&2\nkill -TRAP $$\n'
  )
  const result = launch(dist)
  t.not(result.status, 0, 'the crash is reported')
  t.absent(result.stdout.includes('retried'), 'no retry')
})
