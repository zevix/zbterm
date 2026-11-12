#!/usr/bin/env node
// `npm start`: runs `electron-forge start -- --no-updates <your args>`, after one
// check that would otherwise end in a Chromium FATAL with no hint of the fix.
//
// On Linux, Chromium's sandbox needs either unprivileged user namespaces or a
// setuid-root chrome-sandbox helper. An unpacked Electron (node_modules) never has
// the setuid helper, and Ubuntu >= 23.10 restricts user namespaces through
// AppArmor, so there the app aborts at launch ("The SUID sandbox helper binary
// was found, but is not configured correctly"). When both are true and
// --no-sandbox was not given, this prints how to start it and exits 1 instead.
// run.sh adds --no-sandbox itself in the same situation (no_sandbox_fallback).
//
// The check runs here, not in `prestart`: npm hands the arguments after `--` only
// to the `start` script itself.
'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const args = process.argv.slice(2)

function readSysctl(name) {
  try {
    return fs.readFileSync(`/proc/sys/${name}`, 'utf8').trim()
  } catch {
    return null
  }
}

function sandboxHelperUsable() {
  try {
    const st = fs.statSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'chrome-sandbox'))
    return st.uid === 0 && (st.mode & 0o4000) !== 0
  } catch {
    // No helper at all: Chromium does not take the SUID path, nothing to warn about.
    return true
  }
}

function userNamespacesRestricted() {
  return (
    readSysctl('kernel/apparmor_restrict_unprivileged_userns') === '1' ||
    readSysctl('kernel/unprivileged_userns_clone') === '0' ||
    readSysctl('user/max_user_namespaces') === '0'
  )
}

function sandboxWillAbort() {
  if (process.platform !== 'linux') return false
  if (args.includes('--no-sandbox')) return false
  if (process.env.ELECTRON_DISABLE_SANDBOX) return false
  if (process.env.ZBTERM_SKIP_SANDBOX_CHECK) return false
  return !sandboxHelperUsable() && userNamespacesRestricted()
}

if (sandboxWillAbort()) {
  const helper = 'node_modules/electron/dist/chrome-sandbox'
  process.stderr.write(
    [
      '',
      "npm start: Chromium's sandbox cannot start on this machine, so Electron would abort.",
      '  Unprivileged user namespaces are restricted (AppArmor), and',
      `  ${helper} is not setuid root.`,
      '',
      'Start it with one of:',
      '  npm start -- --no-sandbox',
      '  ./run.sh --dev                  (adds --no-sandbox itself)',
      '',
      'Or make the helper setuid root (again after every npm install / npm ci):',
      `  sudo chown root:root ${helper} && sudo chmod 4755 ${helper}`,
      '',
      'If you know the sandbox works here anyway, set ZBTERM_SKIP_SANDBOX_CHECK=1.',
      ''
    ].join('\n')
  )
  process.exit(1)
}

const forge = require.resolve('@electron-forge/cli/dist/electron-forge.js', { paths: [ROOT] })
const child = spawn(process.execPath, [forge, 'start', '--', '--no-updates', ...args], {
  cwd: ROOT,
  stdio: 'inherit'
})
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig))
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
