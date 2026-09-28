// One authenticated Freenet peer connection (engine/backends/types.js
// PeerConnection; design §4 rows 'connection', path(), openChannel/onChannel).
// It exists only once design §6 step 5 passed: the peer signed the SDP whose
// certificate fingerprint the DTLS handshake presented. The WebRTC peer
// connection itself lives in the host process (electron/rtc-host.js), reached
// through the backend's rtcHost by `connId`.
//
// Channels (./channel.js) pair the way the loopback's do: the side that opens
// (protocol, id) first creates a data channel labelled `protocol + ' ' +
// hex(id)` with a chanId it picks (1 up; 0 is the dial's bootstrap channel);
// the remote hears of it through its onChannel callback for `protocol` and
// takes it with openChannel(protocol, id), which then sends and reads on that
// same data channel. If both sides open the same key at once, each sends on
// its own data channel and reads from both, so each direction stays on one
// ordered data channel. Opening a key this side already has open throws.
const { EventEmitter } = require('events')

const { PATH } = require('../types')
const { FreenetChannel, labelOf, parseLabel, READY_PART } = require('./channel')

// The dial's bootstrap data channel (engine/backends/freenet/index.js): both
// halves report its label when it opens.
const BOOTSTRAP_LABEL = 'zbterm/fnet-bootstrap'

// BACKEND_STATE.pathKind is the local candidate type, or 'relay' when either
// end is a TURN relay. The contract brokers the handshake, never the data, so
// a Freenet path is never BROKER.
function pathOf(pathKind) {
  return pathKind === 'relay' ? PATH.RELAY : PATH.DIRECT
}

class FreenetConnection extends EventEmitter {
  constructor({ rtcHost, connId, remotePeerKey, initiator, pathKind, debug }) {
    super()
    this.remotePeerKey = remotePeerKey
    this.initiator = initiator
    this.closed = false
    this._rtcHost = rtcHost
    this._connId = connId
    this._path = pathOf(pathKind)
    this._debugSink = debug || null
    // key -> this side's FreenetChannel.
    this._channels = new Map()
    // chanId -> the FreenetChannel reading it, or a pending remote channel.
    this._byChan = new Map()
    // key -> { chanId, protocol, id, open, data, notified }: data channels the
    // remote opened that this side has not taken with openChannel yet.
    this._pending = new Map()
    // protocol -> onChannel callback.
    this._onChannel = new Map()
    this._nextChanId = 1
    // Data channels this side made are created in the host half only once
    // the bootstrap channel is open (_bootstrapOpened): chanId -> label.
    this._bootstrapOpen = false
    this._deferred = new Map()
  }

  path() {
    return this._path
  }

  openChannel(protocol, id, handlers) {
    return this._openChannel(protocol, id, handlers, FreenetChannel)
  }

  // openChannel with the channel class to make: FreenetChannel, or a
  // subclass of it (./history.js::HistoryChannel carries bytes, not JSON,
  // with the same pairing, queue and back-pressure).
  _openChannel(protocol, id, handlers, Channel) {
    if (this.closed) throw new Error('Connection is closed')
    const key = labelOf(protocol, id)
    if (this._channels.has(key)) {
      throw new Error(`Channel ${key} is already open on this connection`)
    }
    const channel = new Channel(this, protocol, id, handlers)
    this._channels.set(key, channel)
    const pending = this._pending.get(key)
    if (pending) {
      // The remote opened it first: send and read on its data channel.
      this._pending.delete(key)
      this._byChan.set(pending.chanId, channel)
      channel._sendOn(pending.chanId, pending.open)
      channel._hold(pending.data)
      return channel
    }
    const chanId = this._nextChanId++
    this._byChan.set(chanId, channel)
    channel._sendOn(chanId, false, true)
    if (this._bootstrapOpen) this._rtcHost.openChannel(this._connId, chanId, key)
    else this._deferred.set(chanId, key)
    return channel
  }

  // node-datachannel reports a peer connection `connected` before it has
  // opened the data channels made before SCTP was up (the dial's bootstrap
  // channel). A data channel created in that window is opened twice, its
  // stream is reset, and the other side never hears of it: under load the
  // first ShareManager channel of a join vanished and the join hung until its
  // timeout (S-26). Until the bootstrap channel reports open, channels this
  // side opens wait here (their messages queue in the channel, as for any
  // channel not open yet).
  _bootstrapOpened() {
    if (this._bootstrapOpen) return
    this._bootstrapOpen = true
    const deferred = Array.from(this._deferred)
    this._deferred.clear()
    for (const [chanId, key] of deferred) {
      if (this._byChan.has(chanId)) this._rtcHost.openChannel(this._connId, chanId, key)
    }
  }

  onChannel(protocol, cb) {
    this._onChannel.set(protocol, cb)
    // Channels the remote opened before this side was listening.
    for (const pending of this._pending.values()) {
      if (pending.protocol === protocol) queueMicrotask(() => this._notify(pending))
    }
  }

  close(reason) {
    if (this.closed) return
    this._rtcHost.close(this._connId, reason || 'closed')
    this._closed(reason || 'closed')
  }

  // BACKEND_CHANNEL from the host half: `opened` for a data channel this side
  // opened, or one the remote opened; `closed` for either.
  _channelEvent(body) {
    if (this.closed) return
    const target = this._byChan.get(body.chanId)
    if (body.op === 'closed') {
      if (!target) return
      this._byChan.delete(body.chanId)
      if (target instanceof FreenetChannel) {
        target._chanIds.delete(body.chanId)
        target._shut(true)
      } else if (this._pending.get(labelOf(target.protocol, target.id)) === target) {
        this._pending.delete(labelOf(target.protocol, target.id))
      }
      return
    }
    if (body.op !== 'opened') return
    if (body.label === BOOTSTRAP_LABEL) this._bootstrapOpened()
    if (target) {
      if (target instanceof FreenetChannel) target._opened(body.chanId)
      else target.open = true
      return
    }
    // A data channel the remote opened. The dial's bootstrap channel, and
    // any label this file did not make, carries nothing and is left alone.
    const parsed = parseLabel(body.label)
    if (!parsed) return
    const key = labelOf(parsed.protocol, parsed.id)
    const mine = this._channels.get(key)
    if (mine) {
      // Both sides opened the key at once: read from theirs too.
      this._byChan.set(body.chanId, mine)
      mine._chanIds.add(body.chanId)
      this._rtcHost.send(this._connId, body.chanId, READY_PART)
      return
    }
    if (this._pending.has(key)) {
      this._rtcHost.closeChannel(this._connId, body.chanId)
      return
    }
    // The host half has wired it: the opener may send (channel.js READY).
    this._rtcHost.send(this._connId, body.chanId, READY_PART)
    const pending = { chanId: body.chanId, ...parsed, open: true, data: [], notified: false }
    this._pending.set(key, pending)
    this._byChan.set(body.chanId, pending)
    this._notify(pending)
  }

  _dataEvent(body) {
    if (this.closed) return
    const target = this._byChan.get(body.chanId)
    if (!target) return
    const data = Buffer.isBuffer(body.data) ? body.data : Buffer.from(body.data)
    if (target instanceof FreenetChannel) target._data(data, body.chanId)
    else target.data.push(data)
  }

  _flowEvent(body) {
    const target = this._byChan.get(body.chanId)
    if (target instanceof FreenetChannel) target._flow(body.chanId, body.paused)
  }

  _notify(pending) {
    const key = labelOf(pending.protocol, pending.id)
    if (this.closed || pending.notified || this._pending.get(key) !== pending) return
    const cb = this._onChannel.get(pending.protocol)
    if (!cb) return
    pending.notified = true
    try {
      cb(Buffer.from(pending.id))
    } catch (err) {
      this._fail(err)
    }
  }

  // A channel stopped: its data channels are no longer read.
  _forgetChannel(channel, chanIds) {
    if (this._channels.get(channel.label) === channel) this._channels.delete(channel.label)
    for (const chanId of chanIds) {
      if (this._byChan.get(chanId) === channel) this._byChan.delete(chanId)
      this._deferred.delete(chanId)
    }
  }

  // A handler that throws takes the connection down, as on the loopback.
  _fail(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err)
    this.close('handler error')
  }

  _debug(event, details) {
    if (this._debugSink) this._debugSink(event, details)
  }

  // A later BACKEND_STATE with a selected pair.
  _setPathKind(pathKind) {
    if (!pathKind) return
    const next = pathOf(pathKind)
    if (next === this._path) return
    this._path = next
    this.emit('path', next)
  }

  // Every channel hears onclose once, then the connection emits 'close'.
  _closed(reason) {
    if (this.closed) return
    this.closed = true
    for (const channel of Array.from(this._channels.values())) channel._shut(false)
    this._pending.clear()
    this._deferred.clear()
    this._byChan.clear()
    this._onChannel.clear()
    this.emit('close', reason)
  }
}

module.exports = FreenetConnection
module.exports.pathOf = pathOf
