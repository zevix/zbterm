// 261125_speed-and-keys P3 (design Interface bullet 3, F4, Q-2): the lazy
// open and the sliced `session.timeline` read.
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('brittle')

require('./helpers/zxterm-core')

const SessionEngine = require('../engine')
const PtyHost = require('../electron/pty-host')

test('a lazy open carries the timeline length, and session.timeline reads it in slices', async (t) => {
  const dir = await temp()
  const engine = new SessionEngine({ userData: dir, ptyHost: new PtyHost() })
  await engine.ready()

  try {
    const created = await engine.invoke('session.create', { name: 'slices', cols: 80, rows: 24 })
    const sessionId = created.sessionId
    // Every resize is a recorded packet with its own timeline entry.
    for (let i = 0; i < 12; i++) {
      await engine.invoke('session.resize', { sessionId, cols: 80 + i, rows: 24 })
    }
    const full = await engine.invoke('session.open', { sessionId, frame: false })
    t.ok(Array.isArray(full.timeline), 'without the option the timeline rides on the open (Q-2)')
    t.ok(full.timeline.length >= 12, `${full.timeline.length} entries`)

    const lazy = await engine.invoke('session.open', { sessionId, frame: false, timeline: 'lazy' })
    t.absent('timeline' in lazy, 'a lazy open has no timeline')
    t.ok(lazy.timelineLength >= full.timeline.length, 'it names the timeline length')
    t.is(lazy.length, full.length)

    // Slices of 5 put back together are the engine's timeline.
    const timeline = engine.sessions.get(sessionId).store.timeline
    const got = []
    let length = Infinity
    while (got.length < length) {
      const last = got.length ? got[got.length - 1] : null
      const slice = await engine.invoke('session.timeline', {
        sessionId,
        from: got.length,
        limit: 5,
        lastTsMs: last ? last.tsMs : undefined,
        lastSeq: last ? last.seq : undefined
      })
      t.is(slice.reset, false)
      t.is(slice.from, got.length)
      t.ok(slice.entries.length <= 5)
      got.push(...slice.entries)
      length = slice.length
    }
    t.alike(got, timeline.slice(0, got.length), 'the slices are the timeline, in order')
    t.is(got.length, timeline.length)

    // F4: the caller's last entry is not the engine's at from - 1.
    const wrongTs = await engine.invoke('session.timeline', {
      sessionId,
      from: 4,
      limit: 3,
      lastTsMs: timeline[3].tsMs - 1
    })
    t.is(wrongTs.reset, true, 'a different last tsMs resets')
    t.is(wrongTs.from, 0)
    t.alike(wrongTs.entries, timeline.slice(0, 3))
    const past = await engine.invoke('session.timeline', {
      sessionId,
      from: timeline.length + 5,
      lastTsMs: timeline[timeline.length - 1].tsMs
    })
    t.is(past.reset, true, 'a from past the engine length resets (the timeline was cleared)')
    const atEnd = await engine.invoke('session.timeline', {
      sessionId,
      from: timeline.length,
      lastTsMs: timeline[timeline.length - 1].tsMs
    })
    t.is(atEnd.reset, false)
    t.is(atEnd.entries.length, 0, 'a cache that is complete gets nothing')

    // A cleared timeline regrown past the cached length (F4).
    const cachedLength = timeline.length
    const cachedLast = timeline[cachedLength - 1]
    await engine.invoke('session.clearCaches', { sessionId })
    for (let i = 0; i < cachedLength + 3; i++) {
      await engine.invoke('session.resize', { sessionId, cols: 100 + (i % 20), rows: 24 })
    }
    const regrown = await engine.invoke('session.timeline', {
      sessionId,
      from: cachedLength,
      lastTsMs: cachedLast.tsMs,
      lastSeq: cachedLast.seq
    })
    t.is(regrown.reset, true, 'regrown past the cached length: reset')
    t.is(regrown.from, 0)
    t.alike(regrown.entries, engine.sessions.get(sessionId).store.timeline.slice(0, 10000))

    // Ended: the player's lazy open, then slices with the player open and
    // with no store held at all.
    await engine.invoke('session.close', { sessionId })
    await waitFor(() => !engine.sessions.has(sessionId))
    const player = await engine.invoke('player.open', { sessionId, timeline: 'lazy' })
    t.absent('timeline' in player, 'a lazy player.open has no timeline')
    t.ok(player.frame, 'the frame is there')
    const plain = await engine.invoke('player.open', { sessionId })
    t.is(player.timelineLength, plain.timeline.length)
    const fromPlayer = await engine.invoke('session.timeline', { sessionId, from: 0, limit: 50000 })
    t.alike(fromPlayer.entries, plain.timeline)
    await engine._closePlayerNow(sessionId)
    t.absent(engine.players.has(sessionId))
    const unheld = await engine.invoke('session.timeline', { sessionId, from: 0, limit: 50000 })
    t.alike(unheld.entries, plain.timeline, 'read from the store when nothing holds it')
    t.is(unheld.length, plain.timeline.length)

    await t.exception(
      engine.invoke('session.timeline', { sessionId: 'no-such-session', from: 0 }),
      /not found/i
    )
  } finally {
    await engine.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

async function waitFor(fn) {
  const started = Date.now()
  while (Date.now() - started < 5000) {
    const result = await fn()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for condition')
}

function temp() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-engine-timeline-test-'))
}
