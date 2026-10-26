const fs = require('fs')
const test = require('brittle')

const PtySession = require('../electron/pty-session')
const { adopt, scopeName } = require('../electron/pty-scope')
const { adoptArgs } = require('../electron/pty-scope')._test

test('adopt builds a StartTransientUnit call for the given pid', (t) => {
  const args = adoptArgs(4321)

  t.is(args[0], '--user')
  t.is(args[5], 'StartTransientUnit')
  t.is(args[7], scopeName(4321), 'scope is named after the pid')
  t.is(args[8], 'fail')

  // The declared property count has to match what actually follows it, or
  // systemd rejects the whole message.
  const declared = Number(args[9])
  const names = ['Description', 'PIDs', 'CollectMode', 'OOMPolicy']
  t.is(declared, names.length)
  for (const name of names) t.ok(args.includes(name), `sends ${name}`)

  const pids = args.indexOf('PIDs')
  t.is(args[pids + 1], 'au', 'PIDs is an array of unsigned ints')
  t.is(args[pids + 2], '1', 'exactly one pid')
  t.is(args[pids + 3], '4321')

  const policy = args.indexOf('OOMPolicy')
  t.is(args[policy + 2], 'continue', 'an OOM kill here must not stop the unit')
  t.is(args[args.length - 1], '0', 'empty aux array terminates the message')
})

test('adopt is a no-op off Linux and never shells out', async (t) => {
  let called = false
  const execFile = () => {
    called = true
  }

  t.is(await adopt(1234, { platform: 'darwin', execFile }), false)
  t.is(await adopt(1234, { platform: 'win32', execFile }), false)
  t.absent(called, 'no busctl on platforms without systemd')
})

test('adopt resolves false rather than rejecting when the host has no systemd', async (t) => {
  const missing = (_cmd, _args, _opts, cb) => cb(new Error('ENOENT: busctl'))
  t.is(await adopt(1234, { platform: 'linux', execFile: missing }), false)

  const throws = () => {
    throw new Error('spawn failed')
  }
  t.is(await adopt(1234, { platform: 'linux', execFile: throws }), false)

  t.is(await adopt(0, { platform: 'linux', execFile: throws }), false, 'no pid, no call')
})

test('adopt reports success only once the child is really in the scope', async (t) => {
  const ok = (_cmd, _args, _opts, cb) => cb(null)

  t.is(
    await adopt(77, {
      platform: 'linux',
      execFile: ok,
      readCgroup: () => `0::/user.slice/${scopeName(77)}\n`
    }),
    true,
    'confirmed migration'
  )

  // systemd accepted the job but the process never moved: report the truth
  // rather than a containment we do not actually have.
  let clock = 0
  t.is(
    await adopt(77, {
      platform: 'linux',
      execFile: ok,
      readCgroup: () => '0::/user.slice/app.slice/app-org.chromium.Chromium-1.scope\n',
      now: () => (clock += 500)
    }),
    false,
    'gives up instead of claiming an unconfirmed scope'
  )

  t.is(
    await adopt(77, {
      platform: 'linux',
      execFile: ok,
      readCgroup: () => {
        throw new Error('ESRCH')
      }
    }),
    false,
    'shell exited before containment landed'
  )
})

test(
  'a spawned terminal lands in its own scope',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const session = new PtySession({ cols: 80, rows: 24 })
    t.teardown(() => session.kill())

    const pid = session._pty.pid
    const adopted = await session.scoped

    if (!adopted) {
      t.comment('no systemd user session available - skipping cgroup assertion')
      t.pass('adopt degraded gracefully instead of failing the spawn')
      return
    }

    const cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8')
    t.ok(cgroup.includes(scopeName(pid)), `pty is contained in ${scopeName(pid)}`)
    t.absent(cgroup.includes('Chromium'), 'pty no longer shares the app cgroup')
  }
)
