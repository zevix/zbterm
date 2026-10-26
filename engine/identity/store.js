// A profile's identity records - the local claim (`self.json`) and one file
// per remote peer (`peers/<identityKeyHex>.json`) - as a thin call-through
// to the Rust `zxterm-core` sidecar (K9 of zxterm-core, in `zevix/zxterm`;
// not this directory's own JS package, `zbterm-core`), whose
// `zxterm_core::identity::store` owns the files now. The sidecar serves
// `<profile>/identity`, so `root` must be a directory named `identity`: the
// sidecar is opened on its parent (`<profile>/account` in a SessionEngine).
// Record shapes are exactly the ones this module wrote before.
const path = require('path')

const { VERSION } = require('../schema')
const { EngineError, CODES } = require('../errors')
const { openCore } = require('../zxterm/core')
const { claimJson } = require('./claim')
const { UNKNOWN } = require('./providers')

const PEER_STATUS = ['unknown', 'pending', 'verified', 'failed']
const PROVIDER_CACHE_DIR = 'provider-cache'

class IdentityStore {
  constructor(root, opts = {}) {
    this.root = root
    if (opts.core) {
      this.core = opts.core
    } else {
      if (path.basename(root) !== 'identity') {
        throw new EngineError(
          CODES.E_INTERNAL,
          `IdentityStore root must be a directory named "identity" (got ${root})`
        )
      }
      this.core = openCore(path.dirname(root))
    }
  }

  // The sidecar creates `peers/` and `provider-cache/` itself.
  async ready() {
    await this.core.request('identity.peers', {})
  }

  async getSelf() {
    const record = await this.core.request('identity.self', {})
    if (!record || record.version === undefined || record.version === null) return null
    return selfShape(record)
  }

  async setSelf(record) {
    if (!record || typeof record !== 'object') {
      throw new EngineError(CODES.E_AUTH, 'Identity claim is required')
    }
    const claim = claimJson(record)
    const saved = await this.core.request('identity.setSelf', {
      record: {
        provider: String(record.provider),
        subject: claim.subject,
        identityKeyHex: String(record.identityKey || ''),
        authKeyHex: claim.authKey,
        sshPublicKeyBase64: claim.sshPublicKey,
        sshKeyType: record.sshKeyType || undefined,
        sshFingerprint: claim.sshFingerprint,
        issuedAt: claim.issuedAt,
        nonce: claim.nonce,
        signature: claim.signature,
        createdAt: record.createdAt || undefined
      }
    })
    return selfShape(saved)
  }

  async clearSelf(identityKey = null) {
    const cleared = await this.core.request('identity.clear', {
      identityKeyHex: identityKey ? String(identityKey) : undefined
    })
    return selfShape(cleared)
  }

  async listPeers() {
    const answer = await this.core.request('identity.peers', {})
    return answer.peers
  }

  async getPeer(idHex) {
    return await this.core.request('identity.getPeer', { identityKeyHex: normalizeKey(idHex) })
  }

  async putPeer(idHex, patch = {}) {
    const clean = {}
    for (const key of Object.keys(patch)) {
      if (patch[key] !== undefined) clean[key] = patch[key]
    }
    if (clean.status && !PEER_STATUS.includes(clean.status)) {
      throw new EngineError(CODES.E_INTERNAL, `Unknown peer status: ${clean.status}`)
    }
    return await this.core.request('identity.putPeer', {
      identityKeyHex: normalizeKey(idHex),
      patch: clean
    })
  }
}

// `self.json`'s shapes, as this module returned them: a minimal record for
// `unknown`, the full claim otherwise.
function selfShape(record) {
  if (record.provider === UNKNOWN) {
    return {
      version: VERSION,
      provider: UNKNOWN,
      identityKey: record.identityKey,
      createdAt: record.createdAt
    }
  }
  return {
    version: VERSION,
    provider: record.provider,
    subject: record.subject,
    identityKey: record.identityKey,
    authKey: record.authKey,
    sshPublicKey: record.sshPublicKey,
    sshKeyType: record.sshKeyType,
    sshFingerprint: record.sshFingerprint,
    issuedAt: record.issuedAt,
    nonce: record.nonce,
    signature: record.signature,
    createdAt: record.createdAt
  }
}

function normalizeKey(idHex) {
  const value = String(idHex || '').toLowerCase()
  if (!/^[0-9a-f]{2,128}$/.test(value)) {
    throw new EngineError(CODES.E_INTERNAL, 'Peer identity key must be hex')
  }
  return value
}

module.exports = { IdentityStore, PEER_STATUS, PROVIDER_CACHE_DIR }
