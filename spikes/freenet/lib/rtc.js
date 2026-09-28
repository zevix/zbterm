// A tiny common surface over the three WebRTC libraries, for probes P-3, P-4 and P-6.
// pair(lib) opens two in-process peers with no ICE servers (host candidates only), exchanges
// SDP/candidates through plain callbacks, and resolves once a data channel is open both ways.
// Each side is { send(buf), onMessage(fn), bufferedAmount(), close(), remoteFingerprint }.
// Throwaway spike code.
const now = () => performance.now()
const sdpFingerprint = (sdp) => {
  const m = /a=fingerprint:(\S+) (\S+)/i.exec(sdp || '')
  return m ? { algorithm: m[1].toLowerCase(), value: m[2].toUpperCase() } : null
}

// signal(from, msg) lets a caller route signalling through something slow (P-4).
async function pairNodeDatachannel({ signal, maxMessageSize } = {}) {
  const ndc = require('node-datachannel')
  const cfg = { iceServers: [] }
  if (maxMessageSize) cfg.maxMessageSize = maxMessageSize
  const a = new ndc.PeerConnection('a', cfg)
  const b = new ndc.PeerConnection('b', cfg)
  const remoteSdp = {}
  const route = signal || ((from, msg, deliver) => deliver(msg))
  const deliverTo = (pc, name) => (msg) => {
    if (msg.sdp) {
      remoteSdp[name] = msg.sdp
      pc.setRemoteDescription(msg.sdp, msg.type)
    } else pc.addRemoteCandidate(msg.candidate, msg.mid)
  }
  a.onLocalDescription((sdp, type) => route('a', { sdp, type }, deliverTo(b, 'b')))
  a.onLocalCandidate((candidate, mid) => route('a', { candidate, mid }, deliverTo(b, 'b')))
  b.onLocalDescription((sdp, type) => route('b', { sdp, type }, deliverTo(a, 'a')))
  b.onLocalCandidate((candidate, mid) => route('b', { candidate, mid }, deliverTo(a, 'a')))
  const t0 = now()
  const wrap = (pc, dc, name) => ({
    send: (buf) => dc.sendMessageBinary(buf),
    onMessage: (fn) => dc.onMessage((m) => fn(typeof m === 'string' ? Buffer.from(m) : Buffer.from(m))),
    bufferedAmount: () => dc.bufferedAmount(),
    onDrain: (low, fn) => {
      dc.setBufferedAmountLowThreshold(low)
      dc.onBufferedAmountLow(fn)
    },
    maxMessageSize: () => dc.maxMessageSize(),
    close: () => {
      try { dc.close() } catch {}
      try { pc.close() } catch {}
    },
    remoteFingerprint: () => ({ api: { ...pc.remoteFingerprint(), from: 'pc.remoteFingerprint()' }, sdp: sdpFingerprint(remoteSdp[name]) })
  })
  const opened = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('node-datachannel: no open data channel within 15 s')), 15000)
    let left = 2
    const sides = {}
    const done = () => { if (--left === 0) { clearTimeout(timer); resolve(sides) } }
    b.onDataChannel((dc) => { sides.b = wrap(b, dc, 'b'); if (dc.isOpen()) done(); else dc.onOpen(done) })
    const dcA = a.createDataChannel('probe')
    sides.a = wrap(a, dcA, 'a')
    dcA.onOpen(done)
  })
  return { ...opened, openMs: now() - t0, cleanup: () => ndc.cleanup && ndc.cleanup() }
}

// werift and @roamhq/wrtc both follow the W3C shape.
async function pairW3c(RTCPeerConnection, label, { signal } = {}) {
  const a = new RTCPeerConnection({ iceServers: [] })
  const b = new RTCPeerConnection({ iceServers: [] })
  const route = signal || ((from, msg, deliver) => deliver(msg))
  const onCandidate = (from, to) => (ev) => {
    if (ev && ev.candidate) route(from, { candidate: ev.candidate }, (m) => to.addIceCandidate(m.candidate).catch(() => {}))
  }
  a.onicecandidate = onCandidate('a', b)
  b.onicecandidate = onCandidate('b', a)
  const t0 = now()
  const wrap = (pc, dc) => ({
    send: (buf) => dc.send(buf),
    onMessage: (fn) => { dc.onmessage = (ev) => fn(Buffer.from(ev.data)) },
    bufferedAmount: () => dc.bufferedAmount,
    onDrain: (low, fn) => { dc.bufferedAmountLowThreshold = low; dc.onbufferedamountlow = fn },
    maxMessageSize: () => (pc.sctp && pc.sctp.maxMessageSize) || null,
    close: () => { try { dc.close() } catch {} try { pc.close() } catch {} },
    remoteFingerprint: () => {
      let api = null
      try {
        // werift keeps the verified remote parameters on its DTLS transport.
        const t = pc.dtlsTransports ? pc.dtlsTransports[0] : pc.sctp && pc.sctp.transport
        const fp = t && t.remoteParameters && t.remoteParameters.fingerprints
        if (fp && fp.length) api = { algorithm: fp[0].algorithm, value: String(fp[0].value).toUpperCase(), from: 'dtlsTransport.remoteParameters' }
        if (!api && t && typeof t.getRemoteCertificates === 'function') {
          const certs = t.getRemoteCertificates()
          if (certs && certs.length) {
            const der = Buffer.from(certs[0])
            const hex = require('crypto').createHash('sha256').update(der).digest('hex').toUpperCase()
            api = { algorithm: 'sha-256', value: hex.match(/../g).join(':'), from: 'getRemoteCertificates()' }
          }
        }
      } catch (err) {
        api = { error: err.message }
      }
      return { api, sdp: sdpFingerprint(pc.remoteDescription && pc.remoteDescription.sdp) }
    }
  })
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: no open data channel within 15 s`)), 15000)
    let left = 2
    const sides = {}
    const done = () => { if (--left === 0) { clearTimeout(timer); resolve(sides) } }
    b.ondatachannel = (ev) => {
      const dc = ev.channel
      dc.binaryType = 'arraybuffer'
      sides.b = wrap(b, dc)
      if (dc.readyState === 'open') done(); else dc.onopen = done
    }
    const dcA = a.createDataChannel('probe')
    dcA.binaryType = 'arraybuffer'
    sides.a = wrap(a, dcA)
    dcA.onopen = done
  })
  const offer = await a.createOffer()
  await a.setLocalDescription(offer)
  await new Promise((resolve) => route('a', { sdp: a.localDescription }, async (m) => { await b.setRemoteDescription(m.sdp); resolve() }))
  const answer = await b.createAnswer()
  await b.setLocalDescription(answer)
  await new Promise((resolve) => route('b', { sdp: b.localDescription }, async (m) => { await a.setRemoteDescription(m.sdp); resolve() }))
  const sides = await opened
  return { ...sides, openMs: now() - t0, cleanup: () => {} }
}

const libs = {
  'node-datachannel': (opts) => pairNodeDatachannel(opts),
  werift: (opts) => pairW3c(require('werift').RTCPeerConnection, 'werift', opts),
  '@roamhq/wrtc': (opts) => pairW3c(require('@roamhq/wrtc').RTCPeerConnection, '@roamhq/wrtc', opts)
}

module.exports = { libs, sdpFingerprint }
