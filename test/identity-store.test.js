const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-native')

const SessionEngine = require('../engine')
const PtyHost = require('../electron/pty-host')
const { IdentityStore } = require('../engine/identity/store')
const { getProvider } = require('../engine/identity/providers')
const {
  NAMESPACE,
  HASH_ALG,
  claimBytes,
  signedDataBlob,
  buildArmoredSignature,
  encodeEd25519PublicKey,
  fingerprint
} = require('../engine/identity/claim')

test('identity store round trips a signed self claim', async (t) => {
  const store = await freshStore(t)
  const { claim, signature } = signedClaim()

  const written = await store.setSelf({ ...claim, signature })
  const read = await store.getSelf()

  t.is(written.provider, 'github')
  t.alike(read, written)
  t.is(read.subject, 'octocat')
  t.is(read.version, 2)
  t.is(getProvider(read.provider).displayId(read.subject), 'octocat@github')
  t.is(await mode(path.join(store.root, 'self.json')), 0o600)
})

test('identity store rejects a claim whose signature does not match its bytes', async (t) => {
  const store = await freshStore(t)
  const { claim, signature } = signedClaim()

  await t.exception(
    store.setSelf({ ...claim, subject: 'someone-else', signature }),
    /signature does not verify/
  )
  await t.exception(
    store.setSelf({ ...claim, signature: undefined }),
    /Identity claim is not signed/
  )
  await t.exception(
    store.setSelf({ ...claim, sshFingerprint: 'SHA256:nope', signature }),
    /fingerprint mismatch/
  )
  t.is(await store.getSelf(), null, 'nothing was written')
})

test('identity store validates the provider and the github username', async (t) => {
  const store = await freshStore(t)
  const { claim, signature } = signedClaim()

  await t.exception(
    store.setSelf({ ...claim, provider: 'gitlab', signature }),
    /Unknown identity provider: gitlab/
  )
  t.is(getProvider('unknown').displayId('a'.repeat(64)), 'aaaaaaaaaaaa@UNKNOWN')
  t.exception(() => getProvider('github').validateSubject('-bad'), /Invalid github username/)
  t.exception(() => getProvider('github').validateSubject('a'.repeat(40)), /Invalid github/)
  t.is(getProvider('github').validateSubject('OctoCat'), 'octocat')
})

test('annotatePeer preserves prior status fields and peer files are 0o600', async (t) => {
  const store = await freshStore(t)
  const idHex = 'ab'.repeat(32)

  await store.putPeer(idHex, {
    provider: 'github',
    subject: 'octocat',
    status: 'verified',
    lastVerifiedAt: 1750000000000,
    lastSeenAt: 1750000000001,
    sshFingerprint: 'SHA256:abc'
  })
  const annotated = await store.putPeer(idHex, { localName: 'Alice', localComment: 'laptop' })

  t.is(annotated.status, 'verified')
  t.is(annotated.lastVerifiedAt, 1750000000000)
  t.is(annotated.sshFingerprint, 'SHA256:abc')
  t.is(annotated.displayId, 'octocat@github')
  t.is(annotated.localName, 'Alice')
  t.is(annotated.localComment, 'laptop')
  t.is(await mode(path.join(store.root, 'peers', `${idHex}.json`)), 0o600)

  const reseen = await store.putPeer(idHex, { status: 'pending', lastSeenAt: 1750000000002 })
  t.is(reseen.localName, 'Alice', 'a status patch never drops local annotations')
  t.is(reseen.localComment, 'laptop')

  const unknownPeer = await store.putPeer('cd'.repeat(32), {})
  t.is(unknownPeer.status, 'unknown')
  t.is(unknownPeer.displayId, `${'cd'.repeat(32).slice(0, 12)}@UNKNOWN`)
  t.is((await store.listPeers()).length, 2)
})

test('clearSelf drops to unknown and leaves peers intact', async (t) => {
  const store = await freshStore(t)
  const { claim, signature } = signedClaim()
  await store.setSelf({ ...claim, signature })
  await store.putPeer('ab'.repeat(32), { status: 'verified', localName: 'Alice' })

  const cleared = await store.clearSelf()
  const self = await store.getSelf()
  const peers = await store.listPeers()

  t.is(cleared.provider, 'unknown')
  t.is(self.provider, 'unknown')
  t.is(self.identityKey, claim.identityKey)
  t.absent(self.signature)
  t.is(peers.length, 1)
  t.is(peers[0].localName, 'Alice')
})

test('engine ready installs a device auth keypair and never rotates it', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const engine = new SessionEngine({ userData: dir, ptyHost: new PtyHost() })
  await engine.ready()
  let record = null
  try {
    const profile = await engine.account.getProfile()
    record = await engine.account.getDevice(profile.localDeviceKey)

    t.ok(record.authPublicKey, 'device record carries an auth public key')
    t.ok(record.authSecretKey, 'device record carries an auth secret key')
    t.is(record.version, 2, 'the device record version is untouched')
    t.is(b4a.from(record.authPublicKey, 'hex').byteLength, sodium.crypto_sign_PUBLICKEYBYTES)
    t.is(b4a.from(record.authSecretKey, 'hex').byteLength, sodium.crypto_sign_SECRETKEYBYTES)
    t.is(
      b4a.toString(engine.localDevice.authPublicKey, 'hex'),
      record.authPublicKey,
      'engine.localDevice.authPublicKey is materialized'
    )
  } finally {
    await engine.close().catch(() => {})
  }

  const reopened = new SessionEngine({ userData: dir, ptyHost: new PtyHost() })
  await reopened.ready()
  try {
    const profile = await reopened.account.getProfile()
    const again = await reopened.account.getDevice(profile.localDeviceKey)
    t.is(again.authPublicKey, record.authPublicKey, 'a second ready() does not rotate the key')
    t.is(again.authSecretKey, record.authSecretKey)
  } finally {
    await reopened.close().catch(() => {})
  }
})

test('engine identity methods mint, install, annotate and clear identities', async (t) => {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))

  const engine = new SessionEngine({ userData: dir, ptyHost: new PtyHost() })
  await engine.ready()
  try {
    const profile = await engine.account.getProfile()
    const record = await engine.account.getDevice(profile.localDeviceKey)
    const self = await engine.invoke('identity.self')
    t.is(self.configured, false)
    t.is(self.provider, 'unknown')
    t.is(self.displayId, `${self.identityKey.slice(0, 12)}@UNKNOWN`)
    t.is(self.authKey, record.authPublicKey)

    const get = await engine.invoke('identity.get')
    t.is(get.provider, 'unknown')
    t.is(get.displayId, self.displayId)
    t.is(get.deviceKey, profile.localDeviceKey, 'identity.get still returns device keys')

    const key = ed25519()
    const begun = await engine.invoke('identity.beginClaim', {
      provider: 'github',
      subject: 'OctoCat',
      sshPublicKey: b4a.toString(key.pubkeyBlob, 'base64')
    })
    t.is(begun.claim.subject, 'octocat')
    t.is(begun.claim.identityKey, self.identityKey)
    t.is(begun.claim.authKey, self.authKey)
    t.is(begun.claim.sshFingerprint, fingerprint(key.pubkeyBlob))
    t.is(begun.claim.nonce.length, 32)
    t.alike(b4a.from(begun.bytes, 'base64'), claimBytes(begun.claim))

    const events = []
    engine.on('identity:changed', (payload) => events.push(payload))

    await t.exception(
      engine.invoke('identity.setSelf', {
        claim: begun.claim,
        signature: sign(ed25519(), claimBytes(begun.claim))
      }),
      /signature does not verify|fingerprint mismatch/
    )

    const installed = await engine.invoke('identity.setSelf', {
      claim: begun.claim,
      signature: sign(key, claimBytes(begun.claim))
    })
    t.is(installed.configured, true)
    t.is(installed.displayId, 'octocat@github')
    t.is(events.length, 1, 'identity:changed fired once')
    t.is(events[0].displayId, 'octocat@github')

    const annotated = await engine.invoke('identity.annotatePeer', {
      identityKey: 'ab'.repeat(32),
      name: 'Alice',
      comment: 'work laptop'
    })
    t.is(annotated.localName, 'Alice')
    t.is((await engine.invoke('identity.peers')).length, 1)

    const cleared = await engine.invoke('identity.clear')
    t.is(cleared.configured, false)
    t.is(cleared.provider, 'unknown')
    t.is(events.length, 2)
  } finally {
    await engine.close().catch(() => {})
  }
})

function signedClaim() {
  const key = ed25519()
  const claim = {
    version: 2,
    provider: 'github',
    subject: 'octocat',
    identityKey: 'a'.repeat(64),
    authKey: 'b'.repeat(64),
    sshPublicKey: b4a.toString(key.pubkeyBlob, 'base64'),
    sshKeyType: 'ssh-ed25519',
    sshFingerprint: fingerprint(key.pubkeyBlob),
    issuedAt: 1750000000000,
    nonce: 'c'.repeat(32)
  }
  return { claim, signature: sign(key, claimBytes(claim)) }
}

function ed25519() {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey, pubkeyBlob: encodeEd25519PublicKey(publicKey) }
}

function sign(key, message) {
  const rawSig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(rawSig, signedDataBlob(NAMESPACE, HASH_ALG, message), key.secretKey)
  return buildArmoredSignature({ pubkeyBlob: key.pubkeyBlob, rawSig })
}

async function freshStore(t) {
  const dir = await temp()
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  const store = new IdentityStore(path.join(dir, 'account', 'identity'))
  await store.ready()
  return store
}

async function mode(file) {
  return (await fs.promises.stat(file)).mode & 0o777
}

function temp() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-identity-test-'))
}
