// On-disk identity records for one profile: the local claim (`self.json`) and
// one file per remote peer (`peers/<identityKeyHex>.json`). Same storage rules
// as AccountStore: JSON, mode 0o600, tmp file + rename, `version: VERSION` on
// every record.
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')

const { VERSION } = require('../schema')
const { EngineError, CODES } = require('../errors')
const { claimBytes, fingerprint, parseArmoredSignature, verifySshSignature } = require('./claim')
const { UNKNOWN, getProvider } = require('./providers')

const PEER_STATUS = ['unknown', 'pending', 'verified', 'failed']
const PROVIDER_CACHE_DIR = 'provider-cache'

class IdentityStore {
  constructor(root) {
    this.root = root
  }

  async ready() {
    await fs.promises.mkdir(path.join(this.root, 'peers'), { recursive: true })
    await fs.promises.mkdir(path.join(this.root, PROVIDER_CACHE_DIR), { recursive: true })
  }

  // Cached provider key lists (`provider-cache/<provider>/<subject>.json`),
  // written by IdentityResolver. A corrupt or unreadable entry is a cache
  // miss, never an error: the worst case is one extra lookup.
  async readProviderCache(provider, subject) {
    const key = providerCacheKey(provider, subject)
    let record = null
    try {
      record = await this._readJson(key)
    } catch {
      return null
    }
    if (!record || record.version !== VERSION) return null
    return {
      version: record.version,
      provider: record.provider,
      subject: record.subject,
      status: record.status,
      keys: Array.isArray(record.keys) ? record.keys : [],
      fetchedAt: typeof record.fetchedAt === 'number' ? record.fetchedAt : 0
    }
  }

  async writeProviderCache(provider, subject, { status, keys, fetchedAt }) {
    const record = {
      version: VERSION,
      provider: getProvider(provider).id,
      subject: getProvider(provider).validateSubject(subject),
      status,
      keys: Array.isArray(keys) ? keys : [],
      fetchedAt: typeof fetchedAt === 'number' ? fetchedAt : Date.now()
    }
    await this._writeJson(providerCacheKey(provider, subject), record)
    return record
  }

  async getSelf() {
    const record = await this._readJson('self')
    if (!record) return null
    assertVersion(record)
    return record
  }

  async setSelf(record) {
    if (!record || typeof record !== 'object') {
      throw new EngineError(CODES.E_AUTH, 'Identity claim is required')
    }
    const provider = getProvider(record.provider)
    if (provider.id === UNKNOWN) {
      const unknown = {
        version: VERSION,
        provider: UNKNOWN,
        identityKey: String(record.identityKey || ''),
        createdAt: record.createdAt || Date.now()
      }
      await this._writeJson('self', unknown)
      return unknown
    }
    verifyClaimSignature(record)
    const next = {
      version: VERSION,
      provider: provider.id,
      subject: provider.validateSubject(record.subject),
      identityKey: String(record.identityKey || ''),
      authKey: String(record.authKey || ''),
      sshPublicKey: record.sshPublicKey || null,
      sshKeyType: record.sshKeyType || 'ssh-ed25519',
      sshFingerprint: record.sshFingerprint,
      issuedAt: record.issuedAt,
      nonce: record.nonce,
      signature: record.signature,
      createdAt: record.createdAt || Date.now()
    }
    await this._writeJson('self', next)
    return next
  }

  async clearSelf(identityKey = null) {
    const record = {
      version: VERSION,
      provider: UNKNOWN,
      identityKey: String(identityKey || (await this.getSelf())?.identityKey || ''),
      createdAt: Date.now()
    }
    await this._writeJson('self', record)
    return record
  }

  async listPeers() {
    const dir = path.join(this.root, 'peers')
    let names = []
    try {
      names = await fs.promises.readdir(dir)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    const peers = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const record = await this._readJson(`peers/${name.slice(0, -5)}`)
      if (record) {
        assertVersion(record)
        peers.push(record)
      }
    }
    peers.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
    return peers
  }

  async getPeer(idHex) {
    const record = await this._readJson(`peers/${normalizeKey(idHex)}`)
    if (!record) return null
    assertVersion(record)
    return record
  }

  async putPeer(idHex, patch = {}) {
    const identityKey = normalizeKey(idHex)
    const previous = (await this.getPeer(identityKey)) || emptyPeer(identityKey)
    const next = { ...previous }
    for (const key of Object.keys(patch)) {
      const value = patch[key]
      if (value === undefined) continue
      // Local annotations are user data: a patch that does not carry them (or
      // carries null) must never wipe them.
      if ((key === 'localName' || key === 'localComment') && value === null) continue
      next[key] = value
    }
    next.version = VERSION
    next.identityKey = identityKey
    if (next.status && !PEER_STATUS.includes(next.status)) {
      throw new EngineError(CODES.E_INTERNAL, `Unknown peer status: ${next.status}`)
    }
    if (!next.status) next.status = 'unknown'
    next.displayId = peerDisplayId(next)
    await this._writeJson(`peers/${identityKey}`, next)
    return next
  }

  _path(key) {
    return path.join(this.root, ...key.split('/')) + '.json'
  }

  async _readJson(key) {
    try {
      return JSON.parse(await fs.promises.readFile(this._path(key), 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') return null
      if (err instanceof SyntaxError) {
        throw new EngineError(CODES.E_CORRUPT, `Corrupt identity record: ${key}`)
      }
      throw err
    }
  }

  async _writeJson(key, value) {
    assertVersion(value)
    const file = this._path(key)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    await fs.promises.rename(tmp, file)
    await fs.promises.chmod(file, 0o600).catch(() => {})
  }
}

// `provider` and `subject` both go through the registry first, so a subject
// can never carry a path separator into the cache directory.
function providerCacheKey(provider, subject) {
  const entry = getProvider(provider)
  const value = entry.validateSubject(subject)
  // The `unknown` provider accepts any string; nothing may build a path out of
  // one that is not a plain filename.
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new EngineError(CODES.E_AUTH, `Invalid identity subject: ${value}`)
  }
  return `${PROVIDER_CACHE_DIR}/${entry.id}/${value}`
}

function emptyPeer(identityKey) {
  return {
    version: VERSION,
    identityKey,
    provider: UNKNOWN,
    subject: null,
    displayId: getProvider(UNKNOWN).displayId(identityKey),
    status: 'unknown',
    lastVerifiedAt: null,
    lastSeenAt: null,
    localName: null,
    localComment: null,
    sshFingerprint: null,
    failureReason: null
  }
}

function peerDisplayId(peer) {
  const provider = getProvider(peer.provider || UNKNOWN)
  if (provider.id === UNKNOWN) return provider.displayId(peer.identityKey)
  return provider.displayId(peer.subject)
}

function verifyClaimSignature(record) {
  if (!record.signature) {
    throw new EngineError(CODES.E_AUTH, 'Identity claim is not signed')
  }
  const parsed = parseArmoredSignature(record.signature)
  const actual = fingerprint(parsed.pubkeyBlob)
  if (record.sshFingerprint !== actual) {
    throw new EngineError(
      CODES.E_AUTH,
      `Identity claim fingerprint mismatch: claim says ${record.sshFingerprint}, signature is ${actual}`
    )
  }
  if (record.sshPublicKey && record.sshPublicKey !== b4a.toString(parsed.pubkeyBlob, 'base64')) {
    throw new EngineError(CODES.E_AUTH, 'Identity claim public key does not match its signature')
  }
  const ok = verifySshSignature({
    message: claimBytes(record),
    armored: record.signature,
    expectedPublicKeyBlob: parsed.pubkeyBlob
  })
  if (!ok) throw new EngineError(CODES.E_AUTH, 'Identity claim signature does not verify')
}

function normalizeKey(idHex) {
  const value = String(idHex || '').toLowerCase()
  if (!/^[0-9a-f]{2,128}$/.test(value)) {
    throw new EngineError(CODES.E_INTERNAL, 'Peer identity key must be hex')
  }
  return value
}

function assertVersion(record) {
  if (!record || record.version !== VERSION) {
    throw new EngineError(CODES.E_CORRUPT, 'Unsupported identity record version')
  }
}

module.exports = { IdentityStore, PEER_STATUS, PROVIDER_CACHE_DIR }
