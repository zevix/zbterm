// Talks to a running `zxterm-core sidecar --profile <dir>` over its
// profile's local socket (K7, spike S3). Not yet wired into any existing
// ZBTerm code path - K9 does that.
//
// Process spawning is a host capability with no adapter contract in the
// core (`test/core-boundary.test.js`'s own words: no file under `engine/`
// may `require('child_process')`/`require('node:child_process')` - checked
// by that test, which this phase's own Acceptance criteria require staying
// green). So, unlike the brief's own first sketch, `SeamClient` never
// spawns the sidecar itself: `start()` takes an injected `spawn(bin, args)`
// function (`opts.spawn`, required) that returns a `child_process`-shaped
// handle (`.on('exit'|'error', ...)`, `.kill()`) and does the actual
// spawning - `bare-subprocess` under Bare, Node's own `child_process`
// otherwise, exactly the swap `bare-sidecar`'s own `package.json` declares
// for the very same need, but supplied from *outside* `engine/` (a host
// file, or - for this phase's own test - `test/fixtures/zxterm-seam-
// worker.js`, which is not under `engine/` and so is not scanned by that
// boundary test). `engine/package.json` still declares `bare-subprocess`
// as a direct dependency (owner go-ahead this phase, see this phase's
// Handoff notes) for whichever host file K9 has inject the real spawn
// function.
//
// Socket connection: a `Pipe` (`bare-pipe`) under Bare, `net.connect` under
// Node - the same `typeof Bare === 'undefined'` runtime switch
// `electron/zxterm-core-host.js` uses elsewhere in this tree (and the removed
// `engine/backends/freenet/bare-shims.js` used until K11), and
// not a host capability in the sense `core-boundary` means (every backend
// already dials sockets straight from `engine/`). `bare-pipe` is not
// declared as a direct dependency here: every dependency already installed
// resolves it (it backs `bare-subprocess`'s and `bare-sidecar`'s own stdio
// pipes), so requiring it needed no `npm install` and adds nothing to
// `package.json`/the lockfile - unlike `bare-subprocess`, which did (see
// this phase's Handoff notes for why this was judged not to need its own
// owner go-ahead).
'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const { EngineError, CODES } = require('../errors')
const codec = require('./codec')
const { tunePipe } = require('../rpc/pipe')

const DEFAULT_BIN = process.env.ZXTERM_CORE_BIN || 'zxterm-core'
const DEFAULT_CONNECT_TIMEOUT_MS = Number(
  process.env.ZBTERM_ZXTERM_SEAM_CONNECT_TIMEOUT_MS || 10000
)
const DEFAULT_REQUEST_TIMEOUT_MS = Number(
  process.env.ZBTERM_ZXTERM_SEAM_REQUEST_TIMEOUT_MS || 15000
)
const SOCKET_POLL_MS = 20

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Connects to an already-listening Unix-domain socket / named pipe at
// `socketPath`. Returns a Duplex stream (bare-pipe's `Pipe` under Bare,
// `net.Socket` under Node) - both expose 'data'/'error'/'close' and
// write()/end(), which is all this module needs.
function connectSocket(socketPath) {
  if (typeof Bare === 'undefined') {
    const net = require('net')
    return net.connect({ path: socketPath })
  }
  const Pipe = require('bare-pipe')
  return new Pipe(socketPath)
}

// One connection to one running `zxterm-core sidecar --profile <dir>`:
// `start()` spawns it, waits for its socket to appear, connects, and gives
// request/reply/event plumbing over `./codec.js`'s frame protocol. (K9,
// wiring this into ZBTerm for real, owns the "one sidecar per profile,
// attach instead of double-spawning" policy - out of scope here.)
//
// Events: `'event'` ({name, data}) for every unsolicited `Event` frame,
// `'output'` ({stream, bytes}) for every `Output` frame, `'chan'`
// ({chan, bytes}) for every `Chan` frame (K11: raw channel bytes of the
// Freenet transport service), `'drain'` once the socket takes more after a
// `sendChan()` that returned false, `'exit'`
// ({code, signal}) when the sidecar process exits, `'error'` for a
// connection-level failure after `start()` has already resolved.
class SeamClient extends EventEmitter {
  constructor(opts = {}) {
    super()
    if (!opts.profile) {
      throw new EngineError(CODES.E_INTERNAL, 'SeamClient requires a profile directory')
    }
    if (typeof opts.spawn !== 'function') {
      // Process spawning is a host capability (core-boundary, see this
      // file's header comment) - the core has no adapter contract for it,
      // so it never defaults to one itself.
      throw new EngineError(
        CODES.E_INTERNAL,
        'SeamClient requires an injected spawn(bin, args) function (process spawning is a host ' +
          'capability - see engine/zxterm/client.js and test/core-boundary.test.js)'
      )
    }
    this.profile = opts.profile
    this.bin = opts.bin || DEFAULT_BIN
    this._spawn = opts.spawn
    this.connectTimeoutMs = opts.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS
    this.requestTimeoutMs = opts.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS
    this._child = null
    this._socket = null
    this._decoder = new codec.FrameDecoder()
    this._pending = new Map()
    this._nextId = 1
    this._closed = false
    this._childExit = null
    this._needDrain = false
  }

  socketPath() {
    return path.join(this.profile, 'zxterm-core.sock')
  }

  // Spawns the sidecar (unless it is already running for this profile -
  // K9's "attach, do not double-spawn" case is a caller concern: this
  // method always spawns, since only the caller knows whether one is
  // already up) and connects. Never hangs: both the wait for the socket
  // file and the connection attempt are bounded, with a clear error on
  // failure - this phase's own Goal.
  async start() {
    this._child = this._spawn(this.bin, ['sidecar', '--profile', this.profile])
    this._child.on('exit', (code, signal) => {
      this._childExit = { code, signal }
      this.emit('exit', { code, signal })
      this._failAllPending(
        new EngineError(
          CODES.E_BACKEND_UNAVAILABLE,
          `zxterm-core sidecar exited (code=${code}, signal=${signal})`
        )
      )
    })
    this._child.on('error', (err) => {
      this._failAllPending(
        new EngineError(
          CODES.E_BACKEND_UNAVAILABLE,
          `zxterm-core sidecar failed to start: ${err.message}`
        )
      )
    })

    await this._waitForSocket()
    await this._connect()
  }

  async _waitForSocket() {
    const socketPath = this.socketPath()
    const deadline = Date.now() + this.connectTimeoutMs
    for (;;) {
      if (this._childExit) {
        throw new EngineError(
          CODES.E_BACKEND_UNAVAILABLE,
          `zxterm-core sidecar exited before its socket appeared (code=${this._childExit.code}, ` +
            `signal=${this._childExit.signal})`
        )
      }
      if (fs.existsSync(socketPath)) return
      if (Date.now() >= deadline) {
        throw new EngineError(
          CODES.E_BACKEND_UNAVAILABLE,
          `zxterm-core sidecar socket did not appear within ${this.connectTimeoutMs}ms: ${socketPath}`
        )
      }
      await delay(SOCKET_POLL_MS)
    }
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const socketPath = this.socketPath()
      let settled = false
      const socket = connectSocket(socketPath)
      const onReady = () => {
        if (settled) return
        settled = true
        this._socket = socket
        this._wireSocket(socket)
        resolve()
      }
      const onFail = (err) => {
        if (settled) return
        settled = true
        reject(
          new EngineError(
            CODES.E_BACKEND_UNAVAILABLE,
            `cannot connect to zxterm-core sidecar: ${err.message}`
          )
        )
      }
      socket.on('connect', onReady)
      // bare-pipe's Pipe is eagerly open and may never emit a distinct
      // 'connect' before the first 'data'/'close' - treat the first write
      // opportunity as "connected" too, via a microtask fallback timer only
      // if neither fired (kept short: this is a Unix socket on the same
      // host, never a real network round trip).
      socket.once('error', onFail)
      socket.once('close', () => onFail(new Error('socket closed before connecting')))
      setTimeout(() => {
        if (!settled && socket.writable !== false) onReady()
      }, 50)
    })
  }

  _wireSocket(socket) {
    // K11: a raw channel part is up to 64 KiB, and streamx's default 16 KiB
    // highWaterMark (bare-pipe, under Bare) made every such write report a
    // full socket on an idle one - the false alarm engine/rpc/pipe.js
    // describes for the worker pipe, here tripping the Freenet backend's
    // back-pressure (sendChan) on every large message.
    tunePipe(socket)
    socket.on('data', (chunk) => {
      let frames
      try {
        frames = this._decoder.push(chunk)
      } catch (err) {
        this._fail(new EngineError(CODES.E_CORRUPT, `zxterm-core seam: ${err.message}`))
        return
      }
      for (const frame of frames) this._onFrame(frame)
    })
    socket.on('drain', () => {
      if (!this._needDrain) return
      this._needDrain = false
      this.emit('drain')
    })
    socket.on('error', (err) => {
      this._fail(new EngineError(CODES.E_NET, `zxterm-core seam connection error: ${err.message}`))
    })
    socket.on('close', () => {
      this._fail(new EngineError(CODES.E_BACKEND_UNAVAILABLE, 'zxterm-core seam connection closed'))
    })
  }

  _onFrame(frame) {
    if (frame.kind === 'Reply') {
      const pending = this._pending.get(frame.id)
      if (!pending) return
      this._pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.ok.ok) {
        let value
        try {
          value = frame.ok.value === '' ? undefined : JSON.parse(frame.ok.value)
        } catch (err) {
          pending.reject(
            new EngineError(CODES.E_CORRUPT, `zxterm-core seam: invalid JSON reply: ${err.message}`)
          )
          return
        }
        pending.resolve(value)
      } else {
        pending.reject(new EngineError(frame.ok.error.code, frame.ok.error.message))
      }
      return
    }
    if (frame.kind === 'Event') {
      let data
      try {
        data = frame.data === '' ? undefined : JSON.parse(frame.data)
      } catch {
        data = frame.data
      }
      this.emit('event', { name: frame.name, data })
      return
    }
    if (frame.kind === 'Output') {
      this.emit('output', { stream: frame.stream, bytes: frame.bytes })
      return
    }
    if (frame.kind === 'Chan') {
      this.emit('chan', { chan: frame.chan, bytes: frame.bytes })
    }
  }

  _fail(err) {
    if (this._closed) return
    this._failAllPending(err)
    this.emit('error', err)
  }

  _failAllPending(err) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this._pending.clear()
  }

  // Sends one `Request` and resolves with its parsed JSON result (or
  // rejects with an `EngineError` carrying the sidecar's own `code`).
  request(method, args = {}) {
    if (this._closed) {
      return Promise.reject(
        new EngineError(CODES.E_BACKEND_UNAVAILABLE, 'zxterm-core seam client is closed')
      )
    }
    if (!this._socket) {
      return Promise.reject(
        new EngineError(CODES.E_INTERNAL, 'SeamClient.start() has not completed')
      )
    }
    const id = String(this._nextId++)
    const message = codec.encodeMessage({
      kind: 'Request',
      id,
      method,
      args: JSON.stringify(args === undefined ? {} : args)
    })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(
          new EngineError(
            CODES.E_NET,
            `zxterm-core seam: ${method} timed out after ${this.requestTimeoutMs}ms`
          )
        )
      }, this.requestTimeoutMs)
      this._pending.set(id, { resolve, reject, timer })
      this._socket.write(message, (err) => {
        if (err) {
          this._pending.delete(id)
          clearTimeout(timer)
          reject(new EngineError(CODES.E_NET, `zxterm-core seam: write failed: ${err.message}`))
        }
      })
    })
  }

  // Sends one `Chan` frame: `bytes` for raw channel `chan` (K11). Never
  // dropped. Returns the socket's write result: false once its buffer is
  // full, and a `'drain'` event follows when it takes more. False, and
  // nothing sent, when the client is closed or not connected.
  sendChan(chan, bytes) {
    if (this._closed || !this._socket) return false
    const ok = this._socket.write(codec.encodeMessage({ kind: 'Chan', chan, bytes }))
    if (ok === false) this._needDrain = true
    return ok !== false
  }

  // Not `async`: every step here is synchronous, and the lint rule that
  // flags an `async` function with no `await` would otherwise fire. Callers
  // that `await client.close()` (this file's own test fixture does) still
  // work: awaiting a non-promise value is a no-op.
  close() {
    this._closed = true
    this._failAllPending(
      new EngineError(CODES.E_BACKEND_UNAVAILABLE, 'zxterm-core seam client closed')
    )
    if (this._socket) {
      try {
        this._socket.end()
      } catch {
        // already gone
      }
      this._socket = null
    }
    if (this._child && this._childExit === null) {
      try {
        this._child.kill()
      } catch {
        // already exited
      }
    }
  }
}

module.exports = { SeamClient }
