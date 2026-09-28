const fs = require('fs')
const { execFile } = require('child_process')

// When the kernel OOM-kills any process, systemd stops the whole unit that
// process belonged to (DefaultOOMPolicy=stop). Electron registers the app as a
// single app-org.chromium.Chromium-<pid>.scope, so every shell we spawn lands
// in the same unit as the app itself: one runaway command in one tab takes
// ZBTerm down, every other tab with it.
//
// Adopting each PTY child into its own transient scope puts that blast radius
// back where it belongs. OOMPolicy=continue means even the offending tab keeps
// its shell, and per-tab memory becomes visible in systemd-cgtop.
//
// This is deliberately applied *after* pty.spawn rather than by wrapping the
// shell in `systemd-run --scope`: moving a cgroup leaves the session leader,
// controlling terminal, job control and exit-status plumbing untouched, where
// an extra wrapper process between the pty and the shell would disturb all
// four.
const BUS_ARGS = [
  '--user',
  'call',
  'org.freedesktop.systemd1',
  '/org/freedesktop/systemd1',
  'org.freedesktop.systemd1.Manager',
  'StartTransientUnit',
  'ssa(sv)a(sa(sv))'
]

const TIMEOUT_MS = 2000
// StartTransientUnit returns once the job is queued, not once the process has
// moved, so success is only real when the child's cgroup actually says so.
const CONFIRM_MS = 1000
const POLL_MS = 10

function scopeName(pid) {
  return `zbterm-pty-${pid}.scope`
}

function adoptArgs(pid) {
  return BUS_ARGS.concat([
    scopeName(pid),
    'fail',
    '4',
    'Description',
    's',
    `ZBTerm terminal (pid ${pid})`,
    'PIDs',
    'au',
    '1',
    String(pid),
    'CollectMode',
    's',
    'inactive-or-failed',
    'OOMPolicy',
    's',
    'continue',
    '0'
  ])
}

function readCgroup(pid) {
  return fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8')
}

// Resolves true only once the child is observably inside its own scope, false
// when the host cannot provide one. Never rejects: a terminal must still open
// on a machine with no systemd user session (containers, some sandboxes,
// non-Linux), it just does not get the containment.
function adopt(pid, opts = {}) {
  const platform = opts.platform || process.platform
  const exec = opts.execFile || execFile
  const read = opts.readCgroup || readCgroup
  const now = opts.now || Date.now
  if (platform !== 'linux' || !pid) return Promise.resolve(false)

  return new Promise((resolve) => {
    const name = scopeName(pid)
    const deadline = now() + CONFIRM_MS

    const confirm = () => {
      let cgroup
      try {
        cgroup = read(pid)
      } catch {
        return resolve(false) // the shell exited before we could contain it
      }
      if (cgroup.includes(name)) return resolve(true)
      if (now() >= deadline) return resolve(false)
      setTimeout(confirm, POLL_MS)
    }

    try {
      exec('busctl', adoptArgs(pid), { timeout: TIMEOUT_MS }, (err) => {
        if (err) return resolve(false)
        confirm()
      })
    } catch {
      resolve(false)
    }
  })
}

module.exports = { adopt, scopeName }
module.exports._test = { adoptArgs }
