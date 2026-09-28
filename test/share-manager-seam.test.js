// Characterisation goldens for the share seam (backend-abstraction B1).
//
// These pin what a remote build, a pasted invite or a diagnostics consumer can
// observe today, so the phases that move transport code behind a backend
// interface can prove they changed none of it. A golden that breaks means the
// externally visible behaviour moved: fix the code, do not re-bless the value.
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-native')
const Protomux = require('protomux')
const c = require('compact-encoding')
const { Duplex } = require('streamx')

const ShareManager = require('../engine/share-manager')
const { PearConnection } = require('../engine/backends/pear')
const invite = require('../engine/invite')
const { CODES } = require('../engine/errors')
const { loadOrCreateLocalDevice } = require('../engine/crypto')
const { VIEW_LIVE } = require('../engine/caps')
const { challengeBytes, signChallenge, verifyChallenge } = require('../engine/identity/claim')

const LINK_ID = 'aa'.repeat(16)
const SESSION_ID = 'session-a'
const TOPIC = '11'.repeat(32)
const HOST_KEY = '22'.repeat(32)

const V1_PAYLOAD = { v: 2, linkId: LINK_ID, topic: TOPIC, hostDhtKey: HOST_KEY, claim: null }
const V1_URI =
  'zbterm://join/eyJ2IjoyLCJsaW5rSWQiOiJhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYSIsInRvcGljIjoiMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMSIsImhvc3REaHRLZXkiOiIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyIiwiY2xhaW0iOm51bGx9'

test('golden: encodeLink output for a fixed payload', (t) => {
  withInviteV2(t, undefined)
  t.is(ShareManager.LINK_PREFIX, 'zbterm://join/')
  t.is(ShareManager.encodeLink(V1_PAYLOAD), V1_URI, 'the v1 invite bytes are unchanged')
  t.is(ShareManager.encodeLink, invite.encodeLink, 'share-manager re-exports the codec')
  t.is(ShareManager.decodeLink, invite.decodeLink)
  t.is(ShareManager.LINK_PREFIX, invite.LINK_PREFIX)
})

test('golden: diagnostics() key set', async (t) => {
  const h = await hostHarness(t)
  await h.autoJoin()
  h.manager.joins.set('join-a', {
    invite: invite.decodeLink(V1_URI),
    connected: false,
    confirmed: false,
    sessionId: null
  })
  const diag = h.manager.diagnostics()
  h.manager.joins.clear()

  t.alike(Object.keys(diag), [
    'relayPublicKey',
    'relayFallbackMs',
    'hostSwarm',
    'hostShares',
    'joins',
    // B6 (R-7): appended; every key above keeps its place and meaning.
    'backend'
  ])
  t.is(diag.backend.id, 'pear', 'the active backend reports itself')
  t.is(diag.backend.hostSwarm, diag.hostSwarm, 'the top-level keys alias the backend report')
  t.is(diag.hostSwarm, null, 'no swarm exists until a link is created or joined')
  t.alike(Object.keys(diag.hostShares[0]), [
    'sessionId',
    'peers',
    'pendingApprovals',
    'links',
    'peerDetails',
    'inputCounters'
  ])
  t.alike(Object.keys(diag.hostShares[0].links[0]), [
    'linkId',
    'topic',
    'type',
    'maxViewers',
    'caps',
    'canSendInput',
    'viewers',
    'autoJoin',
    'revoked',
    'consumed'
  ])
  t.alike(Object.keys(diag.hostShares[0].peerDetails[0]), [
    'confirmed',
    'linkId',
    'caps',
    'canViewLive',
    'canSendInput',
    'deviceKey',
    'inputCtr'
  ])
  t.alike(Object.keys(diag.joins[0]), [
    'linkId',
    'topic',
    'hostDhtKey',
    'connected',
    'confirmed',
    'sessionId',
    'inputMode',
    'inputCtr'
  ])
  t.is(diag.joins[0].topic, TOPIC)
  t.is(diag.joins[0].hostDhtKey, HOST_KEY)
})

// The viewer presents no identity claim, so no `host:identity:result` appears:
// that event is only emitted when there is a claim to verify.
test('golden: host debug event order for an auto-join over a real Protomux pair', async (t) => {
  const h = await hostHarness(t)
  const confirm = await h.autoJoin()

  t.is(confirm.type, 'confirm', 'the auto-join completes')
  t.alike(
    h.debug.map((entry) => entry.event),
    [
      'host:socket:connection',
      'host:ctl:open',
      'host:ctl:message',
      'host:join-request',
      'host:join-confirm',
      'host:bootstrap:sent'
    ]
  )
  t.alike(h.debug[0].details, {
    remotePublicKey: hex(h.viewerDevice.dhtPublicKey),
    client: false,
    server: true
  })
  t.alike(h.debug[2].details, { sessionId: SESSION_ID, type: 'join-request', linkId: LINK_ID })
})

test('golden: identity-challenge signed bytes for fixed keys', (t) => {
  const challenge = {
    sessionId: SESSION_ID,
    challengeId: '01'.repeat(16),
    nonce: '02'.repeat(32),
    verifierDhtKey: '03'.repeat(32),
    proverDhtKey: '04'.repeat(32),
    role: 'viewer'
  }
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, b4a.alloc(32, 7))

  t.is(
    b4a.toString(challengeBytes(challenge), 'ascii'),
    'zbterm-identity-challenge/v1\n' +
      'sessionId=session-a\n' +
      'challengeId=01010101010101010101010101010101\n' +
      'nonce=0202020202020202020202020202020202020202020202020202020202020202\n' +
      'verifierDhtKey=0303030303030303030303030303030303030303030303030303030303030303\n' +
      'proverDhtKey=0404040404040404040404040404040404040404040404040404040404040404\n' +
      'role=viewer\n'
  )
  const signature = signChallenge(secretKey, challenge)
  t.is(hex(publicKey), GOLDEN_AUTH_PUBLIC_KEY)
  t.is(hex(signature), GOLDEN_CHALLENGE_SIGNATURE)
  t.ok(verifyChallenge(publicKey, challenge, signature))
  t.absent(verifyChallenge(publicKey, { ...challenge, proverDhtKey: '05'.repeat(32) }, signature))
})

const GOLDEN_AUTH_PUBLIC_KEY = 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c'
// 2026-09-28 (Z3 of docs/projects/260928_zbterm-fork/): recomputed after the
// SSHSIG namespace and challenge magic moved from zbterm-identity* to
// zbterm-identity* (D-23: no compatibility with the old wire bytes is kept).
const GOLDEN_CHALLENGE_SIGNATURE =
  '4aa6f6c5d707ab4ae785abb6ec9ab3029cb0a72be101297509b6a6bcf61d13fca007fa6ace21bf2bbb4efbf3113b7f89a562b62078474bda529eb0ccef77b408'

// ---- invite codec (engine/invite.js) ----

test('invite codec: v1 round trip keeps every v1 field', (t) => {
  withInviteV2(t, undefined)
  const claim = { provider: 'github', subject: 'alice' }
  const decoded = invite.decodeLink(invite.encodeLink({ ...V1_PAYLOAD, claim }))
  t.is(decoded.v, 2)
  t.is(decoded.linkId, LINK_ID)
  t.is(decoded.topic, TOPIC)
  t.is(decoded.hostDhtKey, HOST_KEY)
  t.alike(decoded.claim, claim)
})

test('invite codec: a v1 payload decodes to the normalised shape', (t) => {
  const decoded = invite.decodeLink(V1_URI)
  t.alike(decoded, {
    v: 2,
    linkId: LINK_ID,
    topic: TOPIC,
    hostDhtKey: HOST_KEY,
    claim: null,
    b: 'pear',
    peer: HOST_KEY,
    route: { topic: TOPIC }
  })
})

test('invite codec: v2 round trip, and v2 emission keeps the v1 fields', (t) => {
  withInviteV2(t, '1')
  const uri = invite.encodeLink(V1_PAYLOAD)
  t.not(uri, V1_URI, 'ZBTERM_INVITE_V2=1 changes the emitted shape')
  t.alike(rawPayload(uri), {
    v: 2,
    b: 'pear',
    linkId: LINK_ID,
    peer: HOST_KEY,
    route: { topic: TOPIC },
    topic: TOPIC,
    hostDhtKey: HOST_KEY,
    claim: null
  })
  t.alike(invite.decodeLink(uri), invite.decodeLink(V1_URI), 'both shapes normalise identically')

  // A pure v2 payload (no v1 fields) still decodes, and still surfaces the
  // v1 names so existing callers keep working.
  const pure = rawUri({
    v: 2,
    b: 'pear',
    linkId: LINK_ID,
    peer: HOST_KEY,
    route: { topic: TOPIC },
    claim: null
  })
  const decoded = invite.decodeLink(pure)
  t.is(decoded.b, 'pear')
  t.is(decoded.peer, HOST_KEY)
  t.alike(decoded.route, { topic: TOPIC })
  t.is(decoded.topic, TOPIC)
  t.is(decoded.hostDhtKey, HOST_KEY)

  // `b` is carried through untouched; nothing raises on it in this phase.
  t.is(invite.decodeLink(rawUri({ ...rawPayload(pure), b: 'freenet' })).b, 'freenet')
})

test('invite codec: a bad host key is rejected', (t) => {
  const rejects = (payload, why) => {
    try {
      invite.decodeLink(rawUri(payload))
      t.fail(why)
    } catch (err) {
      t.is(err.code, CODES.E_AUTH, why)
    }
  }
  const { hostDhtKey, ...noKey } = V1_PAYLOAD
  t.ok(hostDhtKey)
  rejects(noKey, 'a missing host key')
  rejects({ ...V1_PAYLOAD, hostDhtKey: '22'.repeat(31) }, 'a short host key')
  rejects({ ...V1_PAYLOAD, hostDhtKey: 'zz'.repeat(32) }, 'a non-hex host key')
  rejects(
    { v: 2, b: 'pear', linkId: LINK_ID, peer: 'nope', route: { topic: TOPIC } },
    'a bad v2 peer'
  )
  rejects({ ...V1_PAYLOAD, peer: '33'.repeat(32) }, 'a v2 peer that contradicts hostDhtKey')
  rejects({ ...V1_PAYLOAD, route: { topic: '44'.repeat(32) } }, 'a v2 route that contradicts topic')
  try {
    invite.decodeLink('https://example.com/' + V1_URI.slice(invite.LINK_PREFIX.length))
    t.fail('a foreign prefix')
  } catch (err) {
    t.is(err.code, CODES.E_AUTH, 'a foreign prefix')
  }
})

test('the backend error codes exist', (t) => {
  t.is(CODES.E_BACKEND_UNSUPPORTED, 'E_BACKEND_UNSUPPORTED')
  t.is(CODES.E_BACKEND_UNAVAILABLE, 'E_BACKEND_UNAVAILABLE')
})

// ---- helpers ----

function withInviteV2(t, value) {
  const before = process.env.ZBTERM_INVITE_V2
  if (value === undefined) delete process.env.ZBTERM_INVITE_V2
  else process.env.ZBTERM_INVITE_V2 = value
  t.teardown(() => {
    if (before === undefined) delete process.env.ZBTERM_INVITE_V2
    else process.env.ZBTERM_INVITE_V2 = before
  })
}

function rawUri(payload) {
  return invite.LINK_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url')
}

function rawPayload(uri) {
  return JSON.parse(Buffer.from(uri.slice(invite.LINK_PREFIX.length), 'base64url').toString('utf8'))
}

// Two in-memory message streams wired back to back: what one side writes the
// other receives as one `data` event, which is the framing Protomux expects.
function duplexPair() {
  const make = () =>
    new Duplex({
      write(data, cb) {
        this.other.push(data)
        cb(null)
      },
      final(cb) {
        this.other.push(null)
        cb(null)
      }
    })
  const a = make()
  const b = make()
  a.other = b
  b.other = a
  a.userData = null
  b.userData = null
  return [a, b]
}

// A real host ShareManager over mocked storage, reached through a real
// Protomux on each end of a duplex pair. The viewer end is a bare Protomux
// channel speaking `zbterm/ctl`, exactly what a remote build would open.
async function hostHarness(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-seam-test-'))
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  const hostDevice = await loadOrCreateLocalDevice({ root: path.join(dir, 'host') })
  const viewerDevice = await loadOrCreateLocalDevice({ root: path.join(dir, 'viewer') })

  const link = {
    linkId: LINK_ID,
    sessionId: SESSION_ID,
    topic: TOPIC,
    type: 'group',
    maxViewers: 8,
    caps: VIEW_LIVE,
    viewers: 0,
    autoJoin: true,
    revoked: false
  }
  const runtime = {
    inputMode: 'host',
    store: {
      sessionId: SESSION_ID,
      epoch: 1,
      keys: { liveKey: b4a.alloc(32, 3) },
      info: { name: 'shared' },
      timeline: [],
      log: { key: b4a.alloc(32, 1), length: 0, replicate: () => {} },
      metaCore: { key: b4a.alloc(32, 2), replicate: () => {} },
      writerDeviceKey: hostDevice.publicKey,
      localDevice: hostDevice,
      meta: { get: () => resolved({ value: link }), put: () => resolved() },
      getMember: () => resolved(null),
      putMember: () => resolved(),
      sealHistoryForMember: () => resolved(),
      listActiveMembers: () => resolved([]),
      rotateEpoch: () => resolved({ epoch: 2, envelopes: new Map() })
    }
  }

  const manager = new ShareManager({
    localDevice: hostDevice,
    account: null,
    sessions: new Map([[SESSION_ID, runtime]]),
    buildLiveBootstrap: () => resolved({ seq: 1, cols: 80, rows: 24, data: '' })
  })
  t.teardown(() => manager.close())
  manager.on('error', () => {})
  const debug = []
  manager.on('debug', (entry) => {
    if (entry.event.startsWith('host:')) debug.push(entry)
  })

  manager.hostShares.set(SESSION_ID, {
    sessionId: SESSION_ID,
    peers: new Set(),
    links: new Map([[LINK_ID, link]]),
    pendingApprovals: new Map(),
    inputCounters: new Map(),
    liveSeq: 0,
    timelineSyncedCount: 0
  })
  manager._linkIndex.set(LINK_ID, SESSION_ID)

  const autoJoin = () =>
    new Promise((resolve, reject) => {
      const [hostSocket, viewerSocket] = duplexPair()
      hostSocket.remotePublicKey = viewerDevice.dhtPublicKey
      t.teardown(() => {
        hostSocket.destroy()
        viewerSocket.destroy()
      })
      // What the Pear backend does for an inbound swarm socket: wrap it and
      // emit it, once, as a 'connection'.
      const info = { client: false, server: true }
      manager.backend.emit('connection', new PearConnection(hostSocket, info), info)

      const mux = Protomux.from(viewerSocket)
      const channel = mux.createChannel({ protocol: 'zbterm/ctl', id: b4a.from(LINK_ID, 'hex') })
      const message = channel.addMessage({
        encoding: c.json,
        onmessage: (msg) => {
          if (msg.type === 'confirm') resolve(msg)
          if (msg.type === 'error') reject(new Error(msg.message || msg.code))
        }
      })
      channel.open()
      message.send({
        type: 'join-request',
        linkId: LINK_ID,
        deviceKey: hex(viewerDevice.publicKey),
        identityKey: hex(viewerDevice.identityPublicKey),
        identityProof: hex(viewerDevice.identityProof),
        deviceName: 'viewer',
        identityClaim: null,
        authKey: null,
        appVersion: '1'
      })
    })

  return { manager, hostDevice, viewerDevice, debug, autoJoin }
}

function resolved(value) {
  return Promise.resolve(value)
}

function hex(value) {
  return value ? b4a.toString(value, 'hex') : null
}
