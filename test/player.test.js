const test = require('brittle')
const { PacketKind } = require('../engine/schema')
const {
  Player,
  coalescePackets,
  seqForTime,
  scanAltScreenRanges,
  createAltScreenScanner
} = require('../engine/player')

test('timeline seq lookup handles boundaries', (t) => {
  const timeline = [
    { seq: 1, tsMs: 100 },
    { seq: 2, tsMs: 200 },
    { seq: 3, tsMs: 300 }
  ]
  t.is(seqForTime(timeline, 0), 0)
  t.is(seqForTime(timeline, 100), 1)
  t.is(seqForTime(timeline, 250), 2)
  t.is(seqForTime(timeline, 999), 3)
})

test('playback coalesces adjacent data without crossing resizes', (t) => {
  const packets = coalescePackets([
    dataPacket(1, 'hello '),
    dataPacket(2, 'world'),
    {
      seq: 3,
      tsMs: 30,
      kind: PacketKind.RESIZE,
      cols: 120,
      rows: 40,
      payload: Buffer.alloc(0)
    },
    dataPacket(4, 'after')
  ])

  t.is(packets.length, 3)
  t.is(packets[0].seq, 2)
  t.is(packets[0].payload.toString('utf8'), 'hello world')
  t.is(packets[1].kind, PacketKind.RESIZE)
  t.is(packets[2].seq, 4)
  t.is(packets[2].payload.toString('utf8'), 'after')
})

test('playback coalescing preserves hd boundaries', (t) => {
  const packets = coalescePackets([
    dataPacket(1, 'normal-a'),
    dataPacket(2, 'normal-b'),
    dataPacket(3, 'hd-a', true),
    dataPacket(4, 'hd-b', true),
    dataPacket(5, 'normal-c')
  ])

  t.is(packets.length, 3)
  t.is(packets[0].payload.toString('utf8'), 'normal-anormal-b')
  t.is(packets[0].hd, false)
  t.is(packets[1].payload.toString('utf8'), 'hd-ahd-b')
  t.is(packets[1].hd, true)
  t.is(packets[2].payload.toString('utf8'), 'normal-c')
  t.is(packets[2].hd, false)
})

test('local player ignores stale playbackLength while session keeps recording', async (t) => {
  const store = {
    remote: false,
    playbackLength: 1,
    log: { length: 3 },
    info: { cols: 80, rows: 24 },
    timeline: [
      { seq: 1, tsMs: 100, hd: false },
      { seq: 2, tsMs: 200, hd: false },
      { seq: 3, tsMs: 210, hd: false }
    ],
    async *readRange(from, to) {
      for (let seq = from; seq <= to; seq++) yield dataPacket(seq, `p${seq}`)
    }
  }
  const player = new Player(store, null)
  await player.seek(200)

  const packet = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed playback did not advance')), 200)
    player.once('player:data', (data) => {
      clearTimeout(timer)
      resolve(data)
    })
    player.once('player:end', () => {
      clearTimeout(timer)
      reject(new Error('timed playback ended at stale playbackLength'))
    })
    player.play(1)
  })

  t.is(packet.seq, 3)
  t.is(packet.payload.toString('utf8'), 'p3')
})

test('remote player clamps seeks to downloaded playback length', async (t) => {
  const store = {
    remote: true,
    playbackLength: 2,
    log: { length: 10 },
    info: { cols: 80, rows: 24 },
    timeline: [
      { seq: 1, tsMs: 100, hd: false },
      { seq: 2, tsMs: 200, hd: false },
      { seq: 10, tsMs: 1000, hd: false }
    ],
    async *readRange(from, to) {
      t.ok(to <= 2, 'remote playback never reads past downloaded length')
      for (let seq = from; seq <= to; seq++) yield dataPacket(seq, `p${seq}`)
    }
  }
  const player = new Player(store, null)
  const frame = await player.seek(1000)

  t.is(player.seq, 2)
  t.is(frame.seq, 2)
})

// Bug 3 (scrolling back through history on a joined session left the
// listener's worker restarting): `playbackLength` is supposed to be the
// downloaded length (test above), but a remote store's real readRange
// (session-store.js) still honours whatever `to` it is given - if
// `playbackLength` is ever stale or overoptimistic (e.g. its own fallback,
// `_remoteAvailableLength`'s `.catch()` in engine/index.js, uses the core's
// announced total length rather than what has actually landed), a seek can
// ask for content that has not replicated. Before this fix, that meant an
// unbounded `await` inside readRange - hypercore's `get(seq, { wait: true })`
// waits forever for a block that may never arrive (peer gone, stream
// stalled) - which nothing above it ever cancels except engine/client.js's
// 60 s invoke timeout, which kills and respawns the *entire* worker over
// one stuck scrollback read. This store's fake readRange mirrors that real
// hang (an await that never resolves) whenever it is asked to wait for
// content past what it actually has, so this test times out if buildFrame
// ever goes back to unconditionally waiting.
function goneMidDownloadStore({ have = 2, total = 10 } = {}) {
  const timeline = []
  for (let seq = 1; seq <= total; seq++) timeline.push({ seq, tsMs: seq * 100, hd: false })
  return {
    remote: true,
    // Deliberately larger than `have`: a stale/overoptimistic playbackLength,
    // exactly what must not be trusted to mean "safe to wait for". `have` is
    // a plain mutable property (not a captured constant) so a test can grow
    // it mid-way to simulate more of the recording landing.
    have,
    playbackLength: total,
    log: { length: total },
    info: { cols: 80, rows: 24 },
    timeline,
    async *readRange(from, to, opts = {}) {
      for (let seq = from; seq <= to; seq++) {
        if (seq > this.have) {
          if (opts.wait === false) return // what the fix asks for: stop, do not wait
          await new Promise(() => {}) // the pre-fix hang: a block that never arrives
        }
        yield dataPacket(seq, `p${seq}`)
      }
    }
  }
}

async function withinMs(ms, promise, what) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: did not resolve within ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

test('a seek past what a remote store has downloaded does not hang (bug 3)', async (t) => {
  const store = goneMidDownloadStore({ have: 2, total: 10 })
  const player = new Player(store, null)
  // seq 5's timeline entry exists (the scrubber/timeline sync knows about it
  // - engine/share-manager.js broadcastTimeline is metadata-only), but its
  // bytes have not landed: exactly the gap playbackLength is meant to guard,
  // and must still not hang if that guard is ever wrong.
  const frame = await withinMs(500, player.seek(500), 'seek to undownloaded content')
  t.ok(frame, 'seek resolved instead of hanging')
  t.ok(frame.data.includes('p2'), 'the frame reflects what actually replayed')
  t.absent(frame.data.includes('p3'), 'nothing past what was available was replayed')
})

test('a fit-mode (viewport) replay past what a remote store has downloaded does not hang, and does not skip the gap once it lands', async (t) => {
  const store = goneMidDownloadStore({ have: 2, total: 10 })
  const player = new Player(store, null)
  player.setViewport({ cols: 80, rows: 24 })

  const first = await withinMs(500, player.buildFrame(10, 1000), 'fit-mode build past download')
  t.ok(first, 'buildFrame resolved instead of hanging')
  t.ok(first.data.includes('p2'), 'reflects what actually replayed')

  // More has landed since: the cached replay position must resume exactly
  // where it actually left off (seq 2), not from the `targetSeq` (10) the
  // earlier, incomplete call was asked for - or the gap between them would
  // be silently skipped forever.
  store.have = 10
  const seen = []
  const originalReadRange = store.readRange
  store.readRange = async function* (from, to, opts) {
    seen.push([from, to])
    yield* originalReadRange.call(store, from, to, opts)
  }
  const second = await withinMs(
    500,
    player.buildFrame(4, 400),
    'fit-mode build after more downloaded'
  )
  t.alike(
    seen[0],
    [3, 4],
    'resumed from seq 3 (last actually replayed + 1), not from the stale target'
  )
  t.ok(
    second.data.includes('p3') && second.data.includes('p4'),
    'the previously-missing gap is now in'
  )
})

test("a viewport re-renders history at the caller's geometry, not the recording's", async (t) => {
  const store = wideStore()
  const player = new Player(store, null)

  const trueToRecording = await player.buildFrame(3, 300)
  t.is(trueToRecording.cols, 200, "the default is still the recording's width")
  t.is(trueToRecording.view, undefined, 'a true-to-recording frame carries no view')

  t.alike(player.setViewport({ cols: 80, rows: 24 }), { cols: 80, rows: 24 })
  const fitted = await player.buildFrame(3, 300)
  t.is(fitted.cols, 80)
  t.is(fitted.rows, 24)
  t.alike(fitted.view, { cols: 80, rows: 24 }, 'the frame says what it was rendered at')
  t.ok(fitted.data.includes('#2'), 'the last line is still there after re-wrapping')

  t.is(player.setViewport(null), null, 'clearing goes back to true-to-recording')
  const restored = await player.buildFrame(3, 300)
  t.is(restored.cols, 200)
  player.dispose()
})

test("a viewport ignores the recording's own RESIZE packets", async (t) => {
  const store = wideStore()
  const player = new Player(store, null)
  player.setViewport({ cols: 80, rows: 24 })

  // seq 4 is a RESIZE to 300x70; in fit mode it must not snap the render back.
  const frame = await player.buildFrame(4, 400)
  t.is(frame.cols, 80, "RESIZE did not override the caller's geometry")
  t.is(frame.rows, 24)

  const plain = new Player(store, null)
  const applied = await plain.buildFrame(4, 400)
  t.is(applied.cols, 300, 'true-to-recording still applies RESIZE')
  t.is(applied.rows, 70)
  player.dispose()
  plain.dispose()
})

test('a fit-mode frame does not drift: advancing forward matches a fresh build', async (t) => {
  const store = wideStore()

  const advanced = new Player(store, null)
  advanced.setViewport({ cols: 80, rows: 24 })
  await advanced.buildFrame(1, 100)
  await advanced.buildFrame(2, 200)
  const streamed = await advanced.buildFrame(5, 500)

  const direct = new Player(store, null)
  direct.setViewport({ cols: 80, rows: 24 })
  const seeked = await direct.buildFrame(5, 500)

  t.is(streamed.data, seeked.data, 'incremental replay is byte-identical to a direct rebuild')
  t.is(streamed.seq, seeked.seq)

  // Seeking backwards throws the held terminal away rather than reusing it.
  const back = await advanced.buildFrame(2, 200)
  const fresh = new Player(store, null)
  fresh.setViewport({ cols: 80, rows: 24 })
  t.is(back.data, (await fresh.buildFrame(2, 200)).data, 'a backwards seek rebuilds cleanly')

  advanced.dispose()
  direct.dispose()
  fresh.dispose()
})

test('alternate-screen ranges are scanned out of the packet stream', async (t) => {
  const packets = [
    dataPacket(1, 'shell prompt'),
    dataPacket(2, '\x1b[?10'),
    dataPacket(3, '49h htop starts'),
    dataPacket(4, 'painting rows'),
    dataPacket(5, '\x1b[?1049l back to the shell'),
    dataPacket(6, 'more shell')
  ]
  const summary = await scanAltScreenRanges(iterate(packets))
  t.is(summary.used, true)
  t.alike(summary.ranges, [{ fromSeq: 3, fromTsMs: 30, toSeq: 5, toTsMs: 50 }])

  // The escape was split across packets 2 and 3 - a per-packet regex would
  // have missed exactly the moment a TUI starts.
  const perPacket = packets.some((p) => /\x1b\[\?1049h/.test(p.payload.toString('utf8')))
  t.is(perPacket, false, 'no single packet contains the whole sequence')
})

test('alternate-screen scanning ignores unrelated DEC private modes', async (t) => {
  const summary = await scanAltScreenRanges(
    iterate([dataPacket(1, '\x1b[?25l\x1b[?1000h\x1b[?2004h ordinary output')])
  )
  t.is(summary.used, false)
  t.alike(summary.ranges, [])
})

test('an unterminated alternate screen leaves an open range', async (t) => {
  const summary = await scanAltScreenRanges(
    iterate([dataPacket(1, 'x'), dataPacket(2, '\x1b[?47h'), dataPacket(3, 'tui')])
  )
  t.alike(summary.ranges, [{ fromSeq: 2, fromTsMs: 20, toSeq: null, toTsMs: null }])
})

test('the alternate-screen scanner tracks state across chunks', (t) => {
  const scanner = createAltScreenScanner()
  t.is(scanner.feed(Buffer.from('plain')), null, 'ordinary output changes nothing')
  t.is(scanner.feed(Buffer.from('\x1b[?1047')), null, 'an incomplete sequence decides nothing')
  t.is(scanner.feed(Buffer.from('h')), true, 'the final byte in the next chunk enters')
  t.is(scanner.active, true)
  t.is(scanner.feed(Buffer.from('\x1b[?1047h')), null, 'entering twice is not a change')
  t.is(scanner.feed(Buffer.from('\x1b[?1047l')), false, 'and the matching reset exits')
  t.is(scanner.active, false)
})

async function* iterate(packets) {
  for (const packet of packets) yield packet
}

// 200x50 line-oriented output, plus a RESIZE to 300x70 at seq 4.
function wideStore() {
  const packets = []
  for (let seq = 1; seq <= 3; seq++) {
    packets.push(dataPacket(seq, 'W'.repeat(150) + `#${seq - 1}\r\n`))
  }
  packets.push({
    seq: 4,
    tsMs: 40,
    kind: PacketKind.RESIZE,
    cols: 300,
    rows: 70,
    payload: Buffer.alloc(0),
    hd: false
  })
  packets.push(dataPacket(5, 'after the resize\r\n'))
  return {
    remote: false,
    log: { length: packets.length },
    info: { cols: 200, rows: 50 },
    timeline: packets.map((p) => ({ seq: p.seq, tsMs: p.tsMs, hd: false })),
    async *readRange(from, to) {
      for (const packet of packets) {
        if (packet.seq >= from && packet.seq <= to) yield packet
      }
    }
  }
}

function dataPacket(seq, value, hd = false) {
  return {
    seq,
    tsMs: seq * 10,
    kind: PacketKind.DATA,
    cols: null,
    rows: null,
    payload: Buffer.from(value),
    hd
  }
}
