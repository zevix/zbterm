const { EventEmitter } = require('events')

const { FrameKind } = require('./rpc/schema')
const { EngineError, CODES } = require('./errors')

// Worker-side counterpart to electron/pty-host.js. Same external API
// (spawn/write/resize/pause/resume/kill + `data`/`exit` events shaped
// exactly like PtyHost's), but every call becomes a PTY_* frame sent to
// the shell instead of driving a real PtySession in-process - the shell's
// electron/pty-host.js is what actually owns the PTY now. This is the
// "relocation, not a redesign" seam docs/PHASE2-WORK-PLAN.md step 3 calls
// for: engine/index.js's session-creation call sites (`runtime.pty.write`
// etc.) do not change at all.
class PtyRemote extends EventEmitter {
  constructor(send) {
    super()
    this._send = send
  }

  spawn(sessionId, opts = {}) {
    this._send(FrameKind.PTY_SPAWN, 0, {
      sessionId,
      cols: opts.cols,
      rows: opts.rows,
      shell: opts.shell || null,
      cwd: opts.cwd || null,
      command: opts.command || null
    })
    return {
      write: (data) => this.write(sessionId, data),
      resize: (cols, rows) => this.resize(sessionId, cols, rows),
      pause: () => this.pause(sessionId),
      resume: () => this.resume(sessionId),
      kill: () => this.kill(sessionId)
    }
  }

  // The attach half of the PTY host contract (docs/CORE-CONTRACT.md 6),
  // carried over the seam by PTY_ATTACH. Same handle shape as spawn(); the
  // only difference is that kill() detaches instead of terminating, so the
  // terminal the host owns is never killed by the core.
  attach(sessionId, opts = {}) {
    // PtyAttach encodes cols/rows as c.uint, which cannot carry the null /
    // NaN / negative / fractional geometry engine/index.js refuses. Validate
    // here, before encoding, so a bad value surfaces as an EngineError rather
    // than as a compact-encoding failure deep inside the frame writer.
    if (!isGeometry(opts.cols) || !isGeometry(opts.rows)) {
      throw new EngineError(CODES.E_INTERNAL, 'Attach requires positive integer cols and rows')
    }
    this._send(FrameKind.PTY_ATTACH, 0, { sessionId, cols: opts.cols, rows: opts.rows })
    return {
      write: (data) => this.write(sessionId, data),
      resize: (cols, rows) => this.resize(sessionId, cols, rows),
      pause: () => this.pause(sessionId),
      resume: () => this.resume(sessionId),
      kill: () => this.detach(sessionId)
    }
  }

  write(sessionId, data) {
    this._send(FrameKind.PTY_WRITE, 0, {
      sessionId,
      data: Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
    })
  }

  resize(sessionId, cols, rows) {
    this._send(FrameKind.PTY_RESIZE, 0, { sessionId, cols, rows })
  }

  pause(sessionId) {
    this._send(FrameKind.PTY_PAUSE, 0, { sessionId })
  }

  resume(sessionId) {
    this._send(FrameKind.PTY_RESUME, 0, { sessionId })
  }

  kill(sessionId) {
    this._send(FrameKind.PTY_KILL, 0, { sessionId })
  }

  detach(sessionId) {
    this._send(FrameKind.PTY_DETACH, 0, { sessionId })
  }

  // Called by engine/worker.js's frame router for inbound PTY_DATA /
  // PTY_EXIT / PTY_DETACH frames (shell -> worker, the frames that carry PTY
  // ownership's "callback" direction).
  handleData(sessionId, data) {
    this.emit('data', { sessionId, data })
  }

  handleExit(sessionId, exit) {
    this.emit('exit', { sessionId, exit })
  }

  // The host let go of a terminal the core had attached to. PTY_DETACH is
  // deliberately signal-less: engine/index.js's attach branch turns this empty
  // exit into DETACH_SIGNAL, which keeps that string off the wire and leaves
  // PtyExit's OptionalUint `signal` untouched.
  handleDetach(sessionId) {
    this.emit('exit', { sessionId, exit: null })
  }
}

function isGeometry(value) {
  return Number.isInteger(value) && value > 0
}

module.exports = PtyRemote
