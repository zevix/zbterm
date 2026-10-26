// Shared by the tests that run two real `SessionEngine`s over Freenet
// (test/freenet-history.test.js, test/backends/freenet-backend.test.js): each
// engine has the Rust `zxterm-core` sidecar of its profile, and they meet on
// one throwaway local-mode node (test/helpers/freenet-node.js, never the
// owner's).
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

require('./zxterm-core')

const SessionEngine = require('../../engine')
const { PacketKind } = require('../../engine/schema')

// A PTY host that runs nothing (test/share-flood.test.js's FakeHost).
class FakeHost extends EventEmitter {
  constructor() {
    super()
    this.terminals = new Map()
  }

  spawn(sessionId) {
    const terminal = { sessionId, paused: false, registered: true }
    this.terminals.set(sessionId, terminal)
    return {
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {
        if (!terminal.registered) return
        terminal.registered = false
        this.emit('exit', { sessionId, exit: { code: 0, signal: null } })
      }
    }
  }

  push(sessionId, data) {
    const terminal = this.terminals.get(sessionId)
    if (!terminal || !terminal.registered) return false
    this.emit('data', { sessionId, data })
    return true
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function until(fn, ms = 30000, what = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`)
    await delay(50)
  }
}

async function makeEngine(t, node, dir) {
  const ptyHost = new FakeHost()
  const engine = new SessionEngine({
    userData: dir,
    ptyHost,
    backendLimit: 'freenet',
    backendOptions: { nodeUrl: node.url }
  })
  const errors = []
  engine.on('engine:error', (err) => errors.push(err))
  await engine.ready()
  await engine.invoke('share.setIceServers', { iceServers: [] })
  return { engine, ptyHost, errors, dir }
}

async function scratch(t, name) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `zbterm-fh-${name}-`))
  t.teardown(() =>
    fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  )
  return dir
}

// The text of a store's DATA packets, in order.
async function textOf(store, length) {
  let text = ''
  const packets = []
  for await (const packet of store.readRange(1, length, { wait: false })) {
    packets.push(packet)
    if (packet.kind === PacketKind.DATA) text += Buffer.from(packet.payload).toString('utf8')
  }
  return { text, packets }
}

async function joinLink(viewer, link) {
  const joined = new Promise((resolve, reject) => {
    const onChange = (status) => {
      if (status.linkId !== link.linkId) return
      if (status.status === 'joined') {
        viewer.off('share:join-changed', onChange)
        resolve(status)
      } else if (status.status === 'failed') {
        viewer.off('share:join-changed', onChange)
        reject(new Error(`join failed: ${status.message} (${status.reason})`))
      }
    }
    viewer.on('share:join-changed', onChange)
  })
  await viewer.invoke('share.join', { uri: link.uri })
  return await joined
}

function countRequests(engine, method) {
  const counts = { n: 0, calls: [] }
  const request = engine.core.request.bind(engine.core)
  engine.core.request = (name, args) => {
    if (name === method) {
      counts.n++
      counts.calls.push(args)
    }
    return request(name, args)
  }
  return counts
}

// A host engine with a session that has a recording of `lines` lines made
// before any share.
async function hostWithRecording(t, node, { lines = 40, dir = null, name = 'pre-share' } = {}) {
  const host = await makeEngine(t, node, dir || (await scratch(t, 'host')))
  const created = await host.engine.invoke('session.create', { name, cols: 100, rows: 30 })
  const sessionId = created.sessionId
  const runtime = host.engine.sessions.get(sessionId)
  for (let i = 0; i < lines; i++) {
    host.ptyHost.push(sessionId, Buffer.from(`before-share-line-${i} ${'x'.repeat(200)}\r\n`))
    if (i % 10 === 9) await delay(150)
  }
  await until(() => runtime.store.log.length > 1, 15000, 'the recording')
  await delay(500)
  await runtime.store.flushTimeline()
  return { ...host, sessionId, runtime }
}

async function share(host) {
  return await host.engine.invoke('share.createLink', {
    sessionId: host.sessionId,
    type: 'group',
    autoJoin: true,
    backend: 'freenet'
  })
}

// Every packet the host's core-side history holds has reached the contract.
async function published(host) {
  const hostShare = host.engine.share.hostShares.get(host.sessionId)
  await hostShare.history.flush()
  const head = await host.engine.core.request('history.head', { sessionId: host.sessionId })
  const status = await host.engine.core.request('history.publishStatus', {
    sessionId: host.sessionId,
    waitLength: head.length,
    timeoutMs: 20000
  })
  return { head, status }
}

// Signals a sidecar this test started: the one whose command line carries the
// test's own scratch profile directory, and no other.
function killSidecar(engine) {
  const client = engine.core._client
  const pid = client && client._child && client._child.pid
  if (!pid) throw new Error('no sidecar to stop')
  const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  if (!cmdline.includes(engine.core.profileDir)) throw new Error(`pid ${pid} is not this test's`)
  process.kill(pid, 'SIGKILL')
  return pid
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

module.exports = {
  FakeHost,
  delay,
  until,
  makeEngine,
  scratch,
  textOf,
  joinLink,
  countRequests,
  hostWithRecording,
  share,
  published,
  killSidecar,
  alive
}
