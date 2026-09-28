// Live history over a Freenet connection (design §8.1, §4 rows
// serveHistory/attachHistory; A-11 kept). A session's Hypercores, `store.log`
// and `store.metaCore`, replicate over one extra data channel per
// connection, labelled `zbterm/history 00` (HISTORY_PROTOCOL, HISTORY_ID),
// as spikes/freenet/p6.js measured it in-process:
//
//   hypercore.replicate(noise)
//     noise = NoiseSecretStream(initiator, duplex)   (S-07: hypercore 11
//             writes nothing on a raw duplex; the wrap is mandatory)
//     duplex = historyStream(conn): a streamx Duplex whose every write is one
//             frame, u32 LE length then the bytes, cut into data-channel
//             messages of at most MAX_MESSAGE_SIZE (65 536) bytes; reads
//             reassemble the frames and push each one whole.
//
// The channel pairs like every other one (./connection.js): whichever side
// calls serveHistory/attachHistory first opens the data channel and the other
// takes it; a remote history channel nobody has taken yet waits, with what it
// carried, until this side opens the key. The dialing side is the Noise
// initiator. The connection itself is already authenticated (design §6); the
// Noise keys here are ephemeral and prove nothing more.
//
// Back-pressure is BACKEND_FLOW's: a write whose frame the channel cannot
// take without passing QUEUE_HIGH_WATER, or while the host half has the data
// channel paused (RtcHost's 1 MiB mark, or a full worker pipe), completes only
// once the channel drains, so neither the Noise stream nor the worker queue
// grows without bound.
//
// One stream per connection carries every session replicated on it;
// replication is idempotent per (connection, store), as in
// engine/backends/pear/connection.js::_replicate (a WeakSet keyed by the store
// object, so a session reopened on a warm connection is attached again).
const { Duplex } = require('streamx')
const NoiseSecretStream = require('@hyperswarm/secret-stream')

const { FreenetChannel, MAX_MESSAGE_SIZE, QUEUE_HIGH_WATER } = require('./channel')

const HISTORY_PROTOCOL = 'zbterm/history'
const HISTORY_ID = Buffer.from([0])
const FRAME_HEADER = 4

// connection -> { stream, noise, replicated }
const streams = new WeakMap()

// A channel that carries bytes: a message is sent as parts of at most
// MAX_MESSAGE_SIZE bytes with no header, and every part is handed to
// `onmessage` as it arrives (the stream above does the framing). `ondrain`
// fires whenever the channel could take more.
class HistoryChannel extends FreenetChannel {
  constructor(conn, protocol, id, handlers = {}) {
    super(conn, protocol, id, handlers)
    this.ondrain = handlers.ondrain || noop
  }

  send(bytes) {
    if (this._closed) return false
    for (let at = 0; at < bytes.byteLength; at += MAX_MESSAGE_SIZE) {
      const part = bytes.subarray(at, Math.min(bytes.byteLength, at + MAX_MESSAGE_SIZE))
      this._queue.push(part)
      this._queued += part.byteLength
    }
    if (this._queued > this._queuedHigh) this._queuedHigh = this._queued
    this._pump()
    return this._takesMore()
  }

  _takesMore() {
    return !this._closed && !this._paused && this._queued < QUEUE_HIGH_WATER
  }

  _pump() {
    super._pump()
    if (this._takesMore()) this.ondrain()
  }

  _data(data, chanId) {
    if (this._closed || this._readyPart(data, chanId)) return
    if (this._held) {
      this._held.push(data)
      return
    }
    try {
      this.onmessage(data)
    } catch (err) {
      this._conn._fail(err)
    }
  }
}

// The connection's history duplex, made on first use; null once the
// connection is closed.
function historyStream(conn) {
  const entry = open(conn)
  return entry ? entry.stream : null
}

function open(conn) {
  let entry = streams.get(conn)
  if (entry) return entry
  if (!conn || conn.closed) return null

  let waiting = null
  const release = (err) => {
    const cb = waiting
    waiting = null
    if (cb) cb(err || null)
  }
  const channel = conn._openChannel(HISTORY_PROTOCOL, HISTORY_ID, {}, HistoryChannel)
  const stream = new Duplex({
    write(data, cb) {
      const frame = Buffer.allocUnsafe(FRAME_HEADER + data.byteLength)
      frame.writeUInt32LE(data.byteLength, 0)
      frame.set(data, FRAME_HEADER)
      if (channel.send(frame)) return cb(null)
      if (channel._closed) return cb(new Error('history channel closed'))
      waiting = cb
    },
    predestroy() {
      release(new Error('history stream destroyed'))
    },
    destroy(cb) {
      if (streams.get(conn) === entry) streams.delete(conn)
      channel.close()
      cb(null)
    }
  })
  stream.on('error', noop)

  // Reassembly: a frame may span parts, and a part may end one frame and
  // start the next.
  let head = null
  let need = -1
  let parts = []
  let have = 0
  channel.onmessage = (part) => {
    let buf = head ? Buffer.concat([head, part]) : part
    head = null
    while (buf.byteLength) {
      if (need < 0) {
        if (buf.byteLength < FRAME_HEADER) {
          head = buf
          return
        }
        need = buf.readUInt32LE(0)
        buf = buf.subarray(FRAME_HEADER)
        parts = []
        have = 0
      }
      const take = Math.min(need - have, buf.byteLength)
      parts.push(buf.subarray(0, take))
      have += take
      buf = buf.subarray(take)
      if (have === need) {
        stream.push(parts.length === 1 ? parts[0] : Buffer.concat(parts))
        need = -1
        parts = []
        have = 0
      }
    }
  }
  channel.ondrain = () => release(null)
  channel.onclose = () => stream.destroy()

  const noise = new NoiseSecretStream(conn.initiator === true, stream)
  noise.on('error', noop)
  entry = { stream, noise, replicated: new WeakSet() }
  streams.set(conn, entry)
  return entry
}

// Both cores of `store` on the connection's history stream, once per
// (connection, store).
function replicate(conn, store) {
  const entry = open(conn)
  if (!entry || entry.replicated.has(store)) return
  entry.replicated.add(store)
  for (const core of [store.log, store.metaCore]) {
    if (core && typeof core.replicate === 'function') core.replicate(entry.noise)
  }
}

function serveHistory(conn, store) {
  replicate(conn, store)
}

// As the loopback and Pear do: replicate, start the full-range download of
// both cores, and hand back `fetch` for the ranges the engine asks for.
function attachHistory(conn, store, _keys) {
  replicate(conn, store)
  const downloads = [
    store.log.download({ start: 0, end: -1, linear: true }),
    store.metaCore.download({ start: 0, end: -1, linear: true })
  ]
  return {
    fetch({ start, end }) {
      return store.log.download({ start, end, linear: true })
    },
    close() {
      for (const download of downloads.splice(0)) {
        if (download && typeof download.destroy === 'function') download.destroy()
      }
    }
  }
}

function noop() {}

module.exports = {
  historyStream,
  serveHistory,
  attachHistory,
  HistoryChannel,
  HISTORY_PROTOCOL,
  HISTORY_ID
}
