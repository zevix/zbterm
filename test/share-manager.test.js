const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const test = require('brittle')
const b4a = require('b4a')

const ShareManager = require('../engine/share-manager')
const { PearConnection } = require('../engine/backends/pear')
const { VERSION } = require('../engine/schema')
const {
  deriveHistoryKey,
  deriveLiveKey,
  generateEpochKey,
  loadOrCreateLocalDevice,
  openEnvelope,
  sealEnvelope
} = require('../engine/crypto')
const { CODES } = require('../engine/errors')
const { READ_HISTORY, SEND_INPUT, VIEW_LIVE, hasCap } = require('../engine/caps')

test('viewer join envelope omits masterKey and only includes capped keys', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const host = await loadOrCreateLocalDevice({ root: path.join(dir, 'host') })
  const viewer = await loadOrCreateLocalDevice({ root: path.join(dir, 'viewer') })
  const masterKey = generateEpochKey()
  const historyKey = deriveHistoryKey(masterKey)
  const liveKey = deriveLiveKey(masterKey)
  let storedEnvelope = null
  let confirm = null
  const caps = VIEW_LIVE | SEND_INPUT
  const manager = new ShareManager({
    localDevice: host,
    buildLiveBootstrap: async () => ({ seq: 1, cols: 80, rows: 24, data: '' }),
    sessions: new Map()
  })
  t.teardown(() => manager.close())
  const runtime = {
    store: {
      sessionId: 'session-a',
      epoch: 1,
      keys: { masterKey, historyKey, liveKey },
      info: { name: 'shared' },
      log: { key: b4a.alloc(32, 1) },
      metaCore: { key: b4a.alloc(32, 2) },
      writerDeviceKey: host.publicKey,
      localDevice: host,
      putMember: async () => {},
      sealHistoryForMember: async () => {},
      getMember: async () => null,
      listActiveMembers: async () => [
        {
          identityKeyHex: b4a.toString(viewer.identityPublicKey, 'hex'),
          deviceKeyHex: b4a.toString(viewer.publicKey, 'hex'),
          caps
        }
      ],
      // Stands in for the real rotateEpoch (see session-store.js): mints a
      // new epoch and seals it per-member, honoring READ_HISTORY/VIEW_LIVE
      // caps the same way the real implementation does.
      rotateEpoch: async (members) => {
        const nextEpoch = runtime.store.epoch + 1
        const envelopes = new Map()
        for (const member of members) {
          const envelope = sealEnvelope(b4a.from(member.deviceKeyHex, 'hex'), {
            version: VERSION,
            sessionId: 'session-a',
            epoch: nextEpoch,
            caps: member.caps,
            masterKey: null,
            historyKey: hasCap(member.caps, READ_HISTORY) ? historyKey : null,
            liveKey: hasCap(member.caps, VIEW_LIVE) ? liveKey : null
          })
          const envelopeHex = b4a.toString(envelope, 'hex')
          envelopes.set(member.deviceKeyHex, envelopeHex)
          storedEnvelope = { deviceKeyHex: member.deviceKeyHex, envelopeHex }
        }
        runtime.store.epoch = nextEpoch
        return { epoch: nextEpoch, envelopes }
      },
      meta: {
        put: async () => {}
      }
    },
    inputMode: 'host'
  }
  const share = {
    sessionId: 'session-a',
    liveSeq: 0,
    links: new Map(),
    peers: new Set()
  }
  const peer = {
    message: {
      send: (message) => {
        confirm = message
      }
    }
  }
  await manager._grantJoin(
    share,
    peer,
    runtime,
    { linkId: 'link-a', type: 'group', caps, maxViewers: 8 },
    {
      deviceKey: b4a.toString(viewer.publicKey, 'hex'),
      identityKey: b4a.toString(viewer.identityPublicKey, 'hex'),
      identityProof: b4a.toString(viewer.identityProof, 'hex'),
      deviceName: 'viewer'
    }
  )

  const env = openEnvelope(viewer.publicKey, viewer.secretKey, b4a.from(confirm.envelope, 'hex'))
  t.is(storedEnvelope.deviceKeyHex, b4a.toString(viewer.publicKey, 'hex'))
  t.is(storedEnvelope.envelopeHex, confirm.envelope)
  t.is(env.masterKey, null)
  t.is(env.historyKey, null)
  t.alike(env.liveKey, liveKey)
  t.is(env.caps, caps)
})

test('shared keyboard disables when no viewers remain', async (t) => {
  const runtime = { inputMode: 'all' }
  const manager = new ShareManager({
    sessions: new Map([['session-a', runtime]])
  })
  t.teardown(() => manager.close())

  const share = {
    sessionId: 'session-a',
    peers: new Set([{ confirmed: true }])
  }
  manager._disableInputWhenEmpty(share)
  t.is(runtime.inputMode, 'all', 'input remains shared while a viewer is connected')

  share.peers.clear()
  manager._disableInputWhenEmpty(share)
  t.is(runtime.inputMode, 'host', 'input returns to host-only after last viewer disconnects')

  manager.hostShares.set('session-a', share)
  t.is(manager.status('session-a').inputMode, 'host', 'share status reports current input mode')
})

test('snapshot sync caps long histories while keeping latest reference frame', (t) => {
  const snapshots = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1 }))
  const selected = ShareManager._test.selectSnapshotSyncItems(snapshots, 16)

  t.ok(selected.length <= 16, 'long snapshot lists are capped')
  t.is(selected[selected.length - 1].seq, 500, 'latest snapshot is always synced')
  t.alike(
    selected.map((item) => item.seq),
    selected
      .map((item) => item.seq)
      .slice()
      .sort((a, b) => a - b),
    'selected snapshots stay sorted'
  )
})

test('sealed input requires SEND_INPUT, matching identity, and fresh counters', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const host = await loadOrCreateLocalDevice({ root: path.join(dir, 'host') })
  const viewer = await loadOrCreateLocalDevice({ root: path.join(dir, 'viewer') })
  const other = await loadOrCreateLocalDevice({ root: path.join(dir, 'other') })
  const hostManager = new ShareManager({ localDevice: host })
  const viewerManager = new ShareManager({
    localDevice: viewer,
    remoteSessions: new Map([
      [
        'session-a',
        {
          store: {
            epoch: 1,
            writerDeviceKey: host.publicKey
          },
          inputCtr: 0
        }
      ]
    ])
  })
  t.teardown(() => hostManager.close())
  t.teardown(() => viewerManager.close())
  const runtime = {
    store: {
      sessionId: 'session-a',
      epoch: 1
    }
  }
  const inputCounters = new Map()
  const peer = {
    confirmed: true,
    caps: SEND_INPUT,
    deviceKeyHex: b4a.toString(viewer.publicKey, 'hex'),
    identityKeyHex: b4a.toString(viewer.identityPublicKey, 'hex'),
    identityProofHex: b4a.toString(viewer.identityProof, 'hex'),
    inputCounterKey: b4a.toString(viewer.publicKey, 'hex'),
    inputCounters,
    inputCtr: 0
  }
  const sealed = viewerManager.sealInput('session-a', 'hello')

  t.is(hostManager._openInputMessage(runtime, peer, { data: sealed }), 'hello')
  t.exception(
    () => hostManager._openInputMessage(runtime, peer, { data: sealed }),
    { code: CODES.E_AUTH },
    'replays are rejected'
  )
  t.exception(
    () => hostManager._openInputMessage(runtime, { ...peer, inputCtr: 0 }, { data: sealed }),
    { code: CODES.E_AUTH },
    'replays are rejected after reconnect'
  )

  const noInputPeer = { ...peer, inputCtr: 0, caps: VIEW_LIVE }
  t.exception(
    () => hostManager._openInputMessage(runtime, noInputPeer, { data: sealed }),
    { code: CODES.E_AUTH },
    'SEND_INPUT is required'
  )

  const wrongPeer = {
    ...peer,
    inputCtr: 0,
    deviceKeyHex: b4a.toString(other.publicKey, 'hex'),
    identityKeyHex: b4a.toString(other.identityPublicKey, 'hex'),
    identityProofHex: b4a.toString(other.identityProof, 'hex')
  }
  t.exception(
    () => hostManager._openInputMessage(runtime, wrongPeer, { data: sealed }),
    { code: CODES.E_AUTH },
    'sealed input is bound to the joined peer'
  )
})

test('revoking a link disconnects current viewers and rotates keys, dropping their access', async (t) => {
  const members = new Map([
    [
      'identity-a',
      { identityKeyHex: 'identity-a', deviceKeyHex: 'device-a', caps: 3, linkId: 'link-a' }
    ],
    [
      'identity-b',
      { identityKeyHex: 'identity-b', deviceKeyHex: 'device-b', caps: 3, linkId: 'other-link' }
    ]
  ])
  let rotatedWith = null
  const store = {
    meta: {
      get: async () => ({
        value: {
          linkId: 'link-a',
          sessionId: 'session-a',
          revoked: false
        }
      }),
      put: async (key, value) => {
        t.is(key, 'link/link-a')
        t.is(value.revoked, true)
      }
    },
    listActiveMembers: async () =>
      Array.from(members.values()).filter((m) => m.status !== 'revoked'),
    setMemberStatus: async (identityKeyHex, status) => {
      members.set(identityKeyHex, { ...members.get(identityKeyHex), status })
    },
    rotateEpoch: async (remaining) => {
      rotatedWith = remaining.map((m) => m.identityKeyHex)
      return {
        epoch: 2,
        envelopes: new Map(remaining.map((m) => [m.deviceKeyHex, 'envelope-hex']))
      }
    }
  }
  const manager = new ShareManager({
    sessions: new Map([['session-a', { store }]])
  })
  t.teardown(() => manager.close())
  let closed = 0
  const share = {
    links: new Map(),
    peers: new Set([
      {
        linkId: 'link-a',
        channel: { close: () => closed++ },
        socket: { destroy: () => t.fail('socket destroyed') }
      },
      { linkId: 'other-link', socket: { destroy: () => t.fail('unrelated viewer disconnected') } }
    ])
  }
  manager.hostShares.set('session-a', share)

  t.is(await manager.revokeLink('session-a', 'link-a'), true)
  t.is(closed, 1)
  t.is(share.links.get('link-a').revoked, true)
  t.is(
    members.get('identity-a').status,
    'revoked',
    'member who joined via the revoked link loses standing access'
  )
  t.is(members.get('identity-b').status, undefined, 'member from a different link is untouched')
  t.alike(rotatedWith, ['identity-b'], 'key rotation excludes the revoked member going forward')
})

test('join is denied for a previously-revoked session member', async (t) => {
  const host = await loadOrCreateLocalDevice({ root: await temp() })
  const viewer = await loadOrCreateLocalDevice({ root: await temp() })
  const identityKeyHex = b4a.toString(viewer.identityPublicKey, 'hex')
  const deviceKeyHex = b4a.toString(viewer.publicKey, 'hex')

  const manager = new ShareManager({
    localDevice: host,
    account: null,
    sessions: new Map([
      [
        'session-a',
        {
          store: {
            meta: {
              get: async () => ({
                value: {
                  linkId: 'link-a',
                  sessionId: 'session-a',
                  revoked: false,
                  type: 'group',
                  maxViewers: 8
                }
              })
            },
            getMember: async () => ({ status: 'revoked' })
          }
        }
      ]
    ])
  })
  t.teardown(() => manager.close())

  const share = { peers: new Set(), pendingApprovals: new Map() }
  let denied = null
  const peer = {
    message: {
      send: (message) => {
        if (message.type === 'error') denied = message
      }
    },
    socket: { destroy: () => {} }
  }

  await manager._confirmJoin(share, peer, manager.engine.sessions.get('session-a'), {
    linkId: 'link-a',
    deviceKey: deviceKeyHex,
    identityKey: identityKeyHex,
    identityProof: b4a.toString(viewer.identityProof, 'hex'),
    deviceName: 'viewer'
  })

  t.ok(denied, 'revoked member is denied rather than silently granted')
  t.is(denied.code, CODES.E_AUTH)
})

test('join() rejects an invite with no hostDhtKey (Phase 3: mandatory pinnable host key)', async (t) => {
  const host = await loadOrCreateLocalDevice({ root: await temp() })
  const manager = new ShareManager({ localDevice: host, sessions: new Map() })
  t.teardown(() => manager.close())

  const payload = { v: VERSION, linkId: 'a'.repeat(32), topic: 'b'.repeat(64) }
  const uri = 'zbterm://join/' + Buffer.from(JSON.stringify(payload)).toString('base64url')

  await t.exception(
    () => manager.join(uri),
    { code: CODES.E_AUTH },
    'invite without hostDhtKey is rejected'
  )
})

test('share.inputCounters survives across different peer objects for the same device (multiplexed peers)', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const host = await loadOrCreateLocalDevice({ root: path.join(dir, 'host') })
  const viewer = await loadOrCreateLocalDevice({ root: path.join(dir, 'viewer') })
  const hostManager = new ShareManager({ localDevice: host })
  const viewerManager = new ShareManager({
    localDevice: viewer,
    remoteSessions: new Map([
      ['session-a', { store: { epoch: 1, writerDeviceKey: host.publicKey }, inputCtr: 0 }]
    ])
  })
  t.teardown(() => hostManager.close())
  t.teardown(() => viewerManager.close())

  const runtime = { store: { sessionId: 'session-a', epoch: 1 } }
  const inputCounters = new Map()
  const deviceKeyHex = b4a.toString(viewer.publicKey, 'hex')
  const basePeer = {
    confirmed: true,
    caps: SEND_INPUT,
    deviceKeyHex,
    identityKeyHex: b4a.toString(viewer.identityPublicKey, 'hex'),
    identityProofHex: b4a.toString(viewer.identityProof, 'hex'),
    inputCounterKey: deviceKeyHex,
    inputCounters
  }

  const sealed1 = viewerManager.sealInput('session-a', 'first')
  t.is(
    hostManager._openInputMessage(runtime, { ...basePeer, inputCtr: 0 }, { data: sealed1 }),
    'first',
    'first peer object accepts input at counter 1'
  )

  // A fresh peer object (as if the device reconnected on a different
  // multiplexed socket) shares the same inputCounters map - the shared map,
  // not any one peer object, is what enforces replay protection.
  const sealed2 = viewerManager.sealInput('session-a', 'second')
  t.is(
    hostManager._openInputMessage(runtime, { ...basePeer, inputCtr: 0 }, { data: sealed2 }),
    'second',
    'a different peer object for the same device continues from the shared counter'
  )

  t.exception(
    () => hostManager._openInputMessage(runtime, { ...basePeer, inputCtr: 0 }, { data: sealed2 }),
    { code: CODES.E_AUTH },
    'a third peer object sharing the same counters map still rejects an already-used counter'
  )

  t.is(
    inputCounters.get(deviceKeyHex),
    2,
    'the shared map reflects the latest counter regardless of which peer object wrote it'
  )
})

test('host channel close cleans up one peer without closing the shared socket', (t) => {
  const manager = new ShareManager({
    sessions: new Map([['session-a', { inputMode: 'all' }]])
  })
  t.teardown(() => manager.close())

  const share = {
    sessionId: 'session-a',
    peers: new Set(),
    pendingApprovals: new Map()
  }
  manager.hostShares.set('session-a', share)

  const socket = fakeSocket()
  const runtime = {
    store: {
      log: { replicate: () => {} },
      metaCore: { replicate: () => {} }
    }
  }
  manager._openHostChannel(share, runtime, new PearConnection(socket, null), b4a.alloc(16, 1))
  const peer = Array.from(share.peers)[0]

  t.ok(peer, 'peer was registered')
  t.is(share.peers.size, 1)
  peer.channel.close()
  t.is(share.peers.size, 0, 'channel close removes the peer')
  t.absent(socket.destroyed, 'socket remains available for other channels')
})

test('_disconnectHostPeer closes only the channel and never falls back to socket destroy', (t) => {
  const manager = new ShareManager({ sessions: new Map() })
  t.teardown(() => manager.close())
  let closed = 0
  let destroyed = 0

  manager._disconnectHostPeer({
    sessionId: 'session-a',
    linkId: 'link-a',
    channel: { close: () => closed++ },
    socket: { destroy: () => destroyed++ }
  })
  t.is(closed, 1)
  t.is(destroyed, 0)

  manager._disconnectHostPeer({
    sessionId: 'session-b',
    linkId: 'link-b',
    socket: { destroy: () => destroyed++ }
  })
  t.is(destroyed, 0, 'channel-less peers are logged but do not destroy the socket')
})

function fakeSocket() {
  const socket = new EventEmitter()
  socket.write = () => true
  socket.destroyed = false
  socket.userData = null
  socket.destroy = () => {
    if (socket.destroyed) return
    socket.destroyed = true
    socket.emit('close')
  }
  return socket
}

function temp() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-share-test-'))
}
