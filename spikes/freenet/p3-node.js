// Probe P-3 (Node half): which WebRTC library loads, opens a loopback data channel, and
// exposes the remote DTLS fingerprint. Run: node spikes/freenet/p3-node.js
const { libs } = require('./lib/rtc')

;(async () => {
  const rows = []
  for (const name of Object.keys(libs)) {
    const row = { lib: name, version: JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'node_modules', name, 'package.json'))).version }
    try {
      const t = performance.now()
      require(name)
      row.loadMs = Math.round(performance.now() - t)
      const pair = await libs[name]()
      row.channelOpenMs = Math.round(pair.openMs)
      const got = new Promise((resolve) => pair.b.onMessage((m) => resolve(m.toString())))
      pair.a.send(Buffer.from('ping'))
      row.echo = await Promise.race([got, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))])
      const fa = pair.a.remoteFingerprint()
      const fb = pair.b.remoteFingerprint()
      row.remoteFingerprintViaApi = fa.api && !fa.api.error ? `${fa.api.algorithm} ${String(fa.api.value).slice(0, 23)}...` : fa.api
      row.apiPath = fa.api && fa.api.from
      row.remoteFingerprintViaSdp = fa.sdp ? `${fa.sdp.algorithm} ${fa.sdp.value.slice(0, 23)}...` : null
      row.apiMatchesSdp = !!(fa.api && fa.sdp && String(fa.api.value).toUpperCase() === fa.sdp.value) &&
        !!(fb.api && fb.sdp && String(fb.api.value).toUpperCase() === fb.sdp.value)
      row.maxMessageSize = pair.a.maxMessageSize()
      pair.a.close()
      pair.b.close()
      pair.cleanup()
    } catch (err) {
      row.failure = err.message
    }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
  setTimeout(() => process.exit(0), 200)
})()
