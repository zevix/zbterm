const { EventEmitter } = require('events')

const FramedStream = require('framed-stream')

const SessionEngine = require('./index')
const { EngineError, CODES } = require('./errors')
const { FrameKind, encodeFrame, decodeFrame } = require('./rpc/schema')
const { tunePipe } = require('./rpc/pipe')
const spawner = require('./spawn-worker')

const INVOKE_TIMEOUT_MS = 60000

function reviveError(json) {
  if (!json) return new EngineError(CODES.E_INTERNAL, 'Unknown worker error')
  return new EngineError(json.code || CODES.E_INTERNAL, json.message, json.details)
}

// Host-side counterpart to engine/worker.js, and the second half of the
// `zbterm-core` package: the core runs as a sidecar, this supervises it.
// It reconstructs an EventEmitter-shaped surface (`.on(name, cb)`) from
// inbound EVENT_JSON / EVENT_DATA frames so a host keeps its existing
// engine.on(...) call patterns unchanged, and exposes
// invoke()/ready()/close() with the same external contract SessionEngine has
// in-process (docs/PHASE2-WORK-PLAN.md step 3, docs/CORE-CONTRACT.md).
//
// Nothing here is Electron-specific: the PTY host is injected exactly as it
// is into SessionEngine itself (docs/ARCHITECTURE.md 2.6), and the only
// host-shaped decision left - what to do with the sidecar's stdout/stderr -
// is the overridable `_attachWorkerOutput()` hook. electron/engine-client.js
// is the Electron subclass: it injects electron/pty-host.js and colours the
// worker's output.
//
// This object's identity survives a worker crash - respawn() tears down
// only the dead worker process/pipe and spins up a new one; `this.ptyHost`
// (the actual live PTYs, which live in the host) and every listener a host
// registered via `.on(...)` are untouched. A "new EngineClient per restart"
// design would silently orphan every live PTY and drop already-registered
// listeners - see docs/PHASE2-WORK-PLAN.md step 4.
class EngineClient extends EventEmitter {
  constructor({
    userData,
    profileId,
    profilePath,
    backend,
    workerEntrypoint,
    ptyHost,
    rtcHost
  } = {}) {
    super()
    if (!ptyHost) {
      throw new EngineError(CODES.E_INTERNAL, 'EngineClient requires an injected ptyHost')
    }
    // `backend` is the share-backend limit ('pear', 'freenet', 'none', or
    // empty for no limit). The host resolves it; the core only forwards it.
    // `rtcHost` is the optional WebRTC adapter (electron/rtc-host.js's API):
    // with one the worker is told the host offers `rtc`, and the BACKEND_*
    // frames are dispatched to it. `hostCaps` is derived, never passed.
    this._spawnArgs = { userData, profileId, profilePath, backend, hostCaps: rtcHost ? 'rtc' : '' }
    this._workerEntrypoint = workerEntrypoint || require.resolve('./worker.js')

    this._pending = new Map()
    this._nextId = 1
    this._closed = false
    this._closedByShell = false
    this._workerAlive = false
    this._readyBooted = false
    this._pendingRespawn = null
    this._failureSignaled = false
    this._allowedPtySpawns = 0

    this._ptyBuffer = new Map()
    this._ptyBufferedBytes = new Map()
    // Sessions this host registered via ptyHost.attach() rather than spawn().
    // Load-bearing: an attached terminal's end is a detach, and PTY_EXIT's
    // `signal` is an OptionalUint, so the host must send PTY_DETACH for these
    // instead - a string signal cannot be encoded on PTY_EXIT at all.
    this._attached = new Set()

    this.ptyHost = ptyHost
    this.ptyHost.on('data', ({ sessionId, data }) => this._sendPtyData(sessionId, data))
    this.ptyHost.on('exit', ({ sessionId, exit }) => this._sendPtyExit(sessionId, exit))

    // Channels whose rtcHost delivery is paused because the pipe to the
    // worker was full; one `drain` resumes them all.
    this._rtcPaused = new Map()
    this.rtcHost = rtcHost || null
    if (this.rtcHost) {
      const forward = (kind) => (body) => this._sendBackend(kind, body)
      this.rtcHost.on('signal', forward(FrameKind.BACKEND_SIGNAL))
      this.rtcHost.on('state', forward(FrameKind.BACKEND_STATE))
      this.rtcHost.on('channel', forward(FrameKind.BACKEND_CHANNEL))
      this.rtcHost.on('flow', forward(FrameKind.BACKEND_FLOW))
      this.rtcHost.on('close', forward(FrameKind.BACKEND_CLOSE))
      this.rtcHost.on('data', (body) => this._sendBackendData(body))
    }

    let resolveReady, rejectReady
    this._readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    this._resolveReady = resolveReady
    this._rejectReady = rejectReady

    this._spawnWorker()
  }

  // The sidecar launch contract, frozen in docs/CORE-CONTRACT.md: the Bare
  // entrypoint is run with argv [userData, profileId, profilePath, backend,
  // hostCaps] (empty strings, never undefined, for the four optional ones) and
  // speaks the framed binary protocol of engine/rpc/schema.js over its IPC pipe.
  _spawnWorker() {
    this._worker = spawner.spawnWorker(this._workerEntrypoint, [
      this._spawnArgs.userData,
      this._spawnArgs.profileId || '',
      this._spawnArgs.profilePath || '',
      this._spawnArgs.backend || '',
      this._spawnArgs.hostCaps || ''
    ])
    // See engine/rpc/pipe.js: framed-stream's default highWaterMark made a
    // single frame of 16 KiB or more report backpressure on an idle pipe.
    this._pipe = tunePipe(new FramedStream(this._worker))
    this._pipe.on('data', (buf) => this._onFrame(buf))
    this._attachWorkerOutput(this._worker)
    this._failureSignaled = false
    this._worker.once('exit', (code, status) => this._onWorkerExit(code, status))
  }

  // Overridable: what a host does with the sidecar's own console output.
  // The default forwards it verbatim, which also keeps the pipes drained.
  _attachWorkerOutput(worker) {
    worker.stdout?.on('data', (chunk) => process.stdout.write(chunk))
    worker.stderr?.on('data', (chunk) => process.stderr.write(chunk))
  }

  ready() {
    return this._readyPromise
  }

  // Respawns the worker after an unexpected exit. Resolves with the
  // reattach payload ({ sessionIds }) once the new worker reports
  // engine:worker-ready, or rejects (e.g. profile lock still held by the
  // old worker's not-yet-reaped process). Does not touch this.ptyHost.
  respawn() {
    if (this._closed) {
      return Promise.reject(new EngineError(CODES.E_INTERNAL, 'Engine client is closed'))
    }
    return new Promise((resolve, reject) => {
      this._pendingRespawn = { resolve, reject }
      this._spawnWorker()
    })
  }

  get pid() {
    return this._worker && this._worker._process ? this._worker._process.pid : null
  }

  invoke(method, args = {}) {
    if (this._closed) {
      return Promise.reject(new EngineError(CODES.E_INTERNAL, 'Engine worker is not available'))
    }
    if (!this._workerAlive) {
      return Promise.reject(new EngineError(CODES.E_INTERNAL, 'Engine worker is restarting'))
    }
    const id = this._nextId++
    if (allowsPtySpawn(method)) this._allowedPtySpawns++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this._pending.get(id)
        if (!pending) return
        this._pending.delete(id)
        if (pending.allowsPtySpawn && !pending.ptySpawnConsumed) {
          this._allowedPtySpawns = Math.max(0, this._allowedPtySpawns - 1)
        }
        reject(new EngineError(CODES.E_INTERNAL, `invoke('${method}') timed out`))
        this._signalWorkerFailure(`invoke('${method}') timed out`)
      }, INVOKE_TIMEOUT_MS)
      this._pending.set(id, {
        resolve,
        reject,
        timer,
        allowsPtySpawn: allowsPtySpawn(method),
        ptySpawnConsumed: false
      })
      this._pipe.write(encodeFrame(FrameKind.INVOKE, id, { method, args }))
    })
  }

  async close() {
    if (this._closed) return
    this._closed = true
    this._closedByShell = true
    this._rejectPendingInvokes()
    this._pipe.end?.()
    await new Promise((resolve) => {
      let killTimer = null
      const termTimer = setTimeout(() => {
        this._worker.destroy?.()
      }, 5000)
      killTimer = setTimeout(() => {
        const proc = this._worker && this._worker._process
        if (proc && proc.pid) {
          try {
            process.kill(proc.pid, 'SIGKILL')
          } catch {}
        }
      }, 7000)
      this._worker.once('exit', () => {
        clearTimeout(termTimer)
        clearTimeout(killTimer)
        resolve()
      })
    })
  }

  _rejectPendingInvokes() {
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer)
      reject(new EngineError(CODES.E_INTERNAL, 'Engine worker closed'))
    }
    this._pending.clear()
    this._allowedPtySpawns = 0
  }

  // Per docs/DESIGN-SWARM-AND-WORKER.md "Worker crash / restart semantics":
  // PTYs survive in the host; while the worker is down their output is
  // buffered per session up to FLOW_LIMIT (same cap live flow control
  // already uses), pausing the PTY beyond it. On reattach the buffer is
  // replayed as ordinary PTY_DATA/PTY_EXIT frames.
  _sendPtyData(sessionId, data) {
    if (this._closed) return
    if (!this._workerAlive) {
      this._bufferPty(sessionId, { type: 'data', data })
      return
    }
    const ok = this._pipe.write(encodeFrame(FrameKind.PTY_DATA, 0, { sessionId, data }))
    if (ok) return
    this._setPtyPaused(sessionId, 'pipe', true)
    // One `drain` listener for every session the full pipe paused, not one
    // more per refused write.
    if (this._ptyDrainArmed) return
    this._ptyDrainArmed = true
    this._pipe.once('drain', () => {
      this._ptyDrainArmed = false
      for (const [id, reasons] of Array.from(this._ptyPauses || [])) {
        if (reasons.has('pipe')) this._setPtyPaused(id, 'pipe', false)
      }
    })
  }

  // A PTY is paused for as long as any of its reasons holds: the core asked
  // ('core': PTY_PAUSE, its FLOW_LIMIT / CORE_BACKLOG_LIMIT), the pipe to the
  // worker is full ('pipe'), or the worker is down and the buffer is full
  // ('buffer'). Only the last reason to clear resumes it. Before, each resumed
  // on its own - the pipe's drain resumed a PTY the core had paused, and
  // PTY_RESUME one the full pipe had - so a flood ran through both.
  _setPtyPaused(sessionId, reason, paused) {
    if (!this._ptyPauses) this._ptyPauses = new Map()
    const reasons = this._ptyPauses.get(sessionId) || new Set()
    const before = reasons.size > 0
    if (paused) reasons.add(reason)
    else reasons.delete(reason)
    if (reasons.size) this._ptyPauses.set(sessionId, reasons)
    else this._ptyPauses.delete(sessionId)
    if (!before && reasons.size) this.ptyHost.pause(sessionId)
    else if (before && !reasons.size) this.ptyHost.resume(sessionId)
  }

  // rtcHost events -> BACKEND_* frames. A peer connection belongs to the
  // worker that opened it, so nothing is buffered while the worker is down:
  // _onWorkerExit closes them all.
  _sendBackend(kind, body) {
    if (this._closed || !this._workerAlive) return
    this._pipe.write(encodeFrame(kind, 0, body))
  }

  // Mirrors _sendPtyData: a full pipe pauses delivery from that channel on the
  // host adapter, and the pipe's `drain` resumes it.
  _sendBackendData({ connId, chanId, data }) {
    if (this._closed || !this._workerAlive) return
    const ok = this._pipe.write(encodeFrame(FrameKind.BACKEND_DATA, 0, { connId, chanId, data }))
    if (ok) return
    const key = `${connId}:${chanId}`
    if (this._rtcPaused.has(key)) return
    this._rtcPaused.set(key, { connId, chanId })
    this.rtcHost.pause(connId, chanId)
    if (this._rtcPaused.size === 1) this._pipe.once('drain', () => this._resumeRtc())
  }

  _resumeRtc() {
    const paused = Array.from(this._rtcPaused.values())
    this._rtcPaused.clear()
    for (const { connId, chanId } of paused) this.rtcHost.resume(connId, chanId)
  }

  // BACKEND_* frames from the worker. Without an adapter, an open is answered
  // with a close, so the worker is never left waiting on a connection.
  _onBackendFrame(frame) {
    const body = frame.body
    if (!this.rtcHost) {
      if (frame.kind === FrameKind.BACKEND_OPEN) {
        this._sendBackend(FrameKind.BACKEND_CLOSE, {
          connId: body.connId,
          reason: 'host has no WebRTC adapter'
        })
      }
      return
    }
    switch (frame.kind) {
      case FrameKind.BACKEND_OPEN:
        this.rtcHost.open(body.connId, { iceServers: body.iceServers })
        return
      case FrameKind.BACKEND_SIGNAL:
        this.rtcHost.signal(body.connId, body)
        return
      case FrameKind.BACKEND_CHANNEL:
        if (body.op === 'open') this.rtcHost.openChannel(body.connId, body.chanId, body.label)
        else if (body.op === 'closed') this.rtcHost.closeChannel(body.connId, body.chanId)
        return
      case FrameKind.BACKEND_DATA:
        this.rtcHost.send(body.connId, body.chanId, body.data)
        return
      case FrameKind.BACKEND_CLOSE:
        this.rtcHost.close(body.connId, body.reason)
    }
  }

  _sendPtyExit(sessionId, exit) {
    if (this._closed) return
    // Attached terminals detach, they do not exit: the core supplies
    // DETACH_SIGNAL on its side from this signal-less frame, which is exactly
    // why PTY_DETACH is a separate kind (docs/CORE-CONTRACT.md 3, 6).
    if (this._attached.delete(sessionId)) {
      if (!this._workerAlive) {
        this._bufferPty(sessionId, { type: 'detach' })
        return
      }
      this._pipe.write(encodeFrame(FrameKind.PTY_DETACH, 0, { sessionId }))
      return
    }
    const body = { sessionId, code: exit && exit.code, signal: exit && exit.signal }
    if (!this._workerAlive) {
      this._bufferPty(sessionId, { type: 'exit', body })
      return
    }
    this._pipe.write(encodeFrame(FrameKind.PTY_EXIT, 0, body))
  }

  _bufferPty(sessionId, entry) {
    if (!this._ptyBuffer.has(sessionId)) this._ptyBuffer.set(sessionId, [])
    this._ptyBuffer.get(sessionId).push(entry)
    if (entry.type === 'data') {
      const bytes = (this._ptyBufferedBytes.get(sessionId) || 0) + entry.data.byteLength
      this._ptyBufferedBytes.set(sessionId, bytes)
      if (bytes > SessionEngine.FLOW_LIMIT) this._setPtyPaused(sessionId, 'buffer', true)
    }
  }

  _flushPtyBuffer(sessionId) {
    const entries = this._ptyBuffer.get(sessionId)
    this._ptyBuffer.delete(sessionId)
    this._ptyBufferedBytes.delete(sessionId)
    // A new worker on a new pipe: what the old core and the old pipe paused
    // no longer holds. Resumed below, once the buffer is replayed.
    const paused = this._ptyPauses && this._ptyPauses.get(sessionId)
    if (paused) this._ptyPauses.delete(sessionId)
    if (!entries || !entries.length) {
      if (paused && paused.size) this.ptyHost.resume(sessionId)
      return
    }
    for (const entry of entries) {
      if (entry.type === 'data') {
        this._pipe.write(encodeFrame(FrameKind.PTY_DATA, 0, { sessionId, data: entry.data }))
      } else if (entry.type === 'detach') {
        this._pipe.write(encodeFrame(FrameKind.PTY_DETACH, 0, { sessionId }))
      } else {
        this._pipe.write(encodeFrame(FrameKind.PTY_EXIT, 0, entry.body))
      }
    }
    this.ptyHost.resume(sessionId)
  }

  _onFrame(buf) {
    let frame
    try {
      frame = decodeFrame(buf)
    } catch (err) {
      console.error('engine-client: dropping malformed frame from worker:', err.message)
      return
    }

    try {
      switch (frame.kind) {
        case FrameKind.REPLY_OK: {
          const pending = this._pending.get(frame.id)
          if (!pending) return
          this._pending.delete(frame.id)
          clearTimeout(pending.timer)
          if (pending.allowsPtySpawn && !pending.ptySpawnConsumed) {
            this._allowedPtySpawns = Math.max(0, this._allowedPtySpawns - 1)
          }
          pending.resolve(frame.body.result)
          return
        }
        case FrameKind.REPLY_ERR: {
          const pending = this._pending.get(frame.id)
          if (!pending) return
          this._pending.delete(frame.id)
          clearTimeout(pending.timer)
          if (pending.allowsPtySpawn && !pending.ptySpawnConsumed) {
            this._allowedPtySpawns = Math.max(0, this._allowedPtySpawns - 1)
          }
          pending.reject(reviveError(frame.body.error))
          return
        }
        case FrameKind.EVENT_JSON:
          this._onEventJson(frame.body.name, frame.body.data)
          return
        case FrameKind.EVENT_DATA:
          this._onEventData(frame.body)
          return
        case FrameKind.PTY_SPAWN:
          this._onPtySpawn(frame.body)
          return
        case FrameKind.PTY_ATTACH:
          this._onPtyAttach(frame.body)
          return
        case FrameKind.PTY_DETACH:
          // The core letting go of an attached terminal. kill() on a session
          // the host registered via attach() detaches it (the terminal keeps
          // running) - docs/CORE-CONTRACT.md 6.
          this.ptyHost.kill(frame.body.sessionId)
          return
        case FrameKind.PTY_WRITE:
          this.ptyHost.write(frame.body.sessionId, frame.body.data)
          return
        case FrameKind.PTY_RESIZE:
          this.ptyHost.resize(frame.body.sessionId, frame.body.cols, frame.body.rows)
          return
        case FrameKind.PTY_KILL:
          this.ptyHost.kill(frame.body.sessionId)
          return
        case FrameKind.PTY_PAUSE:
          this._setPtyPaused(frame.body.sessionId, 'core', true)
          return
        case FrameKind.PTY_RESUME:
          this._setPtyPaused(frame.body.sessionId, 'core', false)
          return
        case FrameKind.BACKEND_OPEN:
        case FrameKind.BACKEND_SIGNAL:
        case FrameKind.BACKEND_CHANNEL:
        case FrameKind.BACKEND_DATA:
        case FrameKind.BACKEND_CLOSE:
          this._onBackendFrame(frame)
          return
        default:
          console.error('engine-client: unexpected frame kind from worker:', frame.kind)
      }
    } catch (err) {
      console.error(
        'engine-client: dropping frame from worker:',
        err && err.message ? err.message : err
      )
    }
  }

  _onPtySpawn(body) {
    if (this.ptyHost.sessions.has(body.sessionId)) {
      console.error('engine-client: rejected duplicate PTY_SPAWN for session:', body.sessionId)
      return
    }
    if (!this._consumePtySpawnCredit()) {
      console.error('engine-client: rejected unexpected PTY_SPAWN for session:', body.sessionId)
      return
    }
    let pty = null
    try {
      pty = this.ptyHost.spawn(body.sessionId, {
        cols: body.cols,
        rows: body.rows,
        cwd: body.cwd || null,
        command: body.command || null
      })
    } catch (err) {
      // A spawn that throws (no pty could be forked, an unusable shell) would
      // otherwise leave the core believing the session is live, with nothing
      // ever reaching the terminal. Report it the way a failed command does:
      // the message as output, then an exit, so the UI shows both.
      console.error('engine-client: PTY spawn failed for session:', body.sessionId, err)
      const message = (err && err.message) || String(err)
      this._sendPtyData(body.sessionId, Buffer.from(`zbterm: could not start: ${message}\r\n`))
      this._sendPtyExit(body.sessionId, { code: 127, signal: null })
      return
    }
    if (!pty) {
      console.error('engine-client: failed to spawn PTY for session:', body.sessionId)
    }
  }

  // Attach mode over the seam: the core asks the host to register a terminal
  // the host already owns. Same admission control as PTY_SPAWN - one credit
  // per session.create / session.extend - so a wedged or hostile worker cannot
  // make the host enumerate or re-register terminals on its own initiative.
  _onPtyAttach(body) {
    if (typeof this.ptyHost.attach !== 'function') {
      console.error('engine-client: PTY host cannot attach; detaching session:', body.sessionId)
      this._refuseAttach(body.sessionId)
      return
    }
    if (this.ptyHost.sessions.has(body.sessionId)) {
      console.error('engine-client: rejected duplicate PTY_ATTACH for session:', body.sessionId)
      return
    }
    if (!this._consumePtySpawnCredit()) {
      console.error('engine-client: rejected unexpected PTY_ATTACH for session:', body.sessionId)
      return
    }
    const pty = this.ptyHost.attach(body.sessionId, { cols: body.cols, rows: body.rows })
    if (!pty) {
      console.error('engine-client: failed to attach PTY for session:', body.sessionId)
      this._refuseAttach(body.sessionId)
      return
    }
    this._attached.add(body.sessionId)
  }

  // A refused attach would otherwise leave the core with a session whose
  // terminal never produces a byte and never ends. Answering with PTY_DETACH
  // closes it out as a detach instead of a hang.
  _refuseAttach(sessionId) {
    if (this._closed || !this._workerAlive) return
    this._pipe.write(encodeFrame(FrameKind.PTY_DETACH, 0, { sessionId }))
  }

  _consumePtySpawnCredit() {
    if (this._allowedPtySpawns <= 0) return false
    for (const pending of this._pending.values()) {
      if (!pending.allowsPtySpawn || pending.ptySpawnConsumed) continue
      pending.ptySpawnConsumed = true
      this._allowedPtySpawns--
      return true
    }
    return false
  }

  _signalWorkerFailure(message) {
    if (this._closed || this._failureSignaled) return
    this._failureSignaled = true
    this._workerAlive = false
    console.error('engine-client: treating worker as failed:', message)
    this.emit('worker:exit', { code: null, status: message, unexpected: true })
    this._worker.destroy?.()
  }

  _onEventJson(name, data) {
    if (name === 'engine:worker-ready') {
      this._workerAlive = true
      const sessionIds = (data && data.sessionIds) || []
      this._reattach(sessionIds)
      if (!this._readyBooted) {
        this._readyBooted = true
        this._resolveReady({ sessionIds })
      } else if (this._pendingRespawn) {
        const pending = this._pendingRespawn
        this._pendingRespawn = null
        pending.resolve({ sessionIds })
      }
      this.emit('worker:ready', { sessionIds })
      return
    }
    if (name === 'engine:worker-ready-error') {
      const err = reviveError(data)
      if (!this._readyBooted) {
        this._rejectReady(err)
      } else if (this._pendingRespawn) {
        const pending = this._pendingRespawn
        this._pendingRespawn = null
        pending.reject(err)
      }
      return
    }
    this.emit(name, data)
  }

  // Reattach protocol (docs/DESIGN-SWARM-AND-WORKER.md "Worker crash /
  // restart semantics"): sessions the new worker doesn't recognize get
  // their host-side PTY killed; sessions it does recognize get their
  // buffered output replayed as ordinary PTY_DATA/PTY_EXIT.
  _reattach(knownSessionIds) {
    const known = new Set(knownSessionIds)
    for (const sessionId of Array.from(this.ptyHost.sessions.keys())) {
      if (!known.has(sessionId)) {
        this.ptyHost.kill(sessionId)
        this._ptyBuffer.delete(sessionId)
        this._ptyBufferedBytes.delete(sessionId)
      }
    }
    for (const sessionId of known) {
      this._flushPtyBuffer(sessionId)
    }
  }

  _onEventData(body) {
    if (body.name === 'session:data') {
      this.emit('session:data', {
        sessionId: body.sessionId,
        source: body.source,
        hd: body.hd,
        data: body.data
      })
      return
    }
    if (body.name === 'player:data') {
      this.emit('player:data', {
        sessionId: body.sessionId,
        seq: body.seq,
        tsMs: body.tsMs,
        kind: body.kind,
        cols: body.cols,
        rows: body.rows,
        hd: body.hd,
        data: body.data
      })
    }
  }

  _onWorkerExit(code, status) {
    this._workerAlive = false
    this._allowedPtySpawns = 0
    this._rtcPaused.clear()
    // The dead pipe's `drain` never comes; _flushPtyBuffer clears its pauses.
    this._ptyDrainArmed = false
    if (this.rtcHost && typeof this.rtcHost.closeAll === 'function') {
      this.rtcHost.closeAll('worker exited')
    }
    const unexpected = !this._closedByShell
    this._rejectPendingInvokes()
    if (unexpected) {
      const err = new EngineError(CODES.E_INTERNAL, `Engine worker exited unexpectedly (${code})`)
      if (this._pendingRespawn) {
        const pending = this._pendingRespawn
        this._pendingRespawn = null
        pending.reject(err)
      } else if (!this._readyBooted) {
        this._rejectReady(err)
      }
      if (!this._failureSignaled) this.emit('worker:exit', { code, status, unexpected })
    } else {
      this._closed = true
    }
  }
}

function allowsPtySpawn(method) {
  return method === 'session.create' || method === 'session.extend'
}

module.exports = { EngineClient, INVOKE_TIMEOUT_MS }
