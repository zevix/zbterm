const { EventEmitter } = require('events')
const test = require('brittle')

const PtySession = require('../electron/pty-session')
const PtyHost = require('../electron/pty-host')
const { EngineClient } = require('../electron/engine-client')
const { FrameKind, encodeFrame, decodeFrame } = require('../engine/rpc/schema')

test('PtySession uses cmd.exe as the default Windows shell', (t) => {
  const { defaultShell } = PtySession._test
  t.is(defaultShell('win32', {}), 'cmd.exe')
  t.is(
    defaultShell('win32', { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' }),
    'C:\\Windows\\System32\\cmd.exe'
  )
  t.is(defaultShell('linux', { SHELL: '/bin/zsh' }), '/bin/zsh')
  t.is(defaultShell('linux', {}), 'bash')
})

test('PtySession runs a session command through the shell and expands ~ in cwd', (t) => {
  const os = require('os')
  const path = require('path')
  const { resolveCwd, commandArgs } = PtySession._test
  t.alike(commandArgs(''), [])
  t.alike(commandArgs(null), [])
  t.alike(commandArgs(' htop -d 5 ', 'linux'), ['-c', 'htop -d 5'])
  t.alike(commandArgs('dir', 'win32'), ['/c', 'dir'])
  const home = os.homedir()
  t.is(resolveCwd(''), home)
  t.is(resolveCwd('~'), home)
  t.is(resolveCwd('~/'), home)
  t.is(resolveCwd(os.tmpdir()), os.tmpdir())
  t.is(resolveCwd('~/' + path.relative(home, home)), home)
  t.is(resolveCwd('/definitely/not/a/dir/zbterm'), home, 'missing directory falls back to home')
})

test('PtyHost operations for unknown sessions are no-ops', (t) => {
  const host = new PtyHost()
  doesNotThrow(t, () => host.write('missing', Buffer.from('x')))
  doesNotThrow(t, () => host.resize('missing', 80, 24))
  doesNotThrow(t, () => host.pause('missing'))
  doesNotThrow(t, () => host.resume('missing'))
  doesNotThrow(t, () => host.kill('missing'))
})

test('EngineClient rejects unexpected and duplicate PTY_SPAWN frames', (t) => {
  const client = Object.create(EngineClient.prototype)
  const spawned = []
  client._allowedPtySpawns = 0
  client._pending = new Map()
  client.ptyHost = {
    sessions: new Map(),
    spawn: (sessionId, opts) => {
      spawned.push({ sessionId, opts })
      client.ptyHost.sessions.set(sessionId, true)
      return {}
    }
  }

  client._onFrame(
    encodeFrame(FrameKind.PTY_SPAWN, 0, {
      sessionId: 'unexpected',
      cols: 80,
      rows: 24,
      shell: '/tmp/evil',
      cwd: '/tmp'
    })
  )
  t.is(spawned.length, 0, 'unexpected spawn is rejected')

  client._allowedPtySpawns = 1
  client._pending.set(1, { allowsPtySpawn: true, ptySpawnConsumed: false })
  client._onFrame(
    encodeFrame(FrameKind.PTY_SPAWN, 0, {
      sessionId: 's1',
      cols: 100,
      rows: 30,
      shell: '/tmp/evil',
      cwd: '/tmp'
    })
  )
  // `shell` from the worker is never honoured; the session's home directory
  // and command are - the worker can already type anything into the PTY.
  t.alike(spawned, [{ sessionId: 's1', opts: { cols: 100, rows: 30, cwd: '/tmp', command: null } }])

  client._allowedPtySpawns = 1
  client._pending.set(2, { allowsPtySpawn: true, ptySpawnConsumed: false })
  client._onFrame(
    encodeFrame(FrameKind.PTY_SPAWN, 0, {
      sessionId: 's1',
      cols: 100,
      rows: 30
    })
  )
  t.is(spawned.length, 1, 'duplicate spawn is rejected')
})

test('EngineClient reports a PTY spawn that throws as output and an exit, never silence', (t) => {
  const client = Object.create(EngineClient.prototype)
  const frames = []
  client._allowedPtySpawns = 1
  client._pending = new Map([[1, { allowsPtySpawn: true, ptySpawnConsumed: false }]])
  client._closed = false
  client._workerAlive = true
  client._attached = new Set()
  client._pipe = {
    write: (buf) => {
      frames.push(decodeFrame(buf))
      return true
    }
  }
  client.ptyHost = {
    sessions: new Map(),
    spawn: () => {
      throw new Error('forkpty(3) failed')
    },
    pause: () => {}
  }
  doesNotThrow(t, () =>
    client._onFrame(encodeFrame(FrameKind.PTY_SPAWN, 0, { sessionId: 's1', cols: 80, rows: 24 }))
  )
  t.alike(
    frames.map((frame) => frame.kind),
    [FrameKind.PTY_DATA, FrameKind.PTY_EXIT],
    'the failure is delivered as terminal output followed by an exit'
  )
  t.ok(
    Buffer.from(frames[0].body.data).toString().includes('could not start: forkpty(3) failed'),
    'the output names the error'
  )
  t.alike(
    [frames[1].body.sessionId, frames[1].body.code],
    ['s1', 127],
    'the exit carries the session and a command-not-found code'
  )
})

test('EngineClient PTY frame dispatch drops stale-session errors', (t) => {
  const client = Object.create(EngineClient.prototype)
  client.ptyHost = {
    write: () => {
      throw new Error('stale session')
    }
  }
  doesNotThrow(t, () =>
    client._onFrame(
      encodeFrame(FrameKind.PTY_WRITE, 0, {
        sessionId: 'gone',
        data: Buffer.from('x')
      })
    )
  )
})

test('EngineClient worker failure signal emits restart event once', (t) => {
  const client = Object.create(EngineClient.prototype)
  EventEmitter.call(client)
  client._closed = false
  client._failureSignaled = false
  client._workerAlive = true
  client._worker = { destroy: () => {} }

  let exits = 0
  client.on('worker:exit', ({ unexpected }) => {
    exits++
    t.ok(unexpected)
  })
  client._signalWorkerFailure('hung')
  client._signalWorkerFailure('hung again')
  t.is(exits, 1)
  t.absent(client._workerAlive)
})

function doesNotThrow(t, fn) {
  try {
    fn()
    t.pass('did not throw')
  } catch (err) {
    t.fail(err && err.message ? err.message : err)
  }
}
