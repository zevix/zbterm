// The Freenet share path's side of the core's session protocol (K14 of
// zxterm-core, stage C2; ZBTerm D-38). The Rust `zxterm-core` sidecar runs
// the session protocol for a Freenet share - envelopes, epochs and their
// rotation, the identity challenge, approvals, live output and its lag
// resync, sealed input - over the connections of its Freenet backend
// (`zxterm_core::session`, `docs/projects/260928_zxterm-core/protocol.md` in
// zxterm; `zxterm_core::seam::share_methods` is the method table). This file
// is the seam client's half of it: `request('share.<method>', args)` and the
// core's `share.*` events as EventEmitter events named without the prefix
// (`pending`, `granted`, `epoch`, `input`, `output`, `joinChanged`, ...).
//
// It knows nothing of ShareManager, the session store or the engine: what an
// event means is engine/share-manager.js's. Bytes cross the seam as base64
// inside JSON payloads (`b64()`/`unb64()` here), keys and envelopes as hex.
//
// One bridge per sidecar client (`bridgeFor`), because one client is one seam
// connection and the core sends every `share.*` event to every connection
// that called a `share.*` method.
//
// Order. The seam answers the requests of one connection concurrently, each on
// a task of its own (`zxterm_core::seam::server::handle_connection`), so two
// requests sent one after the other can be handled in either order. A stream
// whose order matters - a session's output, the bootstrap that answers the
// core and the output after it, a viewer's keystrokes - goes through an
// `OrderedRequests`: one request at a time, in the order it was queued, and
// output queued behind an unanswered request joins into one.
'use strict'

const { EventEmitter } = require('events')

const BRIDGES_KEY = Symbol.for('zbterm.zxtermShareBridges')

const PREFIX = 'share.'

// The label of the session protocol's control channel
// (`zxterm_core::wire::SESSION_CTL_PROTOCOL`, protocol.md section 1). Since K17
// nothing in this process watches for it (the core serves the session's
// history on its own `history` channel); kept as the one place the string is
// written on this side.
const SESSION_CTL_PROTOCOL = 'zxterm/ctl'

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function unb64(text) {
  return Buffer.from(String(text || ''), 'base64')
}

class ShareBridge extends EventEmitter {
  // `core` is an engine/zxterm/core.js `Core`: `request(method, args)`,
  // 'event' ({name, data}) and 'exit'.
  constructor(core) {
    super()
    this._core = core
    this._onEvent = ({ name, data }) => {
      if (typeof name !== 'string' || !name.startsWith(PREFIX)) return
      this.emit(name.slice(PREFIX.length), data && typeof data === 'object' ? data : {})
    }
    this._onExit = (info) => this.emit('exit', info)
    core.on('event', this._onEvent)
    core.on('exit', this._onExit)
  }

  // `method` is the seam method, prefix included ('share.push').
  request(method, args = {}) {
    return this._core.request(method, args)
  }

  close() {
    this._core.off('event', this._onEvent)
    this._core.off('exit', this._onExit)
    this.removeAllListeners()
  }
}

// The most output bytes one queued `share.push` carries.
const PUSH_BATCH_BYTES = 64 * 1024

class OrderedRequests {
  // `request(method, args)` is the bridge's.
  constructor(request) {
    this._request = request
    this._queue = []
    this._running = false
  }

  // The reply of `method`, once every request queued before it has been
  // answered.
  send(method, args) {
    return new Promise((resolve, reject) => {
      this._queue.push({ method, args, resolve, reject })
      this._run()
    })
  }

  // `share.push`: output for `sessionId`. When the request last queued is also
  // a push of that session with the same `hd` flag, and still waiting, the
  // bytes join it (a flood then costs one request per round trip, not one per
  // chunk).
  push(sessionId, data, hd) {
    const last = this._queue[this._queue.length - 1]
    if (
      last &&
      last.chunks &&
      last.sessionId === sessionId &&
      last.hd === hd &&
      last.bytes + data.byteLength <= PUSH_BATCH_BYTES
    ) {
      last.chunks.push(data)
      last.bytes += data.byteLength
      return last.promise
    }
    const item = { chunks: [data], bytes: data.byteLength, sessionId, hd, method: 'share.push' }
    item.promise = new Promise((resolve, reject) => {
      item.resolve = resolve
      item.reject = reject
    })
    this._queue.push(item)
    this._run()
    return item.promise
  }

  async _run() {
    if (this._running) return
    this._running = true
    while (this._queue.length) {
      const item = this._queue.shift()
      const args = item.chunks
        ? { sessionId: item.sessionId, data: b64(Buffer.concat(item.chunks)), hd: item.hd }
        : item.args
      try {
        item.resolve(await this._request(item.method, args))
      } catch (err) {
        item.reject(err)
      }
    }
    this._running = false
  }
}

// The bridge of `core`, made on first use and shared afterwards (state on
// globalThis, like engine/zxterm/core.js, so a second copy of this file
// shares it).
function bridgeFor(core) {
  if (!globalThis[BRIDGES_KEY]) globalThis[BRIDGES_KEY] = new WeakMap()
  const bridges = globalThis[BRIDGES_KEY]
  let bridge = bridges.get(core)
  if (!bridge) {
    bridge = new ShareBridge(core)
    bridges.set(core, bridge)
  }
  return bridge
}

module.exports = { ShareBridge, OrderedRequests, bridgeFor, b64, unb64, SESSION_CTL_PROTOCOL }
