// Shims the Freenet SDK needs under Bare (probe P-1). Same idea as the top of
// engine/worker.js: install globals before anything else is required.
// Shimmed: process (bare-process), TextEncoder/TextDecoder (bare-encoding), performance
// (Date.now fallback lives in lib/fnet.js), and a browser-shaped WebSocket over bare-ws,
// whose Socket is a Duplex stream rather than an EventTarget.
globalThis.process = require('bare-process')
const encoding = require('bare-encoding')
if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = encoding.TextEncoder
if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = encoding.TextDecoder

const { Socket } = require('bare-ws')

class BrowserShapedWebSocket {
  constructor(url) {
    this.binaryType = 'arraybuffer'
    this.onmessage = null
    this._listeners = { open: [], close: [], error: [], message: [] }
    this._socket = new Socket(url)
    this._socket.on('open', () => this._fire('open', {}))
    this._socket.on('data', (data) => {
      // Hand the SDK an ArrayBuffer that covers exactly this message.
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      const ev = { data: ab }
      if (this.onmessage) this.onmessage(ev)
      this._fire('message', ev)
    })
    this._socket.on('error', (err) => this._fire('error', { error: err, message: err.message }))
    this._socket.on('close', () => this._fire('close', { code: 1006, reason: '' }))
  }

  addEventListener(name, fn) {
    ;(this._listeners[name] || (this._listeners[name] = [])).push(fn)
  }

  _fire(name, ev) {
    for (const fn of this._listeners[name] || []) fn(ev)
  }

  send(bytes) {
    this._socket.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  }

  close() {
    this._socket.end()
  }
}

globalThis.WebSocket = BrowserShapedWebSocket
