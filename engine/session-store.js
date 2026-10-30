const fs = require('fs')
const path = require('path')
const Hypercore = require('hypercore')
const Hyperbee = require('hyperbee')
const b4a = require('b4a')

const {
  VERSION,
  PacketKind,
  PacketKindName,
  StoredPacket,
  PlainPacket,
  SessionInfo,
  encode,
  decode
} = require('./schema')
const {
  generateEpochKey,
  deriveHistoryKey,
  deriveLiveKey,
  deriveHistoryCacheKey,
  encryptPacket,
  decryptPacket,
  sealEnvelope,
  openEnvelope
} = require('./crypto')
const { EngineError, CODES } = require('./errors')
const { FULL_CAPS, READ_HISTORY, VIEW_LIVE, hasCap } = require('./caps')

const MAX_PACKET_BYTES = 64 * 1024
const NORMAL_REPACK_MAX_MS = 1200
const NORMAL_REPACK_MAX_BYTES = 64 * 1024

class SessionStore {
  constructor(opts) {
    this.root = opts.root
    this.sessionId = opts.sessionId
    this.localDevice = opts.localDevice
    this.log = null
    this.metaCore = null
    this.meta = null
    this.info = null
    this.epoch = 1
    this.keys = null
    this.keysByEpoch = new Map()
    this.writerDeviceKey = opts.writerDeviceKey || null
    this.timeline = []
    this.timelineDirty = false
    this._timelineFlushQueue = Promise.resolve()
    this._timelineTempCounter = 0
    this.remote = !!opts.remote
    // A joined Freenet session (zxterm K17, ZBTerm D-40): the log is a local
    // cache of the packets the core verified, sealed under this device's own
    // key, and the session's history is the core's. `null` for every other
    // store (Pear, local, loopback: their log is the history, D-18).
    this.historyCache = !!opts.historyCache
    // Hex Ed25519 key that signs the host's history (the segment-v1
    // contract's `host` parameter); a viewer learns it from the host.
    this.historyVerifyingKey = opts.verifyingKey || null
    this.historyInfoReady = !!opts.verifyingKey
    // Called `(seq, plainPacket)` after every append, in order: the host's
    // history feed (engine/zxterm/history.js::HostHistory).
    this.onAppend = null
    // While a history copy fills seqs 1..pendingHistoryLength in the
    // background (see beginHistoryCopy), 0 otherwise.
    this.pendingHistoryLength = 0
    this.pendingHistorySeeded = false
  }

  // `opts.initialResize: false` leaves the new recording empty, for a caller
  // that copies history in first (see appendCopied) and records the first
  // resize after it.
  static async create(root, localDevice, info, opts = {}) {
    const tempId = `creating-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const tempDir = path.join(root, tempId)
    await fs.promises.mkdir(tempDir, { recursive: true })

    const log = new Hypercore(path.join(tempDir, 'log'))
    await log.ready()
    const sessionId = b4a.toString(log.discoveryKey, 'hex')
    await log.close()

    const finalDir = path.join(root, sessionId)
    await fs.promises.rename(tempDir, finalDir)
    const store = new SessionStore({ root, sessionId, localDevice })
    try {
      await store.ready()
      await store.initialize(info, opts)
    } catch (err) {
      // A half-seeded recording must not linger as a session of its own.
      await store._abandon()
      await fs.promises.rm(finalDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
    return store
  }

  // `opts.timeline: false` skips loading the timeline, for a short-lived open
  // that only reads packets (a history copy reopens its source once per slice).
  static async open(root, sessionId, localDevice, opts = {}) {
    const store = new SessionStore({ root, sessionId, localDevice })
    try {
      await store.ready()
      await store.load(opts)
    } catch (err) {
      await store._abandon()
      throw err
    }
    return store
  }

  static async openJoined(root, sessionId, localDevice) {
    const manifest = await readRemoteManifest(root, sessionId)
    const store = new SessionStore({
      root,
      sessionId,
      localDevice,
      writerDeviceKey: manifest.hostDeviceKey ? b4a.from(manifest.hostDeviceKey, 'hex') : null,
      remote: true,
      historyCache: !!manifest.core,
      verifyingKey: manifest.verifyingKey
    })
    try {
      await store.ready(manifest.core ? {} : { logKey: manifest.logKey, metaKey: manifest.metaKey })
      store.loadRemoteManifest(manifest)
      await store.loadTimeline()
    } catch (err) {
      await store._abandon()
      throw err
    }
    return store
  }

  static async openRemote(root, sessionId, localDevice, opts = {}) {
    await prepareRemoteDirectory(root, sessionId, opts)
    const store = new SessionStore({
      root,
      sessionId,
      localDevice,
      writerDeviceKey: opts.hostDeviceKey ? b4a.from(opts.hostDeviceKey, 'hex') : null,
      remote: true,
      historyCache: !!opts.core
    })
    await store.ready(opts.core ? {} : { logKey: opts.logKey, metaKey: opts.metaKey })
    store.info = {
      version: VERSION,
      name: opts.info && opts.info.name ? opts.info.name : 'Shared session',
      createdAt: opts.info && opts.info.createdAt ? opts.info.createdAt : Date.now(),
      flags: (opts.info && opts.info.flags) || { sensitive: false, quickCatchupKB: 0 },
      cols: opts.info && opts.info.cols ? opts.info.cols : 100,
      rows: opts.info && opts.info.rows ? opts.info.rows : 30,
      hostDeviceKey: opts.hostDeviceKey
    }
    store.writerDeviceKey = opts.hostDeviceKey
      ? b4a.from(opts.hostDeviceKey, 'hex')
      : localDevice.publicKey
    const env = openEnvelope(
      localDevice.publicKey,
      localDevice.secretKey,
      b4a.from(opts.envelope, 'hex')
    )
    store.epoch = env.epoch
    store.keys = {
      masterKey: env.masterKey,
      historyKey: env.historyKey,
      liveKey: env.liveKey
    }
    store.keysByEpoch.set(store.epoch, store.keys)
    await store.writeRemoteManifest({
      version: VERSION,
      sessionId,
      ...(opts.core ? { core: true } : { logKey: opts.logKey, metaKey: opts.metaKey }),
      hostDeviceKey: opts.hostDeviceKey,
      epoch: store.epoch,
      envelope: opts.envelope,
      ...(opts.core ? { envelopes: { [store.epoch]: opts.envelope } } : {}),
      info: store.info
    })
    try {
      await store.loadTimeline()
    } catch (err) {
      if (opts.replaceCorrupt === false || !(err instanceof EngineError)) throw err
      await store.close().catch(() => {})
      await fs.promises.rm(store.dir, { recursive: true, force: true })
      return SessionStore.openRemote(root, sessionId, localDevice, {
        ...opts,
        replaceCorrupt: false
      })
    }
    return store
  }

  // Applies a freshly-rotated epoch's envelope pushed by the host over the
  // live control channel (see ShareManager's 'rekey' message). Must move
  // this.epoch forward so subsequent appendPlain/live-encrypt calls (host
  // side) or decrypt calls (viewer side reading new live traffic) use the
  // new keys, while older epochs stay decryptable via keysByEpoch/meta.
  async applyEpochEnvelope(epoch, envelopeHex) {
    const env = openEnvelope(
      this.localDevice.publicKey,
      this.localDevice.secretKey,
      b4a.from(envelopeHex, 'hex')
    )
    const keys = {
      masterKey: env.masterKey,
      historyKey: env.historyKey,
      liveKey: env.liveKey
    }
    this.keysByEpoch.set(epoch, keys)
    if (epoch > this.epoch) {
      this.epoch = epoch
      this.keys = keys
      if (this.remote) {
        const manifest = await readRemoteManifest(this.root, this.sessionId).catch(() => null)
        if (manifest) {
          await this.writeRemoteManifest({
            ...manifest,
            epoch,
            envelope: envelopeHex,
            ...(manifest.core
              ? { envelopes: { ...(manifest.envelopes || {}), [epoch]: envelopeHex } }
              : {})
          })
        }
      }
    } else if (this.historyCache) {
      await this._rememberEnvelopes({ [epoch]: envelopeHex })
    }
    return keys
  }

  // What the host told this viewer of its history (zxterm K17, D-40): the key
  // its head is signed with and the envelopes of the epochs before the one
  // this device joined in, as `{ verifyingKey, envelopes: {epoch: hex} }`.
  // Kept in the joined-session manifest, so the contract can be read, and
  // decrypted, in a later run with the host gone.
  async applyHistoryInfo(info) {
    if (!this.historyCache) return
    const envelopes = {}
    for (const [epoch, envelopeHex] of Object.entries(info.envelopes || {})) {
      const env = openEnvelope(
        this.localDevice.publicKey,
        this.localDevice.secretKey,
        b4a.from(envelopeHex, 'hex')
      )
      if (!env.historyKey) continue
      const number = Number(epoch)
      if (!this.keysByEpoch.has(number)) {
        this.keysByEpoch.set(number, {
          masterKey: env.masterKey,
          historyKey: env.historyKey,
          liveKey: env.liveKey
        })
      }
      envelopes[number] = envelopeHex
    }
    if (typeof info.verifyingKey === 'string' && info.verifyingKey.length === 64) {
      this.historyVerifyingKey = info.verifyingKey
    }
    await this._rememberEnvelopes(envelopes, this.historyVerifyingKey)
    this.historyInfoReady = true
  }

  async _rememberEnvelopes(envelopes, verifyingKey) {
    const manifest = await readRemoteManifest(this.root, this.sessionId).catch(() => null)
    if (!manifest || !manifest.core) return
    await this.writeRemoteManifest({
      ...manifest,
      envelopes: { ...(manifest.envelopes || {}), ...envelopes },
      ...(verifyingKey ? { verifyingKey } : {})
    })
  }

  // `{ "<epoch>": historyKeyHex }` for every epoch this device holds a
  // history key of: what the core opens a segment with.
  historyKeysHex() {
    const out = {}
    for (const [epoch, keys] of this.keysByEpoch) {
      if (keys && keys.historyKey) out[String(epoch)] = b4a.toString(keys.historyKey, 'hex')
    }
    return out
  }

  // Appends packets the core verified (`{seq, tsMs, kind, cols, rows,
  // payload, hd}`, consecutive, the first at `log.length + 1`) to a joined
  // Freenet session's local cache.
  async appendVerified(packets) {
    if (!this.historyCache) {
      throw new EngineError(CODES.E_INTERNAL, 'Only a joined Freenet session caches core history')
    }
    if (!packets.length) return this.log.length
    const blocks = []
    const entries = []
    let expected = this.log.length + 1
    for (const packet of packets) {
      if (packet.seq !== expected) {
        throw new EngineError(CODES.E_INTERNAL, `History packet ${packet.seq} is out of order`)
      }
      blocks.push(
        this._seal(expected, {
          version: VERSION,
          tsMs: packet.tsMs,
          kind: packet.kind,
          cols: packet.cols,
          rows: packet.rows,
          payload: packet.payload,
          hd: !!packet.hd
        })
      )
      entries.push({ seq: expected, tsMs: packet.tsMs, hd: !!packet.hd })
      expected++
    }
    await this.log.append(blocks)
    // The host's timeline messages may already have named these seqs.
    this.timeline = addTimelineEntries(this.timeline, entries)
    this.timelineDirty = true
    return this.log.length
  }

  get dir() {
    return path.join(this.root, this.sessionId)
  }

  async ready(opts = {}) {
    await fs.promises.mkdir(this.dir, { recursive: true })
    this.log = opts.logKey
      ? new Hypercore(path.join(this.dir, 'log'), b4a.from(opts.logKey, 'hex'))
      : new Hypercore(path.join(this.dir, 'log'))
    this.metaCore = opts.metaKey
      ? new Hypercore(path.join(this.dir, 'meta'), b4a.from(opts.metaKey, 'hex'))
      : new Hypercore(path.join(this.dir, 'meta'))
    this.meta = new Hyperbee(this.metaCore, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    await this.log.ready()
    await this.meta.ready()
  }

  async initialize(info, opts = {}) {
    const epochKey = generateEpochKey()
    const historyKey = deriveHistoryKey(epochKey)
    const liveKey = deriveLiveKey(epochKey)
    const fullInfo = {
      version: VERSION,
      name: info.name,
      createdAt: info.createdAt || Date.now(),
      flags: { sensitive: false, quickCatchupKB: 0 },
      cols: info.cols || 100,
      rows: info.rows || 30,
      hostDeviceKey: b4a.toString(this.localDevice.publicKey, 'hex')
    }
    const envelope = sealEnvelope(this.localDevice.publicKey, {
      version: VERSION,
      sessionId: this.sessionId,
      epoch: 1,
      caps: FULL_CAPS,
      masterKey: epochKey,
      historyKey,
      liveKey
    })

    await this.meta.put('session/info', {
      encoded: b4a.toString(encode(SessionInfo, fullInfo), 'hex'),
      value: fullInfo
    })
    await this.meta.put('epoch/1', {
      version: VERSION,
      startSeq: 1,
      createdAt: fullInfo.createdAt,
      reason: 'create'
    })
    await this.meta.put('env/1/local', b4a.toString(envelope, 'hex'))
    await this.meta.put('epoch/current', 1)
    this.info = fullInfo
    this.writerDeviceKey = this.localDevice.publicKey
    this.epoch = 1
    this.keys = { masterKey: epochKey, historyKey, liveKey }
    this.keysByEpoch.set(1, this.keys)
    if (opts.initialResize !== false) await this.appendResize(fullInfo.cols, fullInfo.rows)
  }

  // Marks seqs 1..length as history that appendCopied is about to fill. With
  // `timeline` (the source's entries for exactly those seqs) the whole
  // timeline is known up front, the way a joined session's is; only the part
  // already copied is ever written to disk.
  beginHistoryCopy(length, timeline = null) {
    if (this.remote) throw new EngineError(CODES.E_INTERNAL, 'Remote sessions are read-only')
    if (this.log.length) {
      throw new EngineError(CODES.E_INTERNAL, 'History can only be copied into a new session')
    }
    this.pendingHistoryLength = length
    this.pendingHistorySeeded = !!timeline
    if (timeline) this.timeline = timeline
  }

  // Appends packets read from another store (its readRange output), each
  // re-sealed under this store's own keys at the same seq and keeping its
  // timestamp, kind, geometry, payload and HD flag, so the copy replays exactly
  // like the original and the source's snapshots stay valid for it.
  async appendCopied(packets) {
    if (this.remote) throw new EngineError(CODES.E_INTERNAL, 'Remote sessions are read-only')
    if (!packets.length) return this.log.length
    const start = this.log.length
    const blocks = []
    const entries = []
    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i]
      const seq = start + i + 1
      if (packet.seq !== seq) {
        throw new EngineError(CODES.E_INTERNAL, `Copied packet ${packet.seq} is out of order`)
      }
      blocks.push(
        this._seal(seq, {
          version: VERSION,
          tsMs: packet.tsMs,
          kind: packet.kind,
          cols: packet.cols,
          rows: packet.rows,
          payload: packet.payload,
          hd: !!packet.hd
        })
      )
      entries.push({ seq, tsMs: packet.tsMs, hd: !!packet.hd })
    }
    await this.log.append(blocks)
    if (!this.pendingHistorySeeded) this.timeline.push(...entries)
    this.timelineDirty = true
    return this.log.length
  }

  // Ends a history copy, finished or not: the timeline keeps only the seqs
  // that were actually copied.
  async endHistoryCopy() {
    if (this.pendingHistorySeeded && this.timeline.length > this.log.length) {
      this.timeline = this.timeline.slice(0, this.log.length)
    }
    this.pendingHistoryLength = 0
    this.pendingHistorySeeded = false
    this.timelineDirty = true
    await this.flushTimeline()
  }

  async load(opts = {}) {
    const infoNode = await this.meta.get('session/info')
    if (!infoNode) throw new EngineError(CODES.E_CORRUPT, 'Missing session info')
    this.info = infoNode.value.value || decode(SessionInfo, b4a.from(infoNode.value.encoded, 'hex'))
    this.writerDeviceKey = this.info.hostDeviceKey
      ? b4a.from(this.info.hostDeviceKey, 'hex')
      : this.localDevice.publicKey
    const currentNode = await this.meta.get('epoch/current')
    this.epoch = currentNode && Number.isFinite(currentNode.value) ? currentNode.value : 1
    this.keys = await this._loadLocalEpochKeys(this.epoch)
    if (opts.timeline !== false) await this.loadTimeline()
  }

  // Loads (and caches) the keys this local device holds for a given epoch.
  // Used both to encrypt/decrypt the current epoch and to decrypt older
  // packets still on disk from before the most recent rotation - each
  // rotation writes a fresh envelope per epoch rather than overwriting the
  // previous one, so old epochs stay readable to whoever was authorized for
  // them at the time (see rotateEpoch/sealHistoryForMember).
  async _loadLocalEpochKeys(epoch) {
    if (this.keysByEpoch.has(epoch)) return this.keysByEpoch.get(epoch)
    const deviceEnvKey = `env/${epoch}/${b4a.toString(this.localDevice.publicKey, 'hex')}`
    // 'env/<epoch>/local' is only ever sealed to the *host's* own device key
    // (see initialize()/rotateEpoch()). It lives in the same meta Hyperbee
    // that gets replicated to every viewer, so a remote/viewer store must
    // never read it - it would find the host's envelope and fail to open it
    // with its own secret key. Only the host's own store instance (remote
    // === false) may use that shortcut; everyone else looks up their own
    // device-keyed entry.
    const envNode = this.remote
      ? await this.meta.get(deviceEnvKey)
      : (await this.meta.get(`env/${epoch}/local`)) || (await this.meta.get(deviceEnvKey))
    if (!envNode) {
      throw new EngineError(CODES.E_NOKEY, `Missing local envelope for epoch ${epoch}`)
    }
    const env = openEnvelope(
      this.localDevice.publicKey,
      this.localDevice.secretKey,
      b4a.from(envNode.value, 'hex')
    )
    const keys = {
      masterKey: env.masterKey,
      historyKey: env.historyKey,
      liveKey: env.liveKey
    }
    this.keysByEpoch.set(epoch, keys)
    return keys
  }

  // Mints a new epoch: a fresh master/history/live key sealed to this
  // device plus every device in `members` (their currently-granted caps
  // decide which of historyKey/liveKey they receive - never masterKey).
  // Must be called whenever membership or access changes in a way that
  // affects confidentiality (join, removal, cap change) per the session's
  // key-rotation requirement. Callers control the `members` list, so
  // excluding a device here is how revocation stops future key material
  // from reaching it.
  async rotateEpoch(members = [], reason = 'rotate') {
    if (this.remote) {
      throw new EngineError(CODES.E_INTERNAL, 'Only the host can rotate session keys')
    }
    const newEpoch = this.epoch + 1
    const epochKey = generateEpochKey()
    const historyKey = deriveHistoryKey(epochKey)
    const liveKey = deriveLiveKey(epochKey)

    await this.meta.put(`epoch/${newEpoch}`, {
      version: VERSION,
      startSeq: this.log.length + 1,
      createdAt: Date.now(),
      reason
    })

    const selfEnvelope = sealEnvelope(this.localDevice.publicKey, {
      version: VERSION,
      sessionId: this.sessionId,
      epoch: newEpoch,
      caps: FULL_CAPS,
      masterKey: epochKey,
      historyKey,
      liveKey
    })
    await this.meta.put(`env/${newEpoch}/local`, b4a.toString(selfEnvelope, 'hex'))

    const envelopes = new Map()
    for (const member of members) {
      const caps = Number.isFinite(member.caps) ? member.caps : 0
      const envelope = sealEnvelope(b4a.from(member.deviceKeyHex, 'hex'), {
        version: VERSION,
        sessionId: this.sessionId,
        epoch: newEpoch,
        caps,
        masterKey: null,
        historyKey: hasCap(caps, READ_HISTORY) ? historyKey : null,
        liveKey: hasCap(caps, VIEW_LIVE) ? liveKey : null
      })
      const envelopeHex = b4a.toString(envelope, 'hex')
      await this.meta.put(`env/${newEpoch}/${member.deviceKeyHex}`, envelopeHex)
      envelopes.set(member.deviceKeyHex, envelopeHex)
    }

    await this.meta.put('epoch/current', newEpoch)
    this.epoch = newEpoch
    this.keys = { masterKey: epochKey, historyKey, liveKey }
    this.keysByEpoch.set(newEpoch, this.keys)
    return { epoch: newEpoch, envelopes }
  }

  // Seals every epoch up to (but not including) the epoch a rotation is
  // about to mint, so a newly-granted READ_HISTORY device can decrypt the
  // backlog that _syncTimelineToPeer/_syncSnapshotsToPeer already push to
  // it. Without this a new viewer's history sync would arrive but fail to
  // decrypt, since older packets stay encrypted under their original
  // epoch's historyKey forever (keys are never re-encrypted retroactively).
  //
  // `opts.upTo` stops at that epoch instead: on a Freenet share the core mints
  // the epochs it holds (`applyCoreEpoch`) and seals its own history envelopes
  // for those, so this covers only the ones before them.
  async sealHistoryForMember(deviceKeyHex, caps, opts = {}) {
    if (this.remote) throw new EngineError(CODES.E_INTERNAL, 'Only the host can distribute keys')
    if (!hasCap(caps, READ_HISTORY)) return
    const upTo = Number.isFinite(opts.upTo) ? Math.min(opts.upTo, this.epoch) : this.epoch
    for (let epoch = 1; epoch <= upTo; epoch++) {
      const keys = await this._loadLocalEpochKeys(epoch)
      const envelope = sealEnvelope(b4a.from(deviceKeyHex, 'hex'), {
        version: VERSION,
        sessionId: this.sessionId,
        epoch,
        caps,
        masterKey: null,
        historyKey: keys.historyKey,
        liveKey: null
      })
      await this.meta.put(`env/${epoch}/${deviceKeyHex}`, b4a.toString(envelope, 'hex'))
    }
  }

  // Installs an epoch the core minted for a Freenet share (`share.epoch`,
  // zxterm K13/K14; protocol.md section 4): `rotateEpoch`'s effects with the
  // keys and the sealed envelopes coming from the core, which persists
  // nothing itself. `event.local` is the host's own envelope (hex, sealed to
  // this device), `event.envelopes` one per member device (`{deviceKeyHex:
  // envelopeHex}`) and `event.history` the earlier epochs' history-key
  // envelopes of a joiner (`[{deviceKey, epoch, envelope}]`); the last two
  // are empty, and nothing at all is written, when `event.persist` is false
  // (a sensitive session: the keys then live in memory only).
  async applyCoreEpoch(event) {
    if (this.remote) {
      throw new EngineError(CODES.E_INTERNAL, 'Only the host can rotate session keys')
    }
    const epoch = event.epoch
    const env = openEnvelope(
      this.localDevice.publicKey,
      this.localDevice.secretKey,
      b4a.from(event.local, 'hex')
    )
    const keys = { masterKey: env.masterKey, historyKey: env.historyKey, liveKey: env.liveKey }
    if (event.persist !== false) {
      await this.meta.put(`epoch/${epoch}`, {
        version: VERSION,
        startSeq: this.log.length + 1,
        createdAt: Date.now(),
        reason: event.reason || 'rotate'
      })
      await this.meta.put(`env/${epoch}/local`, event.local)
      for (const [deviceKeyHex, envelopeHex] of Object.entries(event.envelopes || {})) {
        await this.meta.put(`env/${epoch}/${deviceKeyHex}`, envelopeHex)
      }
      for (const item of event.history || []) {
        await this.meta.put(`env/${item.epoch}/${item.deviceKey}`, item.envelope)
      }
      if (epoch > this.epoch) await this.meta.put('epoch/current', epoch)
    }
    this.keysByEpoch.set(epoch, keys)
    if (epoch > this.epoch) {
      this.epoch = epoch
      this.keys = keys
    }
    return keys
  }

  async putMember(identityKeyHex, member = {}) {
    await this.meta.put(`member/${identityKeyHex}`, {
      version: VERSION,
      devices: [member.deviceKeyHex],
      caps: Number.isFinite(member.caps) ? member.caps : FULL_CAPS,
      linkId: member.linkId || null,
      status: 'active',
      since: Date.now(),
      name: member.deviceName || 'viewer'
    })
  }

  async getMember(identityKeyHex) {
    const node = await this.meta.get(`member/${identityKeyHex}`)
    return node ? node.value : null
  }

  async setMemberStatus(identityKeyHex, status) {
    const node = await this.meta.get(`member/${identityKeyHex}`)
    if (!node) return null
    const next = { ...node.value, status, updatedAt: Date.now() }
    await this.meta.put(`member/${identityKeyHex}`, next)
    return next
  }

  // Members currently entitled to future key material - excludes anyone
  // revoked, and optionally one identity (eg. the member just being
  // removed, before it's been marked revoked yet).
  async listActiveMembers(excludeIdentityHex) {
    const out = []
    for await (const node of this.meta.createReadStream({ gt: 'member/', lt: 'member0' })) {
      const identityKeyHex = node.key.slice('member/'.length)
      if (excludeIdentityHex && identityKeyHex === excludeIdentityHex) continue
      const member = node.value
      if (member.status !== 'active') continue
      const deviceKeyHex = Array.isArray(member.devices) ? member.devices[0] : member.devices
      if (!deviceKeyHex) continue
      out.push({ identityKeyHex, deviceKeyHex, caps: member.caps, linkId: member.linkId || null })
    }
    return out
  }

  async updateInfo(patch) {
    if (!this.info) await this.load()
    const value = { ...this.info, ...patch }
    await this.meta.put('session/info', {
      encoded: b4a.toString(encode(SessionInfo, value), 'hex'),
      value
    })
    this.info = value
    return value
  }

  loadRemoteManifest(manifest) {
    this.info = {
      version: VERSION,
      name: manifest.info && manifest.info.name ? manifest.info.name : 'Shared session',
      createdAt: manifest.info && manifest.info.createdAt ? manifest.info.createdAt : Date.now(),
      flags: (manifest.info && manifest.info.flags) || { sensitive: false, quickCatchupKB: 0 },
      cols: manifest.info && manifest.info.cols ? manifest.info.cols : 100,
      rows: manifest.info && manifest.info.rows ? manifest.info.rows : 30,
      hostDeviceKey: manifest.hostDeviceKey
    }
    this.writerDeviceKey = manifest.hostDeviceKey
      ? b4a.from(manifest.hostDeviceKey, 'hex')
      : this.localDevice.publicKey
    const env = openEnvelope(
      this.localDevice.publicKey,
      this.localDevice.secretKey,
      b4a.from(manifest.envelope, 'hex')
    )
    this.epoch = env.epoch
    this.keys = {
      masterKey: env.masterKey,
      historyKey: env.historyKey,
      liveKey: env.liveKey
    }
    this.keysByEpoch.set(this.epoch, this.keys)
    // The earlier epochs' history keys a joined Freenet session was given.
    for (const [epoch, envelopeHex] of Object.entries(manifest.envelopes || {})) {
      const number = Number(epoch)
      if (this.keysByEpoch.has(number)) continue
      try {
        const earlier = openEnvelope(
          this.localDevice.publicKey,
          this.localDevice.secretKey,
          b4a.from(envelopeHex, 'hex')
        )
        this.keysByEpoch.set(number, {
          masterKey: earlier.masterKey,
          historyKey: earlier.historyKey,
          liveKey: earlier.liveKey
        })
      } catch {
        // An envelope that no longer opens is one epoch's history lost, not
        // the session.
      }
    }
  }

  async writeRemoteManifest(manifest) {
    const file = remoteManifestPath(this.root, this.sessionId)
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.promises.writeFile(temp, JSON.stringify(manifest))
    await fs.promises.rename(temp, file)
  }

  // `opts.tsMs` is when the output was produced, for output that waited in a
  // queue before being appended; it defaults to now.
  async appendData(bytes, opts = {}) {
    const tsMs = Number.isFinite(opts.tsMs) ? opts.tsMs : null
    const chunks = []
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_PACKET_BYTES) {
      chunks.push(bytes.subarray(offset, Math.min(offset + MAX_PACKET_BYTES, bytes.byteLength)))
    }
    for (const chunk of chunks) {
      await this.appendPlain({
        version: VERSION,
        tsMs: tsMs === null ? Date.now() : tsMs,
        kind: PacketKind.DATA,
        cols: null,
        rows: null,
        payload: chunk,
        hd: !!opts.hd
      })
    }
  }

  async appendResize(cols, rows, opts = {}) {
    await this.appendPlain({
      version: VERSION,
      tsMs: Number.isFinite(opts.tsMs) ? opts.tsMs : Date.now(),
      kind: PacketKind.RESIZE,
      cols,
      rows,
      payload: Buffer.alloc(0),
      hd: !!opts.hd
    })
  }

  async appendPlain(plain) {
    if (this.remote) throw new EngineError(CODES.E_INTERNAL, 'Remote sessions are read-only')
    const seq = this.log.length + 1
    await this.log.append(this._seal(seq, plain))
    this.timeline.push({ seq, tsMs: plain.tsMs, hd: !!plain.hd })
    this.timelineDirty = true
    if (this.onAppend) {
      try {
        this.onAppend(seq, plain)
      } catch {
        // The history feed must never fail a recording.
      }
    }
    return seq
  }

  _seal(seq, plain) {
    // A joined Freenet session's cache is sealed under the device's own cache
    // key at epoch 0, whatever epoch the host recorded the packet in.
    const epoch = this.historyCache ? 0 : this.epoch
    const ciphertext = encryptPacket(
      this.historyCache ? this._cacheKey() : this.keys.historyKey,
      this.sessionId,
      epoch,
      seq,
      this.localDevice.publicKey,
      encode(PlainPacket, plain)
    )
    return encode(StoredPacket, {
      version: VERSION,
      epoch,
      seq,
      ciphertext
    })
  }

  _cacheKey() {
    if (!this._historyCacheKey) {
      this._historyCacheKey = deriveHistoryCacheKey(this.localDevice.secretKey)
    }
    return this._historyCacheKey
  }

  async *readRange(from = 1, to = this.log.length, opts = {}) {
    const end = Math.min(to, this.log.length)
    for (let seq = Math.max(1, from); seq <= end; seq++) {
      let stored
      try {
        if (opts.wait === false && !(await this.log.has(seq - 1))) break
        stored = decode(StoredPacket, await this.log.get(seq - 1, { wait: opts.wait !== false }))
        if (stored.seq !== seq) throw new Error('Packet sequence mismatch')
        const cached = this.historyCache
        const epochKeys = cached ? null : await this._loadLocalEpochKeys(stored.epoch)
        const plain = decode(
          PlainPacket,
          decryptPacket(
            cached ? this._cacheKey() : epochKeys.historyKey,
            this.sessionId,
            stored.epoch,
            stored.seq,
            cached
              ? this.localDevice.publicKey
              : this.writerDeviceKey || this.localDevice.publicKey,
            stored.ciphertext
          )
        )
        yield {
          ...plain,
          epoch: stored.epoch,
          seq: stored.seq,
          kindName: PacketKindName[plain.kind]
        }
      } catch (err) {
        if (err instanceof EngineError) {
          err.details = { ...(err.details || {}), seq }
          throw err
        }
        throw new EngineError(CODES.E_CORRUPT, `Could not read packet ${seq}: ${err.message}`, {
          seq
        })
      }
    }
  }

  async readAll() {
    const packets = []
    for await (const packet of this.readRange(1, this.log.length)) packets.push(packet)
    return packets
  }

  async loadTimeline() {
    const timelinePath = path.join(this.dir, 'timeline.json')
    try {
      const raw = await fs.promises.readFile(timelinePath, 'utf8')
      const timeline = JSON.parse(raw)
      if (Array.isArray(timeline)) {
        this.timeline = timeline
        return
      }
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err
    }
    await this.rebuildTimeline()
  }

  async rebuildTimeline() {
    this.timeline = []
    for await (const packet of this.readRange(1, this.log.length, { wait: !this.remote })) {
      this.timeline.push({ seq: packet.seq, tsMs: packet.tsMs, hd: !!packet.hd })
    }
    this.timelineDirty = true
    await this.flushTimeline()
  }

  // Incrementally catches the in-memory timeline up to whatever has replicated
  // since it was last built, instead of re-decoding the whole log. Remote
  // stores need this called before every playback op — history keeps
  // replicating in via Hypercore even while a Player stays open across seeks,
  // but nothing else advances `timeline`/`playbackLength` for those.
  async extendTimeline() {
    const from = this.timeline.length ? this.timeline[this.timeline.length - 1].seq + 1 : 1
    const to = this.remote ? await this.availableLength() : this.log.length
    if (to < from) return
    for await (const packet of this.readRange(from, to, { wait: !this.remote })) {
      this.timeline.push({ seq: packet.seq, tsMs: packet.tsMs, hd: !!packet.hd })
    }
    this.timelineDirty = true
    await this.flushTimeline()
  }

  async removeHd() {
    const packets = []
    for await (const packet of this.readRange(1, this.log.length)) packets.push(packet)
    const repacked = repackWithoutHd(packets)
    await this.log.truncate(0)
    this.timeline = []
    this.timelineDirty = true
    for (const packet of repacked) await this.appendPlain(packet)
    await this.flushTimeline()
    await this.log.update()
    return { before: packets.length, after: repacked.length }
  }

  async flushTimeline() {
    this._timelineFlushQueue = this._timelineFlushQueue.then(
      () => this._flushTimelineNow(),
      () => this._flushTimelineNow()
    )
    return this._timelineFlushQueue
  }

  async _flushTimelineNow() {
    if (!this.timelineDirty) return
    this.timelineDirty = false
    // Mid-copy the in-memory timeline can run ahead of the log; on disk it
    // never does, so a crash mid-copy leaves a consistent recording.
    const timeline = this.pendingHistoryLength
      ? this.timeline.slice(0, this.log.length)
      : this.timeline.slice()
    const timelinePath = path.join(this.dir, 'timeline.json')
    const tempPath = `${timelinePath}.${process.pid}.${Date.now()}.${++this._timelineTempCounter}.tmp`
    await fs.promises.writeFile(tempPath, JSON.stringify(timeline))
    await fs.promises.rename(tempPath, timelinePath)
  }

  async finalize() {
    await this.flushTimeline()
    await this.log.update()
  }

  async ensureRemoteInfo(info, hostDeviceKey) {
    const existing = await this.meta.get('session/info')
    if (existing) return
    const value = {
      version: VERSION,
      name: info.name || 'Shared session',
      createdAt: info.createdAt || Date.now(),
      flags: info.flags || { sensitive: false, quickCatchupKB: 0 },
      cols: info.cols || 100,
      rows: info.rows || 30,
      hostDeviceKey
    }
    await this.meta.put('session/info', {
      encoded: b4a.toString(encode(SessionInfo, value), 'hex'),
      value
    })
  }

  async putLocalEnvelope(envelopeHex) {
    await this.meta.put('env/1/local', envelopeHex)
  }

  // How many packets from seq 1 on are held locally, without a gap. It is
  // asked for per live chunk and per session.open of a joined session, so the
  // scan resumes where the last one stopped: a block a core holds stays held
  // for as long as the core keeps its fork (a truncation starts a new one).
  async availableLength() {
    const log = this.log
    const fork = log.fork || 0
    const known = this._available && this._available.fork === fork ? this._available.length : 0
    let seq = Math.min(known, log.length)
    while (seq < log.length) {
      if (!(await log.has(seq))) break
      seq++
    }
    this._available = { fork, length: seq }
    return seq
  }

  async close() {
    try {
      await this.flushTimeline()
    } finally {
      await this._closeCores()
    }
  }

  // A store whose open failed part-way. Whatever cores did open hold their
  // directory lock until closed, and would make every later open of this
  // session fail with "File descriptor could not be locked".
  async _abandon() {
    await this._closeCores().catch(() => {})
  }

  async _closeCores() {
    // Closing the Hyperbee does not close a core that never became ready.
    const results = await Promise.allSettled([
      this.meta ? this.meta.close() : null,
      this.metaCore ? this.metaCore.close() : null,
      this.log ? this.log.close() : null
    ])
    const failed = results.find((r) => r.status === 'rejected')
    if (failed) throw failed.reason
  }

  async delete() {
    await this.close()
    await fs.promises.rm(this.dir, { recursive: true, force: true })
  }
}

function remoteManifestPath(root, sessionId) {
  return path.join(root, sessionId, 'remote-manifest.json')
}

async function readRemoteManifest(root, sessionId) {
  try {
    const manifest = JSON.parse(
      await fs.promises.readFile(remoteManifestPath(root, sessionId), 'utf8')
    )
    if (
      !manifest ||
      !manifest.envelope ||
      (!manifest.core && (!manifest.logKey || !manifest.metaKey))
    ) {
      throw new Error('Remote manifest is incomplete')
    }
    return manifest
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new EngineError(
        CODES.E_NOKEY,
        'Missing joined-session metadata. Rejoin once while the host is online to enable offline playback.'
      )
    }
    if (err instanceof EngineError) throw err
    throw new EngineError(CODES.E_CORRUPT, `Could not read joined-session metadata: ${err.message}`)
  }
}

async function prepareRemoteDirectory(root, sessionId, opts = {}) {
  if (opts.replacePartial === false) return
  const dir = path.join(root, sessionId)
  try {
    const stat = await fs.promises.stat(dir)
    if (!stat.isDirectory()) return
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  try {
    await fs.promises.access(remoteManifestPath(root, sessionId))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}

function repackWithoutHd(packets) {
  const out = []
  let data = []
  let dataBytes = 0
  let firstTsMs = 0
  let lastTsMs = 0

  const flushData = () => {
    if (!data.length) return
    out.push({
      version: VERSION,
      tsMs: firstTsMs || lastTsMs || Date.now(),
      kind: PacketKind.DATA,
      cols: null,
      rows: null,
      payload: Buffer.concat(data, dataBytes),
      hd: false
    })
    data = []
    dataBytes = 0
    firstTsMs = 0
    lastTsMs = 0
  }

  for (const packet of packets) {
    if (packet.kind === PacketKind.DATA && packet.hd) {
      const nextBytes = dataBytes + packet.payload.byteLength
      const nextSpan = firstTsMs ? packet.tsMs - firstTsMs : 0
      if (data.length && (nextBytes > NORMAL_REPACK_MAX_BYTES || nextSpan > NORMAL_REPACK_MAX_MS)) {
        flushData()
      }
      if (!firstTsMs) firstTsMs = packet.tsMs
      lastTsMs = packet.tsMs
      data.push(packet.payload)
      dataBytes += packet.payload.byteLength
      continue
    }

    flushData()
    out.push({
      version: VERSION,
      tsMs: packet.tsMs,
      kind: packet.kind,
      cols: packet.cols,
      rows: packet.rows,
      payload: packet.payload,
      hd: false
    })
  }

  flushData()
  return out
}

// Adds timeline entries, one per seq, in seq order. A joined Freenet session's
// cache gets the same seqs twice: from the host's timeline messages and from
// the packets the core verifies. The verified entry wins.
function addTimelineEntries(timeline, entries) {
  const base = Array.isArray(timeline) ? timeline : []
  const lastSeq = base.length ? base[base.length - 1].seq : 0
  if (entries.every((entry) => entry.seq > lastSeq)) return base.concat(entries)
  const bySeq = new Map()
  for (const entry of base) bySeq.set(entry.seq, entry)
  for (const entry of entries) bySeq.set(entry.seq, entry)
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq)
}

module.exports = { SessionStore, MAX_PACKET_BYTES, repackWithoutHd }
