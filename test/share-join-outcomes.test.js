// What a viewer is told about a join, and what a host is told about a
// requester, once two engines talk over the in-process loopback backend:
//
// - a repeated bootstrap (the host re-sends its screen on every resize) is a
//   repaint, not a second `joined` - a second `joined` made the viewer's UI
//   select the session again, so the viewer followed the host's tab switches;
// - a refused or failed join names its reason (`reason`, JOIN_REASONS), on a
//   channel the host answers even when it no longer shares the session;
// - a requester that leaves while its approval is pending cancels the prompt;
// - a session whose command exits at once reports how long it ran and what
//   it ran, so the UI can say so instead of extending it again.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const test = require('brittle')

const SessionEngine = require('../engine')
const { JOIN_REASONS } = require('../engine/share-manager')
const { LoopbackBackend, LoopbackHub } = require('../engine/backends/loopback')

test('a later bootstrap repaints the viewer without a second joined (host resize, tab switch)', async (t) => {
  const { host, viewer, hostPty } = await pair(t)
  const sessionId = await liveSession(host, hostPty)
  const link = await host.share.createLink(sessionId, { type: 'group', autoJoin: true })
  const joins = collect(viewer, 'share:join-changed')
  const restored = collect(viewer, 'session:restored')

  await viewer.share.join(link.uri)
  await waitFor(() => joins.some((event) => event.status === 'joined'))
  t.is(restored.length, 0, 'the first bootstrap is the join, not a repaint')

  // The host renderer resizes on every switch back to the session's tab,
  // usually to the very same grid; the engine re-sends the screen each time.
  await host.resize(sessionId, 100, 30)
  await host.resize(sessionId, 100, 30)
  await host.resize(sessionId, 120, 40)
  await waitFor(() => restored.length >= 3)

  t.is(joins.filter((event) => event.status === 'joined').length, 1, 'joined exactly once')
  t.alike(
    restored.map((event) => event.sessionId),
    [sessionId, sessionId, sessionId],
    'each later bootstrap is a repaint of the joined session'
  )
  const remote = viewer.remoteSessions.get(sessionId)
  t.alike([remote.frame.cols, remote.frame.rows], [120, 40], 'at the new geometry')
})

test('a join the host user denies fails with reason denied and the host message', async (t) => {
  const { host, viewer, hostPty } = await pair(t)
  const sessionId = await liveSession(host, hostPty)
  const link = await host.share.createLink(sessionId, { type: 'group', autoJoin: false })
  const approvals = collect(host, 'share:approval-pending')
  const joins = collect(viewer, 'share:join-changed')

  await viewer.share.join(link.uri)
  await waitFor(() => approvals.length === 1)
  await waitFor(() => joins.some((event) => event.status === 'approval-pending'))
  host.share.denyJoin(sessionId, approvals[0].requestId)
  await waitFor(() => joins.some((event) => event.status === 'failed'))

  const failed = joins.find((event) => event.status === 'failed')
  t.alike(
    [failed.reason, failed.message, failed.linkId],
    [JOIN_REASONS.DENIED, 'Join request denied', link.linkId],
    'the reason and the message reach the viewer'
  )
  t.is(viewer.share.joins.size, 0, 'and the join state is gone')
})

test('a revoked link is refused with reason revoked', async (t) => {
  const { host, viewer, hostPty } = await pair(t)
  const sessionId = await liveSession(host, hostPty)
  const link = await host.share.createLink(sessionId, { type: 'group', autoJoin: true })
  await host.share.revokeLink(sessionId, link.linkId)
  const joins = collect(viewer, 'share:join-changed')

  const started = Date.now()
  await viewer.share.join(link.uri)
  await waitFor(() => joins.some((event) => event.status === 'failed'))
  const failed = joins.find((event) => event.status === 'failed')
  // The loopback keeps the host reachable after withdraw (D-16), so the host
  // itself answers; over Pear the route is gone and the viewer times out
  // with JOIN_REASONS.UNREACHABLE instead. Both name a reason.
  t.is(failed.reason, JOIN_REASONS.REVOKED, 'refused as revoked')
  t.ok(Date.now() - started < 5000, 'at once, not at the join timeout')
})

test('a link for a session that has ended is answered with reason ended, not a timeout', async (t) => {
  const { host, viewer, hostPty } = await pair(t)
  const sessionId = await liveSession(host, hostPty)
  const link = await host.share.createLink(sessionId, { type: 'group', autoJoin: true })
  const exits = collect(host, 'session:exit')
  hostPty.emit('exit', { sessionId, exit: { code: 0, signal: null } })
  await waitFor(() => exits.length === 1)
  const joins = collect(viewer, 'share:join-changed')

  const started = Date.now()
  await viewer.share.join(link.uri)
  await waitFor(() => joins.some((event) => event.status === 'failed'))
  const failed = joins.find((event) => event.status === 'failed')
  t.alike(
    [failed.reason, failed.message],
    [JOIN_REASONS.ENDED, 'This share is no longer active'],
    'the host answers on the channel the viewer opened'
  )
  t.ok(Date.now() - started < 5000, 'well before JOIN_TIMEOUT_MS')
  t.is(viewer.share.joins.size, 0, 'and no join state is left')
})

test('a requester that leaves while approval is pending cancels the prompt', async (t) => {
  const { host, viewer, hostPty } = await pair(t)
  const sessionId = await liveSession(host, hostPty)
  const link = await host.share.createLink(sessionId, { type: 'group', autoJoin: false })
  const approvals = collect(host, 'share:approval-pending')
  const cancelled = collect(host, 'share:approval-cancelled')

  await viewer.share.join(link.uri)
  await waitFor(() => approvals.length === 1)
  await viewer.share.close()
  await waitFor(() => cancelled.length === 1)
  t.alike(
    cancelled[0],
    { requestId: approvals[0].requestId, sessionId },
    'named by request, so the host UI can close that prompt'
  )
  await t.exception(
    () => host.share.approveJoin(sessionId, approvals[0].requestId),
    /no longer pending/,
    'and nothing is left to approve'
  )
})

test('session:exit says how long the command ran and what it was', async (t) => {
  const { host, hostPty } = await pair(t)
  const exits = collect(host, 'session:exit')
  const session = await host.createSession({
    name: 'broken',
    cols: 80,
    rows: 24,
    command: 'no-such-command --flag'
  })
  hostPty.push(session.sessionId, 'bash: no-such-command: command not found\r\n')
  hostPty.emit('exit', { sessionId: session.sessionId, exit: { code: 127, signal: null } })
  await waitFor(() => exits.length === 1)
  const [exit] = exits
  t.alike(
    [exit.sessionId, exit.exit, exit.command],
    [session.sessionId, { code: 127, signal: null }, 'no-such-command --flag'],
    'the exit, and the command that produced it'
  )
  t.ok(Number.isFinite(exit.uptimeMs) && exit.uptimeMs >= 0 && exit.uptimeMs < 5000, 'ran briefly')
})

test('a resync screen carries a capped scrollback, a join bootstrap the whole of it', async (t) => {
  const { host, hostPty } = await pair(t)
  const sessionId = await liveSession(host, hostPty)
  for (let i = 0; i < 1200; i++) hostPty.push(sessionId, `line ${i}\r\n`)
  const full = await host.buildLiveBootstrap(sessionId)
  const capped = await host.buildLiveBootstrap(sessionId, { scrollback: 100 })
  const lines = (frame) => frame.data.split('\r\n').length
  t.ok(lines(full) > 1100, `the join bootstrap has the whole scrollback (${lines(full)} lines)`)
  t.ok(lines(capped) <= 100 + 30 + 2, `the resync one is capped (${lines(capped)} lines)`)
  t.ok(capped.data.includes('line 1199'), 'and ends at the latest output')
  t.is(capped.scrollback, full.scrollback, 'while the frame still states the mirror capacity')
})

// A PTY host that runs nothing: output is pushed by the test, an exit is
// emitted by the test (or by kill()).
class FakeHost extends EventEmitter {
  constructor() {
    super()
    this.terminals = new Map()
  }

  spawn(sessionId, opts = {}) {
    const terminal = { sessionId, cols: opts.cols, rows: opts.rows, alive: true }
    this.terminals.set(sessionId, terminal)
    return {
      write: () => {},
      resize: (cols, rows) => {
        terminal.cols = cols
        terminal.rows = rows
      },
      pause: () => {},
      resume: () => {},
      kill: () => {
        if (!terminal.alive) return
        terminal.alive = false
        this.emit('exit', { sessionId, exit: { code: 0, signal: null } })
      }
    }
  }

  push(sessionId, data) {
    this.emit('data', { sessionId, data: Buffer.from(data, 'utf8') })
  }
}

async function pair(t) {
  const hub = new LoopbackHub()
  const hostPty = new FakeHost()
  const host = new SessionEngine({
    userData: await temp(t),
    ptyHost: hostPty,
    shareBackend: new LoopbackBackend({ hub, routeKey: 'loop' })
  })
  const viewer = new SessionEngine({
    userData: await temp(t),
    ptyHost: new FakeHost(),
    shareBackend: new LoopbackBackend({ hub, routeKey: 'loop' })
  })
  await host.ready()
  await viewer.ready()
  t.teardown(async () => {
    await viewer.close()
    await host.close()
  })
  return { hub, hostPty, host, viewer }
}

async function liveSession(host, hostPty) {
  const session = await host.createSession({ name: 'shared', cols: 100, rows: 30 })
  hostPty.push(session.sessionId, 'hello from the host\r\n')
  return session.sessionId
}

function collect(emitter, name) {
  const events = []
  emitter.on(name, (event) => events.push(event))
  return events
}

async function waitFor(fn, ms = 10000) {
  const until = Date.now() + ms
  while (!fn()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function temp(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-join-outcomes-'))
  // Retried: a store closed a moment ago can still be flushing a file.
  t.teardown(() =>
    fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  )
  return dir
}
