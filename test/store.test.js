const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('brittle')

require('./helpers/zxterm-core')
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

// K14 (ZBTerm D-38): on a Freenet share the core mints the epochs and this
// store installs them from `share.epoch` (zxterm K13); the envelopes are the
// core's, sealed exactly as `rotateEpoch` seals them.
test('applyCoreEpoch installs the epoch the core minted, as rotateEpoch would have', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  const host = await loadOrCreateLocalDevice({ root: path.join(dir, 'host') })
  const member = await loadOrCreateLocalDevice({ root: path.join(dir, 'member') })
  const root = path.join(dir, 'corestore')
  const store = await SessionStore.create(root, host, { name: 'test', cols: 80, rows: 24 })
  await store.appendData(b4a.from('epoch-1-data'))
  const memberHex = b4a.toString(member.publicKey, 'hex')

  const masterKey = generateEpochKey()
  const historyKey = deriveHistoryKey(masterKey)
  const liveKey = deriveLiveKey(masterKey)
  const sealed = (to, caps, keys) =>
    b4a.toString(
      sealEnvelope(to, { version: VERSION, sessionId: store.sessionId, epoch: 2, caps, ...keys }),
      'hex'
    )
  const local = sealed(host.publicKey, FULL_CAPS, { masterKey, historyKey, liveKey })
  const forMember = sealed(member.publicKey, FULL_CAPS, { masterKey: null, historyKey, liveKey })
  const earlier = b4a.toString(
    sealEnvelope(member.publicKey, {
      version: VERSION,
      sessionId: store.sessionId,
      epoch: 1,
      caps: FULL_CAPS,
      masterKey: null,
      historyKey: store.keys.historyKey,
      liveKey: null
    }),
    'hex'
  )

  await store.applyCoreEpoch({
    epoch: 2,
    reason: 'join',
    persist: true,
    local,
    envelopes: { [memberHex]: forMember },
    history: [{ deviceKey: memberHex, epoch: 1, envelope: earlier }]
  })
  t.is(store.epoch, 2, 'the epoch moves forward')
  t.alike(store.keys.liveKey, liveKey, "with the core's live key")
  t.alike(store.keys.historyKey, historyKey, 'and history key')
  t.alike(store.keys.masterKey, masterKey, "and the master key, from the host's own envelope")
  t.is((await store.meta.get('epoch/current')).value, 2, 'epoch/current says so')
  t.is((await store.meta.get('epoch/2')).value.reason, 'join', 'epoch/2 records why')
  t.is(
    (await store.meta.get('epoch/2')).value.startSeq,
    store.log.length + 1,
    'and where it starts'
  )
  t.is((await store.meta.get('env/2/local')).value, local, "the host's envelope is kept")
  t.is((await store.meta.get(`env/2/${memberHex}`)).value, forMember, "and the member's")
  t.is(
    (await store.meta.get(`env/1/${memberHex}`)).value,
    earlier,
    "and the member's history-only envelope of the epoch before"
  )

  await store.appendData(b4a.from('epoch-2-data'))
  const packets = []
  for await (const packet of store.readRange(1, store.log.length)) packets.push(packet)
  t.alike(
    packets.map((p) => p.epoch),
    [1, 1, 2],
    "packets written from now on are under the core's epoch"
  )
  t.is(
    Buffer.concat(packets.filter((p) => p.payload.length).map((p) => p.payload)).toString(),
    'epoch-1-dataepoch-2-data',
    'and both epochs decrypt'
  )

  // An older epoch arriving late never moves the store back.
  const before = store.keys
  await store.applyCoreEpoch({
    epoch: 1,
    reason: 'open',
    persist: true,
    local: (await store.meta.get('env/1/local')).value,
    envelopes: {},
    history: []
  })
  t.is(store.epoch, 2, 'an older epoch does not move it back')
  t.is(store.keys, before, 'nor change the keys in use')

  const sessionId = store.sessionId
  await store.close()
  const reopened = await SessionStore.open(root, sessionId, host)
  t.is(reopened.epoch, 2, 'a reopened store finds the epoch')
  t.alike(reopened.keys.liveKey, liveKey, 'and its keys, from the envelope the core minted')
  await reopened.close()
})

test('applyCoreEpoch writes nothing for a session that is not to be persisted', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  const host = await loadOrCreateLocalDevice({ root: path.join(dir, 'host') })
  const store = await SessionStore.create(path.join(dir, 'corestore'), host, {
    name: 'test',
    cols: 80,
    rows: 24
  })
  const masterKey = generateEpochKey()
  const historyKey = deriveHistoryKey(masterKey)
  const liveKey = deriveLiveKey(masterKey)
  const local = b4a.toString(
    sealEnvelope(host.publicKey, {
      version: VERSION,
      sessionId: store.sessionId,
      epoch: 2,
      caps: FULL_CAPS,
      masterKey,
      historyKey,
      liveKey
    }),
    'hex'
  )
  await store.applyCoreEpoch({
    epoch: 2,
    reason: 'open',
    persist: false,
    local,
    envelopes: {},
    history: []
  })
  t.is(store.epoch, 2, 'the keys are in use')
  t.alike(store.keys.liveKey, liveKey)
  t.is(await store.meta.get('env/2/local'), null, 'no envelope is stored')
  t.is((await store.meta.get('epoch/current')).value, 1, 'and epoch/current stays')
  await store.close()
})

test('sealHistoryForMember stops at the epoch it is told to (`upTo`)', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  const host = await loadOrCreateLocalDevice({ root: path.join(dir, 'host') })
  const member = await loadOrCreateLocalDevice({ root: path.join(dir, 'member') })
  const store = await SessionStore.create(path.join(dir, 'corestore'), host, {
    name: 'test',
    cols: 80,
    rows: 24
  })
  await store.rotateEpoch([], 'one')
  await store.rotateEpoch([], 'two')
  t.is(store.epoch, 3)
  const memberHex = b4a.toString(member.publicKey, 'hex')
  await store.sealHistoryForMember(memberHex, FULL_CAPS, { upTo: 2 })
  t.ok(await store.meta.get(`env/1/${memberHex}`), 'epoch 1 is sealed')
  t.ok(await store.meta.get(`env/2/${memberHex}`), 'epoch 2 is sealed')
  t.is(await store.meta.get(`env/3/${memberHex}`), null, 'epoch 3 is not')
  await store.sealHistoryForMember(memberHex, FULL_CAPS)
  t.ok(await store.meta.get(`env/3/${memberHex}`), 'with no limit every epoch up to the current is')
  await store.close()
})

// K17 (zxterm-core C3, ZBTerm D-40): a joined Freenet session's store is a
// cache of what the core verified, sealed under the device's own key.
async function coreCacheStore(dir, device, sessionId = 'd'.repeat(64)) {
  const hostKey = generateEpochKey()
  const envelope = (epoch, historyKey) =>
    b4a.toString(
      sealEnvelope(device.publicKey, {
        version: VERSION,
        sessionId,
        epoch,
        caps: FULL_CAPS,
        masterKey: null,
        historyKey,
        liveKey: deriveLiveKey(hostKey)
      }),
      'hex'
    )
  const first = envelope(1, deriveHistoryKey(hostKey))
  const current = envelope(3, Buffer.alloc(32, 9))
  const store = await SessionStore.openRemote(path.join(dir, 'corestore'), sessionId, device, {
    core: true,
    hostDeviceKey: b4a.toString(device.publicKey, 'hex'),
    envelope: current,
    info: { name: 'cached', cols: 80, rows: 24 }
  })
  return { store, first, current, historyKey: deriveHistoryKey(hostKey), sessionId }
}

function corePackets(from, to) {
  const out = []
  for (let seq = from; seq <= to; seq++) {
    out.push({
      seq,
      tsMs: 1000 + seq,
      kind: PacketKind.DATA,
      cols: null,
      rows: null,
      payload: b4a.from(`core-${seq}`),
      hd: false
    })
  }
  return out
}

test('a core cache takes the packets the core verified, in order, and refuses a hole', async (t) => {
  const dir = await temp()
  const device = await loadOrCreateLocalDevice({ root: dir })
  const { store } = await coreCacheStore(dir, device)
  t.teardown(() => store.close().catch(() => {}))
  t.is(store.historyCache, true)
  t.is(store.remote, true, 'it is still a joined, read-only session')
  await t.exception(() => store.appendPlain({}), /read-only/, 'nothing but the core writes to it')
  t.is(await store.appendVerified(corePackets(1, 3)), 3)
  await t.exception(
    () => store.appendVerified(corePackets(5, 6)),
    /out of order/,
    'a hole is refused'
  )
  t.is(await store.appendVerified(corePackets(4, 5)), 5)
  const seen = []
  for await (const packet of store.readRange(1, 5, { wait: false })) seen.push(packet)
  t.alike(
    seen.map((p) => [p.seq, p.tsMs, p.payload.toString()]),
    corePackets(1, 5).map((p) => [p.seq, p.tsMs, p.payload.toString()]),
    'they read back as they went in'
  )
  t.is(await store.availableLength(), 5)
  t.alike(
    store.timeline.map((e) => e.seq),
    [1, 2, 3, 4, 5],
    'the timeline follows'
  )
  const raw = b4a.toString(await store.log.get(0), 'latin1')
  t.absent(raw.includes('core-1'), 'and the cache is sealed on disk')
})

test('what the host says of its history is kept with the joined session and survives a reopen', async (t) => {
  const dir = await temp()
  const device = await loadOrCreateLocalDevice({ root: dir })
  const { store, first, sessionId, historyKey } = await coreCacheStore(dir, device)
  t.is(store.historyInfoReady, false, 'nothing is known of the history before the host says')
  t.is(store.historyVerifyingKey, null)
  await store.applyHistoryInfo({ verifyingKey: 'ab'.repeat(32), envelopes: { 1: first } })
  t.is(store.historyInfoReady, true)
  t.is(store.historyVerifyingKey, 'ab'.repeat(32))
  const keys = store.historyKeysHex()
  t.alike(Object.keys(keys).sort(), ['1', '3'], 'the keys of the epochs this device holds')
  t.is(keys['1'], b4a.toString(historyKey, 'hex'))
  await store.appendVerified(corePackets(1, 2))
  await store.close()

  const reopened = await SessionStore.openJoined(path.join(dir, 'corestore'), sessionId, device)
  t.teardown(() => reopened.close().catch(() => {}))
  t.is(reopened.historyCache, true, 'a core session reopens as one')
  t.is(reopened.historyVerifyingKey, 'ab'.repeat(32), 'with the key that finds its contract')
  t.is(reopened.historyInfoReady, true)
  t.alike(reopened.historyKeysHex(), keys, 'and the keys to open its segments')
  t.is(await reopened.availableLength(), 2, 'and the packets it had')

  // A later epoch's envelope (a rekey) is kept as well.
  const later = b4a.toString(
    sealEnvelope(device.publicKey, {
      version: VERSION,
      sessionId,
      epoch: 4,
      caps: FULL_CAPS,
      masterKey: null,
      historyKey: Buffer.alloc(32, 4),
      liveKey: Buffer.alloc(32, 5)
    }),
    'hex'
  )
  await reopened.applyEpochEnvelope(4, later)
  await reopened.close()
  const again = await SessionStore.openJoined(path.join(dir, 'corestore'), sessionId, device)
  t.teardown(() => again.close().catch(() => {}))
  t.alike(Object.keys(again.historyKeysHex()).sort(), ['1', '3', '4'])
})

test('a recording store is no core cache, and feeds its append hook in order', async (t) => {
  const dir = await temp()
  const device = await loadOrCreateLocalDevice({ root: dir })
  const store = await SessionStore.create(path.join(dir, 'corestore'), device, {
    name: 'fed',
    cols: 80,
    rows: 24
  })
  t.teardown(() => store.close().catch(() => {}))
  t.is(store.historyCache, false)
  await t.exception(() => store.appendVerified(corePackets(1, 1)), /joined Freenet session/)
  const fed = []
  store.onAppend = (seq, plain) => fed.push([seq, plain.kind])
  await store.appendData(b4a.from('a'))
  await store.appendResize(90, 20)
  await store.appendData(b4a.from('b'))
  t.alike(
    fed,
    [
      [2, PacketKind.DATA],
      [3, PacketKind.RESIZE],
      [4, PacketKind.DATA]
    ],
    'each append, at its sequence number, after it is in the log'
  )
  store.onAppend = () => {
    throw new Error('a failing feed')
  }
  await store.appendData(b4a.from('c'))
  t.is(store.log.length, 5, 'a feed that fails never fails the recording')
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
