// Globals the Freenet SDK expects and Bare lacks (probe P-1; A-6). Required by
// ./index.js before anything that loads the SDK, which is the same idea as the
// three shims at the top of ../../worker.js. They cannot live there: nothing
// outside the registry may require into a backend directory
// (test/backend-boundary.test.js), and a build without this backend has no
// bare-ws.
//
// Only under Bare, and only for a global that is missing: under Node >= 22
// the global WebSocket and TextEncoder are used as they are, and brittle-node
// runs every test file in one process, so a shim must never land there.
//
// Installed: TextEncoder / TextDecoder (bare-encoding), and a browser-shaped
// WebSocket over bare-ws, whose Socket is a Duplex stream rather than an
// EventTarget. The SDK uses `binaryType`, `onmessage`, `addEventListener`
// ('open', 'close'), `send(Uint8Array)` and nothing else.
function install() {
  if (typeof Bare === 'undefined') return false
  if (
    typeof globalThis.TextEncoder === 'undefined' ||
    typeof globalThis.TextDecoder === 'undefined'
  ) {
    const encoding = require('bare-encoding')
    if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = encoding.TextEncoder
    if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = encoding.TextDecoder
  }
  if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = browserShapedWebSocket()
  return true
}

// S-29 (F9): bare-ws opens its connection through bare-http1's global agent,
// whose sockets carry a 5 000 ms idle timeout (`HTTPAgent.global`, `timeout:
// 5000`, bare-http1 4.5.7). The upgrade hands that same TCP socket to the
// WebSocket with the timer still armed, so a node connection with no traffic
// for 5 s was destroyed (1006, no close frame) - within any network-mode Put,
// which takes seconds. The WebSocket has its own idle ping (bare-ws
// IDLE_TIMEOUT, 120 s); the agent's HTTP timeout is switched off.
function keepOpenWhenIdle(socket) {
  const tcp = socket && socket._socket
  if (tcp && typeof tcp.setTimeout === 'function') tcp.setTimeout(0)
}

function browserShapedWebSocket() {
  const { Socket } = require('bare-ws')

  return class BrowserShapedWebSocket {
    constructor(url) {
      this.binaryType = 'arraybuffer'
      this.onmessage = null
      this._opened = false
      this._closed = false
      this._listeners = { open: [], close: [], error: [], message: [] }
      this._socket = new Socket(url)
      this._socket.on('open', () => {
        this._opened = true
        keepOpenWhenIdle(this._socket)
        this._fire('open', {})
      })
      this._socket.on('data', (data) => {
        // Hand the SDK an ArrayBuffer that covers exactly this message.
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        const ev = { data: ab }
        if (this.onmessage) this.onmessage(ev)
        this._fire('message', ev)
      })
      // A refused connection may end in 'error' alone; the SDK and ./node-client.js
      // learn about failure from 'close', so it is fired exactly once either way.
      this._socket.on('error', (err) => {
        this._fire('error', { error: err, message: err.message })
        this._onclose()
      })
      this._socket.on('close', () => this._onclose())
    }

    addEventListener(name, fn) {
      ;(this._listeners[name] || (this._listeners[name] = [])).push(fn)
    }

    _fire(name, ev) {
      for (const fn of this._listeners[name] || []) fn(ev)
    }

    _onclose() {
      if (this._closed) return
      this._closed = true
      this._fire('close', { code: 1006, reason: '' })
    }

    send(bytes) {
      this._socket.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    }

    close() {
      if (this._opened) this._socket.end()
      else this._socket.destroy()
    }
  }
}

module.exports = { install }
