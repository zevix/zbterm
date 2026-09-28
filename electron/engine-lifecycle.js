const path = require('path')
const { EngineClient } = require('./engine-client')
const { RtcHost } = require('./rtc-host')
const { ProfileManager } = require('../engine/profile-manager')
const { EngineError, CODES } = require('../engine/errors')
const { LOW_RATE_EVENTS, EVENT_DATA_NAMES } = require('../engine/rpc/schema')

const RESTART_LIMIT = 3
const RESTART_WINDOW_MS = 60000

// The seam between Electron-specific orchestration (windows, popups, IPC -
// electron/main.js) and starting/owning the engine + profile manager. Pulled
// out per docs/REFACTOR-PLAN.md section 3 so a future headless entrypoint
// (systemd service, `pts` CLI) can reuse profile resolution + engine start
// without importing anything Electron-specific. No behavior change from the
// code this replaced in main.js - callers still drive it through the same
// injected side effects (popups, debug server wiring, renderer events) they
// always performed inline.
//
// Engine events cross into the Electron main process as plain EventEmitter
// listeners reconstructed by EngineClient from framed IPC - the engine runs
// in a Bare sidecar (engine/worker.js, the zbterm-core entrypoint - see
// docs/CORE-CONTRACT.md), not in-process (see
// docs/DESIGN-SWARM-AND-WORKER.md "Phase 2 - Core/worker isolation" and
// docs/PHASE2-WORK-PLAN.md). `this.profileManager` here is only used
// pre-engine-start, to decide whether to prompt for a profile
// (shouldAutoSelectProfile/defaultStartupProfileId) - the worker
// constructs its own ProfileManager and owns the actual profile lock (see
// PHASE2-WORK-PLAN.md "Profile lock ownership").
class EngineLifecycle {
  constructor(opts) {
    this.pearDataRoot = opts.pearDataRoot
    this.requestedProfileId = opts.requestedProfileId || null
    this.requestedProfilePath = opts.requestedProfilePath || null
    // The share-backend limit (--backend / ZBTERM_BACKEND), '' for none.
    this.backendLimit = opts.backendLimit || ''
    // D-11: the ICE servers for new peer connections (./ice-servers.js), or
    // null for RtcHost's own default list.
    this.iceServers = Array.isArray(opts.iceServers) ? opts.iceServers : null
    this.rtcHost = null
    this.debugServerEnabled = !!opts.debugServerEnabled

    this.onEngineStarting = opts.onEngineStarting || (() => {})
    this.onEngineEvent = opts.onEngineEvent || (() => {})
    this.onProfileSelected = opts.onProfileSelected || (() => {})
    this.onEngineStartError = opts.onEngineStartError || (() => {})
    this.onProfileRequired = opts.onProfileRequired || (() => {})
    this.onStartupBegin = opts.onStartupBegin || (() => {})

    this.engine = null
    this.engineReady = false
    this.profileManager = null
    this.selectedProfileId = null
    this.engineStarting = null
    this.pearRuntimeInitializing = false
    this._restartTimestamps = []
    this._recovering = false
  }

  async ensureProfileManager(userData) {
    if (this.profileManager) return this.profileManager
    this.profileManager = new ProfileManager(path.join(userData, 'zbterm-profiles'))
    await this.profileManager.ready()
    return this.profileManager
  }

  shouldAutoSelectProfile() {
    return !!this.requestedProfileId || !!this.requestedProfilePath || this.debugServerEnabled
  }

  // Distinguishes "no profile has been chosen yet" from "a profile is
  // selected but the worker crashed and is being respawned" - `engineReady`
  // is false in both cases, but they need different UI/error handling (see
  // electron/main.js `zbterm:invoke`): the former should prompt for a
  // profile, the latter should ask the caller to retry shortly instead of
  // claiming no profile was ever selected.
  get isRecovering() {
    return this._recovering || !!this.engineStarting
  }

  async defaultStartupProfileId(userData) {
    if (this.requestedProfilePath) return null
    const manager = await this.ensureProfileManager(userData)
    if (this.requestedProfileId) return await manager.resolveProfileId(this.requestedProfileId)
    const registry = await manager.listProfiles()
    if (this.debugServerEnabled) {
      const defaultProfile = registry.profiles.find((profile) => profile.id === 'default')
      return defaultProfile && !defaultProfile.locked ? 'default' : null
    }
    const hasRunningProfile = registry.profiles.some((profile) => profile.locked)
    return hasRunningProfile ? null : 'default'
  }

  _wireEngine(userData, opts) {
    this.onEngineStarting(userData, opts)
    this.engineReady = false
    // The Freenet backend's WebRTC half lives here, in the host (D-06, D-09).
    // Without node-datachannel the worker is told the host has no adapter, and
    // the backend reports that as its reason.
    this.rtcHost = RtcHost.available()
      ? new RtcHost(this.iceServers ? { iceServers: this.iceServers } : {})
      : null
    const engine = new EngineClient({
      userData,
      profileId: opts.profileId,
      profilePath: opts.profilePath,
      backend: this.backendLimit,
      rtcHost: this.rtcHost || undefined
    })
    this.engine = engine
    const forward = (name) => (data) => this.onEngineEvent(name, data)
    for (const name of EVENT_DATA_NAMES) engine.on(name, forward(name))
    for (const name of LOW_RATE_EVENTS) engine.on(name, forward(name))
    engine.on('worker:exit', ({ unexpected }) => {
      if (unexpected) this._onWorkerCrash()
    })
    return engine.ready().then(async () => {
      this.engineReady = true
      await this._pushIceServers()
    })
  }

  // D-11: a new list applies to the host's adapter and, through the core, to
  // every peer connection a backend opens from now on.
  async setIceServers(servers) {
    this.iceServers = Array.isArray(servers) ? servers : null
    if (this.rtcHost && this.iceServers) this.rtcHost.iceServers = this.iceServers
    await this._pushIceServers()
  }

  async _pushIceServers() {
    if (!this.engine || !this.engineReady || !this.iceServers) return
    await this.engine
      .invoke('share.setIceServers', { iceServers: this.iceServers })
      .catch((err) => console.error('share.setIceServers failed:', err && err.message))
  }

  // Worker crash / restart supervision (docs/DESIGN-SWARM-AND-WORKER.md
  // "Worker crash / restart semantics"): at most RESTART_LIMIT restarts per
  // RESTART_WINDOW_MS; beyond that, stop respawning, surface a fatal
  // engine:error, and leave the app in the profile-required state rather
  // than crash-looping a process that holds DHT announces. PTYs (shell-
  // side) and their buffered output survive - EngineClient.respawn() keeps
  // the same client/ptyHost, only the dead worker process is replaced.
  async _onWorkerCrash() {
    if (this._recovering || !this.engine) return
    this._recovering = true
    try {
      this.engineReady = false
      this.onEngineEvent('engine:restarting', {})

      const now = Date.now()
      this._restartTimestamps = this._restartTimestamps.filter((ts) => now - ts < RESTART_WINDOW_MS)
      this._restartTimestamps.push(now)

      if (this._restartTimestamps.length > RESTART_LIMIT) {
        await this._giveUpAfterRepeatedCrashes(
          new EngineError(CODES.E_INTERNAL, 'Engine worker crashed repeatedly; giving up')
        )
        return
      }

      try {
        await this.engine.respawn()
        this.engineReady = true
        await this._pushIceServers()
      } catch (err) {
        await this._giveUpAfterRepeatedCrashes(EngineError.from(err))
      }
    } finally {
      this._recovering = false
    }
  }

  async _giveUpAfterRepeatedCrashes(err) {
    this.onEngineEvent('engine:error', err.toJSON())
    const closing = this.engine
    this.engine = null
    this.engineReady = false
    this._restartTimestamps = []
    if (closing) await closing.close().catch(() => {})
    await this.onProfileRequired(this.pearDataRoot())
  }

  async startEngineForProfile(userData, opts = {}) {
    if (this.engineReady) return this.engine
    if (this.engineStarting) {
      await this.engineStarting
      return this.engine
    }
    await this.ensureProfileManager(userData)
    this.engineStarting = this._wireEngine(userData, opts).then(async () => {
      this.selectedProfileId = opts.profileId || this.selectedProfileId || null
      await this.onProfileSelected({
        userData,
        profileId: this.selectedProfileId,
        profilePath: opts.profilePath || null,
        identity: await this.engine.invoke('identity.get')
      })
      return this.engine
    })
    try {
      return await this.engineStarting
    } catch (err) {
      if (this.engine && !this.engineReady) {
        await this.engine.close().catch(() => {})
        this.engine = null
      }
      await this.onEngineStartError(err)
      throw err
    } finally {
      this.engineStarting = null
    }
  }

  async startPearRuntime() {
    this.pearRuntimeInitializing = true
    try {
      const userData = this.pearDataRoot()
      await this.ensureProfileManager(userData)
      await this.onStartupBegin()
      const startupProfileId = await this.defaultStartupProfileId(userData)
      if (startupProfileId || this.requestedProfilePath) {
        const profileId = startupProfileId
        this.selectedProfileId = profileId
        await this.startEngineForProfile(userData, {
          profileId,
          profilePath: this.requestedProfilePath
        })
        return
      }
      await this.onProfileRequired(userData)
    } finally {
      this.pearRuntimeInitializing = false
    }
  }

  async closeEngine() {
    if (!this.engine) return
    const closing = this.engine
    this.engine = null
    this.engineReady = false
    await closing.close().catch((err) => console.error('Failed to close engine:', err))
  }
}

module.exports = { EngineLifecycle, RESTART_LIMIT, RESTART_WINDOW_MS }
