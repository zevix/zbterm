// Worker-side counterpart to electron/rtc-host.js (Freenet design 3, 3.1;
// D-06/D-09), the way engine/pty-remote.js is to electron/pty-host.js: the
// same API and the same events as RtcHost, but every call becomes a BACKEND_*
// frame sent to the host, which owns the peer connections, and every event
// arrives as a frame through handleFrame(). The worker gets one only through
// engine/backends/index.js::rtcRemote, and only when the host said it has the
// adapter (the `rtc` host capability).
const { EventEmitter } = require('events')

const { FrameKind } = require('../../rpc/schema')

function key(connId, chanId) {
  return `${connId}:${chanId}`
}

class RtcRemote extends EventEmitter {
  // `send(kind, id, body)` writes one frame and returns the pipe's write
  // result: false means the pipe is full.
  constructor(send) {
    super()
    this._send = send
    // key -> { connId, chanId, host, pipe }: a channel is paused while the
    // host says so (BACKEND_FLOW) or while the pipe it last wrote to is full.
    this._flow = new Map()
  }

  open(connId, { iceServers } = {}) {
    this._send(FrameKind.BACKEND_OPEN, 0, { connId, iceServers: iceServers || null })
  }

  // A remote description or candidate, already checked by the caller.
  signal(connId, msg = {}) {
    this._send(FrameKind.BACKEND_SIGNAL, 0, {
      connId,
      type: msg.type,
      sdp: msg.sdp || null,
      candidate: msg.candidate || null,
      mid: msg.mid === undefined || msg.mid === null ? null : String(msg.mid)
    })
  }

  openChannel(connId, chanId, label) {
    this._send(FrameKind.BACKEND_CHANNEL, 0, { connId, chanId, label: label || null, op: 'open' })
  }

  closeChannel(connId, chanId) {
    this._flow.delete(key(connId, chanId))
    this._send(FrameKind.BACKEND_CHANNEL, 0, { connId, chanId, label: null, op: 'closed' })
  }

  // RtcHost.send's answer, as far as the worker can know it: false while the
  // host has paused the channel or the pipe is full; `flow` says when to go on.
  send(connId, chanId, data) {
    const written = this._send(FrameKind.BACKEND_DATA, 0, {
      connId,
      chanId,
      data: Buffer.isBuffer(data) ? data : Buffer.from(data)
    })
    const flow = this._flowOf(connId, chanId)
    if (written === false && !flow.pipe) {
      flow.pipe = true
      if (!flow.host) this.emit('flow', { connId, chanId, paused: true })
    }
    return !flow.host && !flow.pipe
  }

  close(connId, reason) {
    this._forget(connId)
    this._send(FrameKind.BACKEND_CLOSE, 0, { connId, reason: reason || null })
  }

  // The frames the host sends (host -> worker). Returns false for a kind that
  // is not one of them.
  handleFrame(frame) {
    const body = frame.body
    switch (frame.kind) {
      case FrameKind.BACKEND_SIGNAL:
        this.emit('signal', body)
        return true
      case FrameKind.BACKEND_STATE:
        this.emit('state', body)
        return true
      case FrameKind.BACKEND_CHANNEL:
        if (body.op === 'closed') this._flow.delete(key(body.connId, body.chanId))
        this.emit('channel', body)
        return true
      case FrameKind.BACKEND_DATA:
        this.emit('data', body)
        return true
      case FrameKind.BACKEND_FLOW: {
        const flow = this._flowOf(body.connId, body.chanId)
        const was = flow.host || flow.pipe
        flow.host = !!body.paused
        if ((flow.host || flow.pipe) !== was) {
          this.emit('flow', { connId: body.connId, chanId: body.chanId, paused: !was })
        }
        return true
      }
      case FrameKind.BACKEND_CLOSE:
        this._forget(body.connId)
        this.emit('close', body)
        return true
      default:
        return false
    }
  }

  // The pipe drained (engine/worker.js): every channel that stopped on a full
  // pipe, and is not paused by the host, may go on.
  handleDrain() {
    for (const flow of this._flow.values()) {
      if (!flow.pipe) continue
      flow.pipe = false
      if (!flow.host) this.emit('flow', { connId: flow.connId, chanId: flow.chanId, paused: false })
    }
  }

  _flowOf(connId, chanId) {
    const k = key(connId, chanId)
    let flow = this._flow.get(k)
    if (!flow) {
      flow = { connId, chanId, host: false, pipe: false }
      this._flow.set(k, flow)
    }
    return flow
  }

  _forget(connId) {
    for (const [k, flow] of this._flow) if (flow.connId === connId) this._flow.delete(k)
  }
}

module.exports = RtcRemote
