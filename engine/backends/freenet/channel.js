// One Freenet channel (engine/backends/types.js Channel; design §4 row
// openChannel/onChannel, A-10): an ordered, reliable data channel per
// (protocol, id) carrying JSON, run in the host process (electron/rtc-host.js)
// and reached through the backend's rtcHost by (connId, chanId).
//
// A message is JSON, then UTF-8, cut into parts of at most MAX_MESSAGE_SIZE
// bytes each (S-07: a larger data-channel message kills the channel, and
// RtcHost.send refuses one). Every part is binary and starts with a 5-byte
// header `[flags u8][index u32 LE]`: `flags` bit 0 marks the last part of a
// message, `index` counts the parts of one message from 0. A channel is
// ordered, so the parts of one message arrive consecutively and in order.
// `flags` bit 1 marks READY_PART, which carries no message: the first thing
// the side that did not open a data channel sends on it; the opener sends
// nothing before it (S-27).
//
// Back-pressure has the loopback's shape (engine/backends/loopback.js
// LoopbackChannel): advisory. `send` never drops a message on an open channel;
// it returns false while the host half reports the data channel paused
// (BACKEND_FLOW, RtcHost's 1 MiB high-water mark or a full worker pipe), or
// while this channel holds QUEUE_HIGH_WATER bytes or more in the worker
// (parts wait here until the data channel opens, and while it is paused).
// There is no 'drain' event, as the loopback has none. Once closed, `send`
// returns false and the message is dropped.
const MAX_MESSAGE_SIZE = 65536
const HEADER_BYTES = 5
const PART_BYTES = MAX_MESSAGE_SIZE - HEADER_BYTES
const LAST = 1
// The one part that is not a message: sent by the side that did NOT open a
// data channel, first thing on it, once its host half has wired it (see
// FreenetChannel#_readyPart).
const READY = 2
const READY_PART = Buffer.from([READY, 0, 0, 0, 0])
// Bytes held in the worker for one channel before `send` reports
// back-pressure. The messages past it are still queued and delivered.
const QUEUE_HIGH_WATER = 256 * 1024

function hex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

function labelOf(protocol, id) {
  return protocol + ' ' + hex(id)
}

// A label back to (protocol, id); null for one this file did not make (the
// dial's bootstrap channel, engine/backends/freenet/index.js).
function parseLabel(label) {
  if (typeof label !== 'string') return null
  const at = label.lastIndexOf(' ')
  if (at <= 0) return null
  const idHex = label.slice(at + 1)
  if (!/^(?:[0-9a-f]{2})*$/.test(idHex)) return null
  return { protocol: label.slice(0, at), id: Buffer.from(idHex, 'hex') }
}

// A message as the parts that carry it.
function cut(message) {
  const text = JSON.stringify(message)
  if (text === undefined) throw new TypeError('A channel message must be JSON')
  const body = Buffer.from(text, 'utf8')
  const count = Math.max(1, Math.ceil(body.byteLength / PART_BYTES))
  const parts = []
  for (let index = 0; index < count; index++) {
    const chunk = body.subarray(index * PART_BYTES, (index + 1) * PART_BYTES)
    const part = Buffer.allocUnsafe(HEADER_BYTES + chunk.byteLength)
    part[0] = index === count - 1 ? LAST : 0
    part.writeUInt32LE(index, 1)
    chunk.copy(part, HEADER_BYTES)
    parts.push(part)
  }
  return parts
}

class FreenetChannel {
  constructor(conn, protocol, id, handlers = {}) {
    // Replaceable: whatever is assigned at delivery time receives the message.
    this.onmessage = handlers.onmessage || noop
    this.onclose = handlers.onclose || noop
    this.protocol = protocol
    this.id = Buffer.from(id)
    this.label = labelOf(protocol, id)
    this._conn = conn
    // The data channel this side sends on: its own, or the remote's when the
    // remote opened this (protocol, id) first. Writable once it is open.
    this._sendChanId = null
    this._writable = false
    this._open = false
    // An opener waits for the other side's READY_PART before it sends.
    this._awaitReady = false
    this._paused = false
    // Every data channel this endpoint reads from (the send one, and the
    // remote's own when both sides opened the same key at once).
    this._chanIds = new Set()
    this._queue = []
    this._queued = 0
    this._queuedHigh = 0
    this._parts = []
    // Messages that arrived before the opener got its channel object back.
    this._held = null
    this._closed = false
  }

  send(message) {
    if (this._closed) return false
    for (const part of cut(message)) {
      this._queue.push(part)
      this._queued += part.byteLength
    }
    if (this._queued > this._queuedHigh) this._queuedHigh = this._queued
    this._pump()
    return !this._closed && !this._paused && this._queued < QUEUE_HIGH_WATER
  }

  close() {
    this._shut(true)
  }

  // The data channel `chanId` is this endpoint's to send on; `awaitReady`
  // when this side created it.
  _sendOn(chanId, open, awaitReady = false) {
    this._sendChanId = chanId
    this._chanIds.add(chanId)
    this._awaitReady = awaitReady
    if (open) this._opened(chanId)
  }

  _opened(chanId) {
    if (chanId !== this._sendChanId || this._open) return
    this._open = true
    this._becomeWritable()
  }

  _becomeWritable() {
    if (this._writable || !this._open || this._awaitReady) return
    this._writable = true
    this._pump()
  }

  // The opener of a data channel sends nothing until the other side says it
  // has wired the channel. node-datachannel delivers the messages that reach
  // a remote-opened data channel before its message handler is set from a
  // second thread once it is set, and under load one of them came out
  // hundreds of messages late (S-27). The other side's first part on the
  // opener's data channel is READY_PART; it is consumed here. Returns true
  // for that part.
  _readyPart(data, chanId) {
    if (!this._awaitReady || chanId !== this._sendChanId) return false
    if (data.byteLength !== READY_PART.byteLength || !data.equals(READY_PART)) {
      this._conn._debug('channel:malformed', { label: this.label })
      this._shut(true)
      return true
    }
    this._awaitReady = false
    this._becomeWritable()
    return true
  }

  // BACKEND_FLOW for the data channel this endpoint sends on.
  _flow(chanId, paused) {
    if (chanId !== this._sendChanId) return
    this._paused = !!paused
    if (!this._paused) this._pump()
  }

  // Hands queued parts to the host half until it pauses the data channel.
  // The host half reports a pause through 'flow' before its send() returns.
  _pump() {
    const conn = this._conn
    while (!this._closed && this._writable && !this._paused && this._queue.length) {
      const part = this._queue.shift()
      this._queued -= part.byteLength
      conn._rtcHost.send(conn._connId, this._sendChanId, part)
    }
  }

  // Replays, on the next microtask, what arrived before the opener had this
  // object (the opener's handler may name the channel it is assigned to).
  _hold(buffers) {
    this._held = buffers.slice()
    queueMicrotask(() => {
      const held = this._held || []
      this._held = null
      for (const data of held) this._data(data)
    })
  }

  _data(data, chanId) {
    if (this._closed || this._readyPart(data, chanId)) return
    if (this._held) {
      this._held.push(data)
      return
    }
    if (data.byteLength < HEADER_BYTES || data.readUInt32LE(1) !== this._parts.length) {
      this._conn._debug('channel:malformed', { label: this.label })
      this._shut(true)
      return
    }
    this._parts.push(data.subarray(HEADER_BYTES))
    if (!(data[0] & LAST)) return
    const body = this._parts.length === 1 ? this._parts[0] : Buffer.concat(this._parts)
    this._parts = []
    let message
    try {
      message = JSON.parse(body.toString('utf8'))
    } catch {
      this._conn._debug('channel:malformed', { label: this.label })
      this._shut(true)
      return
    }
    try {
      // Not awaited, as the contract says.
      this.onmessage(message)
    } catch (err) {
      this._conn._fail(err)
    }
  }

  // Closes every data channel of this endpoint (unless the connection is
  // gone) and fires onclose once.
  _shut(closeDataChannels) {
    if (this._closed) return
    this._closed = true
    this._queue = []
    this._queued = 0
    this._parts = []
    this._held = null
    const chanIds = Array.from(this._chanIds)
    this._chanIds.clear()
    this._conn._forgetChannel(this, chanIds)
    if (closeDataChannels && !this._conn.closed) {
      for (const chanId of chanIds) this._conn._rtcHost.closeChannel(this._conn._connId, chanId)
    }
    try {
      this.onclose()
    } catch (err) {
      this._conn._fail(err)
    }
  }
}

function noop() {}

module.exports = {
  FreenetChannel,
  labelOf,
  parseLabel,
  cut,
  MAX_MESSAGE_SIZE,
  HEADER_BYTES,
  QUEUE_HIGH_WATER,
  READY_PART
}
