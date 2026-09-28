const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const sodium = require('sodium-native')

const { deriveSnapshotKey } = require('./crypto')
const { EngineError, CODES } = require('./errors')

const SNAPSHOT_CACHE_VERSION = 2

class SnapshotCache {
  constructor(root, sessionId, localDevice) {
    this.dir = path.join(root, sessionId)
    this.sessionId = sessionId
    this.key = deriveSnapshotKey(localDevice.secretKey)
    this.index = emptyIndex()
  }

  async ready() {
    await fs.promises.mkdir(this.dir, { recursive: true })
    try {
      this.index = JSON.parse(await fs.promises.readFile(this.indexPath, 'utf8'))
      if (this.index.version !== SNAPSHOT_CACHE_VERSION || !Array.isArray(this.index.snapshots)) {
        await this.clear()
        await fs.promises.mkdir(this.dir, { recursive: true })
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  get indexPath() {
    return path.join(this.dir, 'index.json')
  }

  // `opts.saveIndex: false` defers writing index.json to a later saveIndex(),
  // for a caller writing many snapshots in a row.
  async write(seq, frame, opts = {}) {
    await fs.promises.mkdir(this.dir, { recursive: true })
    const plain = Buffer.from(JSON.stringify(frame))
    const nonce = nonceFor(this.sessionId, seq)
    const ad = adFor(this.sessionId, seq)
    const out = b4a.alloc(plain.byteLength + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(out, plain, ad, null, nonce, this.key)
    const file = path.join(this.dir, `${String(seq).padStart(16, '0')}.snap`)
    await fs.promises.writeFile(file, out)
    this.index.version = SNAPSHOT_CACHE_VERSION
    this.index.snapshots = this.index.snapshots.filter((s) => s.seq !== seq)
    this.index.snapshots.push({ seq, bytes: out.byteLength })
    this.index.snapshots.sort((a, b) => a.seq - b.seq)
    if (opts.saveIndex !== false) await this.saveIndex()
  }

  async saveIndex() {
    await fs.promises.mkdir(this.dir, { recursive: true })
    await fs.promises.writeFile(this.indexPath, JSON.stringify(this.index, null, 2))
  }

  async read(seq) {
    const file = path.join(this.dir, `${String(seq).padStart(16, '0')}.snap`)
    const data = await fs.promises.readFile(file)
    const plain = b4a.alloc(data.byteLength - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)
    if (
      !sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        plain,
        null,
        data,
        adFor(this.sessionId, seq),
        nonceFor(this.sessionId, seq),
        this.key
      )
    ) {
      throw new EngineError(CODES.E_CORRUPT, `Snapshot ${seq} failed authentication`, { seq })
    }
    return JSON.parse(plain.toString('utf8'))
  }

  nearest(seq) {
    let best = null
    for (const item of this.index.snapshots) {
      if (item.seq > seq) break
      best = item
    }
    return best
  }

  async clear() {
    await fs.promises.rm(this.dir, { recursive: true, force: true })
    this.index = emptyIndex()
  }
}

function emptyIndex() {
  return { version: SNAPSHOT_CACHE_VERSION, snapshots: [] }
}

function nonceFor(sessionId, seq) {
  const nonce = b4a.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const digest = b4a.alloc(32)
  sodium.crypto_generichash(digest, Buffer.from(`snapshot:${sessionId}`))
  digest.copy(nonce, 0, 0, 16)
  nonce.writeBigUInt64BE(BigInt(seq), 16)
  return nonce
}

function adFor(sessionId, seq) {
  const seqBuf = b4a.alloc(8)
  seqBuf.writeBigUInt64BE(BigInt(seq))
  return Buffer.concat([Buffer.from(sessionId), seqBuf])
}

module.exports = SnapshotCache
