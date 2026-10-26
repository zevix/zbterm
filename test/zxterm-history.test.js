// The two halves of engine/zxterm/history.js against a scripted core: the
// host's HostHistory (what it asks of `history.*`, in what order, and what it
// never asks twice) and the viewer's CoreHistoryHandle (live range, contract
// fallback, what it refuses). The real sidecar, end to end, is
// test/freenet-history.test.js.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const test = require('brittle')

const { HostHistory, CoreHistoryHandle, packetToCore } = require('../engine/zxterm/history')
const { PacketKind } = require('../engine/schema')
const { CODES, EngineError } = require('../engine/errors')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function scratch(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-zh-'))
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  return dir
}

function plain(seq, text = `p${seq}`, tsMs = seq * 10) {
  return {
    seq,
    tsMs,
    kind: PacketKind.DATA,
    cols: null,
    rows: null,
    payload: Buffer.from(text),
    hd: false
  }
}

// A store as HostHistory reads it: a directory, a log of `packets`, the epochs'
// keys.
async function hostStore(t, packets, { epoch = 2 } = {}) {
  const dir = await scratch(t)
  const store = {
    dir,
    sessionId: 'a'.repeat(64),
    epoch,
    info: { cols: 80, rows: 24 },
    localDevice: { secretKey: Buffer.alloc(64, 3) },
    log: { length: packets.length },
    onAppend: null,
    _loadLocalEpochKeys: (e) => Promise.resolve({ historyKey: Buffer.alloc(32, e) }),
    async *readRange(from, to) {
      for (let seq = from; seq <= Math.min(to, store.log.length); seq++) yield packets[seq - 1]
    }
  }
  return store
}

// `history.*` answered like the core: `nextSeq` follows what is appended.
function scriptedCore(initial = 1) {
  const calls = []
  let next = initial
  const request = (method, args) => {
    calls.push({ method, args })
    if (method === 'history.import') {
      next = initial + args.packets.length
      return Promise.resolve({ segments: 1, nextSeq: next })
    }
    if (method === 'history.open') return Promise.resolve({ segments: 0, nextSeq: next })
    if (method === 'history.append') {
      const firstSeq = next
      next += args.packets.length
      return Promise.resolve({ firstSeq, nextSeq: next })
    }
    if (method === 'history.head') return Promise.resolve({ verifyingKey: 'ab'.repeat(32) })
    return Promise.resolve(null)
  }
  return { request, calls, setNext: (n) => (next = n) }
}

const names = (calls) => calls.map((c) => c.method)

test('host history: a recording is imported once, in the first batch, at its Hypercore positions', async (t) => {
  const packets = Array.from({ length: 12 }, (_, i) => plain(i + 1, 'x'.repeat(1024 * 1024)))
  const store = await hostStore(t, packets)
  const core = scriptedCore()
  const history = new HostHistory({ request: core.request, store, sessionId: store.sessionId })
  await history.open()
  const imported = core.calls.filter((c) => c.method === 'history.import')
  t.is(imported.length, 1, 'one import')
  t.is(imported[0].args.firstSeq, 1, 'at the first position of the log')
  t.is(imported[0].args.epoch, 2, 'under the current epoch')
  t.is(
    imported[0].args.historyKey,
    Buffer.alloc(32, 2).toString('hex'),
    "and that epoch's history key"
  )
  t.alike(Object.keys(imported[0].args.epochKeys), ['1', '2'], 'with every epoch the store holds')
  t.ok(imported[0].args.packets.length < packets.length, 'a long log is cut: the rest is appended')
  const appended = core.calls
    .filter((c) => c.method === 'history.append')
    .reduce((n, c) => n + c.args.packets.length, 0)
  t.is(
    imported[0].args.packets.length + appended,
    packets.length,
    'every packet reaches the core once'
  )
  t.alike(
    names(core.calls).slice(-2),
    ['history.head', 'history.publish'],
    'then the key is read and publishing starts'
  )
  // The seam drops a connection that sends a frame above 8 MiB
  // (`MAX_FRAME_BYTES`): every batch, in JSON, stays well under it.
  for (const call of core.calls) {
    t.ok(JSON.stringify(call.args).length < 8 * 1024 * 1024, `${call.method} fits one seam frame`)
  }
  t.is(history.verifyingKey, 'ab'.repeat(32))
  t.is(
    store.historyVerifyingKey,
    'ab'.repeat(32),
    'the store knows the key that finds the contract'
  )
  const state = JSON.parse(fs.readFileSync(path.join(store.dir, 'zxhistory', 'state.json'), 'utf8'))
  t.is(state.imported, true, 'and the flag is written')
  t.is(state.signingSeed.length, 64)
  await history.close()
})

test('host history: an existing core history is opened, never imported again, and only the gap is appended', async (t) => {
  const packets = Array.from({ length: 8 }, (_, i) => plain(i + 1))
  const store = await hostStore(t, packets)
  const dir = path.join(store.dir, 'zxhistory')
  await fs.promises.mkdir(path.join(dir, 'segments'), { recursive: true })
  await fs.promises.writeFile(path.join(dir, 'segments', 'segments.zxs'), '')
  await fs.promises.writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({ signingSeed: 'cd'.repeat(32), imported: false })
  )
  const core = scriptedCore(6)
  core.setNext(6)
  const history = new HostHistory({ request: core.request, store, sessionId: store.sessionId })
  await history.open()
  t.absent(names(core.calls).includes('history.import'), 'no import')
  t.is(core.calls[0].method, 'history.open')
  t.is(
    core.calls[0].args.signingKey,
    'cd'.repeat(32),
    'the history is opened with the key it was made with'
  )
  t.absent(core.calls[0].args.create, 'as an existing one')
  const appended = core.calls.filter((c) => c.method === 'history.append')
  t.is(appended.length, 1)
  t.alike(
    appended[0].args.packets.map((p) => p.payload),
    [packets[5], packets[6], packets[7]].map((p) => packetToCore(p).payload),
    'packets 6 to 8, which the core lacked'
  )
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
  t.is(state.imported, true, 'the flag a crash left unwritten is written')
  await history.close()
})

test('host history: a session with nothing recorded creates an empty history', async (t) => {
  const store = await hostStore(t, [])
  const core = scriptedCore()
  const history = new HostHistory({ request: core.request, store, sessionId: store.sessionId })
  await history.open()
  t.is(core.calls[0].method, 'history.open')
  t.is(core.calls[0].args.create, true)
  t.is(core.calls[0].args.firstSeq, 1)
  await history.close()
})

test('host history: what the store appends follows in order, a gap is read back, an epoch waits its turn', async (t) => {
  const packets = [plain(1), plain(2)]
  const store = await hostStore(t, packets)
  const core = scriptedCore()
  const history = new HostHistory({ request: core.request, store, sessionId: store.sessionId })
  await history.open()
  core.calls.length = 0

  packets.push(plain(3), plain(4))
  store.log.length = 4
  store.onAppend(3, packets[2])
  store.onAppend(4, packets[3])
  history.setEpoch(3, 'ee'.repeat(32))
  packets.push(plain(5))
  store.log.length = 5
  store.onAppend(5, packets[4])
  await delay(50)
  t.alike(
    names(core.calls),
    ['history.append', 'history.setEpoch', 'history.append'],
    'the packets before an epoch go before it, the ones after go after'
  )
  t.alike(
    core.calls[0].args.packets.map((p) => p.payload),
    [packets[2], packets[3]].map((p) => packetToCore(p).payload)
  )
  t.is(core.calls[1].args.epoch, 3)
  t.is(core.calls[1].args.key, 'ee'.repeat(32))

  // A packet the core was never told of: the store is read for the gap.
  core.calls.length = 0
  packets.push(plain(6), plain(7), plain(8))
  store.log.length = 8
  store.onAppend(8, packets[7])
  await delay(50)
  const sent = core.calls
    .filter((c) => c.method === 'history.append')
    .flatMap((c) => c.args.packets.map((p) => Buffer.from(p.payload, 'base64').toString()))
  t.alike(sent, ['p6', 'p7', 'p8'], 'the gap, then the packet')

  // One the core already holds is not sent twice.
  core.calls.length = 0
  store.onAppend(8, packets[7])
  await delay(30)
  t.absent(names(core.calls).includes('history.append'), 'a repeat is dropped')
  await history.close()
})

test('host history: a quiet host closes its segment, and close flushes before the core drops the history', async (t) => {
  const store = await hostStore(t, [plain(1)])
  const core = scriptedCore()
  const history = new HostHistory({ request: core.request, store, sessionId: store.sessionId })
  await history.open()
  core.calls.length = 0
  store.log.length = 2
  store.onAppend(2, plain(2))
  await delay(2400)
  t.alike(
    names(core.calls),
    ['history.append', 'history.flush'],
    'the open segment is closed once output stops'
  )
  core.calls.length = 0
  await history.close()
  t.alike(names(core.calls), ['history.flush', 'history.close'], 'closing flushes, then closes')
  t.is(store.onAppend, null, 'and the store no longer feeds it')
})

test('host history: a history a former run left open is closed and opened again', async (t) => {
  const store = await hostStore(t, [])
  const calls = []
  let first = true
  const request = (method, args) => {
    calls.push(method)
    if (method === 'history.open' && first) {
      first = false
      return Promise.reject(new EngineError(CODES.E_INTERNAL, 'history is already open'))
    }
    if (method === 'history.open') return Promise.resolve({ nextSeq: 1 })
    if (method === 'history.head') return Promise.resolve({ verifyingKey: 'ab'.repeat(32) })
    return Promise.resolve(null)
  }
  const history = new HostHistory({ request, store, sessionId: store.sessionId })
  await history.open()
  t.alike(calls.slice(0, 3), ['history.open', 'history.close', 'history.open'])
  await history.close()
})

// --- the viewer -------------------------------------------------------------

function viewerStore(initial = 0) {
  const held = []
  for (let seq = 1; seq <= initial; seq++) held.push(seq)
  return {
    sessionId: 'b'.repeat(64),
    historyInfoReady: true,
    historyVerifyingKey: 'ab'.repeat(32),
    held,
    historyKeysHex: () => ({ 1: '11'.repeat(32) }),
    availableLength: () => Promise.resolve(held.length),
    appendVerified(packets) {
      for (const p of packets) held.push(p.seq)
      return Promise.resolve(held.length)
    }
  }
}

function corePacket(seq) {
  return { seq, tsMs: seq, kind: 0, hd: false, payload: Buffer.from(`p${seq}`).toString('base64') }
}

function scriptedBridge(script) {
  const bridge = new EventEmitter()
  bridge.calls = []
  bridge.request = (method, args) => {
    bridge.calls.push({ method, args })
    return script(method, args, bridge)
  }
  return bridge
}

test('viewer history: a range is asked of the host, verified segment by segment, and stored', async (t) => {
  const store = viewerStore()
  const bridge = scriptedBridge((method, args, b) => {
    if (method === 'share.history') {
      // Events may beat the reply.
      b.emit('historySegment', { sessionId: store.sessionId, requestId: 7, start: 1, data: 'QQ==' })
      b.emit('historySegment', { sessionId: store.sessionId, requestId: 7, start: 3, data: 'Qg==' })
      b.emit('historyDone', { sessionId: store.sessionId, requestId: 7, next: 5 })
      return Promise.resolve({ requestId: 7 })
    }
    if (method === 'history.verify') {
      return Promise.resolve(
        args.data === 'QQ=='
          ? { index: 0, packets: [corePacket(1), corePacket(2)] }
          : { index: 1, packets: [corePacket(3), corePacket(4)] }
      )
    }
    return Promise.resolve(null)
  })
  const handle = new CoreHistoryHandle({ core: bridge, store, keys: {}, live: () => true })
  await handle.fetch({ start: 0, end: 4 }).done()
  t.alike(store.held, [1, 2, 3, 4], 'the packets are in the store, in order')
  const verify = bridge.calls.filter((c) => c.method === 'history.verify')
  t.is(verify.length, 2)
  t.is(verify[0].args.verifyingKey, 'ab'.repeat(32), "against the host's signing key")
  t.alike(verify[0].args.epochKeys, { 1: '11'.repeat(32) }, 'under the epoch keys the device holds')
  t.is(
    bridge.calls.filter((c) => c.method === 'share.historyCredit').length,
    2,
    'each segment gives the host its credit back'
  )
  const done = bridge.calls.find((c) => c.method === 'history.verifyDone')
  t.alike([done.args.start, done.args.next], [1, 5], 'and the request ends with what the host said')
  const asked = bridge.calls.find((c) => c.method === 'share.history')
  t.alike([asked.args.start, asked.args.end], [1, 5], 'packets 1 to 4 are sequence numbers [1, 5)')
  handle.close()
})

test('viewer history: with no connection the contract is read instead, and only what continues the store is kept', async (t) => {
  const store = viewerStore(2)
  const bridge = scriptedBridge((method) => {
    if (method === 'history.readContract') {
      return Promise.resolve({
        headLength: 2,
        segments: [
          { index: 0, firstSeq: 1, packets: [corePacket(1), corePacket(2)] },
          { index: 1, firstSeq: 3, packets: [corePacket(3), corePacket(4)] }
        ]
      })
    }
    return Promise.resolve(null)
  })
  const handle = new CoreHistoryHandle({ core: bridge, store, keys: {}, live: () => false })
  await handle.pull(Infinity, { destroyed: false }, { poll: false })
  t.alike(store.held, [1, 2, 3, 4], 'packets 3 and 4 were added, 1 and 2 were already there')
  t.absent(
    bridge.calls.some((c) => c.method === 'share.history'),
    'no live request without a connection'
  )
  handle.close()

  // A retained suffix that starts past what the store holds leaves a hole: it
  // is not stored.
  const gap = viewerStore(1)
  const evicted = scriptedBridge(() =>
    Promise.resolve({
      headLength: 5,
      segments: [{ index: 4, firstSeq: 9, packets: [corePacket(9)] }]
    })
  )
  const other = new CoreHistoryHandle({ core: evicted, store: gap, keys: {}, live: () => false })
  await other.pull(Infinity, { destroyed: false }, { poll: false })
  t.alike(gap.held, [1], 'nothing is appended across a gap')
  other.close()
})

test('viewer history: a connection that is gone falls back to the contract; a bad segment does not', async (t) => {
  const store = viewerStore()
  const bridge = scriptedBridge((method) => {
    if (method === 'share.history') {
      return Promise.reject(new EngineError(CODES.E_INTERNAL, 'Remote session is not registered'))
    }
    if (method === 'history.readContract') {
      return Promise.resolve({
        headLength: 1,
        segments: [{ index: 0, firstSeq: 1, packets: [corePacket(1)] }]
      })
    }
    return Promise.resolve(null)
  })
  const handle = new CoreHistoryHandle({ core: bridge, store, keys: {}, live: () => true })
  await handle.pull(Infinity, { destroyed: false }, { poll: false })
  t.alike(store.held, [1], 'the contract answered where the host could not')
  handle.close()

  const tampered = viewerStore()
  const bad = scriptedBridge((method, args, b) => {
    if (method === 'share.history') {
      b.emit('historySegment', {
        sessionId: tampered.sessionId,
        requestId: 1,
        start: 1,
        data: 'QQ=='
      })
      return Promise.resolve({ requestId: 1 })
    }
    if (method === 'history.verify') {
      return Promise.reject(new EngineError(CODES.E_CORRUPT, 'Segment failed its checks'))
    }
    return Promise.resolve(null)
  })
  const refusing = new CoreHistoryHandle({ core: bad, store: tampered, keys: {}, live: () => true })
  await t.exception(
    () => refusing.pull(Infinity, { destroyed: false }, { poll: false }),
    /failed its checks/
  )
  t.absent(
    bad.calls.some((c) => c.method === 'history.readContract'),
    'and is not papered over with another source'
  )
  t.alike(tampered.held, [], 'nothing of it is stored')
  refusing.close()

  const refused = scriptedBridge(() =>
    Promise.reject(new EngineError(CODES.E_CORRUPT, 'Contract state is forged'))
  )
  const forged = new CoreHistoryHandle({
    core: refused,
    store: viewerStore(),
    keys: {},
    live: () => false
  })
  await t.exception(() => forged.pull(Infinity, { destroyed: false }, { poll: false }), /forged/)
  forged.close()

  const unreachable = scriptedBridge(() => Promise.reject(new EngineError(CODES.E_NET, 'no node')))
  const quiet = new CoreHistoryHandle({
    core: unreachable,
    store: viewerStore(),
    keys: {},
    live: () => false
  })
  await quiet.pull(Infinity, { destroyed: false }, { poll: false })
  t.pass('a node that is not there is no progress, not an error')
  quiet.close()
})

test('viewer history: nothing is asked until the host has said which key signs its history', async (t) => {
  const store = viewerStore()
  store.historyInfoReady = false
  store.historyVerifyingKey = null
  const bridge = scriptedBridge(() => Promise.resolve(null))
  const handle = new CoreHistoryHandle({ core: bridge, store, keys: {}, live: () => true })
  t.is(handle.ready, false)
  await handle.pull(Infinity, { destroyed: false }, { poll: false })
  t.alike(bridge.calls, [], 'no request')
  handle.keys.verifyingKey = 'cd'.repeat(32)
  store.historyInfoReady = true
  t.is(handle.ready, true, 'a key that arrives later is taken')
  handle.close()
})
