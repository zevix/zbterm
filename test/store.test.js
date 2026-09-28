const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('brittle')
const b4a = require('b4a')

const { SessionStore } = require('../engine/session-store')
const {
  deriveHistoryKey,
  deriveLiveKey,
  encryptPacket,
  generateEpochKey,
  loadOrCreateLocalDevice,
  sealEnvelope
} = require('../engine/crypto')
const { CODES } = require('../engine/errors')
const { VERSION, PacketKind, PlainPacket, StoredPacket, encode } = require('../engine/schema')
const { FULL_CAPS } = require('../engine/caps')

test('store appends and reads ordered encrypted packets', async (t) => {
  const dir = await temp()
  const device = await loadOrCreateLocalDevice({ root: dir })
  const store = await SessionStore.create(path.join(dir, 'corestore'), device, {
    name: 'test',
    cols: 80,
    rows: 24
  })
  await store.appendData(b4a.from('hello'))
  await store.appendResize(100, 30)
  await store.appendData(b4a.from('world'))

  const packets = []
  for await (const packet of store.readRange(1, store.log.length)) packets.push(packet)
  t.alike(
    packets.map((p) => p.seq),
    [1, 2, 3, 4]
  )
  t.is(
    Buffer.concat(packets.filter((p) => p.payload.length).map((p) => p.payload)).toString(),
    'helloworld'
  )

  await store.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
})

test('store rebuilds corrupt timeline cache', async (t) => {
  const dir = await temp()
  const device = await loadOrCreateLocalDevice({ root: dir })
  const root = path.join(dir, 'corestore')
  const store = await SessionStore.create(root, device, {
    name: 'test',
    cols: 80,
    rows: 24
  })
  await store.appendData(b4a.from('hello'))
  const sessionId = store.sessionId
  await store.close()

  const timelinePath = path.join(root, sessionId, 'timeline.json')
  await fs.promises.writeFile(timelinePath, '')
  const reopened = await SessionStore.open(root, sessionId, device)

  t.is(reopened.timeline.length, 2)
  t.alike(
    reopened.timeline.map((p) => p.seq),
    [1, 2]
  )

  await reopened.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
})

test('store missing envelope raises E_NOKEY', async (t) => {
  const dir = await temp()
  const device = await loadOrCreateLocalDevice({ root: dir })
  const store = await SessionStore.create(path.join(dir, 'corestore'), device, {
    name: 'test',
    cols: 80,
    rows: 24
  })
  const sessionId = store.sessionId
  await store.meta.del('env/1/local')
  await store.close()
  try {
    await SessionStore.open(path.join(dir, 'corestore'), sessionId, device)
    t.fail('open should fail')
  } catch (err) {
    t.is(err.code, CODES.E_NOKEY)
  }
  await fs.promises.rm(dir, { recursive: true, force: true })
})

test('joined store persists manifest for offline reopen', async (t) => {
  const dir = await temp()
  const viewer = await loadOrCreateLocalDevice({ root: path.join(dir, 'viewer') })
  const root = path.join(dir, 'corestore')
  const sessionId = 'joined-session'
  const masterKey = generateEpochKey()
  const historyKey = deriveHistoryKey(masterKey)
  const liveKey = deriveLiveKey(masterKey)
  const envelope = sealEnvelope(viewer.publicKey, {
    version: VERSION,
    sessionId,
    epoch: 1,
    caps: FULL_CAPS,
    masterKey,
    historyKey,
    liveKey
  })

  const joined = await SessionStore.openRemote(root, sessionId, viewer, {
    logKey: b4a.toString(b4a.alloc(32, 1), 'hex'),
    metaKey: b4a.toString(b4a.alloc(32, 2), 'hex'),
    hostDeviceKey: b4a.toString(b4a.alloc(32, 3), 'hex'),
    envelope: b4a.toString(envelope, 'hex'),
    info: {
      name: 'offline joined',
      createdAt: 1234,
      cols: 90,
      rows: 28
    }
  })
  await joined.close()

  const reopened = await SessionStore.openJoined(root, sessionId, viewer)
  t.is(reopened.remote, true)
  t.is(reopened.info.name, 'offline joined')
  t.is(reopened.info.createdAt, 1234)
  t.is(reopened.info.cols, 90)
  t.is(reopened.info.rows, 28)
  t.alike(reopened.keys.historyKey, historyKey)

  await reopened.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
})

test('openRemote replaces partial joined store left by failed join', async (t) => {
  const dir = await temp()
  const viewer = await loadOrCreateLocalDevice({ root: path.join(dir, 'viewer') })
  const root = path.join(dir, 'corestore')
  const sessionId = 'partial-joined-session'
  const partialDir = path.join(root, sessionId)
  await fs.promises.mkdir(partialDir, { recursive: true })
  await fs.promises.writeFile(path.join(partialDir, 'orphan'), 'stale')

  const masterKey = generateEpochKey()
  const historyKey = deriveHistoryKey(masterKey)
  const liveKey = deriveLiveKey(masterKey)
  const envelope = sealEnvelope(viewer.publicKey, {
    version: VERSION,
    sessionId,
    epoch: 1,
    caps: FULL_CAPS,
    masterKey,
    historyKey,
    liveKey
  })

  const joined = await SessionStore.openRemote(root, sessionId, viewer, {
    logKey: b4a.toString(b4a.alloc(32, 4), 'hex'),
    metaKey: b4a.toString(b4a.alloc(32, 5), 'hex'),
    hostDeviceKey: b4a.toString(b4a.alloc(32, 6), 'hex'),
    envelope: b4a.toString(envelope, 'hex'),
    info: { name: 'rejoined cleanly' }
  })

  t.absent(await exists(path.join(partialDir, 'orphan')), 'stale partial files are removed')
  t.is(joined.info.name, 'rejoined cleanly')

  await joined.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
})

test('store bit flip raises E_CORRUPT with seq', async (t) => {
  const dir = await temp()
  const device = await loadOrCreateLocalDevice({ root: dir })
  const store = await SessionStore.create(path.join(dir, 'corestore'), device, {
    name: 'test',
    cols: 80,
    rows: 24
  })
  await store.appendData(b4a.from('hello'))
  const original = await store.log.get(1)
  const flipped = b4a.from(original)
  flipped[flipped.length - 1] ^= 1
  await store.log.truncate(1)
  await store.log.append(flipped)
  try {
    for await (const packet of store.readRange(2, 2)) void packet
    t.fail('read should fail')
  } catch (err) {
    t.is(err.code, CODES.E_CORRUPT)
    t.is(err.details.seq, 2)
  }
  await store.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
})

test('store removes hd by repacking hd data packets', async (t) => {
  const dir = await temp()
  const device = await loadOrCreateLocalDevice({ root: dir })
  const store = await SessionStore.create(path.join(dir, 'corestore'), device, {
    name: 'test',
    cols: 80,
    rows: 24
  })
  await store.appendData(b4a.from('a'), { hd: true })
  await store.appendData(b4a.from('b'), { hd: true })
  await store.appendResize(100, 30, { hd: true })
  await store.appendData(b4a.from('c'))

  const result = await store.removeHd()
  const packets = []
  for await (const packet of store.readRange(1, store.log.length)) packets.push(packet)

  t.is(result.before, 5)
  t.is(result.after, 4)
  t.alike(
    packets.map((p) => p.hd),
    [false, false, false, false]
  )
  t.is(packets[1].payload.toString('utf8'), 'ab')
  t.is(packets[2].cols, 100)
  t.is(
    store.timeline.some((p) => p.hd),
    false
  )

  await store.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
})

test('store extendTimeline catches up on new packets without a full rebuild', async (t) => {
  const dir = await temp()
  const device = await loadOrCreateLocalDevice({ root: dir })
  const store = await SessionStore.create(path.join(dir, 'corestore'), device, {
    name: 'test',
    cols: 80,
    rows: 24
  })
  await store.appendData(b4a.from('hello'))
  t.is(store.timeline.length, 2)

  // A remote/joined store's Hypercore keeps receiving new blocks via
  // replication independent of `appendPlain` (which is writer-only and
  // throws for remote stores). Append raw stored packets directly to the
  // log core the same way replication would, to simulate history that
  // arrived after a Player snapshotted `timeline` and went stale.
  await appendRawPacket(store, { kind: PacketKind.DATA, payload: b4a.from('world') })
  await appendRawPacket(store, { kind: PacketKind.RESIZE, cols: 100, rows: 30 })
  t.is(store.timeline.length, 2, 'timeline did not track replicated packets')

  await store.extendTimeline()
  t.alike(
    store.timeline.map((p) => p.seq),
    [1, 2, 3, 4]
  )

  await store.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
})

test('store timeline flushes tolerate concurrent callers in the same millisecond', async (t) => {
  const dir = await temp()
  const device = await loadOrCreateLocalDevice({ root: dir })
  const store = await SessionStore.create(path.join(dir, 'corestore'), device, {
    name: 'test',
    cols: 80,
    rows: 24
  })
  const originalNow = Date.now
  t.teardown(async () => {
    Date.now = originalNow
    await store.close().catch(() => {})
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  Date.now = () => 1234567890

  await store.appendData(b4a.from('hello'))
  await Promise.all([store.flushTimeline(), store.flushTimeline()])

  const raw = await fs.promises.readFile(path.join(store.dir, 'timeline.json'), 'utf8')
  const timeline = JSON.parse(raw)
  t.alike(
    timeline.map((item) => item.seq),
    store.timeline.map((item) => item.seq),
    'concurrent flushes write one valid timeline cache'
  )
})

async function appendRawPacket(store, plain) {
  const seq = store.log.length + 1
  const full = {
    version: VERSION,
    tsMs: Date.now(),
    kind: plain.kind,
    cols: plain.cols || null,
    rows: plain.rows || null,
    payload: plain.payload || b4a.alloc(0),
    hd: false
  }
  const encodedPlain = encode(PlainPacket, full)
  const ciphertext = encryptPacket(
    store.keys.historyKey,
    store.sessionId,
    store.epoch,
    seq,
    store.localDevice.publicKey,
    encodedPlain
  )
  const stored = encode(StoredPacket, { version: VERSION, epoch: store.epoch, seq, ciphertext })
  await store.log.append(stored)
}

test('rotateEpoch mints a new epoch, keeps old packets readable, and excludes non-members', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const host = await loadOrCreateLocalDevice({ root: path.join(dir, 'host') })
  const kept = await loadOrCreateLocalDevice({ root: path.join(dir, 'kept') })
  const removed = await loadOrCreateLocalDevice({ root: path.join(dir, 'removed') })

  const store = await SessionStore.create(path.join(dir, 'corestore'), host, {
    name: 'test',
    cols: 80,
    rows: 24
  })
  await store.appendData(b4a.from('epoch-1-data'))
  t.is(store.epoch, 1)
  const epoch1HistoryKey = store.keys.historyKey

  const { epoch, envelopes } = await store.rotateEpoch(
    [{ deviceKeyHex: b4a.toString(kept.publicKey, 'hex'), caps: FULL_CAPS }],
    'test-rotation'
  )
  t.is(epoch, 2)
  t.is(store.epoch, 2)
  t.ok(!b4a.equals(store.keys.historyKey, epoch1HistoryKey), 'rotation mints a fresh history key')
  t.ok(
    envelopes.has(b4a.toString(kept.publicKey, 'hex')),
    'kept member receives the new epoch envelope'
  )
  t.absent(
    envelopes.has(b4a.toString(removed.publicKey, 'hex')),
    'a device left out of the members list receives no new-epoch key material'
  )

  await store.appendData(b4a.from('epoch-2-data'))

  const packets = []
  for await (const packet of store.readRange(1, store.log.length)) packets.push(packet)
  t.alike(
    packets.map((p) => p.epoch),
    [1, 1, 2]
  )
  t.is(
    Buffer.concat(packets.filter((p) => p.payload.length).map((p) => p.payload)).toString(),
    'epoch-1-dataepoch-2-data',
    'packets from before and after rotation both decrypt correctly'
  )

  await store.close()
})

test('remote store never opens the host-only "local" envelope key', async (t) => {
  // Regression: env/<epoch>/local is sealed to the host's own device key,
  // but lives in the same meta Hyperbee that gets replicated to every
  // viewer. A remote/viewer store must resolve its *own* device-keyed
  // envelope (env/<epoch>/<deviceKeyHex>) and must never even attempt to
  // open 'local' - doing so would try box_seal_open with the viewer's
  // secret key against an envelope sealed to the host and fail with
  // E_NOKEY ("Could not open local key envelope"), exactly as caught by
  // test/debug-server-e2e.js's playback/seek step.
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const host = await loadOrCreateLocalDevice({ root: path.join(dir, 'host') })
  const viewer = await loadOrCreateLocalDevice({ root: path.join(dir, 'viewer') })

  const masterKey = generateEpochKey()
  const historyKey = deriveHistoryKey(masterKey)
  const liveKey = deriveLiveKey(masterKey)

  const records = {
    'env/2/local': b4a.toString(
      sealEnvelope(host.publicKey, {
        version: VERSION,
        sessionId: 's',
        epoch: 2,
        caps: FULL_CAPS,
        masterKey,
        historyKey,
        liveKey
      }),
      'hex'
    ),
    [`env/2/${b4a.toString(viewer.publicKey, 'hex')}`]: b4a.toString(
      sealEnvelope(viewer.publicKey, {
        version: VERSION,
        sessionId: 's',
        epoch: 2,
        caps: FULL_CAPS,
        masterKey: null,
        historyKey,
        liveKey
      }),
      'hex'
    )
  }
  let sawLocalLookup = false
  const fakeMeta = {
    get: async (key) => {
      if (key === 'env/2/local') sawLocalLookup = true
      return records[key] ? { value: records[key] } : null
    }
  }

  const remoteStore = new SessionStore({
    root: dir,
    sessionId: 's',
    localDevice: viewer,
    remote: true
  })
  remoteStore.meta = fakeMeta

  const keys = await remoteStore._loadLocalEpochKeys(2)
  t.alike(keys.historyKey, historyKey, 'viewer resolves its own device-keyed envelope')
  t.absent(sawLocalLookup, 'remote store never looks up the host-only "local" key')
})

function temp() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-test-'))
}

async function exists(file) {
  try {
    await fs.promises.access(file)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}
