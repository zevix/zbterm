// Probes P-1 / P-2 body: SDK round trip (Put, Get, Subscribe, Update -> notification).
// Runtime-neutral: the launcher passes { wasm, port, runtime, nonce }.
const f = require('./lib/fnet')

module.exports = async function run({ wasm, port, runtime, nonce }) {
  const params = f.enc({ ttl_ms: 120000, n: nonce })
  const { key, id } = f.contractKey(wasm, params)
  const out = { runtime, port, contract: id, wasmBytes: wasm.length }

  const waiters = []
  const sub = await f.connect(port, {
    notification: (n) => {
      const at = f.now()
      for (const e of f.notificationEntries(n)) {
        const w = waiters[e.s]
        if (w) w(at)
      }
    }
  })
  const pub = await f.connect(port)
  out.wsOpenMs = [sub.openMs, pub.openMs].map((x) => Math.round(x * 100) / 100)

  const stage = (s) => process.env.PROBE_VERBOSE && console.log('stage:', s)
  let t = f.now()
  await pub.api.put(f.putRequest(wasm, params, f.enc({ e: [] })))
  out.putMs = Math.round((f.now() - t) * 100) / 100

  stage('put done')
  const gets = []
  for (let i = 0; i < 20; i++) {
    t = f.now()
    const res = await sub.api.get(new f.sdk.GetRequest(key, false))
    gets.push(f.now() - t)
    if (i === 0) out.getStateBytes = res.state.length
  }
  out.getMs = f.stats(gets)
  stage('gets done')

  t = f.now()
  await sub.subscribe(key)
  out.subscribeMs = Math.round((f.now() - t) * 100) / 100

  stage('subscribed')
  const updates = []
  const notifs = []
  for (let i = 0; i < 20; i++) {
    const seen = new Promise((resolve, reject) => {
      waiters[i] = resolve
      setTimeout(() => reject(new Error(`no notification for seq ${i} within 10 s`)), 10000)
    })
    const entry = { l: 'p12', r: 'host', s: i, t: Date.now(), d: false, p: 'x'.repeat(256) }
    t = f.now()
    await pub.api.update(f.deltaUpdate(key, f.enc({ e: [entry] })))
    updates.push(f.now() - t)
    notifs.push((await seen) - t)
  }
  out.updateAckMs = f.stats(updates)
  out.updateToNotificationMs = f.stats(notifs)

  const final = await sub.api.get(new f.sdk.GetRequest(key, false))
  out.finalEntries = f.dec(final.state).e.length
  return out
}
