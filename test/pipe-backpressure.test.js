// Unit coverage for the two halves of the "viewer lags forever" regression
// (see test/pipe-backpressure-flood.test.js for the full seam reproduction):
//
//   1. The pipe threshold itself (engine/rpc/pipe.js): a single write must
//      not report backpressure just because it happens to be >= 16 KiB: only
//      a meaningful amount of buffered, undrained bytes should.
//   2. ShareManager's resync recovery (engine/share-manager.js): once a
//      send() reports the truth (false only under real backpressure), the
//      very next resync must clear `lagging` and reset the retry delay - not
//      keep escalating forever the way it did when *any* write over 16 KiB
//      looked like backpressure.
const { Duplex } = require('streamx')
const FramedStream = require('framed-stream')
const b4a = require('b4a')
const test = require('brittle')

const { PIPE_HIGH_WATER_MARK, tunePipe } = require('../engine/rpc/pipe')
const ShareManager = require('../engine/share-manager')
const registry = require('../engine/backends')
const { VIEW_LIVE } = require('../engine/caps')

// A raw duplex pair whose writes only ever complete when `drained()` lets
// them - real backpressure, the way the removed test/backend-seam.test.js's
// gate() did (K11 of zxterm-core),
// so `buffered` genuinely accumulates rather than being an artifact of one
// big write.
function gatedPair() {
  let held = null
  let other = null
  const a = new Duplex({
    write(data, cb) {
      if (held) held.push(() => (other.push(data), cb(null)))
      else (other.push(data), cb(null))
    }
  })
  other = new Duplex({
    write(data, cb) {
      a.push(data)
      cb(null)
    }
  })
  return {
    a,
    gate: () => (held = held || []),
    release: () => {
      const pending = held || []
      held = null
      for (const fn of pending) fn()
    }
  }
}

// --- 1. the pipe threshold --------------------------------------------------

test('pipe threshold: an idle, untuned pipe reports backpressure on one write >= 16 KiB', (t) => {
  // Two separate, otherwise-idle pipes: streamx only drains queued writes on
  // a later microtask, so writing twice on the *same* pipe without a tick in
  // between would count both writes' bytes together, which is not what
  // "alone" means here.
  const justUnder = new FramedStream(gatedPair().a).write(Buffer.alloc(16000))
  const justOver = new FramedStream(gatedPair().a).write(Buffer.alloc(24000))
  t.ok(justUnder, 'a write under 16 KiB is fine even untuned')
  t.absent(justOver, "a single ~24 KB write alone reports 'full' - this is the bug")
})

test('pipe threshold: tunePipe() lets a lone frame well under PIPE_HIGH_WATER_MARK through', (t) => {
  // A fresh pipe per write: streamx only drains queued writes on a later
  // microtask (see WritableState.updateNextTick), so two synchronous writes
  // on the *same* pipe would otherwise pile up against each other and no
  // longer be "one frame on an idle pipe" - each of these checks that in
  // isolation.
  // The largest single frame this seam carried in one piece (a Freenet
  // data-channel part, engine/backends/freenet/index.js::MAX_MESSAGE_SIZE,
  // until K11 of zxterm-core moved them to the zxterm-core seam) plus
  // envelope overhead, comfortably under the mark.
  t.ok(
    tunePipe(new FramedStream(gatedPair().a)).write(Buffer.alloc(65536 + 256)),
    'one 64 KiB-ish frame on an idle pipe: not "full"'
  )
  t.ok(
    tunePipe(new FramedStream(gatedPair().a)).write(Buffer.alloc(PIPE_HIGH_WATER_MARK - 1)),
    'even one frame just under the mark: still not "full"'
  )
})

test('pipe threshold: genuine backlog past PIPE_HIGH_WATER_MARK still reports backpressure, and drain still clears it', async (t) => {
  const { a, gate, release } = gatedPair()
  const pipe = tunePipe(new FramedStream(a))
  gate()
  let sawFalse = false
  const frame = Buffer.alloc(65536)
  let sent = 0
  while (sent < PIPE_HIGH_WATER_MARK + frame.byteLength) {
    if (pipe.write(frame) === false) sawFalse = true
    sent += frame.byteLength
  }
  t.ok(sawFalse, 'enough real, undrained backlog still trips it - the mark is not infinite')
  const drained = new Promise((resolve) => pipe.once('drain', resolve))
  release()
  await drained
  t.pass('drain still fires once the transport actually lets the backlog through')
})

// --- 2. ShareManager resync recovery ---------------------------------------

const { LAG_RESYNC_MS, LAG_RESYNC_MAX_MS, LAG_BACKLOG_BYTES } = ShareManager._test

function harness() {
  const sessionId = 's1'
  const runtime = {
    store: {
      sessionId,
      epoch: 1,
      keys: { liveKey: b4a.alloc(32, 9) },
      writerDeviceKey: b4a.alloc(32, 1)
    }
  }
  const engine = {
    sessions: new Map([[sessionId, runtime]]),
    // A resync bootstrap of a realistic size for a flooded screen + some
    // scrollback (RESYNC_SCROLLBACK/RESYNC_TAIL_BYTES in share-manager.js) -
    // squarely in the "bigger than the old 16 KiB default, smaller than
    // PIPE_HIGH_WATER_MARK" range that broke before the fix.
    buildLiveBootstrap: () => ({ seq: 1, cols: 100, rows: 30, data: 'x'.repeat(24000) })
  }
  const manager = new ShareManager(engine, {})
  manager.on('error', () => {})
  const peer = { conn: null, message: null, confirmed: true, linkId: 'l1', caps: VIEW_LIVE }
  const share = { sessionId, peers: new Set([peer]), liveSeq: 0 }
  manager.hostShares.set(sessionId, share)
  return { manager, share, peer }
}

// A fake channel shaped like the real seam once tuned: false only while more
// than `hwm` bytes worth of message is outstanding in one go - i.e. it
// reports the *size of the message itself* the way an untuned pipe did
// (`write()` false for any single write >= its highWaterMark). Good enough
// to show the ShareManager-level symptom without spinning up the real pipe.
function sizeGatedSend(hwm) {
  return (msg) => Buffer.byteLength(JSON.stringify(msg)) < hwm
}

test('resync recovery: a send() that is honest about capacity clears lagging on the first try', async (t) => {
  const { manager, share, peer } = harness()
  peer.lagging = true
  peer.lagDelay = LAG_RESYNC_MAX_MS
  peer.lagSkippedBytes = 12345
  peer.message = { send: sizeGatedSend(PIPE_HIGH_WATER_MARK) }

  await manager._resyncPeer(share, peer)

  t.absent(peer.lagging, 'lagging clears once the resync actually gets through')
  t.is(peer.lagSkippedBytes, 0)
  t.is(peer.lagDelay, LAG_RESYNC_MS, 'the delay resets, it does not stay escalated')
})

test('resync recovery: a resync over a 16 KiB socket still resumes live data', async (t) => {
  const { manager, share, peer } = harness()
  peer.lagging = true
  peer.lagDelay = LAG_RESYNC_MS
  // A Pear socket: `send` reports backpressure for any message of 16 KiB or
  // more, which every resync here is (24 000 bytes of screen). The screen is
  // still delivered, so live data resumes after it.
  peer.message = { send: sizeGatedSend(16384) }

  await manager._resyncPeer(share, peer)

  t.absent(peer.lagging, 'live data resumes after the screen')
  t.absent(peer.lagTimer, 'no next resync is scheduled')
  t.is(peer.lagDelay, LAG_RESYNC_MS * 2, 'the next lag, if one comes, waits longer')
  t.ok(peer.backlogBytes > 0, 'the screen counts towards the next lag')
})

test('resync recovery: a link with no room lags again only after a real backlog, backing off, capped', async (t) => {
  const { manager, share, peer } = harness()
  peer.lagging = true
  peer.lagDelay = LAG_RESYNC_MS
  peer.message = { send: () => false } // genuinely never has room

  const delays = []
  for (let i = 0; i < 5; i++) {
    await manager._resyncPeer(share, peer)
    t.absent(peer.lagging, 'each resync resumes live data')
    let sent = 0
    while (!peer.lagging) {
      manager.broadcastData(share.sessionId, Buffer.alloc(16 * 1024))
      sent += 16 * 1024
    }
    t.ok(sent >= LAG_BACKLOG_BYTES - 64 * 1024, 'it lags again only once the backlog is real')
    delays.push(peer.lagDelay)
    clearTimeout(peer.lagTimer)
    peer.lagTimer = null
  }

  t.alike(
    delays,
    [1000, 2000, 4000, 8000, 8000],
    'the wait doubles each time and caps at LAG_RESYNC_MAX_MS - never an unbounded queue'
  )
})

test('live data: advisory backpressure on a busy socket does not drop the viewer to screens', (t) => {
  const { manager, share, peer } = harness()
  const delivered = []
  // The socket also carries the session's history replication, so `send`
  // keeps saying "full" while the backlog is small; every message is still
  // delivered.
  peer.message = {
    send: (message) => {
      delivered.push(message)
      return false
    }
  }

  for (let i = 0; i < 200; i++) manager.broadcastData(share.sessionId, Buffer.alloc(1024))

  t.absent(peer.lagging, '200 KiB of live data with "full" answers: still live')
  t.is(delivered.length, 200, 'every chunk went to the viewer')
  t.absent(peer.lagTimer)

  peer.message.send = (message) => {
    delivered.push(message)
    return true
  }
  manager.broadcastData(share.sessionId, Buffer.alloc(1024))
  t.is(peer.backlogBytes, 0, 'a clean send resets the backlog')
})

test('sanity: PIPE_HIGH_WATER_MARK is well above a Freenet data-channel part', (t) => {
  const { MAX_MESSAGE_SIZE } = require('../engine/backends/freenet')
  t.is(MAX_MESSAGE_SIZE, 65536, 'a Freenet data-channel part is at most 64 KiB')
  t.ok(PIPE_HIGH_WATER_MARK > MAX_MESSAGE_SIZE * 4, 'plenty of headroom for one part plus envelope')
  t.ok(registry, 'the backends registry loads')
})
