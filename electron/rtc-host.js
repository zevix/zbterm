const { EventEmitter } = require('events')

// The host half of the Freenet backend's WebRTC (Freenet design 3, 3.1;
// D-06/D-09): peer connections and data channels on node-datachannel, owned
// by the host process because binary frames arrive zeroed under Bare (S-06).
// The worker drives it through BACKEND_* frames: engine/client.js dispatches
// them here and turns the events below back into frames, and
// engine/backends/freenet/rtc-remote.js is the worker-side proxy with the same
// API. Like electron/pty-host.js, the core never requires this file; it is
// injected as `EngineClient({ rtcHost })`.
//
// Events, each with `connId`:
//   signal  { type: 'offer' | 'answer', sdp } or { type: 'candidate', candidate, mid }
//   state   { state, localFingerprint, remoteFingerprint, pathKind }
//   channel { chanId, label, op: 'opened' | 'closed' }
//   data    { chanId, data }
//   flow    { chanId, paused }
//   close   { reason }

// One data-channel message at most (S-07). The framer that cuts larger writes
// lives in the worker (engine/backends/freenet/channel.js); send() only
// refuses.
const MAX_MESSAGE_SIZE = 65536
// Back-pressure per channel: send() returns false and `flow` reports paused
// once bufferedAmount passes the high-water mark (the probe's 1 MiB), and
// `flow` reports resumed when onBufferedAmountLow fires below the low one.
const HIGH_WATER_MARK = 1024 * 1024
const LOW_WATER_MARK = 256 * 1024
// D-11. The flag, the environment and the settings field replace it
// (electron/ice-servers.js, F9).
const DEFAULT_ICE_SERVERS = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']
// A channel the worker opens carries the worker's chanId, which must be below
// this; a channel the remote side opens gets a host-assigned chanId from here
// up, so the two can never collide.
const REMOTE_CHANNEL_BASE = 0x80000000

let ndc = null
let loadError = null

function load() {
  if (ndc || loadError) return ndc
  try {
    ndc = require('node-datachannel')
  } catch (err) {
    loadError = err
  }
  return ndc
}

// 'sha-256 AB:CD:…', the shape of an SDP a=fingerprint line.
function sdpFingerprint(sdp) {
  const match = /a=fingerprint:(\S+) (\S+)/i.exec(sdp || '')
  return match ? `${match[1].toLowerCase()} ${match[2].toUpperCase()}` : null
}

function toBuffer(msg) {
  if (Buffer.isBuffer(msg)) return msg
  if (typeof msg === 'string') return Buffer.from(msg, 'utf8')
  return Buffer.from(msg)
}

class RtcHost extends EventEmitter {
  // Whether node-datachannel loads in this process. A host constructs an
  // RtcHost only when it does; RtcHost.loadError() says why when it does not.
  static available() {
    return !!load()
  }

  static loadError() {
    load()
    return loadError
  }

  // node-datachannel's global teardown: closes every peer connection in the
  // process and lets it exit. For tests and process exit only.
  static cleanup() {
    if (ndc) ndc.cleanup()
  }

  constructor({ iceServers = DEFAULT_ICE_SERVERS } = {}) {
    super()
    if (!load()) throw loadError
    this.iceServers = iceServers
    this.conns = new Map()
  }

  // `iceServers` overrides the host's list for this connection (BACKEND_OPEN).
  open(connId, { iceServers } = {}) {
    if (this.conns.has(connId)) return false
    const pc = new ndc.PeerConnection(`zbterm-${connId}`, {
      iceServers: Array.isArray(iceServers) ? iceServers : this.iceServers,
      maxMessageSize: MAX_MESSAGE_SIZE
    })
    const conn = { connId, pc, channels: new Map(), nextRemote: REMOTE_CHANNEL_BASE, closed: false }
    this.conns.set(connId, conn)
    pc.onLocalDescription((sdp, type) => {
      if (conn.closed) return
      this.emit('signal', { connId, type: String(type).toLowerCase(), sdp })
    })
    pc.onLocalCandidate((candidate, mid) => {
      if (conn.closed) return
      this.emit('signal', { connId, type: 'candidate', candidate, mid })
    })
    pc.onStateChange((state) => this._onState(conn, state))
    pc.onDataChannel((dc) => {
      if (conn.closed) return
      this._wireChannel(conn, conn.nextRemote++, dc)
    })
    return true
  }

  // A remote description or candidate, already checked by the worker.
  signal(connId, msg) {
    const conn = this.conns.get(connId)
    if (!conn || !msg) return
    if (msg.type === 'candidate') {
      conn.pc.addRemoteCandidate(msg.candidate, msg.mid || '0')
    } else {
      conn.pc.setRemoteDescription(msg.sdp, msg.type)
    }
  }

  // Ordered and reliable. On the offering side this is what makes the local
  // offer: node-datachannel negotiates once the first channel exists.
  openChannel(connId, chanId, label) {
    const conn = this.conns.get(connId)
    if (!conn) return false
    if (!(chanId >= 0 && chanId < REMOTE_CHANNEL_BASE) || conn.channels.has(chanId)) return false
    this._wireChannel(conn, chanId, conn.pc.createDataChannel(label || ''))
    return true
  }

  closeChannel(connId, chanId) {
    const chan = this._channel(connId, chanId)
    if (!chan) return
    try {
      chan.dc.close()
    } catch {}
    this._channelClosed(this.conns.get(connId), chan)
  }

  // false once the channel is past the high-water mark (the message is still
  // queued), or when it is not open. A message over MAX_MESSAGE_SIZE is
  // refused with a RangeError: it would kill the channel (S-07).
  send(connId, chanId, data) {
    const chan = this._channel(connId, chanId)
    if (!chan || !chan.open) return false
    const buffer = toBuffer(data)
    if (buffer.byteLength > MAX_MESSAGE_SIZE) {
      throw new RangeError(
        `rtc-host: a ${buffer.byteLength}-byte message exceeds the ${MAX_MESSAGE_SIZE}-byte cap`
      )
    }
    try {
      chan.dc.sendMessageBinary(buffer)
    } catch {
      return false
    }
    if (!chan.paused && chan.dc.bufferedAmount() > HIGH_WATER_MARK) {
      chan.paused = true
      this.emit('flow', { connId, chanId, paused: true })
    }
    return !chan.paused
  }

  // Receive-side back-pressure from the seam (engine/client.js): while a
  // channel is paused its messages are held here, in order, and emitted on
  // resume. A data channel has no way to stop the remote sending.
  pause(connId, chanId) {
    const chan = this._channel(connId, chanId)
    if (chan && !chan.held) chan.held = []
  }

  resume(connId, chanId) {
    const chan = this._channel(connId, chanId)
    if (!chan || !chan.held) return
    const held = chan.held
    chan.held = null
    for (let i = 0; i < held.length; i++) {
      if (chan.held) {
        chan.held.push(...held.slice(i))
        return
      }
      this.emit('data', { connId, chanId, data: held[i] })
    }
  }

  close(connId, reason) {
    const conn = this.conns.get(connId)
    if (conn) this._teardown(conn, reason || 'closed')
  }

  closeAll(reason) {
    for (const conn of Array.from(this.conns.values())) this._teardown(conn, reason || 'closed')
  }

  _channel(connId, chanId) {
    const conn = this.conns.get(connId)
    return (conn && conn.channels.get(chanId)) || null
  }

  _wireChannel(conn, chanId, dc) {
    const { connId } = conn
    const chan = { chanId, dc, label: dc.getLabel(), open: false, paused: false, held: null }
    conn.channels.set(chanId, chan)
    dc.setBufferedAmountLowThreshold(LOW_WATER_MARK)
    const opened = () => {
      if (chan.open || conn.closed || conn.channels.get(chanId) !== chan) return
      chan.open = true
      this.emit('channel', { connId, chanId, label: chan.label, op: 'opened' })
    }
    dc.onOpen(opened)
    dc.onClosed(() => this._channelClosed(conn, chan))
    dc.onError(() => this._channelClosed(conn, chan))
    dc.onBufferedAmountLow(() => {
      if (!chan.paused || conn.closed) return
      chan.paused = false
      this.emit('flow', { connId, chanId, paused: false })
    })
    dc.onMessage((msg) => {
      if (conn.closed || conn.channels.get(chanId) !== chan) return
      const data = toBuffer(msg)
      if (chan.held) chan.held.push(data)
      else this.emit('data', { connId, chanId, data })
    })
    // A channel the remote opened can already be open when it is handed over.
    if (dc.isOpen()) opened()
  }

  _channelClosed(conn, chan) {
    if (!conn || conn.channels.get(chan.chanId) !== chan) return
    conn.channels.delete(chan.chanId)
    if (conn.closed) return
    this.emit('channel', {
      connId: conn.connId,
      chanId: chan.chanId,
      label: chan.label,
      op: 'closed'
    })
  }

  _onState(conn, state) {
    if (conn.closed) return
    this.emit('state', {
      connId: conn.connId,
      state,
      localFingerprint: this._localFingerprint(conn),
      remoteFingerprint: state === 'connected' ? this._remoteFingerprint(conn) : null,
      pathKind: state === 'connected' ? this._pathKind(conn) : null
    })
    if (state === 'failed' || state === 'closed') this._teardown(conn, state)
  }

  _localFingerprint(conn) {
    try {
      const local = conn.pc.localDescription()
      return sdpFingerprint(local && local.sdp)
    } catch {
      return null
    }
  }

  // The certificate fingerprint libdatachannel took from the DTLS handshake,
  // in the SDP line's shape.
  _remoteFingerprint(conn) {
    try {
      const fp = conn.pc.remoteFingerprint()
      if (!fp || !fp.value) return null
      return `${String(fp.algorithm).toLowerCase()} ${String(fp.value).toUpperCase()}`
    } catch {
      return null
    }
  }

  // The local end's candidate type, unless either end is a TURN relay. The
  // remote end is often `prflx` even on one machine: its connectivity check
  // can arrive before its trickled candidate does.
  _pathKind(conn) {
    try {
      const pair = conn.pc.getSelectedCandidatePair()
      if (!pair) return null
      const types = [pair.local, pair.remote].map((end) => (end && end.type) || null)
      return types.includes('relay') ? 'relay' : types[0]
    } catch {
      return null
    }
  }

  _teardown(conn, reason) {
    if (conn.closed) return
    const channels = Array.from(conn.channels.values())
    for (const chan of channels) this._channelClosed(conn, chan)
    conn.closed = true
    this.conns.delete(conn.connId)
    for (const chan of channels) {
      try {
        chan.dc.close()
      } catch {}
    }
    try {
      conn.pc.close()
    } catch {}
    this.emit('close', { connId: conn.connId, reason })
  }
}

module.exports = {
  RtcHost,
  DEFAULT_ICE_SERVERS,
  MAX_MESSAGE_SIZE,
  HIGH_WATER_MARK,
  LOW_WATER_MARK,
  REMOTE_CHANNEL_BASE
}
