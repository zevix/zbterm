// One PearConnection wraps one Hyperswarm socket. Hyperswarm dedupes to one
// socket per remote keypair, so a single PearConnection can carry several
// links, in both roles, at once. The Protomux of the socket is private to this
// file: control channels and Hypercore replication share it, and nothing
// outside the Pear backend ever sees it.
const { EventEmitter } = require('events')
const Protomux = require('protomux')
const c = require('compact-encoding')

const { PATH } = require('../types')

class PearChannel {
  constructor(mux, protocol, id, handlers = {}) {
    // Replaceable, like a Protomux message's own handler: whatever is assigned
    // here at delivery time receives the message, and its result is returned
    // to the caller (Protomux itself does not await it).
    this.onmessage = handlers.onmessage || noop
    this.onclose = handlers.onclose || noop
    const channel = mux.createChannel({ protocol, id })
    if (!channel) throw new Error(`Channel ${protocol} is already open on this connection`)
    this._channel = channel
    this._message = channel.addMessage({
      encoding: c.json,
      onmessage: (message) => this.onmessage(message)
    })
    channel.onclose = () => this.onclose()
    channel.open()
  }

  send(message) {
    return this._message.send(message)
  }

  close() {
    this._channel.close()
  }
}

class PearConnection extends EventEmitter {
  constructor(socket, info) {
    super()
    this._socket = socket
    this._info = info || null
    this._muxInstance = null
    // Session stores already replicated on this connection, so a second link
    // for the same session doesn't call .replicate(mux) twice. Keyed by the
    // store object: a session reopened on a still-warm connection has new
    // cores, and those do need attaching.
    this._replicated = new WeakSet()
    socket.once('close', () => this.emit('close'))
    socket.on('error', (err) => {
      // An EventEmitter throws on an unheard 'error'; a socket error with no
      // one listening is simply dropped, as it was on the raw socket.
      if (this.listenerCount('error') > 0) this.emit('error', err)
    })
  }

  get remotePeerKey() {
    return this._socket.remotePublicKey
  }

  get closed() {
    return !!this._socket.destroyed
  }

  get initiator() {
    if (!this._info) return null
    if (this._info.client) return true
    if (this._info.server) return false
    return null
  }

  // hyperdht swaps a relayed connection over to the punched path underneath
  // the socket without surfacing it, so a relayed path cannot be told apart
  // from here; 'path' is never emitted.
  path() {
    return PATH.DIRECT
  }

  get _mux() {
    if (!this._muxInstance) this._muxInstance = Protomux.from(this._socket)
    return this._muxInstance
  }

  openChannel(protocol, id, handlers) {
    return new PearChannel(this._mux, protocol, id, handlers)
  }

  onChannel(protocol, cb) {
    this._mux.pair({ protocol }, cb)
  }

  close(_reason) {
    this._socket.destroy()
  }

  // Attaching replication after other traffic has flowed on the mux (pre-auth,
  // in the channel-pair callback) is confirmed safe by Phase 0 spike 2(b).
  _replicate(store) {
    if (this._replicated.has(store)) return
    this._replicated.add(store)
    store.log.replicate(this._mux)
    store.metaCore.replicate(this._mux)
  }
}

function noop() {}

module.exports = PearConnection
module.exports.PearChannel = PearChannel
