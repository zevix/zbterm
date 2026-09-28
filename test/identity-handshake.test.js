// Phase 5: identity claim exchange + live challenge during the join
// handshake. Same harness style as test/share-manager.test.js - fake sockets,
// a real Protomux channel per side, and hand-fed ctl messages - so both the
// host gate (_confirmJoin) and the viewer gate (confirm handling) run their
// real code paths, including the deny/abort branches.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-native')

const ShareManager = require('../engine/share-manager')
const { PearConnection } = require('../engine/backends/pear')
const { loadOrCreateLocalDevice } = require('../engine/crypto')
const { CODES } = require('../engine/errors')
const { VIEW_LIVE } = require('../engine/caps')
const {
  HASH_ALG,
  NAMESPACE,
  buildArmoredSignature,
  challengeBytes,
  claimBytes,
  encodeEd25519PublicKey,
  encodeRsaPublicKey,
  fingerprint,
  randomHex,
  signedDataBlob
} = require('../engine/identity/claim')
const { verifyPeerIdentity, inspectClaim } = require('../engine/identity/verify')

const LINK_ID = 'aa'.repeat(16)
const SESSION_ID = 'session-a'

test('host verifies a valid viewer claim, completes the join, and reports it in status()', async (t) => {
  const h = await hostHarness(t)
  const viewer = await identityFor(h.viewerDevice, 'alice')
  h.resolverKeys = [viewer.publishedKey]

  const startedAt = Date.now()
  const outcome = await h.join({
    identityClaim: viewer.claim,
    authKey: viewer.authKeyHex,
    respond: (challenge) => viewer.sign(challenge, h.hostDevice, h.viewerDevice)
  })
  const elapsed = Date.now() - startedAt

  t.is(outcome.type, 'confirm', 'the join completes')
  t.is(h.calls.putMember, 1, 'a member record is written for a verified peer')
  t.alike(
    h.events.map((event) => event.status),
    ['pending', 'verified'],
    'two share:peer-identity events, pending then verified'
  )
  const last = h.events[h.events.length - 1]
  t.is(last.direction, 'viewer')
  t.is(last.displayId, 'alice@github')
  t.is(last.provider, 'github')
  t.is(last.identityKey, h.identityKeyHex)
  t.is(last.deviceKey, h.deviceKeyHex)
  t.is(last.reason, null)

  const stored = h.store.peers.get(h.identityKeyHex)
  t.is(stored.status, 'verified', 'the outcome is persisted')
  t.is(stored.subject, 'alice')
  t.ok(stored.lastVerifiedAt > 0)

  const status = h.manager.status(SESSION_ID)
  t.alike(
    status.viewers,
    [
      {
        identityKey: h.identityKeyHex,
        deviceKey: h.deviceKeyHex,
        displayId: 'alice@github',
        status: 'verified'
      }
    ],
    'status() carries the verified viewer so session.list can render a badge'
  )
  // Re-planning signal 1: this is an in-process round trip (no socket, no
  // network), so it is a floor for the real thing, not a LAN measurement.
  t.comment(`in-process identity round trip + verification: ${elapsed}ms`)
  t.ok(elapsed < 1000, 'verification does not stall the join in-process')
})

// Phase 8: the claim signature may be RSA (rsa-sha2-512); the live challenge
// is ed25519 over the device auth key either way.
test('a viewer whose claim is signed by an RSA SSH key verifies and joins', async (t) => {
  const h = await hostHarness(t)
  const viewer = await identityFor(h.viewerDevice, 'alice', 'ssh-rsa')
  h.resolverKeys = [viewer.publishedKey]

  const outcome = await h.join({
    identityClaim: viewer.claim,
    authKey: viewer.authKeyHex,
    respond: (challenge) => viewer.sign(challenge, h.hostDevice, h.viewerDevice)
  })

  t.is(viewer.claim.sshKeyType, 'ssh-rsa')
  t.is(outcome.type, 'confirm', 'an RSA-signed claim completes the join')
  t.is(h.calls.putMember, 1)
  const last = h.events[h.events.length - 1]
  t.is(last.status, 'verified')
  t.is(last.displayId, 'alice@github')
  const stored = h.store.peers.get(h.identityKeyHex)
  t.is(stored.status, 'verified')
  t.is(stored.sshFingerprint, viewer.claim.sshFingerprint, 'the RSA fingerprint is persisted')
})

test('a viewer that presents no claim joins as unknown and is never challenged', async (t) => {
  const h = await hostHarness(t)

  const outcome = await h.join({ identityClaim: null, authKey: null })

  t.is(outcome.type, 'confirm', 'a peer with no claim still joins')
  t.is(h.calls.putMember, 1)
  t.absent(
    h.sent.some((message) => message.type === 'identity-challenge'),
    'no identity-challenge is sent to a peer that presented no claim'
  )
  t.alike(
    h.events.map((event) => event.status),
    ['unknown'],
    'the peer is recorded as unknown, with no pending state'
  )
  t.is(h.store.peers.get(h.identityKeyHex).status, 'unknown')
  t.is(h.manager.status(SESSION_ID).viewers[0].status, 'unknown')
})

test('a tampered claim is refused with E_AUTH and mints no member and no epoch', async (t) => {
  const h = await hostHarness(t)
  const viewer = await identityFor(h.viewerDevice, 'alice')
  h.resolverKeys = [viewer.publishedKey]
  // Signed as alice, presented as mallory: claimBytes covers `subject`, so
  // the SSHSIG no longer verifies.
  const tampered = { ...viewer.claim, subject: 'mallory' }

  const outcome = await h.join({
    identityClaim: tampered,
    authKey: viewer.authKeyHex,
    respond: (challenge) => viewer.sign(challenge, h.hostDevice, h.viewerDevice)
  })

  t.is(outcome.type, 'error', 'the peer is denied')
  t.is(outcome.code, CODES.E_AUTH)
  t.is(outcome.message, 'Identity verification failed')
  t.is(h.calls.putMember, 0, 'no member record was written')
  t.is(h.calls.rotateEpoch, 0, 'no epoch rotation happened')
  const last = h.events[h.events.length - 1]
  t.is(last.status, 'failed')
  t.ok(/signature does not verify/.test(last.reason), `reason explains the failure: ${last.reason}`)
  t.is(h.store.peers.get(h.identityKeyHex).status, 'failed')
})

test('a claim whose SSH key the provider does not publish is refused, naming the provider', async (t) => {
  const h = await hostHarness(t)
  const viewer = await identityFor(h.viewerDevice, 'alice')
  // github.com/alice.keys lists a completely different key.
  h.resolverKeys = [otherPublishedKey()]

  const outcome = await h.join({
    identityClaim: viewer.claim,
    authKey: viewer.authKeyHex,
    respond: (challenge) => viewer.sign(challenge, h.hostDevice, h.viewerDevice)
  })

  t.is(outcome.type, 'error')
  t.is(outcome.code, CODES.E_AUTH)
  t.is(h.calls.putMember, 0)
  const last = h.events[h.events.length - 1]
  t.is(last.status, 'failed')
  t.ok(/github/i.test(last.reason), `reason mentions the provider: ${last.reason}`)
})

test('a challenge answer signed for a different socket (relayed) does not verify', async (t) => {
  const h = await hostHarness(t)
  const viewer = await identityFor(h.viewerDevice, 'alice')
  h.resolverKeys = [viewer.publishedKey]
  const relayDevice = await device(await temp())

  // The relay forwards the host's challenge verbatim to the real key holder
  // on a *different* socket. The honest prover signs its own view of the two
  // DHT keys (verifier = the relay, prover = itself), which is not the view
  // the host verifies against - the anti-relay property.
  const outcome = await h.join({
    identityClaim: viewer.claim,
    authKey: viewer.authKeyHex,
    respond: (challenge) => viewer.sign(challenge, relayDevice, h.viewerDevice)
  })

  t.is(outcome.type, 'error', 'a relayed challenge answer is refused')
  const last = h.events[h.events.length - 1]
  t.is(last.status, 'failed')
  t.ok(/challenge signature does not verify/.test(last.reason), last.reason)

  // The same signature, checked directly with only proverDhtKey changed.
  const challenge = {
    sessionId: SESSION_ID,
    challengeId: randomHex(16),
    nonce: randomHex(32),
    verifierDhtKey: hex(h.hostDevice.dhtPublicKey),
    proverDhtKey: hex(h.viewerDevice.dhtPublicKey),
    role: 'viewer'
  }
  const signature = viewer.signChallenge(challenge)
  t.is(
    (
      await verifyPeerIdentity({
        claim: viewer.claim,
        authKey: viewer.authKeyHex,
        identityKey: h.identityKeyHex,
        challenge,
        signature,
        resolver: h.resolver
      })
    ).status,
    'verified',
    'the captured answer verifies for the socket it was made on'
  )
  t.is(
    (
      await verifyPeerIdentity({
        claim: viewer.claim,
        authKey: viewer.authKeyHex,
        identityKey: h.identityKeyHex,
        challenge: { ...challenge, proverDhtKey: hex(relayDevice.dhtPublicKey) },
        signature,
        resolver: h.resolver
      })
    ).status,
    'failed',
    'replayed onto a second socket (different proverDhtKey) it does not'
  )
})

test('a prover that never answers the challenge is refused after the identity timeout', async (t) => {
  const h = await hostHarness(t, { identityTimeoutMs: 60 })
  const viewer = await identityFor(h.viewerDevice, 'alice')
  h.resolverKeys = [viewer.publishedKey]

  const outcome = await h.join({
    identityClaim: viewer.claim,
    authKey: viewer.authKeyHex,
    respond: () => null
  })

  t.is(outcome.type, 'error', 'a silent prover with a claim is refused')
  t.is(outcome.code, CODES.E_AUTH)
  t.is(h.calls.putMember, 0)
  const last = h.events[h.events.length - 1]
  t.is(last.status, 'failed')
  t.ok(/did not answer the identity challenge/.test(last.reason), last.reason)
})

test('a resolver timeout allows the connection as unknown instead of refusing it', async (t) => {
  const h = await hostHarness(t)
  const viewer = await identityFor(h.viewerDevice, 'alice')
  h.resolver.resolve = async () => {
    throw new Error('timed out waiting for the ZBTerm shell')
  }

  const outcome = await h.join({
    identityClaim: viewer.claim,
    authKey: viewer.authKeyHex,
    respond: (challenge) => viewer.sign(challenge, h.hostDevice, h.viewerDevice)
  })

  t.is(outcome.type, 'confirm', 'an unreachable resolver never refuses a connection')
  t.is(h.calls.putMember, 1)
  const last = h.events[h.events.length - 1]
  t.is(last.status, 'unknown')
  t.is(last.reason, 'resolver-unreachable')
  t.is(h.store.peers.get(h.identityKeyHex).status, 'unknown')
})

test('viewer verifies the host claim on confirm and only then registers the remote session', async (t) => {
  const v = await viewerHarness(t)
  const host = await identityFor(v.hostDevice, 'octocat')
  v.resolverKeys = [host.publishedKey]

  await v.confirm({
    hostIdentityClaim: host.claim,
    hostAuthKey: host.authKeyHex,
    respond: (challenge) => host.sign(challenge, v.viewerDevice, v.hostDevice)
  })

  t.is(v.registered, 1, 'the remote session is registered once identity checks out')
  t.alike(
    v.events.map((event) => event.status),
    ['pending', 'verified']
  )
  const last = v.events[v.events.length - 1]
  t.is(last.direction, 'host')
  t.is(last.displayId, 'octocat@github')
  t.ok(
    v.joinEvents.some((event) => event.status === 'syncing' || event.status === 'joined'),
    'the join proceeds'
  )
  t.absent(v.finished && v.finished.status === 'failed', 'a verified host does not fail the join')
})

test('viewer aborts the join and destroys the socket when the host claim fails', async (t) => {
  const v = await viewerHarness(t)
  const host = await identityFor(v.hostDevice, 'octocat')
  v.resolverKeys = [otherPublishedKey()]

  await v.confirm({
    hostIdentityClaim: host.claim,
    hostAuthKey: host.authKeyHex,
    respond: (challenge) => host.sign(challenge, v.viewerDevice, v.hostDevice)
  })

  t.is(v.registered, 0, 'no remote session is registered for an unverified host')
  t.ok(v.finished, 'the join settles')
  t.is(v.finished.status, 'failed')
  t.is(v.finished.code, CODES.E_AUTH)
  t.is(v.finished.message, 'Host identity verification failed')
  t.ok(v.socket.destroyed, 'the socket is destroyed')
  t.is(v.events[v.events.length - 1].status, 'failed')
})

test('viewer treats a host that presents no claim as unknown and joins anyway', async (t) => {
  const v = await viewerHarness(t)

  await v.confirm({})

  t.is(v.registered, 1)
  t.alike(
    v.events.map((event) => event.status),
    ['unknown']
  )
  t.absent(
    v.sent.some((message) => message.type === 'identity-challenge'),
    'no challenge is issued to a host that presented no claim'
  )
})

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

async function hostHarness(t, opts = {}) {
  const hostDevice = await device(await temp())
  const viewerDevice = await device(await temp())
  const store = fakeStore()
  const harness = {
    hostDevice,
    viewerDevice,
    store,
    resolverKeys: [],
    events: [],
    sent: [],
    calls: { putMember: 0, rotateEpoch: 0 },
    identityKeyHex: hex(viewerDevice.identityPublicKey),
    deviceKeyHex: hex(viewerDevice.publicKey)
  }
  harness.resolver = {
    resolve: async () => ({
      status: 'ok',
      keys: harness.resolverKeys,
      fetchedAt: Date.now(),
      source: 'remote'
    })
  }

  const link = {
    linkId: LINK_ID,
    sessionId: SESSION_ID,
    type: 'group',
    maxViewers: 8,
    caps: VIEW_LIVE,
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
      meta: {
        get: async () => ({ value: link }),
        put: async () => {}
      },
      getMember: async () => null,
      putMember: async () => {
        harness.calls.putMember++
      },
      sealHistoryForMember: async () => {},
      listActiveMembers: async () => [],
      rotateEpoch: async () => {
        harness.calls.rotateEpoch++
        return { epoch: 2, envelopes: new Map() }
      }
    }
  }

  const manager = new ShareManager({
    localDevice: hostDevice,
    account: null,
    identityStore: store,
    identityResolver: harness.resolver,
    identityTimeoutMs: opts.identityTimeoutMs,
    sessions: new Map([[SESSION_ID, runtime]]),
    buildLiveBootstrap: async () => ({ seq: 1, cols: 80, rows: 24, data: '' })
  })
  t.teardown(() => manager.close())
  manager.on('share:peer-identity', (event) => harness.events.push(event))
  manager.on('error', () => {})

  const share = {
    sessionId: SESSION_ID,
    peers: new Set(),
    links: new Map([[LINK_ID, link]]),
    pendingApprovals: new Map(),
    inputCounters: new Map(),
    liveSeq: 0,
    timelineSyncedCount: 0
  }
  manager.hostShares.set(SESSION_ID, share)
  manager._linkIndex.set(LINK_ID, SESSION_ID)

  const socket = fakeSocket()
  socket.remotePublicKey = viewerDevice.dhtPublicKey
  manager._openHostChannel(
    share,
    runtime,
    new PearConnection(socket, null),
    b4a.from(LINK_ID, 'hex')
  )
  const peer = Array.from(share.peers)[0]

  harness.manager = manager
  harness.share = share
  harness.peer = peer

  // Drives one join-request through the real host handler, answering the
  // identity challenge with `respond` (return null to stay silent).
  harness.join = (request = {}) => {
    let settle = null
    const settled = new Promise((resolve) => {
      settle = resolve
    })
    peer.message.send = (message) => {
      harness.sent.push(message)
      if (message.type === 'identity-challenge') {
        const signature = request.respond ? request.respond(message) : null
        if (signature) {
          setImmediate(() =>
            peer.message.onmessage({
              type: 'identity-response',
              challengeId: message.challengeId,
              signature
            })
          )
        }
        return true
      }
      if (message.type === 'confirm' || message.type === 'error') settle(message)
      return true
    }
    peer.message.onmessage({
      type: 'join-request',
      linkId: LINK_ID,
      deviceKey: harness.deviceKeyHex,
      identityKey: harness.identityKeyHex,
      identityProof: hex(viewerDevice.identityProof),
      deviceName: 'viewer',
      identityClaim: request.identityClaim === undefined ? null : request.identityClaim,
      authKey: request.authKey === undefined ? null : request.authKey,
      appVersion: '1'
    })
    return settled
  }

  return harness
}

async function viewerHarness(t, opts = {}) {
  const hostDevice = await device(await temp())
  const viewerDevice = await device(await temp())
  const store = fakeStore()
  const harness = {
    hostDevice,
    viewerDevice,
    store,
    resolverKeys: [],
    events: [],
    joinEvents: [],
    sent: [],
    registered: 0,
    finished: null
  }
  harness.resolver = {
    resolve: async () => ({
      status: 'ok',
      keys: harness.resolverKeys,
      fetchedAt: Date.now(),
      source: 'remote'
    })
  }

  const manager = new ShareManager({
    localDevice: viewerDevice,
    identityStore: store,
    identityResolver: harness.resolver,
    identityTimeoutMs: opts.identityTimeoutMs,
    sessions: new Map(),
    remoteSessions: new Map(),
    registerRemoteSession: async () => {
      harness.registered++
      return {
        store: {
          log: { replicate: () => {}, download: () => ({}) },
          metaCore: { replicate: () => {}, download: () => ({}) }
        }
      }
    }
  })
  t.teardown(() => manager.close())
  manager.on('share:peer-identity', (event) => harness.events.push(event))
  manager.on('join:changed', (event) => harness.joinEvents.push(event))
  manager.on('error', () => {})

  const socket = fakeSocket()
  socket.remotePublicKey = hostDevice.dhtPublicKey
  const state = {
    invite: { linkId: LINK_ID },
    hostDhtKey: hostDevice.dhtPublicKey,
    connected: false,
    confirmed: false,
    downloads: [],
    // The real state.finish is idempotent (join() guards on state.done), so
    // the first settlement is the one that counts here too.
    finish: (status) => {
      if (!harness.finished) harness.finished = status
    }
  }
  manager._handleViewerConnection(state, new PearConnection(socket, null))

  harness.manager = manager
  harness.state = state
  harness.socket = socket

  harness.confirm = (message = {}) => {
    let settle = null
    const settled = new Promise((resolve) => {
      settle = resolve
    })
    state.message.send = (out) => {
      harness.sent.push(out)
      if (out.type === 'identity-challenge') {
        const signature = message.respond ? message.respond(out) : null
        if (signature) {
          setImmediate(() =>
            state.message.onmessage({
              type: 'identity-response',
              challengeId: out.challengeId,
              signature
            })
          )
        }
      }
      return true
    }
    const queued = state.message.onmessage({
      type: 'confirm',
      sessionId: SESSION_ID,
      info: { name: 'shared' },
      inputMode: 'host',
      logKey: hex(b4a.alloc(32, 1)),
      metaKey: hex(b4a.alloc(32, 2)),
      hostDeviceKey: hex(hostDevice.publicKey),
      envelope: null,
      hostIdentityClaim: message.hostIdentityClaim || null,
      hostAuthKey: message.hostAuthKey || null,
      bootstrap: null
    })
    Promise.resolve(queued).then(settle, settle)
    return settled
  }

  return harness
}

// The SSH key that signs a claim: ed25519 by default, RSA (rsa-sha2-512) when
// asked for. Node's crypto can build an RSA key here because nothing in this
// test ever touches an OpenSSH private-key file.
function sshSigner(keyType) {
  if (keyType === 'ssh-rsa') {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = privateKey.export({ format: 'jwk' })
    return {
      pubkeyBlob: encodeRsaPublicKey({
        e: b4a.from(jwk.e, 'base64'),
        n: b4a.from(jwk.n, 'base64')
      }),
      sign: (blob) => b4a.from(crypto.sign('sha512', blob, privateKey))
    }
  }
  const sshPublicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const sshSecretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(sshPublicKey, sshSecretKey)
  return {
    pubkeyBlob: encodeEd25519PublicKey(sshPublicKey),
    sign: (blob) => {
      const rawSig = b4a.alloc(sodium.crypto_sign_BYTES)
      sodium.crypto_sign_detached(rawSig, blob, sshSecretKey)
      return rawSig
    }
  }
}

// One SSH-signed identity claim plus the challenge signer that goes with it.
// inspectClaim is what the Join dialog runs against the claim carried inside an
// invite: layer 1 only, with no connection to challenge. It must agree with the
// handshake gate on every claim-level verdict, and must never report `verified`
// for something the handshake would refuse on claim grounds.
test('inspectClaim checks an invite claim without a connection', async (t) => {
  const device = await tmpDevice(t)
  const alice = await identityFor(device, 'alice')
  const published = okResolver([alice.publishedKey])

  const verified = await inspectClaim({ claim: alice.claim, resolver: published })
  t.is(verified.status, 'verified', 'a genuine claim whose key github publishes')
  t.is(verified.displayId, 'alice@github')
  t.is(verified.sshFingerprint, alice.claim.sshFingerprint)

  // The exact case the join dialog exists to catch: the claim is validly
  // signed, but github does not publish the signing key.
  const unpublished = await inspectClaim({ claim: alice.claim, resolver: okResolver([]) })
  t.is(unpublished.status, 'failed', 'a claim github does not back is failed')
  t.ok(/publishes no SSH keys/.test(unpublished.reason), unpublished.reason)

  const wrongKey = await inspectClaim({
    claim: alice.claim,
    resolver: okResolver([otherPublishedKey()])
  })
  t.is(wrongKey.status, 'failed', 'a key github does not list is failed')
  t.ok(/is not published by alice@github/.test(wrongKey.reason), wrongKey.reason)

  const tampered = { ...alice.claim, subject: 'mallory' }
  const forged = await inspectClaim({ claim: tampered, resolver: published })
  t.is(forged.status, 'failed', 'editing the signed subject breaks the signature')
  t.ok(/does not verify/.test(forged.reason), forged.reason)

  // No claim at all is the ordinary "this host never identified itself" case,
  // not an error - it must not read as a failure in the dialog.
  const none = await inspectClaim({ claim: null, resolver: published })
  t.is(none.status, 'unknown', 'an invite with no claim is unknown, not failed')
  t.is(none.reason, null)

  // An unreachable provider downgrades rather than refusing, matching the
  // handshake contract - otherwise an offline user could never join anything.
  const offline = await inspectClaim({
    claim: alice.claim,
    resolver: {
      resolve: async () => {
        throw new Error('offline')
      }
    }
  })
  t.is(offline.status, 'unknown', 'an unreachable provider downgrades')
  t.is(offline.reason, 'resolver-unreachable')
})

test('inspectClaim never passes what the handshake gate would refuse', async (t) => {
  const device = await tmpDevice(t)
  const alice = await identityFor(device, 'alice')
  const resolver = okResolver([otherPublishedKey()])

  const inspected = await inspectClaim({ claim: alice.claim, resolver })
  const gated = await verifyPeerIdentity({
    claim: alice.claim,
    identityKey: alice.claim.identityKey,
    authKey: alice.authKeyHex,
    challenge: { challengeId: 'c', nonce: 'n', role: 'viewer' },
    signature: 'not-a-signature',
    resolver
  })
  t.is(inspected.status, 'failed')
  t.is(gated.status, 'failed')
  t.is(inspected.reason, gated.reason, 'both report the same claim-level reason')
})

function okResolver(keys) {
  return {
    resolve: async () => ({ status: 'ok', keys, fetchedAt: Date.now(), source: 'remote' })
  }
}

async function tmpDevice(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbterm-inspect-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return await device(dir)
}

async function identityFor(deviceRecord, subject, keyType = 'ssh-ed25519') {
  const signer = sshSigner(keyType)
  const pubkeyBlob = signer.pubkeyBlob

  const claim = {
    version: 2,
    provider: 'github',
    subject,
    identityKey: hex(deviceRecord.identityPublicKey),
    authKey: hex(deviceRecord.authPublicKey),
    sshPublicKey: b4a.toString(pubkeyBlob, 'base64'),
    sshKeyType: keyType,
    sshFingerprint: fingerprint(pubkeyBlob),
    issuedAt: Date.now(),
    nonce: randomHex(16)
  }
  const rawSig = signer.sign(signedDataBlob(NAMESPACE, HASH_ALG, claimBytes(claim)))
  claim.signature = buildArmoredSignature({ pubkeyBlob, rawSig })

  const signChallengeWith = (challenge) => {
    const signature = b4a.alloc(sodium.crypto_sign_BYTES)
    sodium.crypto_sign_detached(signature, challengeBytes(challenge), deviceRecord.authSecretKey)
    return b4a.toString(signature, 'hex')
  }

  return {
    claim,
    authKeyHex: claim.authKey,
    publishedKey: {
      keyType,
      blobBase64: claim.sshPublicKey,
      fingerprint: claim.sshFingerprint
    },
    signChallenge: signChallengeWith,
    // Prover half of the wire protocol: fill in this side's own view of the
    // two DHT keys, which are never transmitted.
    sign: (message, verifierDevice, proverDevice) =>
      signChallengeWith({
        sessionId: message.sessionId || '',
        challengeId: message.challengeId,
        nonce: message.nonce,
        verifierDhtKey: hex(verifierDevice.dhtPublicKey),
        proverDhtKey: hex(proverDevice.dhtPublicKey),
        role: message.role
      })
  }
}

function otherPublishedKey() {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  const blob = encodeEd25519PublicKey(publicKey)
  return {
    keyType: 'ssh-ed25519',
    blobBase64: b4a.toString(blob, 'base64'),
    fingerprint: fingerprint(blob)
  }
}

function fakeStore() {
  const peers = new Map()
  return {
    peers,
    async putPeer(identityKey, patch) {
      const next = { ...(peers.get(identityKey) || {}), ...patch, identityKey }
      peers.set(identityKey, next)
      return next
    }
  }
}

async function device(root) {
  const record = await loadOrCreateLocalDevice({ root })
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  record.authPublicKey = publicKey
  record.authSecretKey = secretKey
  return record
}

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

function hex(value) {
  return value ? b4a.toString(value, 'hex') : null
}

function temp() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-identity-handshake-'))
}
