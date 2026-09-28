const fs = require('fs')
const path = require('path')
const os = require('os')
const { EventEmitter } = require('events')

const Catalog = require('./catalog')
const SnapshotCache = require('./snapshot-cache')
const { SessionStore } = require('./session-store')
const { Player, seqForTime, scanAltScreenRanges } = require('./player')
const { PacketKind } = require('./schema')
const { TerminalFrame, LIVE_SCROLLBACK } = require('./terminal-frame')
const { loadOrCreateLocalDevice } = require('./crypto')
const { EngineError, CODES } = require('./errors')
const ShareManager = require('./share-manager')
const { inspectClaim } = require('./identity/verify')
const { AccountStore } = require('./account-store')
const { ProfileManager } = require('./profile-manager')
const { IdentityStore } = require('./identity/store')
const { IdentityResolver } = require('./identity/resolver')
const { getProvider, UNKNOWN } = require('./identity/providers')
const {
  claimBytes,
  fingerprint,
  parseArmoredSignature,
  randomHex,
  KEY_TYPE
} = require('./identity/claim')

const SNAPSHOT_BYTES = 256 * 1024
const SNAPSHOT_MS = 30 * 1000
const FLOW_LIMIT = 1024 * 1024
// The core's own backlog: output recorded but not yet written to the live
// mirror, or not yet appended to the store. FLOW_LIMIT counts only what the
// renderer has not acked, and a renderer acks at once - so a flood (`ls -R /`)
// could outrun the core by any amount, queueing tens of MiB in mirrorQueue
// and appendQueue that every bootstrap, snapshot and session.open then
// waited behind. Past CORE_BACKLOG_LIMIT the PTY is paused as it is at
// FLOW_LIMIT, and it resumes once both are below half (see _updateFlow).
const CORE_BACKLOG_LIMIT = 4 * 1024 * 1024
// A joined session's timeline.json is rewritten at most this often while
// live timeline updates stream in (see flushRemoteTimeline).
const REMOTE_TIMELINE_FLUSH_MS = 1000
// An attached terminal is owned by its host, so pause() is only advisory there
// (see docs/ARCHITECTURE.md "Core boundary", attach mode). Output that keeps
// arriving after the core asked for a pause is held in a capped per-session
// buffer and, past the cap, dropped and counted - bounded, never unbounded.
const ATTACH_BUFFER_LIMIT = 4 * 1024 * 1024
// The exit signal recorded for a terminal that detached instead of exiting.
const DETACH_SIGNAL = 'detached'
const HISTORY_DOWNLOAD_CHUNK = 8192
// A copyHistoryFrom copy re-seals packets in batches of COPY_BATCH_PACKETS (or
// COPY_BATCH_BYTES of payload, whichever comes first) and
// holds the source's store lock for at most COPY_SLICE_MS at a time (less when
// someone else is waiting for it). Progress is reported at most every
// COPY_PROGRESS_MS.
const COPY_BATCH_PACKETS = 256
const COPY_BATCH_BYTES = 4 * 1024 * 1024
const COPY_SLICE_MS = 250
const COPY_PROGRESS_MS = 250
// Ceiling on the geometry `player.view` will re-render at. A viewport is a
// real @xterm/headless grid allocation, so a caller must not be able to ask
// for an unbounded one; 1000x1000 is far past any real panel.
const MAX_VIEW_COLS = 1000
const MAX_VIEW_ROWS = 1000
const ARCHIVE_PROFILES = {
  normal: {
    minMs: 50,
    maxMs: 1200,
    maxBytes: 64 * 1024,
    breakBytes: 16 * 1024
  },
  hd: {
    minMs: 25,
    maxMs: 50,
    maxBytes: 64 * 1024,
    breakBytes: 4 * 1024
  }
}

class SessionEngine extends EventEmitter {
  constructor(opts = {}) {
    super()
    const base = opts.userData || path.join(os.tmpdir(), 'zbterm-dev')
    this.profileManager =
      opts.profileManager || new ProfileManager(path.join(base, 'zbterm-profiles'))
    this.profileId = opts.profileId || process.env.ZBTERM_PROFILE || null
    this.explicitProfilePath = opts.profilePath || null
    this.profileLock = null
    const selectedProfilePath =
      this.explicitProfilePath ||
      (this.profileId ? this.profileManager.resolveProfilePath(this.profileId) : null)
    const dataRoot = selectedProfilePath || path.join(base, 'zbterm')
    this.paths = {
      root: dataRoot,
      account: path.join(dataRoot, 'account'),
      corestore: path.join(dataRoot, 'corestore'),
      catalog: path.join(dataRoot, 'catalog'),
      snapshots: path.join(dataRoot, 'snapshots'),
      identity: path.join(dataRoot, 'account', 'identity'),
      preferences: path.join(dataRoot, 'preferences.json')
    }
    this.catalog = new Catalog(this.paths.catalog)
    this.account = new AccountStore(this.paths.account)
    // Named `identityStore`, not `identity`: `SessionEngine.prototype.identity()`
    // (device/DHT keys, used by `identity.get`) already owns that name and an
    // instance property would shadow it.
    this.identityStore = new IdentityStore(this.paths.identity)
    // Cached copy of the signed self claim. The join handshake sends it from
    // synchronous code (`join-request` goes out before any await), so it can
    // never `await identityStore.getSelf()` there - ready()/setIdentitySelf/
    // clearIdentity keep this in sync instead.
    this.selfIdentityClaim = null
    // Provider key lookups need an HTTP client the worker does not have: the
    // resolver emits `identity:resolve-request` and the Electron shell answers
    // with the `identity.resolveResult` invoke.
    this.identityResolver = new IdentityResolver({
      store: this.identityStore,
      emit: (name, data) => this.emit(name, data)
    })
    this.localDevice = null
    this.sessions = new Map()
    this.remoteSessions = new Map()
    this.players = new Map()
    // Sessions a session.delete is removing. Nothing may (re)open their store
    // meanwhile: an open recreates files under the directory being removed.
    this.deletingSessions = new Set()
    this.snapshotBackfills = new Set()
    this.snapshotBackfillAttempts = new Map()
    // The PTY host is an injected adapter, never a local implementation: the
    // core owns the *interface* (spawn/write/resize/pause/resume/kill plus
    // `data`/`exit` events, see docs/ARCHITECTURE.md "Core boundary") and the
    // host supplies it - electron/pty-host.js in the shell, engine/pty-remote.js
    // in the Bare worker. Requiring it here would drag node-pty into the
    // worker's module graph, where it cannot load.
    if (!opts.ptyHost) {
      throw new EngineError(
        CODES.E_INTERNAL,
        'SessionEngine requires a ptyHost adapter (opts.ptyHost)'
      )
    }
    this.ptyHost = opts.ptyHost
    this.ptyHost.on('data', ({ sessionId, data }) => this._onPtyData(sessionId, data))
    this.ptyHost.on('exit', ({ sessionId, exit }) => this._onPtyExit(sessionId, exit))
    // The share backend is injectable (an instance, or a factory called with
    // this engine); ShareManager falls back to Pear when none is given.
    const shareBackend =
      typeof opts.shareBackend === 'function' ? opts.shareBackend(this) : opts.shareBackend
    // `opts.backendLimit` is the host's --backend / ZBTERM_BACKEND value
    // (the worker's 4th spawn argument): it narrows the set of share backends
    // and never adds to it. '' means no limit. An injected shareBackend
    // bypasses both the registry and the limit.
    // `opts.rtcHost` is the host's WebRTC adapter (engine/backends/freenet/
    // rtc-remote.js in the worker) and `opts.hostCaps` what the host offers
    // (the worker's 5th spawn argument). When `hostCaps` is not given it
    // follows `rtcHost`: 'rtc' with an adapter, '' without one.
    // `opts.backendOptions` reaches every backend the registry creates and
    // its probe (tests name a Freenet node address there; the worker passes
    // none).
    this.share = new ShareManager(this, {
      backend: shareBackend || null,
      limit: opts.backendLimit || '',
      hostCaps:
        opts.hostCaps !== undefined && opts.hostCaps !== null
          ? String(opts.hostCaps)
          : opts.rtcHost
            ? 'rtc'
            : '',
      rtcHost: opts.rtcHost || null,
      backendOptions: opts.backendOptions
    })
    this.share.on('share:changed', (status) => {
      this.emit('share:changed', status)
      this.listSessions()
        .then((list) => this.emit('session:list-changed', list))
        .catch(() => {})
    })
    this.share.on('join:changed', (status) => this.emit('share:join-changed', status))
    this.share.on('approval:pending', (request) => this.emit('share:approval-pending', request))
    this.share.on('approval:cancelled', (event) => this.emit('share:approval-cancelled', event))
    this.share.on('share:peer-identity', (event) => this.emit('share:peer-identity', event))
    this.share.on('error', (err) => this.emit('engine:error', EngineError.from(err).toJSON()))
    this.share.on('debug', (event) => this.emit('share:debug', event))
  }

  async ready() {
    if (this.profileId) {
      this.profileLock = await this.profileManager.acquireLock(this.profileId)
    } else if (this.explicitProfilePath) {
      this.profileLock = await this.profileManager.acquirePathLock(this.paths.root)
    }
    await fs.promises.mkdir(this.paths.corestore, { recursive: true })
    await fs.promises.mkdir(this.paths.snapshots, { recursive: true })
    await this.account.ready()
    this.localDevice = await this.account.getLocalDevice()
    if (!this.localDevice) {
      this.localDevice =
        (await this.account.importLegacyLocalDevice(this.paths)) ||
        (await createLegacyCompatibleAccount(this.account, this.paths))
    }
    await this.identityStore.ready()
    await this._refreshSelfIdentityClaim()
    const authKeyPair = await this.account.ensureAuthKeyPair()
    this.localDevice.authPublicKey = authKeyPair.publicKey
    this.localDevice.authSecretKey = authKeyPair.secretKey
    await this.catalog.ready()
    await this.catalog.markPreviousActiveEnded()
    this.emit('session:list-changed', await this.listSessions())
  }

  async getPreference(key) {
    if (!key || typeof key !== 'string') {
      throw new EngineError(CODES.E_INTERNAL, 'Preference key is required')
    }
    const prefs = await this._readPreferences()
    return Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : null
  }

  async setPreference(key, value) {
    if (!key || typeof key !== 'string') {
      throw new EngineError(CODES.E_INTERNAL, 'Preference key is required')
    }
    const prefs = await this._readPreferences()
    prefs[key] = String(value)
    await fs.promises.mkdir(path.dirname(this.paths.preferences), { recursive: true })
    await fs.promises.writeFile(this.paths.preferences, JSON.stringify(prefs, null, 2))
    return { key, value: prefs[key] }
  }

  async _readPreferences() {
    try {
      const prefs = JSON.parse(await fs.promises.readFile(this.paths.preferences, 'utf8'))
      return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {}
    } catch {
      return {}
    }
  }

  async invoke(method, args = {}) {
    try {
      if (method === 'ping') return { ok: true, pong: true }
      if (method === 'session.create') return await this.createSession(args)
      if (method === 'session.extend') return await this.extendSession(args.sessionId, args)
      if (method === 'session.open') return await this.openSession(args.sessionId, args)
      if (method === 'session.close') return await this.closeSession(args.sessionId)
      if (method === 'session.delete') return await this.deleteSession(args.sessionId)
      if (method === 'session.rename') return await this.renameSession(args.sessionId, args.name)
      if (method === 'session.update') return await this.updateSession(args.sessionId, args)
      if (method === 'session.defaultName') return { name: await this.defaultSessionName() }
      if (method === 'session.list') return await this.listSessions(args)
      if (method === 'session.input') return this.input(args.sessionId, args.data)
      if (method === 'session.resize') {
        return await this.resize(args.sessionId, args.cols, args.rows, args.fontSize)
      }
      if (method === 'session.ack') return this.ack(args.sessionId, args.bytes)
      if (method === 'session.diagnostics') return this.diagnostics(args.sessionId)
      if (method === 'session.setHd') return this.setHd(args.sessionId, args.enabled)
      if (method === 'session.removeHd') return await this.removeHd(args.sessionId)
      if (method === 'session.clearCaches') return await this.clearCaches(args.sessionId)
      if (method === 'player.open') return await this.openPlayer(args.sessionId)
      if (method === 'player.seek') return await this.playerSeek(args.sessionId, args.tsMs)
      if (method === 'player.play') {
        return this.playerPlay(args.sessionId, args.speed, args.collapse)
      }
      if (method === 'player.pause') return this.playerPause(args.sessionId)
      if (method === 'player.step') return await this.playerStep(args.sessionId, args.delta)
      if (method === 'player.view') return await this.playerView(args.sessionId, args)
      if (method === 'identity.get') {
        const self = await this.identitySelf()
        return { ...this.identity(), provider: self.provider, displayId: self.displayId }
      }
      if (method === 'identity.self') return await this.identitySelf()
      if (method === 'identity.beginClaim') return await this.beginIdentityClaim(args)
      if (method === 'identity.setSelf') return await this.setIdentitySelf(args)
      if (method === 'identity.clear') return await this.clearIdentity()
      if (method === 'identity.peers') return await this.identityStore.listPeers()
      if (method === 'identity.annotatePeer') return await this.annotateIdentityPeer(args)
      if (method === 'identity.lookup') return await this.lookupIdentityKeys(args)
      if (method === 'identity.inspectInvite') return await this.inspectInviteIdentity(args)
      if (method === 'identity.resolveResult') {
        this.identityResolver.handleResponse(args)
        return true
      }
      if (method === 'account.profile') return await this.account.getProfile()
      if (method === 'account.devices') return await this.account.listDevices()
      if (method === 'account.localDevice') {
        return serializeDeviceRecord(await this.account.getLocalDevice())
      }
      if (method === 'device.revoke') {
        return await this.account.revokeDevice(args.deviceKey, args.reason)
      }
      if (method === 'profile.list') return await this.profileManager.listProfiles()
      if (method === 'profile.create') return await this.profileManager.createProfile(args)
      if (method === 'profile.rename') {
        return await this.profileManager.renameProfile(args.profileId, args.name)
      }
      if (method === 'profile.deleteEmpty') {
        return await this.profileManager.deleteEmptyProfile(args.profileId)
      }
      if (method === 'debug.currentSelection') return null
      if (method === 'preference.get') return await this.getPreference(args.key)
      if (method === 'preference.set') {
        return await this.setPreference(args.key, args.value)
      }
      if (method === 'share.backends') return await this.share.probedBackendsInfo()
      if (method === 'share.setIceServers') return this.share.setIceServers(args.iceServers)
      if (method === 'share.createLink') return await this.share.createLink(args.sessionId, args)
      if (method === 'share.listLinks') return await this.share.listLinks(args.sessionId)
      if (method === 'share.revokeLink') {
        return await this.share.revokeLink(args.sessionId, args.linkId)
      }
      if (method === 'share.revokeMember') {
        return await this.share.revokeMember(args.sessionId, args.identityKey)
      }
      if (method === 'share.join') return await this.share.join(args.uri)
      if (method === 'share.diagnostics') return this.share.diagnostics()
      if (method === 'share.approveJoin') {
        return await this.share.approveJoin(args.sessionId, args.requestId)
      }
      if (method === 'share.denyJoin') return this.share.denyJoin(args.sessionId, args.requestId)
      if (method === 'share.setInputMode') return this.setInputMode(args.sessionId, args.mode)
      throw new EngineError(CODES.E_INTERNAL, `Unknown method: ${method}`)
    } catch (err) {
      throw EngineError.from(err)
    }
  }

  async createSession(opts = {}) {
    const now = Date.now()
    const name = opts.name || (await this.defaultSessionName())
    const cols = opts.cols || 100
    const rows = opts.rows || 30
    // 'attach' registers a terminal the host already owns instead of asking
    // the host to launch one. Everything downstream (recording, sharing,
    // playback) is identical - only this one call differs.
    const mode = opts.mode === 'attach' ? 'attach' : 'spawn'
    // Where and what to launch. Kept on the catalog entry only (never in the
    // shared store info), and reused every time the session is extended.
    const launch = mode === 'spawn' ? launchOptions(opts) : {}
    if (mode === 'attach' && typeof this.ptyHost.attach !== 'function') {
      throw new EngineError(CODES.E_INTERNAL, 'PTY host does not support attach mode')
    }
    const copyFrom = typeof opts.copyHistoryFrom === 'string' ? opts.copyHistoryFrom : ''
    // Only the source's length and timeline are read up front; the packets are
    // copied in the background once the shell is running (see _copyHistory).
    const plan = copyFrom ? await this._planHistoryCopy(copyFrom, now) : null
    const startedAt = plan ? plan.startedAt : now
    const store = await SessionStore.create(
      this.paths.corestore,
      this.localDevice,
      { name, createdAt: startedAt, cols, rows },
      // A copy records its first resize after the copied history.
      { initialResize: !plan }
    )
    const snapshot = new SnapshotCache(this.paths.snapshots, store.sessionId, this.localDevice)
    let runtime
    let beginCopy = null
    try {
      await snapshot.ready()
      runtime = this._createRuntime(store.sessionId, store, snapshot, cols, rows, mode)
      runtime.launch = launch
      if (plan) store.beginHistoryCopy(plan.length, plan.timeline)
      this._startRuntimePty(store.sessionId, runtime)
    } catch (err) {
      // Nothing was spawned: leave no session behind.
      await store.delete().catch(() => {})
      await snapshot.clear().catch(() => {})
      throw err
    }
    if (plan) {
      // Goes live at once, like extend: the copy, the snapshot copy, the first
      // resize and the archive-screen rebuild run in the background, and live
      // output is held behind them in appendQueue/mirrorQueue so the recording
      // stays history, first resize, live output. `session:availability-changed`
      // reports the copy's progress and `session:restored` its end.
      runtime.restoring = true
      runtime.restoreAborted = false
      runtime.historyCopy = { sourceId: copyFrom, length: plan.length, seeded: !!plan.timeline }
      // Held until create has replied: listing sessions below takes the
      // source's store lock too, and should not queue behind a copy slice.
      const begun = new Promise((resolve) => {
        beginCopy = resolve
      })
      const restored = begun.then(() =>
        this._copyHistory(store.sessionId, runtime, { tsMs: now, cols, rows })
      )
      runtime.appendQueue = restored
      runtime.mirrorQueue = restored
    }
    this.sessions.set(store.sessionId, runtime)
    try {
      return await this._registerCreatedSession(store, runtime, { name, now, startedAt, launch })
    } finally {
      if (beginCopy) beginCopy()
    }
  }

  async _registerCreatedSession(store, runtime, { name, now, startedAt, launch }) {
    const entry = {
      sessionId: store.sessionId,
      name,
      // A copy with history starts where that history does, so the live
      // scrubber spans it; lastStartedAt still sorts it as brand new.
      startedAt,
      lastStartedAt: now,
      endedAt: null,
      active: true,
      owner: 'my',
      path: store.dir,
      ...launch
    }
    await this.catalog.put(entry)
    this.emit('session:list-changed', await this.listSessions())
    return {
      ...entry,
      restoring: !!runtime.restoring,
      info: store.info,
      timeline: store.timeline,
      availability: await availabilitySummary(store)
    }
  }

  // session.create's `copyHistoryFrom`, part one: what will be copied. The
  // source's length is fixed here - later output stays in the source - along
  // with its timeline for those seqs, which the copy shows up front. A live
  // source is flushed first so the copy includes its latest output.
  async _planHistoryCopy(sourceId, now) {
    const entry = await this.catalog.get(sourceId)
    if (!entry) {
      throw new EngineError(CODES.E_INTERNAL, 'Session to copy history from was not found')
    }
    if (entry.owner === 'joined' || this.remoteSessions.has(sourceId)) {
      throw new EngineError(CODES.E_INTERNAL, 'History of a joined session cannot be copied')
    }
    const live = this.sessions.get(sourceId)
    if (live && live.historyCopy) {
      throw new EngineError(
        CODES.E_INTERNAL,
        'History of a session that is still copying its own history cannot be copied yet'
      )
    }
    // A source still rebuilding its screen after an extend holds its new
    // output behind that rebuild; its history is already all on disk.
    if (live && !live.restoring) {
      this._flushPacketBuffer(sourceId)
      await live.appendQueue.catch(() => {})
    }
    return await this._withStore(sourceId, (source) => {
      const length = source.log.length
      const timeline = contiguousTimeline(source.timeline, length)
        ? source.timeline.slice(0, length)
        : null
      const first = timeline ? timeline[0] : source.timeline[0]
      const startedAt = first && Number.isFinite(first.tsMs) ? Math.min(first.tsMs, now) : now
      return { length, timeline, startedAt }
    })
  }

  // Part two, in the background. Never rejects: appendQueue and mirrorQueue
  // chain on it. The source's store lock is taken per slice, never for the
  // whole copy, so the source can still be played, extended or deleted. A copy
  // cut short - source gone or rewritten, this session closed or deleted, the
  // engine shutting down, a read error - keeps what it copied; either way the
  // first resize and the held live output are then written after it.
  async _copyHistory(sessionId, runtime, { tsMs, cols, rows }) {
    const store = runtime.store
    const copy = runtime.historyCopy
    const aborted = () => runtime.restoreAborted || this.deletingSessions.has(sessionId)
    let lastProgress = 0
    const progress = (force) => {
      const at = Date.now()
      if (!force && at - lastProgress < COPY_PROGRESS_MS) return
      lastProgress = at
      if (this.sessions.get(sessionId) !== runtime) return
      this.emit('session:availability-changed', {
        sessionId,
        availableLength: store.log.length,
        logLength: Math.max(store.log.length, store.pendingHistoryLength)
      })
    }
    try {
      while (store.log.length < copy.length && !aborted()) {
        const before = store.log.length
        const more = await this._withStoreLock(copy.sourceId, () =>
          this._copyHistorySlice(runtime, aborted)
        )
        progress(false)
        if (!more || store.log.length === before) break
      }
      if (!aborted()) await this._copyHistorySnapshots(runtime, aborted)
    } catch (err) {
      if (!aborted()) this.emit('engine:error', EngineError.from(err).toJSON())
    }
    try {
      await store.endHistoryCopy()
      // Stamped with the create time: nothing copied is newer, and live output
      // held meanwhile keeps the time it was produced at (_flushPacketBuffer).
      await store.appendResize(cols, rows, { hd: runtime.hd, tsMs })
      await store.flushTimeline()
    } catch (err) {
      if (!aborted()) this.emit('engine:error', EngineError.from(err).toJSON())
    }
    runtime.historyCopy = null
    progress(true)
    if (this.sessions.get(sessionId) === runtime) {
      this.share.broadcastTimeline(sessionId)
      // The listed history size has grown to the full copy.
      this.listSessions()
        .then((list) => this.emit('session:list-changed', list))
        .catch(() => {})
    }
    let base
    try {
      base = await restoreBase(store, runtime.snapshot)
    } catch {
      base = { seq: 0, cols, rows, data: '' }
    }
    await this._restoreArchive(sessionId, runtime, base, store.log.length)
  }

  // One slice of a copy. The caller holds the source's store lock. Returns
  // false when the copy cannot go on.
  async _copyHistorySlice(runtime, aborted) {
    const store = runtime.store
    const copy = runtime.historyCopy
    const sourceId = copy.sourceId
    if (aborted() || this.deletingSessions.has(sourceId)) return false
    const held = this.sessions.get(sourceId) || this.players.get(sourceId)
    let source = held ? held.store : null
    if (!source) {
      if (!(await this.catalog.get(sourceId))) return false
      source = await SessionStore.open(this.paths.corestore, sourceId, this.localDevice, {
        timeline: false
      })
    }
    try {
      // Cleared or deleted since the copy started.
      if (source.log.length < copy.length) return false
      const deadline = Date.now() + COPY_SLICE_MS
      let intact = true
      let packets = []
      let bytes = 0
      for await (const packet of source.readRange(store.log.length + 1, copy.length)) {
        // Rewritten since the copy started (Remove HD repacks the recording):
        // what follows no longer matches the timeline shown for the copy.
        if (copy.seeded) {
          const item = store.timeline[packet.seq - 1]
          if (!item || item.tsMs !== packet.tsMs || !!item.hd !== !!packet.hd) {
            intact = false
            break
          }
        }
        packets.push(packet)
        bytes += packet.payload.byteLength
        if (packets.length < COPY_BATCH_PACKETS && bytes < COPY_BATCH_BYTES) continue
        await store.appendCopied(packets)
        packets = []
        bytes = 0
        if (aborted() || Date.now() >= deadline || this._storeLockWaiting(sourceId)) break
      }
      await store.appendCopied(packets)
      return intact
    } finally {
      if (!held) await source.close().catch(() => {})
    }
  }

  // The source's snapshots stay valid for the copy (same packets at the same
  // seqs) and are re-sealed for it, so the copy's screen rebuild starts from
  // the newest one instead of from seq 1. They are a cache: files that vanish
  // or will not read are skipped, and no lock is needed.
  async _copyHistorySnapshots(runtime, aborted) {
    const sourceId = runtime.historyCopy.sourceId
    const stop = () => aborted() || this.deletingSessions.has(sourceId)
    if (stop()) return
    const live = this.sessions.get(sourceId)
    let from = live && live.snapshot
    if (!from) {
      if (!(await this.catalog.get(sourceId))) return
      // Not ready(): that creates the directory, and a source being deleted
      // must not get it back.
      from = new SnapshotCache(this.paths.snapshots, sourceId, this.localDevice)
      from.index = await readSnapshotIndex(this.paths.snapshots, sourceId)
    }
    await copySnapshots(from, runtime.snapshot, runtime.store.log.length, stop)
  }

  async defaultSessionName() {
    const base = await this.defaultSessionNameBase()
    const pattern = new RegExp(`^${escapeRegExp(base)} #(\\d+)$`)
    let max = 0
    for (const session of await this.catalog.list()) {
      const match = pattern.exec(session.name || '')
      if (!match) continue
      const n = Number(match[1])
      if (Number.isSafeInteger(n) && n > max) max = n
    }
    return `${base} #${max + 1}`
  }

  async defaultSessionNameBase() {
    const user = currentUsername()
    const host = os.hostname() || 'localhost'
    const profileName = await this.currentProfileDisplayName()
    const suffix = profileName ? ` (${profileName})` : ''
    return `${user} @ ${host}${suffix}`
  }

  async currentProfileDisplayName() {
    if (!this.profileId || this.profileId === 'default') return ''
    try {
      const registry = await this.profileManager.listProfiles()
      const profile = (registry.profiles || []).find((item) => item.id === this.profileId)
      return (profile && (profile.name || profile.id)) || this.profileId
    } catch {
      return this.profileId
    }
  }

  // `opts.frame: false` leaves out a joined session's screen: the renderer
  // re-opens a joined session every 350 ms for its timeline and availability
  // only, and serialising the mirror's 5000 lines of scrollback each time -
  // after waiting for it to catch up - is what that refresh cost under a flood.
  async openSession(sessionId, opts = {}) {
    if (this.sessions.has(sessionId)) {
      const runtime = this.sessions.get(sessionId)
      return await this._sessionState(sessionId, runtime)
    }
    if (this.remoteSessions.has(sessionId)) {
      const remote = this.remoteSessions.get(sessionId)
      const withFrame = opts.frame !== false
      if (withFrame) await remote.mirrorQueue.catch(() => {})
      if (remote.timelineQueue) await remote.timelineQueue.catch(() => {})
      await this._refreshRemoteTimelineFromDisk(remote)
      remote.store.playbackLength = await this._remoteAvailableLength(remote)
      return {
        sessionId,
        info: remote.store.info,
        active: remote.active,
        timeline: remote.store.timeline,
        length: remote.store.playbackLength,
        availability: await remoteAvailabilitySummary(remote),
        hd: !!remote.hd,
        frame: !withFrame
          ? null
          : remote.mirror
            ? {
                ...remote.mirror.snapshot(this._remoteKnownLength(remote)),
                hd: !!remote.hd
              }
            : remote.frame
      }
    }
    const entry = await this.catalog.get(sessionId)
    return await this._withStore(sessionId, async (store) => {
      if (entry && entry.owner === 'joined') {
        await store.rebuildTimeline().catch(() => {})
        store.playbackLength = await store.availableLength().catch(() => store.timeline.length)
      }
      return {
        sessionId,
        info: store.info,
        active: !!(entry && entry.active),
        timeline: store.timeline,
        length: await playbackLength(store),
        availability: await availabilitySummary(store),
        hd: false
      }
    })
  }

  async extendSession(sessionId) {
    if (!sessionId) throw new EngineError(CODES.E_INTERNAL, 'Session id is required')
    // A shell that just exited stays registered until _onPtyExit has closed
    // its store; extending then would hand back the dead session unchanged.
    const exiting = this.sessions.get(sessionId)
    if (exiting && !exiting.active) await exiting.exitPromise
    if (this.sessions.has(sessionId)) return await this.openSession(sessionId)
    const entry = await this.catalog.get(sessionId)
    if (!entry) throw new EngineError(CODES.E_INTERNAL, 'Session was not found')
    if (entry.owner === 'joined') {
      throw new EngineError(CODES.E_INTERNAL, 'Joined sessions cannot be extended locally')
    }

    // Extend goes live immediately. Rebuilding the archive screen replays the
    // recording through a headless terminal (about a minute per GB), so it runs
    // in the background instead of gating the spawn. Output produced meanwhile
    // reaches the renderer at once, and is held in appendQueue/mirrorQueue -
    // both chained behind the restore - until it lands, then written through
    // in order. `session:restored` tells the UI to repaint with history.
    const runtime = await this._withStoreLock(sessionId, async () => {
      // A concurrent extend may have won the lock first.
      if (this.sessions.has(sessionId)) return null
      this._assertNotDeleting(sessionId)
      await this._closePlayerNow(sessionId)
      const store = await SessionStore.open(this.paths.corestore, sessionId, this.localDevice)
      let runtime = null
      try {
        const snapshot = new SnapshotCache(this.paths.snapshots, sessionId, this.localDevice)
        await snapshot.ready()
        const base = await restoreBase(store, snapshot)
        const cols = base.cols
        const rows = base.rows
        await store.updateInfo({ cols, rows })
        runtime = this._createRuntime(sessionId, store, snapshot, cols, rows)
        runtime.fontSize = isFontSize(entry.fontSize) ? entry.fontSize : null
        runtime.launch = launchOptions(entry)
        runtime.restoring = true
        runtime.restoreAborted = false
        const restored = this._restoreArchive(sessionId, runtime, base, store.log.length)
        runtime.appendQueue = restored
        runtime.mirrorQueue = restored
        this.sessions.set(sessionId, runtime)
        this._startRuntimePty(sessionId, runtime)
        return runtime
      } catch (err) {
        // Nothing else references this store; left open it would hold the
        // session's lock until the process exits.
        if (runtime) {
          runtime.restoreAborted = true
          if (this.sessions.get(sessionId) === runtime) this.sessions.delete(sessionId)
          await runtime.appendQueue.catch(() => {})
          runtime.mirror.dispose()
          runtime.archiveMirror.dispose()
        }
        await store.close().catch(() => {})
        throw err
      }
    })
    if (!runtime) return await this.openSession(sessionId)
    const store = runtime.store

    const updated = await this.catalog.update(sessionId, {
      active: true,
      lastStartedAt: Date.now(),
      endedAt: null,
      exit: null
    })
    this.emit('session:list-changed', await this.listSessions())
    // cols/rows/fontSize are what the session is revived at: the geometry it
    // was last recorded at, and the font size it was last shown with (null if
    // none was ever reported), so the host can fit its view to match.
    return {
      ...(updated || entry),
      cols: runtime.cols,
      rows: runtime.rows,
      fontSize: runtime.fontSize,
      active: true,
      restoring: runtime.restoring,
      endedAt: null,
      exit: null,
      info: store.info,
      timeline: store.timeline
    }
  }

  // Never rejects: appendQueue and mirrorQueue chain on it, and a failed
  // restore must not strand the live output queued behind it. A restore that
  // failed or was cut short leaves `archiveStale` set so no snapshot is taken
  // from the incomplete archive screen; the recording itself is unaffected.
  async _restoreArchive(sessionId, runtime, base, length) {
    const cols = runtime.cols
    const rows = runtime.rows
    let archive
    try {
      archive = await buildArchiveMirror(runtime.store, {
        base,
        to: length,
        aborted: () => runtime.restoreAborted
      })
      if (runtime.restoreAborted) runtime.archiveStale = true
    } catch (err) {
      runtime.archiveStale = true
      this.emit('engine:error', EngineError.from(err).toJSON())
      archive = new TerminalFrame(cols, rows, { scrollback: 0 })
    }
    try {
      await runtime.mirror.restore(archive.snapshot(length))
      // The shell was spawned at `cols x rows` before the replay could say what
      // geometry the recording ended at. If they differ, record the switch so
      // playback renders the new output at the size it was produced at.
      if (archive.cols !== cols || archive.rows !== rows) {
        runtime.mirror.resize(cols, rows)
        archive.resize(cols, rows)
        // Stamped with when the shell went live, ahead of any held output.
        await runtime.store.appendResize(cols, rows, { hd: runtime.hd, tsMs: runtime.liveSince })
      }
    } catch (err) {
      this.emit('engine:error', EngineError.from(err).toJSON())
    }
    runtime.archiveMirror.dispose()
    runtime.archiveMirror = archive
    runtime.restoring = false
    if (this.sessions.get(sessionId) !== runtime) return
    this.emit('session:restored', { sessionId })
    // Viewers that joined mid-restore were bootstrapped without history.
    this.share.broadcastBootstrap(sessionId).catch(() => {})
  }

  closeSession(sessionId) {
    const runtime = this.sessions.get(sessionId)
    if (!runtime) return true
    // kill() is "end this session's terminal handle", not "kill a process":
    // on an attached handle the host detaches instead, leaving the terminal
    // it owns running. The core must never assume it owns the process.
    runtime.pty.kill()
    return true
  }

  async deleteSession(sessionId) {
    this.deletingSessions.add(sessionId)
    try {
      return await this._deleteSession(sessionId)
    } finally {
      this.deletingSessions.delete(sessionId)
    }
  }

  async _deleteSession(sessionId) {
    // First, so a store the player owns is not still locked (or in use) while
    // the recording is removed below.
    await this._closePlayer(sessionId)
    const runtime = this.sessions.get(sessionId)
    const remote = this.remoteSessions.get(sessionId)
    if (runtime) {
      // Detaches rather than terminating when the runtime is attached - see
      // closeSession(). Deleting the recording never kills a host's terminal.
      runtime.restoreAborted = true
      runtime.pty.kill()
      await Promise.race([runtime.exitPromise, delay(1000)])
      await runtime.mirrorQueue.catch(() => {})
      // Flush any buffered-but-not-yet-appended output and wait for the
      // pending appendData/flushTimeline chain to settle before deleting
      // the store's directory - otherwise a still-in-flight timeline write
      // races the delete and fails with ENOENT on its rename.
      this._flushPacketBuffer(sessionId)
      await runtime.appendQueue.catch(() => {})
      // Under the lock, behind any open the exit set off (the renderer reopens
      // an exited session for playback, and listing sessions opens stores).
      // Such an open that got in first is closed here; later ones see
      // deletingSessions and refuse. Unlocked, they recreated files mid-rm
      // (ENOTEMPTY) and left a player holding the removed recording.
      await this._withStoreLock(sessionId, async () => {
        await this._closePlayerNow(sessionId)
        await runtime.store.delete()
        await runtime.snapshot.clear()
      })
      runtime.mirror.dispose()
      runtime.archiveMirror.dispose()
      this.sessions.delete(sessionId)
    } else if (remote) {
      // Unregister first: applyRemoteTimeline/applyRemoteSnapshot/etc. all
      // look the session up via this.remoteSessions.get(sessionId) and
      // no-op if it's missing. Deleting the map entry before tearing down
      // the store means any replication traffic that keeps arriving from
      // the host while this delete is in flight (or after) is silently
      // dropped instead of retrying forever against a directory we're
      // about to remove - previously this entry was never cleaned up on
      // delete, so a still-live join kept calling flushTimeline() against
      // the deleted corestore dir on every incoming message, forever.
      this.remoteSessions.delete(sessionId)
      this.share.leaveJoinedSession(sessionId)
      remote.active = false
      if (remote.timelineQueue) await remote.timelineQueue.catch(() => {})
      if (remote.snapshotQueue) await remote.snapshotQueue.catch(() => {})
      if (remote.historyDownloads) {
        for (const download of remote.historyDownloads) download.destroy()
        remote.historyDownloads.clear()
      }
      if (remote.historyDownloadQueue) await remote.historyDownloadQueue.catch(() => {})
      if (remote.mirror) remote.mirror.dispose()
      await this._withStoreLock(sessionId, async () => {
        await this._closePlayerNow(sessionId)
        await remote.store.delete()
        await remote.snapshot.clear()
      })
    } else {
      this.share.leaveJoinedSession(sessionId)
      await this._withStoreLock(sessionId, async () => {
        await this._closePlayerNow(sessionId)
        try {
          const store = await SessionStore.open(this.paths.corestore, sessionId, this.localDevice)
          await store.delete()
        } catch {
          await fs.promises.rm(path.join(this.paths.corestore, sessionId), {
            recursive: true,
            force: true
          })
        }
      })
      const snapshot = new SnapshotCache(this.paths.snapshots, sessionId, this.localDevice)
      await snapshot.clear()
    }
    await this.catalog.delete(sessionId)
    this.emit('session:list-changed', await this.listSessions())
    return true
  }

  async renameSession(sessionId, name) {
    const runtime = this.sessions.get(sessionId)
    if (runtime) await runtime.store.updateInfo({ name })
    const entry = await this.catalog.update(sessionId, { name })
    if (runtime) this.share.broadcastInfo(sessionId, { name })
    this.emit('session:list-changed', await this.listSessions())
    return entry
  }

  // Edits a session's profile. `cwd` and `command` take effect the next time
  // the session is extended; a live shell keeps running where it started.
  async updateSession(sessionId, patch = {}) {
    if (!sessionId) throw new EngineError(CODES.E_INTERNAL, 'Session id is required')
    const entry = await this.catalog.get(sessionId)
    if (!entry) throw new EngineError(CODES.E_INTERNAL, 'Session was not found')
    const name = typeof patch.name === 'string' ? patch.name.trim() : ''
    if (name && name !== entry.name) await this.renameSession(sessionId, name)
    if (entry.owner !== 'joined' && ('cwd' in patch || 'command' in patch)) {
      const current = launchOptions(entry)
      const next = launchOptions({
        cwd: 'cwd' in patch ? patch.cwd : current.cwd,
        command: 'command' in patch ? patch.command : current.command
      })
      await this.catalog.update(sessionId, { cwd: next.cwd || null, command: next.command || null })
      this.emit('session:list-changed', await this.listSessions())
    }
    return await this.catalog.get(sessionId)
  }

  async listSessions(opts = {}) {
    const list = await this.catalog.list(opts)
    for (const item of list) {
      const runtime = this.sessions.get(item.sessionId)
      if (runtime) {
        item.active = runtime.active
        item.length = runtime.store.log.length
        item.snapshotCount = runtime.snapshot.index.snapshots.length
        Object.assign(item, this.share.status(item.sessionId))
        item.inputMode = runtime.inputMode || 'host'
      } else if (this.remoteSessions.has(item.sessionId)) {
        const remote = this.remoteSessions.get(item.sessionId)
        item.active = remote.active
        item.length = remote.store.log.length
        item.snapshotCount = remote.snapshot.index.snapshots.length
        item.isJoined = true
        item.hd = !!remote.hd
        item.inputMode = remote.inputMode || 'host'
      } else {
        item.snapshotCount = await snapshotCount(this.paths.snapshots, item.sessionId)
      }
      if (item.owner === 'joined' && item.snapshotCount === 0) {
        this._scheduleJoinedSnapshotBackfill(item.sessionId)
      }
      // Hypercore keeps old blocks available for replication after truncate,
      // so directory size does not reflect a history deletion. Report the
      // logical history size instead, which is what this UI label represents.
      item.sizeBytes = await this._withStore(
        item.sessionId,
        (store) => Number(store.log.byteLength) || 0
      ).catch(() => 0)
    }
    return list
  }

  input(sessionId, data) {
    const remote = this.remoteSessions.get(sessionId)
    if (remote && remote.message) {
      remote.message.send({
        type: 'input',
        data: this.share.sealInput(sessionId, data)
      })
      return true
    }
    const runtime = this._live(sessionId)
    // Same call in both modes: the attached handle's write() hands the bytes
    // to the host's terminal, so remote keyboard sharing works unchanged.
    runtime.pty.write(Buffer.from(data).toString('utf8'))
    return true
  }

  setInputMode(sessionId, mode) {
    const runtime = this._live(sessionId)
    runtime.inputMode = mode === 'all' ? 'all' : 'host'
    this.share.broadcastInfo(sessionId, { inputMode: runtime.inputMode })
    this.emit('share:changed', this.share.status(sessionId))
    return { mode: runtime.inputMode }
  }

  async resize(sessionId, cols, rows, fontSize) {
    const runtime = this._live(sessionId)
    // Geometry from an attached host arrives asynchronously and can be absent
    // on the first frame. A null/NaN here would be recorded into the timeline
    // and corrupt playback geometry for the whole session, so refuse it.
    if (!isGeometry(cols) || !isGeometry(rows)) {
      throw new EngineError(CODES.E_INTERNAL, 'Resize requires positive integer cols and rows')
    }
    // The host's font size is not part of the recording, but it is what the
    // grid was fitted with, so an extend can bring the session back looking
    // the way it was left. Kept in the catalog entry (it outlives the
    // runtime) and written only when it changes: resizes are frequent.
    if (isFontSize(fontSize) && fontSize !== runtime.fontSize) {
      runtime.fontSize = fontSize
      await this.catalog.update(sessionId, { fontSize })
    }
    runtime.cols = cols
    runtime.rows = rows
    // With viewers attached the host owns cols/rows; the core only records
    // what it is told and never resizes a terminal it does not own.
    if (runtime.mode !== 'attach') runtime.pty.resize(cols, rows)
    runtime.mirrorQueue = runtime.mirrorQueue.then(() => runtime.mirror.resize(cols, rows))
    const tsMs = Date.now()
    runtime.appendQueue = runtime.appendQueue
      .then(() => runtime.store.appendResize(cols, rows, { hd: runtime.hd, tsMs }))
      .then(() => runtime.archiveMirror.resize(cols, rows))
      .then(() => runtime.store.flushTimeline())
    // Mid-restore the resize is queued behind the replay like live output;
    // the pty already has the new size, so do not hold the caller for it.
    if (runtime.restoring) return true
    await runtime.appendQueue
    this._maybeSnapshot(sessionId, true)
    this.share.broadcastTimeline(sessionId)
    this.share.broadcastBootstrap(sessionId).catch(() => {})
    return true
  }

  setHd(sessionId, enabled) {
    const runtime = this._live(sessionId)
    const hd = !!enabled
    if (runtime.hd === hd) return { hd: runtime.hd }
    this._flushPacketBuffer(sessionId)
    runtime.hd = hd
    this.emit('session:hd-changed', { sessionId, hd })
    return { hd }
  }

  async removeHd(sessionId) {
    const copying = this.sessions.get(sessionId)
    if (copying && copying.historyCopy) {
      throw new EngineError(CODES.E_INTERNAL, 'History is still being copied into this session')
    }
    await this._closePlayer(sessionId)
    const runtime = this.sessions.get(sessionId)
    if (runtime) {
      this._flushPacketBuffer(sessionId)
      await runtime.appendQueue
      runtime.hd = false
      const result = await runtime.store.removeHd()
      await runtime.snapshot.clear()
      runtime.archiveMirror.dispose()
      runtime.archiveMirror = await buildArchiveMirror(runtime.store)
      runtime.archiveStale = false
      runtime.lastSnapshotBytes = runtime.bytesSeen
      this.emit('session:hd-changed', { sessionId, hd: false })
      this.emit('session:list-changed', await this.listSessions())
      return result
    }

    const result = await this._withStore(sessionId, (store) => store.removeHd())
    const snapshot = new SnapshotCache(this.paths.snapshots, sessionId, this.localDevice)
    await snapshot.clear()
    this.emit('session:list-changed', await this.listSessions())
    return result
  }

  // Per-session backpressure state. For attached sessions the buffered/dropped
  // counters are the only visible evidence that a host ignored pause().
  diagnostics(sessionId) {
    const ids = sessionId ? [sessionId] : Array.from(this.sessions.keys())
    const sessions = []
    for (const id of ids) {
      const runtime = this.sessions.get(id)
      if (!runtime) continue
      sessions.push({
        sessionId: id,
        mode: runtime.mode || 'spawn',
        active: runtime.active,
        cols: runtime.cols,
        rows: runtime.rows,
        pendingBytes: runtime.pendingBytes,
        flowPaused: !!runtime.flowPaused,
        bufferLimit: ATTACH_BUFFER_LIMIT,
        bufferedBytes: runtime.attachBufferedBytes || 0,
        bufferedChunks: runtime.attachBuffer ? runtime.attachBuffer.length : 0,
        droppedBytes: runtime.dropped ? runtime.dropped.bytes : 0,
        droppedChunks: runtime.dropped ? runtime.dropped.chunks : 0
      })
    }
    return { sessions }
  }

  ack(sessionId, bytes = 0) {
    const runtime = this.sessions.get(sessionId)
    if (!runtime) return true
    runtime.pendingBytes = Math.max(0, runtime.pendingBytes - bytes)
    this._updateFlow(sessionId, runtime)
    return true
  }

  // One pause for two reasons: the renderer is FLOW_LIMIT behind (pendingBytes,
  // lowered by ack), or the core itself is CORE_BACKLOG_LIMIT behind (the
  // mirror or the store, lowered as they catch up). The PTY is paused when
  // either is over its limit and resumed - replaying what an attached host
  // sent meanwhile - only once both are below half. A session still
  // restoring its history holds its output behind the restore by design, so
  // that backlog does not count until the restore is done.
  _updateFlow(sessionId, runtime) {
    if (!runtime.pty || !runtime.active) return
    const backlog = runtime.restoring
      ? 0
      : Math.max(runtime.mirrorBacklog || 0, runtime.appendBacklog || 0)
    if (!runtime.flowPaused) {
      if (runtime.pendingBytes > FLOW_LIMIT || backlog > CORE_BACKLOG_LIMIT) {
        runtime.flowPaused = true
        runtime.pty.pause()
      }
      return
    }
    if (runtime.pendingBytes < FLOW_LIMIT / 2 && backlog < CORE_BACKLOG_LIMIT / 2) {
      runtime.flowPaused = false
      runtime.pty.resume()
      this._drainAttachBuffer(sessionId)
    }
  }

  async clearCaches(sessionId) {
    if (sessionId) {
      const runtime = this.sessions.get(sessionId)
      const remote = this.remoteSessions.get(sessionId)
      if (remote) {
        throw new EngineError(
          CODES.E_INTERNAL,
          'Joined-session history can only be deleted by its host'
        )
      }
      await this._closePlayer(sessionId)
      if (runtime) {
        // Everything is about to go anyway: stop a history copy rather than
        // wait for it.
        if (runtime.historyCopy) runtime.restoreAborted = true
        this._flushPacketBuffer(sessionId)
        await runtime.appendQueue
        await runtime.mirrorQueue
        await runtime.store.log.truncate(0)
        runtime.store.timeline = []
        runtime.store.timelineDirty = true
        await runtime.store.flushTimeline()
        await runtime.store.log.update()
        runtime.archiveMirror.dispose()
        runtime.archiveMirror = new TerminalFrame(
          runtime.store.info.cols,
          runtime.store.info.rows,
          {
            scrollback: 0
          }
        )
        runtime.archiveStale = false
        runtime.lastSnapshotAt = Date.now()
        runtime.lastSnapshotBytes = runtime.bytesSeen
        await runtime.snapshot.clear()
        this.share.broadcastTimeline(sessionId)
        this.emit('session:list-changed', await this.listSessions())
        return { timeline: [], active: true }
      }

      await this._withStore(sessionId, async (store) => {
        await store.log.truncate(0)
        store.timeline = []
        store.timelineDirty = true
        await store.flushTimeline()
        await store.log.update()
      })
      const snapshot = new SnapshotCache(this.paths.snapshots, sessionId, this.localDevice)
      await snapshot.clear()
      this.emit('session:list-changed', await this.listSessions())
      return { timeline: [], active: false }
    }
    await fs.promises.rm(this.paths.snapshots, { recursive: true, force: true })
    await fs.promises.mkdir(this.paths.snapshots, { recursive: true })
    return true
  }

  _createRuntime(sessionId, store, snapshot, cols, rows, mode = 'spawn') {
    const now = Date.now()
    const runtime = {
      store,
      snapshot,
      pty: null,
      mode,
      mirror: new TerminalFrame(cols, rows, { scrollback: LIVE_SCROLLBACK }),
      archiveMirror: new TerminalFrame(cols, rows, { scrollback: 0 }),
      mirrorQueue: Promise.resolve(),
      exitPromise: null,
      resolveExit: null,
      pendingBytes: 0,
      flowPaused: false,
      // Bytes recorded but not yet through the live mirror / into the store
      // (CORE_BACKLOG_LIMIT), and the chunks the mirror has not written yet
      // (buildLiveBootstrap).
      mirrorBacklog: 0,
      mirrorPending: [],
      appendBacklog: 0,
      // Numbers packet flushes, so only the newest one queued rewrites the
      // timeline (_flushPacketBuffer).
      appendSeq: 0,
      attachBuffer: [],
      attachBufferedBytes: 0,
      dropped: { chunks: 0, bytes: 0 },
      dropWarned: false,
      appendQueue: Promise.resolve(),
      packetBuffer: [],
      flushTimer: null,
      firstBufferedAt: 0,
      lastSnapshotAt: now,
      lastSnapshotBytes: 0,
      bytesSeen: 0,
      hd: false,
      cols,
      rows,
      active: true,
      exit: null,
      liveSince: now
    }
    runtime.exitPromise = new Promise((resolve) => {
      runtime.resolveExit = resolve
    })
    return runtime
  }

  _startRuntimePty(sessionId, runtime) {
    const opts = { cols: runtime.cols, rows: runtime.rows, ...(runtime.launch || {}) }
    runtime.pty =
      runtime.mode === 'attach'
        ? this.ptyHost.attach(sessionId, opts)
        : this.ptyHost.spawn(sessionId, opts)
  }

  async openPlayer(sessionId) {
    // Outside the lock: it takes the other sessions' locks, and two opens
    // doing that inside their own would deadlock.
    await this._closeOtherPlayers(sessionId)
    return await this._withStoreLock(sessionId, () => this._openPlayerLocked(sessionId))
  }

  async _openPlayerLocked(sessionId) {
    this._assertNotDeleting(sessionId)
    const existing = this.players.get(sessionId)
    if (existing) {
      existing.player.pause()
      try {
        const remote = this.remoteSessions.get(sessionId)
        if (existing.store.remote && remote && remote.active) {
          if (remote.timelineQueue) await remote.timelineQueue.catch(() => {})
          await this._refreshRemoteTimelineFromDisk(remote)
          existing.store.playbackLength = await this._remoteAvailableLength(remote)
        } else if (existing.store.remote) {
          await existing.store.extendTimeline().catch(() => {})
        }
        const length =
          existing.store.remote && remote && remote.active
            ? existing.store.playbackLength
            : await playbackLength(existing.store)
        existing.store.playbackLength = length
        assertPlayableLength(existing.store, length)
        const frame =
          this._currentRemoteFrame(sessionId, length) || (await existing.player.buildFrame(length))
        existing.player.seq = length
        existing.player.currentTsMs = frame.tsMs
        return {
          sessionId,
          frame,
          timeline: existing.store.timeline,
          length,
          availability:
            existing.store.remote && remote && remote.active
              ? await remoteAvailabilitySummary(remote)
              : await availabilitySummary(existing.store),
          active:
            !!this.sessions.get(sessionId) || !!(this.remoteSessions.get(sessionId) || {}).active,
          hd: !!frame.hd,
          altScreen: await this._altScreenSummary(sessionId)
        }
      } catch (err) {
        await this._closePlayerNow(sessionId)
        throw err
      }
    }

    let store
    let snapshot
    let ownsStore = false
    const runtime = this.sessions.get(sessionId)
    if (runtime) {
      store = runtime.store
      snapshot = runtime.snapshot
    } else {
      const remote = this.remoteSessions.get(sessionId)
      if (remote) {
        store = remote.store
        snapshot = remote.snapshot
        if (remote.timelineQueue) await remote.timelineQueue.catch(() => {})
        await this._refreshRemoteTimelineFromDisk(remote)
        store.playbackLength = await this._remoteAvailableLength(remote)
      } else {
        const entry = await this.catalog.get(sessionId)
        // Opening a store that does not exist would create an empty one.
        if (!entry) throw new EngineError(CODES.E_INTERNAL, 'Session was not found')
        if (entry && entry.owner === 'joined') {
          store = await SessionStore.openJoined(this.paths.corestore, sessionId, this.localDevice)
          await store.rebuildTimeline().catch(() => {})
          store.playbackLength = await store.availableLength().catch(() => store.timeline.length)
        } else {
          store = await SessionStore.open(this.paths.corestore, sessionId, this.localDevice)
        }
        snapshot = new SnapshotCache(this.paths.snapshots, sessionId, this.localDevice)
        await snapshot.ready()
        ownsStore = true
      }
    }
    const player = new Player(store, snapshot)
    player.on('player:frame', (frame) => this.emit('player:frame', { sessionId, frame }))
    player.on('player:data', (packet) =>
      this.emit('player:data', serializePacket(sessionId, packet))
    )
    player.on('player:end', () => this.emit('player:end', { sessionId }))
    player.on('player:error', (err) => this.emit('engine:error', EngineError.from(err).toJSON()))
    this.players.set(sessionId, { player, store, ownsStore })
    try {
      const remote = this.remoteSessions.get(sessionId)
      const length =
        store.remote && remote && remote.active
          ? await this._remoteAvailableLength(remote)
          : await playbackLength(store)
      store.playbackLength = length
      assertPlayableLength(store, length)
      const frame = this._currentRemoteFrame(sessionId, length) || (await player.buildFrame(length))
      player.seq = frame.seq
      player.currentTsMs = frame.tsMs
      return {
        sessionId,
        frame,
        timeline: store.timeline,
        length,
        availability:
          store.remote && this.remoteSessions.has(sessionId)
            ? await remoteAvailabilitySummary(this.remoteSessions.get(sessionId))
            : await availabilitySummary(store),
        active: !!runtime || !!(this.remoteSessions.get(sessionId) || {}).active,
        hd: !!frame.hd,
        altScreen: await this._altScreenSummary(sessionId)
      }
    } catch (err) {
      await this._closePlayerNow(sessionId)
      throw err
    }
  }

  async playerSeek(sessionId, tsMs) {
    if (!this.players.has(sessionId)) await this.openPlayer(sessionId)
    await this._refreshRemoteHandle(sessionId)
    return await this._player(sessionId).seek(tsMs)
  }

  async playerPlay(sessionId, speed, collapse) {
    if (!this.players.has(sessionId)) await this.openPlayer(sessionId)
    await this._refreshRemoteHandle(sessionId)
    this._player(sessionId).play(speed, collapse)
    return true
  }

  playerPause(sessionId) {
    const handle = this.players.get(sessionId)
    if (!handle) return true
    handle.player.pause()
    return true
  }

  async playerStep(sessionId, delta) {
    if (!this.players.has(sessionId)) await this.openPlayer(sessionId)
    await this._refreshRemoteHandle(sessionId)
    return await this._player(sessionId).stepPacket(delta)
  }

  /**
   * Opens (or re-points) a player at a caller-supplied geometry.
   *
   * `{ cols, rows }` re-renders history at that size instead of the
   * recording's - fit-to-window playback. Omitting both (or passing 0) goes
   * back to true-to-recording, which is the default and what every other
   * player method keeps doing. An optional `tsMs` says where to land, so a
   * caller switching modes mid-playback keeps its position instead of jumping
   * to the end of the recording.
   *
   * Like `seek()` and `step()` this PAUSES: it rebuilds a whole screen, and
   * leaving the packet stream running would race the rebuilt frame. Callers
   * that were playing call `player.play` again afterwards.
   */
  async playerView(sessionId, args = {}) {
    const viewport = viewportFrom(args)
    let state = null
    if (!this.players.has(sessionId)) state = await this.openPlayer(sessionId)
    else await this._refreshRemoteHandle(sessionId)
    const handle = this.players.get(sessionId)
    const player = handle.player
    player.pause()
    player.setViewport(viewport)
    const length = await this._playerLength(sessionId, handle)
    const tsMs = Number.isFinite(args.tsMs) ? Number(args.tsMs) : null
    const seq =
      tsMs === null
        ? Math.min(player.seq, length)
        : Math.min(seqForTime(handle.store.timeline, tsMs), length)
    const frame = await player.buildFrame(seq, tsMs === null ? player.currentTsMs : tsMs)
    player.seq = seq
    player.currentTsMs = frame.tsMs
    const result = state || {
      sessionId,
      timeline: handle.store.timeline,
      length,
      active: !!this.sessions.get(sessionId) || !!(this.remoteSessions.get(sessionId) || {}).active
    }
    result.frame = frame
    result.hd = !!frame.hd
    result.view = viewport
    result.altScreen = await this._altScreenSummary(sessionId)
    this.emit('player:frame', { sessionId, frame })
    return result
  }

  async _playerLength(sessionId, handle) {
    if (Number.isFinite(handle.store.playbackLength)) return handle.store.playbackLength
    return await playbackLength(handle.store)
  }

  /**
   * Which stretches of a recording were painted on the alternate screen.
   *
   * Computed on playback, never stored: the on-disk format is frozen, and a
   * recording made before this code existed has to answer the question too.
   * Cached on the open player handle and keyed by the length it was computed
   * at, so scrubbing a recording scans it once and a still-growing one is
   * rescanned when it grows.
   */
  async _altScreenSummary(sessionId) {
    const handle = this.players.get(sessionId)
    if (!handle) return { used: false, ranges: [], scanned: false }
    const length = await this._playerLength(sessionId, handle)
    if (handle.altScreen && handle.altScreenLength === length) return handle.altScreen
    let summary
    try {
      // `{ wait: false }` for a remote store is what actually makes the "say
      // so rather than claiming fit-safe" comment below true: readRange's
      // default (`wait: true`) instead hangs hypercore's `get()` forever on
      // the first block that has not replicated yet, which never throws - it
      // just never resolves, taking whatever invoke() called this
      // (openPlayer/playerView, on the seek/scrub path) down with it until
      // engine/client.js's invoke timeout kills and respawns the whole
      // worker over one scan. With `wait: false`, an incomplete range comes
      // back short (readRange stops at the first undownloaded block) instead
      // of throwing, so `scanned` has to check reach, not just survival.
      summary = await scanAltScreenRanges(
        handle.store.readRange(1, length, { wait: !handle.store.remote })
      )
      handle.altScreen = {
        used: summary.used,
        ranges: summary.ranges,
        // A remote store with history still downloading cannot be fully
        // scanned; say so rather than claiming the recording is fit-safe.
        scanned: summary.lastSeq >= length
      }
    } catch {
      handle.altScreen = { used: false, ranges: [], scanned: false }
    }
    handle.altScreenLength = length
    return handle.altScreen
  }

  // Remote/joined stores keep replicating new history in the background from
  // the host even while a Player stays open across a scrub session. Only the
  // live socket path (applyRemoteData) auto-updates; the store's timeline and
  // playbackLength need an explicit catch-up before every playback op or they
  // stay frozen at whatever they were when the player was first opened.
  async _refreshRemoteHandle(sessionId) {
    const handle = this.players.get(sessionId)
    if (!handle || !handle.store.remote) return
    const remote = this.remoteSessions.get(sessionId)
    if (remote && remote.active) {
      if (remote.timelineQueue) await remote.timelineQueue.catch(() => {})
      await this._refreshRemoteTimelineFromDisk(remote)
      handle.store.playbackLength = await this._remoteAvailableLength(remote)
      return
    }
    await handle.store.extendTimeline().catch(() => {})
    handle.store.playbackLength = await handle.store.availableLength().catch(() => {
      return handle.store.playbackLength || timelineLength(handle.store.timeline)
    })
    this._scheduleJoinedSnapshotBackfill(sessionId)
  }

  async close() {
    // Stop every background restore and history copy first: a copy reads from
    // another session's store, which the loop below may close before its own.
    for (const runtime of this.sessions.values()) runtime.restoreAborted = true
    for (const id of Array.from(this.sessions.keys())) {
      const runtime = this.sessions.get(id)
      // Detaches, not terminates, when the runtime is attached - see
      // closeSession(). Shutting the engine down leaves host terminals alone.
      runtime.restoreAborted = true
      runtime.pty.kill()
      await Promise.race([runtime.exitPromise, delay(1000)])
      await runtime.appendQueue.catch(() => {})
      await runtime.mirrorQueue.catch(() => {})
      runtime.mirror.dispose()
      runtime.archiveMirror.dispose()
      await runtime.store.close()
    }
    for (const id of Array.from(this.players.keys())) {
      await this._closePlayer(id)
    }
    for (const remote of this.remoteSessions.values()) {
      remote.active = false
      if (remote.timelineQueue) await remote.timelineQueue.catch(() => {})
      if (remote.snapshotQueue) await remote.snapshotQueue.catch(() => {})
      if (remote.historyDownloads) {
        for (const download of remote.historyDownloads) download.destroy()
        remote.historyDownloads.clear()
      }
      if (remote.historyDownloadQueue) await remote.historyDownloadQueue.catch(() => {})
      if (remote.mirror) remote.mirror.dispose()
      await remote.store.close().catch(() => {})
    }
    this.identityResolver.close()
    await this.share.close()
    await this.catalog.close()
    if (this.profileLock) await this.profileLock.release()
  }

  _onPtyData(sessionId, data) {
    const runtime = this.sessions.get(sessionId)
    // Backpressure fallback for attach mode. pause() cannot be enforced on a
    // terminal the core does not own, so data that arrives after a pause is
    // held in a capped buffer and replayed on resume; past the cap it is
    // dropped and counted, and diagnostics() reports both numbers.
    if (runtime && runtime.mode === 'attach' && runtime.flowPaused) {
      if (runtime.attachBufferedBytes + data.byteLength > ATTACH_BUFFER_LIMIT) {
        runtime.dropped.chunks += 1
        runtime.dropped.bytes += data.byteLength
        if (!runtime.dropWarned) {
          runtime.dropWarned = true
          this.emit(
            'engine:error',
            new EngineError(
              CODES.E_INTERNAL,
              'Attached terminal ignored backpressure: output is being dropped',
              { sessionId, bufferLimit: ATTACH_BUFFER_LIMIT }
            ).toJSON()
          )
        }
        return
      }
      runtime.attachBuffer.push(data)
      runtime.attachBufferedBytes += data.byteLength
      return
    }
    this._recordLiveData(sessionId, data)
  }

  _drainAttachBuffer(sessionId) {
    const runtime = this.sessions.get(sessionId)
    if (!runtime || !runtime.attachBuffer.length) return
    const chunks = runtime.attachBuffer.splice(0)
    runtime.attachBufferedBytes = 0
    for (let i = 0; i < chunks.length; i++) {
      if (runtime.flowPaused) {
        // Replaying re-tripped the flow limit: keep the rest buffered instead
        // of pushing past it.
        runtime.attachBuffer = chunks.slice(i)
        runtime.attachBufferedBytes = byteLength(runtime.attachBuffer)
        return
      }
      this._recordLiveData(sessionId, chunks[i])
    }
  }

  _recordLiveData(sessionId, data) {
    const runtime = this.sessions.get(sessionId)
    if (!runtime) return
    runtime.pendingBytes += data.byteLength
    runtime.mirrorBacklog += data.byteLength
    runtime.appendBacklog += data.byteLength
    this._updateFlow(sessionId, runtime)
    this.emit('session:data', {
      sessionId,
      source: 'pty',
      hd: !!runtime.hd,
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    })
    this.share.broadcastData(sessionId, data, { hd: runtime.hd })
    runtime.packetBuffer.push(data)
    this._schedulePacketFlush(sessionId, data)
    runtime.mirrorPending.push(data)
    runtime.mirrorQueue = runtime.mirrorQueue.then(async () => {
      try {
        await runtime.mirror.write(data.toString('utf8'))
      } finally {
        runtime.mirrorPending.shift()
        runtime.mirrorBacklog -= data.byteLength
        this._updateFlow(sessionId, runtime)
      }
    })
    runtime.bytesSeen += data.byteLength
    this._maybeSnapshot(sessionId)
  }

  _flushPacketBuffer(sessionId) {
    const runtime = this.sessions.get(sessionId)
    if (!runtime) return
    if (runtime.flushTimer) clearTimeout(runtime.flushTimer)
    runtime.flushTimer = null
    runtime.firstBufferedAt = 0
    const chunks = runtime.packetBuffer.splice(0)
    if (!chunks.length) return
    const data = Buffer.concat(chunks)
    const hd = runtime.hd
    // Output held behind a restore or history copy keeps the time it was
    // produced at, not the time it finally lands.
    const tsMs = Date.now()
    const seq = ++runtime.appendSeq
    runtime.appendQueue = runtime.appendQueue
      .then(() => runtime.store.appendData(data, { hd, tsMs }))
      .then(() => runtime.archiveMirror.write(data.toString('utf8')))
      .then(async () => {
        // When appends queue up (a flood), only the newest one queued
        // rewrites timeline.json and tells viewers, for all of them at once;
        // one rewrite of the whole file and one timeline message per packet
        // was most of what kept the queue behind.
        if (seq !== runtime.appendSeq) return
        await runtime.store.flushTimeline()
        this.share.broadcastTimeline(sessionId)
      })
      .catch((err) => this.emit('engine:error', EngineError.from(err).toJSON()))
      .then(() => {
        runtime.appendBacklog -= data.byteLength
        this._updateFlow(sessionId, runtime)
      })
  }

  _schedulePacketFlush(sessionId, data) {
    const runtime = this.sessions.get(sessionId)
    if (!runtime) return
    const now = Date.now()
    if (!runtime.firstBufferedAt) runtime.firstBufferedAt = now

    const bufferedBytes = byteLength(runtime.packetBuffer)
    const age = now - runtime.firstBufferedAt
    const hasBoundary = hasTerminalBoundary(data)
    const profile = runtime.hd ? ARCHIVE_PROFILES.hd : ARCHIVE_PROFILES.normal
    const shouldFlush =
      bufferedBytes >= profile.maxBytes ||
      age >= profile.maxMs ||
      (age >= profile.minMs &&
        hasBoundary &&
        bufferedBytes >= Math.min(profile.breakBytes, profile.maxBytes))

    if (shouldFlush) {
      this._flushPacketBuffer(sessionId)
      return
    }

    if (runtime.flushTimer) return
    const delay = Math.max(profile.minMs, profile.maxMs - age)
    runtime.flushTimer = setTimeout(() => this._flushPacketBuffer(sessionId), delay)
  }

  async _onPtyExit(sessionId, exit) {
    const runtime = this.sessions.get(sessionId)
    if (!runtime) return
    // An attached terminal never "exits" - it detaches. Record that as a
    // distinguishable signal so the catalog entry says why the session ended
    // even when the host reports nothing.
    if (runtime.mode === 'attach') {
      exit = {
        code: exit && exit.code !== undefined ? exit.code : null,
        signal: exit && exit.signal ? exit.signal : DETACH_SIGNAL
      }
    }
    try {
      runtime.active = false
      runtime.exit = exit
      // Nothing will look at the live screen again; stop a background restore
      // instead of making the exit wait for it. The output still gets appended.
      runtime.restoreAborted = true
      // Whatever backpressure held back still belongs in the recording.
      if (runtime.attachBuffer && runtime.attachBuffer.length) {
        const buffered = runtime.attachBuffer.splice(0)
        runtime.attachBufferedBytes = 0
        for (const chunk of buffered) this._recordLiveData(sessionId, chunk)
      }
      this._flushPacketBuffer(sessionId)
      await runtime.appendQueue.catch(() => {})
      await this._writeSnapshot(sessionId)
      await runtime.store.finalize()
      await this.catalog.update(sessionId, { active: false, endedAt: Date.now(), exit })
      await this._withStoreLock(sessionId, async () => {
        await runtime.store.close()
        runtime.mirror.dispose()
        runtime.archiveMirror.dispose()
        this.sessions.delete(sessionId)
      })
      this.share.broadcastEnd(sessionId, exit)
      // `uptimeMs` and `command` let the UI tell a command that failed to
      // start (exited at once, non-zero) from a shell the user closed.
      this.emit('session:exit', {
        sessionId,
        exit,
        uptimeMs: Date.now() - runtime.liveSince,
        command: (runtime.launch && runtime.launch.command) || null
      })
      this.emit('session:list-changed', await this.listSessions())
    } catch (err) {
      this.emit('engine:error', EngineError.from(err).toJSON())
    } finally {
      if (runtime.resolveExit) runtime.resolveExit(exit)
    }
  }

  _maybeSnapshot(sessionId, force = false) {
    const runtime = this.sessions.get(sessionId)
    if (!runtime) return
    const enoughBytes = runtime.bytesSeen - runtime.lastSnapshotBytes >= SNAPSHOT_BYTES
    const enoughTime = Date.now() - runtime.lastSnapshotAt >= SNAPSHOT_MS
    if (!force && !enoughBytes && !enoughTime) return
    // Re-armed when the snapshot is scheduled, not when it lands: under a
    // flood the append queue lags, and until then every chunk passed the
    // check again - one snapshot and one packet flush per chunk.
    runtime.lastSnapshotAt = Date.now()
    runtime.lastSnapshotBytes = runtime.bytesSeen
    this._writeSnapshot(sessionId).catch((err) =>
      this.emit('engine:error', EngineError.from(err).toJSON())
    )
  }

  async _writeSnapshot(sessionId) {
    const runtime = this.sessions.get(sessionId)
    if (!runtime) return
    this._flushPacketBuffer(sessionId)
    const snapshotQueue = runtime.appendQueue
    await snapshotQueue
    if (runtime.archiveStale) return
    if (runtime.store.log.length === 0) return
    const frame = runtime.archiveMirror.snapshot(runtime.store.log.length)
    await runtime.snapshot.write(frame.seq, frame)
    runtime.lastSnapshotAt = Date.now()
    runtime.lastSnapshotBytes = runtime.bytesSeen
  }

  _live(sessionId) {
    const runtime = this.sessions.get(sessionId)
    if (!runtime || !runtime.active) {
      throw new EngineError(CODES.E_INTERNAL, 'Session is not live')
    }
    return runtime
  }

  _player(sessionId) {
    const handle = this.players.get(sessionId)
    if (!handle) throw new EngineError(CODES.E_INTERNAL, 'Player is not open')
    return handle.player
  }

  _currentRemoteFrame(sessionId, length) {
    const remote = this.remoteSessions.get(sessionId)
    if (!remote || !remote.active) return null
    if (remote.mirror) {
      const frame = remote.mirror.snapshot(length)
      frame.hd = !!remote.hd
      return frame
    }
    if (!remote.frame) return null
    return { ...remote.frame, seq: length, hd: !!remote.hd }
  }

  _remotePlaybackLength(remote) {
    return this._remoteKnownLength(remote)
  }

  _remoteKnownLength(remote) {
    return Math.max(
      remote && remote.store ? remote.store.log.length || 0 : 0,
      remote && remote.frame ? remote.frame.seq || 0 : 0,
      remote && remote.store ? timelineLength(remote.store.timeline) : 0
    )
  }

  async _remoteAvailableLength(remote) {
    if (!remote || !remote.store) return 0
    return await remote.store.availableLength().catch(() => {
      return Math.min(remote.store.log.length || 0, timelineLength(remote.store.timeline))
    })
  }

  async _refreshRemoteTimelineFromDisk(remote) {
    if (!remote || !remote.store || !remote.store.remote) return
    // Unflushed items in memory are newer than the file (flushRemoteTimeline
    // defers writes); reading it now would roll the timeline back.
    if (remote.store.timelineDirty) return
    const before = timelineLength(remote.store.timeline)
    await remote.store.loadTimeline().catch(() => {})
    if (timelineLength(remote.store.timeline) > before) {
      remote.store.playbackLength = Math.max(
        remote.store.playbackLength || 0,
        timelineLength(remote.store.timeline),
        remote.store.log.length || 0
      )
    }
  }

  async _closeOtherPlayers(sessionId) {
    for (const id of Array.from(this.players.keys())) {
      if (id !== sessionId) await this._closePlayer(id)
    }
  }

  async _closePlayer(sessionId) {
    if (!this.players.has(sessionId)) return
    await this._withStoreLock(sessionId, () => this._closePlayerNow(sessionId))
  }

  // Caller holds the session's store lock.
  async _closePlayerNow(sessionId) {
    const handle = this.players.get(sessionId)
    if (!handle) return
    this.players.delete(sessionId)
    // dispose(), not pause(): a fit-mode player also holds a headless
    // @xterm/headless terminal used to re-render history at the panel's
    // geometry, and only dispose() frees it.
    if (typeof handle.player.dispose === 'function') handle.player.dispose()
    else handle.player.pause()
    if (handle.ownsStore) await handle.store.close()
  }

  _assertNotDeleting(sessionId) {
    if (this.deletingSessions.has(sessionId)) {
      throw new EngineError(CODES.E_INTERNAL, 'Session is being deleted')
    }
  }

  // Opening a session's corestore takes an exclusive lock on its directory, so
  // two overlapping opens of one session fail with "File descriptor could not
  // be locked". Every open, close and hand-over of a session's store runs
  // through this per-session queue. Not reentrant: never call anything that
  // takes the same session's lock (listSessions, _closePlayer, _withStore)
  // from inside `fn`.
  async _withStoreLock(sessionId, fn) {
    if (!this.storeLocks) this.storeLocks = new Map()
    // Calls still queued, see _storeLockWaiting. Kept inline: tests borrow this
    // method onto stand-in objects.
    if (!this.storeLockWaiters) this.storeLockWaiters = new Map()
    const waiters = this.storeLockWaiters
    waiters.set(sessionId, (waiters.get(sessionId) || 0) + 1)
    const run = (this.storeLocks.get(sessionId) || Promise.resolve()).then(() => {
      const count = (waiters.get(sessionId) || 0) - 1
      if (count > 0) waiters.set(sessionId, count)
      else waiters.delete(sessionId)
      return fn()
    })
    const tail = run.catch(() => {})
    this.storeLocks.set(sessionId, tail)
    try {
      return await run
    } finally {
      if (this.storeLocks.get(sessionId) === tail) this.storeLocks.delete(sessionId)
    }
  }

  // Whether a call is queued for the session's store lock, so a long holder
  // (a history copy) can let it in.
  _storeLockWaiting(sessionId) {
    return !!this.storeLockWaiters && this.storeLockWaiters.has(sessionId)
  }

  // Runs `fn` against the session's store: the one a live runtime, joined
  // session or open player already holds, else a short-lived open of its own.
  async _withStore(sessionId, fn) {
    return await this._withStoreLock(sessionId, async () => {
      this._assertNotDeleting(sessionId)
      const held =
        this.sessions.get(sessionId) ||
        this.remoteSessions.get(sessionId) ||
        this.players.get(sessionId)
      if (held) return await fn(held.store)
      const entry = await this.catalog.get(sessionId)
      // Opening a store that does not exist would create an empty one.
      if (!entry) throw new EngineError(CODES.E_INTERNAL, 'Session was not found')
      const store =
        entry && entry.owner === 'joined'
          ? await SessionStore.openJoined(this.paths.corestore, sessionId, this.localDevice)
          : await SessionStore.open(this.paths.corestore, sessionId, this.localDevice)
      try {
        return await fn(store)
      } finally {
        await store.close().catch(() => {})
      }
    })
  }

  async _sessionState(sessionId, runtime) {
    // While an extended session restores its history the live mirror holds
    // nothing worth painting; answer at once with no frame and let the caller
    // repaint on `session:restored` rather than hang until the replay ends.
    let frame = null
    if (!runtime.restoring) {
      await runtime.mirrorQueue
      frame = runtime.mirror.snapshot(runtime.store.log.length)
      frame.hd = runtime.hd
    }
    return {
      sessionId,
      info: runtime.store.info,
      active: runtime.active,
      restoring: !!runtime.restoring,
      timeline: runtime.store.timeline,
      length: runtime.store.log.length,
      availability: await availabilitySummary(runtime.store),
      hd: runtime.hd,
      frame
    }
  }

  identity() {
    return {
      deviceKey: Buffer.from(this.localDevice.publicKey).toString('hex'),
      dhtKey: Buffer.from(this.localDevice.dhtPublicKey).toString('hex'),
      identityKey: Buffer.from(this.localDevice.identityPublicKey).toString('hex'),
      deviceName: this.localDevice.name || null,
      deviceStatus: this.localDevice.status || 'active'
    }
  }

  localIdentityKeyHex() {
    return Buffer.from(this.localDevice.identityPublicKey).toString('hex')
  }

  localAuthKeyHex() {
    return this.localDevice.authPublicKey
      ? Buffer.from(this.localDevice.authPublicKey).toString('hex')
      : null
  }

  async identitySelf() {
    const identityKey = this.localIdentityKeyHex()
    const authKey = this.localAuthKeyHex()
    const record = await this.identityStore.getSelf()
    if (!record || record.provider === UNKNOWN) {
      return {
        configured: false,
        provider: UNKNOWN,
        subject: null,
        displayId: getProvider(UNKNOWN).displayId(identityKey),
        identityKey,
        authKey,
        sshFingerprint: null,
        issuedAt: null
      }
    }
    return {
      configured: true,
      provider: record.provider,
      subject: record.subject,
      displayId: getProvider(record.provider).displayId(record.subject),
      identityKey: record.identityKey,
      authKey: record.authKey,
      sshFingerprint: record.sshFingerprint,
      issuedAt: record.issuedAt
    }
  }

  // Mints the unsigned claim plus the exact bytes an SSH key must sign. The
  // SSH key itself never enters the worker - the shell signs `bytes` and hands
  // the armored signature back to `identity.setSelf`.
  async beginIdentityClaim(args = {}) {
    const provider = getProvider(args.provider)
    if (provider.id === UNKNOWN) {
      throw new EngineError(CODES.E_AUTH, 'The unknown provider cannot be claimed')
    }
    const subject = provider.validateSubject(args.subject)
    const sshPublicKey = args.sshPublicKey || null
    const sshFingerprint = sshPublicKey ? fingerprint(sshPublicKey) : args.sshFingerprint || null
    const claim = {
      version: 2,
      provider: provider.id,
      subject,
      identityKey: this.localIdentityKeyHex(),
      authKey: this.localAuthKeyHex(),
      sshPublicKey,
      sshKeyType: args.sshKeyType || KEY_TYPE,
      sshFingerprint,
      issuedAt: Date.now(),
      nonce: randomHex(16)
    }
    return { claim, bytes: Buffer.from(claimBytes(claim)).toString('base64') }
  }

  async setIdentitySelf(args = {}) {
    const claim = args.claim
    if (!claim || typeof claim !== 'object') {
      throw new EngineError(CODES.E_AUTH, 'An identity claim is required')
    }
    const signature = args.signature || claim.signature
    if (!signature) throw new EngineError(CODES.E_AUTH, 'A claim signature is required')
    const identityKey = this.localIdentityKeyHex()
    const authKey = this.localAuthKeyHex()
    if (claim.identityKey !== identityKey) {
      throw new EngineError(CODES.E_AUTH, 'Identity claim is not bound to this profile')
    }
    if (claim.authKey !== authKey) {
      throw new EngineError(CODES.E_AUTH, 'Identity claim is not bound to this device auth key')
    }
    const parsed = parseArmoredSignature(signature)
    const record = {
      ...claim,
      version: 2,
      signature,
      sshPublicKey: claim.sshPublicKey || Buffer.from(parsed.pubkeyBlob).toString('base64'),
      createdAt: Date.now()
    }
    // IdentityStore.setSelf re-verifies the SSHSIG against the canonical claim
    // bytes and throws E_AUTH if it does not check out.
    await this.identityStore.setSelf(record)
    await this._refreshSelfIdentityClaim()
    const self = await this.identitySelf()
    this.emit('identity:changed', self)
    return self
  }

  async clearIdentity() {
    await this.identityStore.clearSelf(this.localIdentityKeyHex())
    await this._refreshSelfIdentityClaim()
    const self = await this.identitySelf()
    this.emit('identity:changed', self)
    return self
  }

  // Keeps `selfIdentityClaim` (read synchronously by the join handshake) in
  // step with the stored record. A corrupt/unreadable record is treated as
  // "no identity", never as an error - identity is never required to share.
  async _refreshSelfIdentityClaim() {
    try {
      const record = await this.identityStore.getSelf()
      this.selfIdentityClaim = record && record.provider !== UNKNOWN ? record : null
    } catch {
      this.selfIdentityClaim = null
    }
    return this.selfIdentityClaim
  }

  // Renderer/handshake facing key lookup. Deliberately strips `blobBase64`:
  // callers of `identity.lookup` only ever compare fingerprints, and there is
  // no reason to hand raw key blobs to the UI.
  async lookupIdentityKeys(args = {}) {
    const provider = getProvider(args.provider)
    const subject = provider.validateSubject(args.subject)
    const answer = await this.identityResolver.resolve(provider.id, subject, {
      refresh: !!args.refresh
    })
    return {
      provider: provider.id,
      subject,
      status: answer.status,
      fetchedAt: answer.fetchedAt,
      source: answer.source,
      keys: answer.keys.map((key) => ({ keyType: key.keyType, fingerprint: key.fingerprint }))
    }
  }

  // What the Join dialog shows before it connects: the identity an invite
  // carries, checked as far as it can be without a peer to challenge.
  //
  // This is layer 1 only. A `verified` answer means the invite carries a
  // genuine claim - it does NOT mean the host on the other end holds it, which
  // is what the live challenge in ShareManager's handshake decides. Joining
  // still runs that full gate, so a green check here can never let a peer
  // through that the handshake would refuse.
  async inspectInviteIdentity(args = {}) {
    let claim = args.claim || null
    if (!claim && args.uri) {
      // Throws E_AUTH on a malformed invite, which is what the UI wants to
      // show for a link that was truncated in a chat window.
      claim = ShareManager.decodeLink(String(args.uri)).claim || null
    }
    const outcome = await inspectClaim({ claim, resolver: this.identityResolver })
    return {
      status: outcome.status,
      displayId: outcome.displayId,
      provider: outcome.provider,
      subject: outcome.subject,
      sshFingerprint: outcome.sshFingerprint,
      reason: outcome.reason,
      // `unknown` covers both "no claim at all" and "we could not reach the
      // provider", and the UI says very different things about the two.
      claimed: !!claim
    }
  }

  async annotateIdentityPeer(args = {}) {
    if (!args.identityKey) {
      throw new EngineError(CODES.E_INTERNAL, 'identityKey is required')
    }
    return await this.identityStore.putPeer(args.identityKey, {
      localName: args.name === undefined ? undefined : args.name,
      localComment: args.comment === undefined ? undefined : args.comment
    })
  }

  // The screen as of every byte recorded so far. Output recorded while the
  // mirror catches up has already been broadcast to the peers confirmed so
  // far, and a caller confirms its own peer only once this returns - so that
  // output must be in the frame, or a viewer joining (or resynced, see
  // ShareManager::_resyncPeer) mid-flood loses it. Once the awaited queue
  // settles, the chunks queued after it have not reached the mirror yet
  // (their writes run after this continuation) and go in as a raw tail after
  // the serialised screen; nothing is awaited after that.
  async buildLiveBootstrap(sessionId, opts = {}) {
    const runtime = this._live(sessionId)
    await runtime.mirrorQueue
    const frame = runtime.mirror.snapshot(runtime.store.log.length, Date.now(), opts)
    if (runtime.mirrorPending && runtime.mirrorPending.length) {
      let tail = Buffer.concat(runtime.mirrorPending)
      // A resync (opts.tailBytes) keeps only the end of what is pending - up
      // to CORE_BACKLOG_LIMIT under a flood - cut at a line start, so the
      // screen it paints is the latest one, small enough to send at once.
      if (Number.isFinite(opts.tailBytes) && tail.byteLength > opts.tailBytes) {
        const from = tail.byteLength - opts.tailBytes
        const nl = tail.indexOf(0x0a, from)
        tail = tail.subarray(nl === -1 ? from : nl + 1)
      }
      frame.data += tail.toString('utf8')
    }
    frame.hd = !!runtime.hd
    return frame
  }

  // Concurrent connections for the same session (eg. a direct + relayed
  // socket both confirming around the same time) can both reach here before
  // either has inserted into remoteSessions. Without de-duping, both try to
  // open the same on-disk Hypercore/RocksDB directory at once and the loser
  // fails with "File descriptor could not be locked" - and every future
  // message on that connection keeps re-throwing the same cached rejection.
  // Track in-flight registrations per sessionId so racing callers await the
  // same open instead of racing the filesystem lock.
  async registerRemoteSession(message) {
    if (this.remoteSessions.has(message.sessionId)) {
      return this.remoteSessions.get(message.sessionId)
    }
    if (!this._registeringRemote) this._registeringRemote = new Map()
    const inFlight = this._registeringRemote.get(message.sessionId)
    if (inFlight) return inFlight
    const promise = this._doRegisterRemoteSession(message).finally(() => {
      this._registeringRemote.delete(message.sessionId)
    })
    this._registeringRemote.set(message.sessionId, promise)
    return promise
  }

  async _doRegisterRemoteSession(message) {
    if (this.remoteSessions.has(message.sessionId)) {
      return this.remoteSessions.get(message.sessionId)
    }
    // A player opened earlier for offline playback/history of this same
    // (previously joined) session may still hold its own SessionStore open
    // on the same corestore directory. Close it first, or the exclusive open
    // below fails with "File descriptor could not be locked".
    const sessionId = message.sessionId
    const remote = await this._withStoreLock(sessionId, () => this._openRemoteLocked(message))
    this.emit('session:list-changed', await this.listSessions())
    return remote
  }

  async _openRemoteLocked(message) {
    if (this.remoteSessions.has(message.sessionId)) {
      return this.remoteSessions.get(message.sessionId)
    }
    await this._closePlayerNow(message.sessionId)
    const store = await SessionStore.openRemote(
      this.paths.corestore,
      message.sessionId,
      this.localDevice,
      {
        logKey: message.logKey,
        metaKey: message.metaKey,
        hostDeviceKey: message.hostDeviceKey,
        envelope: message.envelope,
        info: message.info
      }
    )
    // The store now holds an exclusive lock on its on-disk directory. If
    // anything below fails, close it before rethrowing - otherwise the lock
    // leaks for the lifetime of the process (nothing else references this
    // store), permanently blocking any future join attempt for this session.
    try {
      const snapshot = new SnapshotCache(this.paths.snapshots, message.sessionId, this.localDevice)
      await snapshot.ready()
      const entry = {
        sessionId: message.sessionId,
        name: message.info.name,
        startedAt: message.info.createdAt,
        lastStartedAt: message.info.createdAt,
        endedAt: null,
        active: true,
        owner: 'joined',
        path: store.dir
      }
      await this.catalog.put(entry)
      return await this._finishRegisterRemoteSession(message, store, snapshot)
    } catch (err) {
      await store.close().catch(() => {})
      throw err
    }
  }

  _finishRegisterRemoteSession(message, store, snapshot) {
    const remote = {
      store,
      snapshot,
      active: true,
      hd: false,
      frame: null,
      mirror: null,
      mirrorQueue: Promise.resolve(),
      timelineQueue: Promise.resolve(),
      snapshotQueue: Promise.resolve(),
      historyDownloadQueue: Promise.resolve(),
      historyDownloads: new Set(),
      historyDownloadTarget: 0,
      historyDownloadActive: false,
      inputCtr: 0,
      inputMode: message.inputMode || 'host',
      message: null,
      // The share backend's history handle, set by ShareManager once the join
      // is confirmed (::_registerViewerRemote).
      history: null
    }
    this.remoteSessions.set(message.sessionId, remote)
    return remote
  }

  async applyRemoteBootstrap(sessionId, frame) {
    const remote = this.remoteSessions.get(sessionId)
    if (!remote) return
    remote.frame = frame
    remote.hd = !!frame.hd
    // A second bootstrap for a session that already has a mirror is the host
    // re-sending its screen (it does so on every resize). The UI repaints it
    // through `session:restored`, the same event an extended local session
    // uses, which never changes the selected session.
    const repaint = !!remote.mirror
    if (!remote.mirror) {
      remote.mirror = new TerminalFrame(frame.cols, frame.rows, {
        scrollback: frame.scrollback || LIVE_SCROLLBACK
      })
    }
    remote.mirrorQueue = remote.mirrorQueue.then(async () => {
      await remote.mirror.restore(frame)
      remote.frame = remote.mirror.snapshot(frame.seq, frame.tsMs)
    })
    await remote.mirrorQueue
    remote.active = true
    this.emit('player:frame', { sessionId, frame })
    if (repaint) this.emit('session:restored', { sessionId })
    this.emit('session:list-changed', await this.listSessions())
  }

  applyRemoteData(sessionId, data, opts = {}) {
    const remote = this.remoteSessions.get(sessionId)
    if (!remote) return
    remote.hd = !!opts.hd
    if (remote.mirror) {
      // The mirror is serialised when a caller asks for the screen
      // (openSession, _currentRemoteFrame), never per chunk: a snapshot of
      // 5000 lines of scrollback per chunk cost ~30 ms and held a viewer to
      // ~30 chunks a second while the host sent thousands.
      remote.mirrorQueue = remote.mirrorQueue
        .then(() => remote.mirror.write(data.toString('utf8')))
        .catch((err) => this.emit('engine:error', EngineError.from(err).toJSON()))
    }
    this.emit('session:data', {
      sessionId,
      source: 'socket',
      hd: !!opts.hd,
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    })
  }

  async applyRemoteSnapshot(sessionId, frame) {
    const remote = this.remoteSessions.get(sessionId)
    if (!remote || !remote.snapshot || !frame || !Number.isFinite(frame.seq)) return
    // A failed write fails its own message only, not every one queued after it.
    remote.snapshotQueue = (remote.snapshotQueue || Promise.resolve())
      .catch(() => {})
      .then(() => remote.snapshot.write(frame.seq, frame))
    await remote.snapshotQueue
  }

  async applyRemoteTimeline(sessionId, payload) {
    const remote = this.remoteSessions.get(sessionId)
    if (!remote || !remote.store || !payload || !Array.isArray(payload.items)) return
    const items = payload.items
      .filter((item) => item && Number.isFinite(item.seq) && Number.isFinite(item.tsMs))
      .map((item) => ({ seq: item.seq, tsMs: item.tsMs, hd: !!item.hd }))
    if (!items.length) return
    // As for snapshots: a failure fails this message, not the queue.
    const queued = (remote.timelineQueue || Promise.resolve()).catch(() => {})
    remote.timelineQueue = queued.then(async () => {
      remote.store.timeline = mergeTimeline(remote.store.timeline, items)
      remote.store.timelineDirty = true
      if (!payload.more) await flushRemoteTimeline(remote)
      remote.store.playbackLength = Math.max(
        remote.store.playbackLength || 0,
        Number.isFinite(payload.length) ? payload.length : 0,
        timelineLength(remote.store.timeline),
        remote.frame ? remote.frame.seq || 0 : 0
      )
    })
    await remote.timelineQueue
    if (!payload.more) {
      this._scheduleRemoteHistoryDownload(sessionId, payload.length)
      this._scheduleJoinedSnapshotBackfill(sessionId)
    }
  }

  _scheduleRemoteHistoryDownload(sessionId, length) {
    const remote = this.remoteSessions.get(sessionId)
    if (!remote || !remote.store || !remote.store.remote) return
    // The handle the share backend attached at join time (ShareManager
    // ::_registerViewerRemote); without one there is nothing to fetch from.
    if (!remote.history) return
    if (!Number.isFinite(length) || length <= 0) return
    remote.historyDownloadTarget = Math.max(remote.historyDownloadTarget || 0, length)
    if (remote.historyDownloadActive) return
    remote.historyDownloadActive = true
    remote.historyDownloadQueue = (remote.historyDownloadQueue || Promise.resolve())
      .then(async () => {
        while (remote.active && remote.store && remote.store.remote && remote.history) {
          const target = remote.historyDownloadTarget || 0
          const start = await remote.store.availableLength().catch(() => 0)
          if (start >= target) break
          const end = Math.min(target, start + HISTORY_DOWNLOAD_CHUNK)
          const download = remote.history.fetch({ start, end })
          remote.historyDownloads.add(download)
          try {
            await download.done()
          } finally {
            remote.historyDownloads.delete(download)
            download.destroy()
          }
          await remote.store.extendTimeline().catch(() => {})
          this.emit('session:availability-changed', { sessionId })
        }
      })
      .catch((err) => {
        if (remote.active) this.emit('engine:error', EngineError.from(err).toJSON())
      })
      .finally(() => {
        remote.historyDownloadActive = false
        const target = remote.historyDownloadTarget || 0
        remote.store
          .availableLength()
          .then((available) => {
            if (remote.active && available < target) {
              this._scheduleRemoteHistoryDownload(sessionId, target)
            }
          })
          .catch(() => {})
      })
  }

  async applyRemoteInfo(sessionId, info = {}) {
    const remote = this.remoteSessions.get(sessionId)
    if (!remote) return
    const updates = {}
    if (typeof info.name === 'string' && info.name.trim()) {
      const name = info.name.trim()
      await remote.store.updateInfo({ name }).catch(() => {})
      updates.name = name
    }
    if (info.inputMode === 'all' || info.inputMode === 'host') {
      remote.inputMode = info.inputMode
      updates.inputMode = info.inputMode
    }
    if (Object.keys(updates).length) await this.catalog.update(sessionId, updates)
    this.emit('session:list-changed', await this.listSessions())
  }

  async markRemoteOffline(sessionId, exit = { code: 0, signal: 'remote-close' }) {
    const remote = this.remoteSessions.get(sessionId)
    if (!remote || !remote.active) return
    remote.active = false
    await remote.store.rebuildTimeline().catch(() => {})
    remote.store.playbackLength = await remote.store
      .availableLength()
      .catch(() => remote.store.timeline.length)
    await this.catalog.update(sessionId, {
      active: false,
      endedAt: Date.now(),
      length: remote.store.playbackLength
    })
    this._scheduleJoinedSnapshotBackfill(sessionId)
    this.emit('session:exit', { sessionId, exit })
    this.emit('session:list-changed', await this.listSessions())
  }

  _scheduleJoinedSnapshotBackfill(sessionId) {
    if (!sessionId || this.snapshotBackfills.has(sessionId)) return
    const now = Date.now()
    const lastAttempt = this.snapshotBackfillAttempts.get(sessionId) || 0
    if (now - lastAttempt < SNAPSHOT_MS) return
    this.snapshotBackfillAttempts.set(sessionId, now)
    this.snapshotBackfills.add(sessionId)
    setImmediate(() => {
      this._backfillJoinedSnapshots(sessionId)
        .catch((err) => this.emit('engine:error', EngineError.from(err).toJSON()))
        .finally(() => {
          this.snapshotBackfills.delete(sessionId)
          this.listSessions()
            .then((list) => this.emit('session:list-changed', list))
            .catch(() => {})
        })
    })
  }

  async _backfillJoinedSnapshots(sessionId) {
    let store
    let snapshot
    let ownsStore = false
    const remote = this.remoteSessions.get(sessionId)
    const handle = this.players.get(sessionId)
    if (remote) {
      store = remote.store
      snapshot = remote.snapshot
    } else if (handle && handle.store.remote) {
      store = handle.store
      snapshot =
        handle.player.snapshotCache ||
        new SnapshotCache(this.paths.snapshots, sessionId, this.localDevice)
      await snapshot.ready()
    } else {
      const entry = await this.catalog.get(sessionId)
      if (!entry || entry.owner !== 'joined') return
      store = await SessionStore.openJoined(this.paths.corestore, sessionId, this.localDevice)
      snapshot = new SnapshotCache(this.paths.snapshots, sessionId, this.localDevice)
      await snapshot.ready()
      ownsStore = true
    }

    try {
      if (store.remote) await store.loadTimeline().catch(() => {})
      await store.extendTimeline().catch(() => {})
      const length = await playbackLength(store).catch(() => store.timeline.length)
      if (length <= 0) return
      const nearest = snapshot.nearest(length)
      let frame
      let from = 1
      if (nearest) {
        const base = await snapshot.read(nearest.seq)
        frame = new TerminalFrame(base.cols || store.info.cols, base.rows || store.info.rows)
        await frame.restore(base)
        from = nearest.seq + 1
      } else {
        frame = new TerminalFrame(store.info.cols, store.info.rows)
      }

      try {
        let bytesSinceSnapshot = 0
        let lastSeq = from - 1
        let lastTs = store.timeline.length
          ? store.timeline[store.timeline.length - 1].tsMs
          : Date.now()
        for await (const packet of store.readRange(from, length, { wait: false })) {
          lastSeq = packet.seq
          lastTs = packet.tsMs || lastTs
          if (packet.kind === PacketKind.DATA) {
            await frame.write(packet.payload.toString('utf8'))
            bytesSinceSnapshot += packet.payload.byteLength
          } else if (packet.kind === PacketKind.RESIZE) {
            frame.resize(packet.cols, packet.rows)
            bytesSinceSnapshot += 1024
          }
          if (bytesSinceSnapshot >= SNAPSHOT_BYTES) {
            const snap = frame.snapshot(packet.seq, lastTs)
            await snapshot.write(snap.seq, snap)
            bytesSinceSnapshot = 0
          }
        }
        if (
          lastSeq > 0 &&
          (!snapshot.nearest(lastSeq) || snapshot.nearest(lastSeq).seq !== lastSeq)
        ) {
          const snap = frame.snapshot(lastSeq, lastTs)
          await snapshot.write(snap.seq, snap)
        }
      } finally {
        frame.dispose()
      }
    } finally {
      if (ownsStore) await store.close().catch(() => {})
    }
  }
}

// Live timeline updates arrive once per host packet, and rewriting the whole
// timeline.json for each held the viewer's message queue on the disk. The
// first write goes through; later ones within REMOTE_TIMELINE_FLUSH_MS are
// folded into one timer (and store.close() flushes a dirty timeline).
async function flushRemoteTimeline(remote) {
  const now = Date.now()
  if (now - (remote.timelineFlushedAt || 0) >= REMOTE_TIMELINE_FLUSH_MS) {
    remote.timelineFlushedAt = now
    await remote.store.flushTimeline()
    return
  }
  if (remote.timelineFlushTimer) return
  remote.timelineFlushTimer = setTimeout(() => {
    remote.timelineFlushTimer = null
    remote.timelineFlushedAt = Date.now()
    remote.store.flushTimeline().catch(() => {})
  }, REMOTE_TIMELINE_FLUSH_MS)
  if (typeof remote.timelineFlushTimer.unref === 'function') remote.timelineFlushTimer.unref()
}

async function playbackLength(store) {
  if (store.remote) return await store.availableLength()
  return store.log.length
}

async function remoteAvailabilitySummary(remote) {
  const logLength = Math.max(
    remote && remote.store ? remote.store.log.length || 0 : 0,
    remote && remote.store ? timelineLength(remote.store.timeline) : 0,
    remote && remote.frame ? remote.frame.seq || 0 : 0
  )
  const availableLength =
    remote && remote.store
      ? await remote.store.availableLength().catch(() => remote.store.playbackLength || 0)
      : 0
  return { availableLength, logLength, gaps: [] }
}

async function availabilitySummary(store) {
  const logLength = store.log.length || 0
  if (!store.remote) {
    // A local session still copying its history in (copyHistoryFrom) reports
    // it like a joined session's download: all of it known, the copied part
    // available.
    return {
      availableLength: logLength,
      logLength: Math.max(logLength, store.pendingHistoryLength || 0),
      gaps: []
    }
  }
  const availableLength = await store.availableLength().catch(() => store.timeline.length)
  const gaps = []
  let gap = null
  for (let seq = 1; seq <= logLength; seq++) {
    const has = seq <= availableLength ? true : await store.log.has(seq - 1).catch(() => false)
    if (!has && !gap) gap = { startSeq: seq, endSeq: seq }
    else if (!has) gap.endSeq = seq
    else if (gap) {
      gaps.push(gap)
      gap = null
    }
  }
  if (gap) gaps.push(gap)
  return { availableLength, logLength, gaps }
}

// Whether `timeline` holds exactly seqs 1..length in order, at its start.
function contiguousTimeline(timeline, length) {
  if (!Array.isArray(timeline) || timeline.length < length) return false
  if (!length) return true
  const first = timeline[0]
  const last = timeline[length - 1]
  return !!first && !!last && first.seq === 1 && last.seq === length
}

function timelineLength(timeline) {
  if (!Array.isArray(timeline) || !timeline.length) return 0
  return timeline[timeline.length - 1].seq || timeline.length
}

function mergeTimeline(current, items) {
  const base = Array.isArray(current) ? current : []
  // Timeline sync chunks always arrive already sorted and, in the common
  // case, strictly after whatever has already been merged - a plain
  // append. Rebuilding a Map from the whole timeline and re-sorting it on
  // every chunk is O(n^2 log n) over a full sync, which stalls out badly
  // for long, busy sessions (hundreds of thousands of packets). Only fall
  // back to the general merge when a chunk actually overlaps or reorders.
  const lastSeq = base.length ? base[base.length - 1].seq : 0
  if (items.every((item) => item.seq > lastSeq)) {
    return base.concat(items)
  }
  const bySeq = new Map()
  for (const item of base) {
    if (item && Number.isFinite(item.seq) && Number.isFinite(item.tsMs)) {
      bySeq.set(item.seq, { seq: item.seq, tsMs: item.tsMs, hd: !!item.hd })
    }
  }
  for (const item of items) bySeq.set(item.seq, item)
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq)
}

function assertPlayableLength(store, length) {
  if (store.remote && length <= 0) {
    throw new EngineError(
      CODES.E_NOKEY,
      'No replicated history is available locally for this shared session'
    )
  }
}

function serializePacket(sessionId, packet) {
  return {
    sessionId,
    seq: packet.seq,
    tsMs: packet.tsMs,
    kind: packet.kind,
    cols: packet.cols,
    rows: packet.rows,
    hd: !!packet.hd,
    data:
      packet.kind === PacketKind.DATA
        ? packet.payload.buffer.slice(
            packet.payload.byteOffset,
            packet.payload.byteOffset + packet.payload.byteLength
          )
        : null
  }
}

function isGeometry(value) {
  return Number.isInteger(value) && value > 0
}

// A host-reported font size in CSS px. Fractional sizes are legal (the
// renderer's fit-to-grid sizes are), absurd ones are ignored, not rejected:
// the size is advisory and must never fail the resize that carries it.
function isFontSize(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 200
}

/**
 * The geometry `player.view` will re-render at, or null for true-to-recording.
 *
 * Validated rather than defaulted on purpose: `new TerminalFrame(undefined,
 * undefined)` silently falls back to DEFAULT_COLS/DEFAULT_ROWS, so a caller
 * that passed a half-measured panel would get a confidently wrong rendering
 * instead of an error. The ceiling bounds the cell allocation a caller can ask
 * the core to make.
 */
function viewportFrom(args = {}) {
  const { cols, rows } = args
  const unset = (value) => value === undefined || value === null || value === 0
  if (unset(cols) && unset(rows)) return null
  if (!isGeometry(cols) || !isGeometry(rows) || cols > MAX_VIEW_COLS || rows > MAX_VIEW_ROWS) {
    throw new EngineError(
      CODES.E_INTERNAL,
      `player.view requires positive integer cols and rows (max ${MAX_VIEW_COLS}x${MAX_VIEW_ROWS})`
    )
  }
  return { cols, rows }
}

function byteLength(chunks) {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  return total
}

function hasTerminalBoundary(data) {
  if (!data || !data.byteLength) return false
  return data.includes(0x0a) || data.includes(0x0d) || data.includes(0x07)
}

function launchOptions(source = {}) {
  const out = {}
  for (const key of ['cwd', 'command']) {
    const value = typeof source[key] === 'string' ? source[key].trim() : ''
    if (value) out[key] = value
  }
  return out
}

async function buildArchiveMirror(store, opts = {}) {
  const base = opts.base || null
  const to = Number.isFinite(opts.to) ? opts.to : store.log.length
  const frame = base
    ? new TerminalFrame(base.cols, base.rows)
    : new TerminalFrame(store.info.cols, store.info.rows)
  try {
    if (base && base.data) await frame.restore(base)
    for await (const packet of store.readRange((base ? base.seq : 0) + 1, to)) {
      if (opts.aborted && opts.aborted()) break
      if (packet.kind === PacketKind.DATA) await frame.write(packet.payload.toString('utf8'))
      if (packet.kind === PacketKind.RESIZE) frame.resize(packet.cols, packet.rows)
    }
    return frame
  } catch (err) {
    frame.dispose()
    throw err
  }
}

// Where an archive rebuild starts: the newest cached snapshot (written on
// every clean exit, so usually the very end of the recording), else the start.
async function restoreBase(store, snapshot) {
  const nearest = snapshot.nearest(store.log.length)
  if (nearest) {
    try {
      const frame = await snapshot.read(nearest.seq)
      if (frame && isGeometry(frame.cols) && isGeometry(frame.rows)) return frame
    } catch {}
  }
  return {
    seq: 0,
    cols: isGeometry(store.info.cols) ? store.info.cols : 100,
    rows: isGeometry(store.info.rows) ? store.info.rows : 30,
    data: ''
  }
}

// Snapshots are only a cache: one that will not read is skipped, and the
// rebuild simply replays further back.
async function copySnapshots(from, to, length, stop = () => false) {
  try {
    for (const { seq } of from.index.snapshots.slice()) {
      if (stop()) break
      if (seq > length) continue
      let frame
      try {
        frame = await from.read(seq)
      } catch {
        continue
      }
      if (frame) await to.write(seq, frame, { saveIndex: false })
    }
  } finally {
    await to.saveIndex()
  }
}

async function readSnapshotIndex(root, sessionId) {
  try {
    const index = JSON.parse(
      await fs.promises.readFile(path.join(root, sessionId, 'index.json'), 'utf8')
    )
    if (index && Array.isArray(index.snapshots)) return index
  } catch {}
  return { snapshots: [] }
}

async function snapshotCount(root, sessionId) {
  try {
    const raw = await fs.promises.readFile(path.join(root, sessionId, 'index.json'), 'utf8')
    return JSON.parse(raw).snapshots.length
  } catch {
    return 0
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function currentUsername() {
  try {
    const info = os.userInfo && os.userInfo()
    if (info && info.username) return info.username
  } catch {}
  return process.env.USER || process.env.USERNAME || 'user'
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function createLegacyCompatibleAccount(account, paths) {
  const device = await loadOrCreateLocalDevice(paths)
  return (await account.importLegacyLocalDevice(paths)) || device
}

function serializeDeviceRecord(device) {
  if (!device) return null
  return {
    deviceKey: Buffer.from(device.publicKey).toString('hex'),
    dhtKey: Buffer.from(device.dhtPublicKey).toString('hex'),
    identityKey: Buffer.from(device.identityPublicKey).toString('hex'),
    name: device.name || null,
    status: device.status || 'active'
  }
}

module.exports = SessionEngine
module.exports.FLOW_LIMIT = FLOW_LIMIT
module.exports.ATTACH_BUFFER_LIMIT = ATTACH_BUFFER_LIMIT
module.exports.DETACH_SIGNAL = DETACH_SIGNAL
module.exports._test = {
  byteLength,
  isGeometry,
  hasTerminalBoundary,
  ARCHIVE_PROFILES,
  currentUsername
}
