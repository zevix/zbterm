// Probe P-3 (Bare half, shimmed): node-datachannel's JS wrapper needs Node's `fs`/`path`, but
// its Node-API binding loads under Bare when required by file path. This drives the raw
// binding: loopback data channel + remote DTLS fingerprint.
// Run: bare spikes/freenet/p3-bare-ndc.js
require('./lib/bare-shims')
const path = require('bare-path')
const ndc = require(path.join(__dirname, 'node_modules/@node-datachannel/linux-x64-gnu/node_datachannel.node'))

const t0 = Date.now()
const a = new ndc.PeerConnection('a', { iceServers: [] })
const b = new ndc.PeerConnection('b', { iceServers: [] })
let remoteSdpAtA = ''
a.onLocalDescription((sdp, type) => b.setRemoteDescription(sdp, type))
a.onLocalCandidate((c, mid) => b.addRemoteCandidate(c, mid))
b.onLocalDescription((sdp, type) => { remoteSdpAtA = sdp; a.setRemoteDescription(sdp, type) })
b.onLocalCandidate((c, mid) => a.addRemoteCandidate(c, mid))

const fail = setTimeout(() => {
  console.log(JSON.stringify({ lib: 'node-datachannel (raw binding)', runtime: `bare ${Bare.version}`, failure: 'no open data channel within 15 s' }))
  Bare.exit(1)
}, 15000)

// Two checks per direction: a text frame, and a binary frame whose bytes are inspected on
// arrival (the first run echoed four zero bytes, so binary marshalling is measured apart).
const seen = { textAtB: null, binaryAtB: null }
b.onDataChannel((dc) => {
  dc.onMessage((m) => {
    if (typeof m === 'string') { seen.textAtB = m; return }
    const bytes = Buffer.from(m)
    seen.binaryAtB = { type: Object.prototype.toString.call(m), length: bytes.length, hex: bytes.toString('hex') }
    dc.sendMessageBinary(Buffer.from('pong'))
  })
})
const dcA = a.createDataChannel('probe')
dcA.onOpen(() => {
  const openMs = Date.now() - t0
  dcA.onMessage((m) => {
    clearTimeout(fail)
    const fp = a.remoteFingerprint()
    const sdp = /a=fingerprint:(\S+) (\S+)/i.exec(remoteSdpAtA)
    console.log(JSON.stringify({
      lib: 'node-datachannel (raw binding)',
      runtime: `bare ${Bare.version}`,
      channelOpenMs: openMs,
      seenAtB: seen,
      binaryAtA: { type: Object.prototype.toString.call(m), hex: Buffer.from(m).toString('hex'), expectedHex: Buffer.from('pong').toString('hex') },
      remoteFingerprintViaApi: `${fp.algorithm} ${fp.value.slice(0, 23)}...`,
      apiMatchesSdp: !!sdp && sdp[2].toUpperCase() === fp.value.toUpperCase()
    }))
    dcA.close(); a.close(); b.close()
    if (ndc.cleanup) ndc.cleanup()
    setTimeout(() => Bare.exit(0), 200)
  })
  dcA.sendMessage('text-ping')
  dcA.sendMessageBinary(Buffer.from('ping'))
})
