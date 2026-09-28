// Probe P-4: (a) contract put -> subscriber notification latency, 200 updates at 1, 5 and
// 20 Hz; (b) full offer -> answer -> connected time with every SDP/ICE message carried through
// the signalling contract. Run: node spikes/freenet/p4.js [port] [rates, e.g. 1,5,20] [count]
const fs = require('fs')
const path = require('path')
const f = require('./lib/fnet')
const { libs } = require('./lib/rtc')

const port = Number(process.argv[2] || 7519)
const rates = (process.argv[3] || '1,5,20').split(',').map(Number)
const count = Number(process.argv[4] || 200)
const wasm = new Uint8Array(
  fs.readFileSync(path.join(__dirname, 'contracts/signalling/target/wasm32-unknown-unknown/release/zbterm_signalling.wasm'))
)

async function freshContract(tag) {
  const params = f.enc({ ttl_ms: 120000, n: `${tag}-${Date.now()}-${process.pid}` })
  const { key, id } = f.contractKey(wasm, params)
  const pub = await f.connect(port)
  await pub.api.put(f.putRequest(wasm, params, f.enc({ e: [] })))
  return { key, id, pub }
}

async function latency(hz) {
  const { key, id, pub } = await freshContract(`p4-${hz}hz`)
  const sent = new Map()
  const samples = []
  let notifBytes = 0
  const variants = {}
  let notifs = 0
  let done
  const all = new Promise((resolve) => (done = resolve))
  const sub = await f.connect(port, {
    notification: (n) => {
      const at = f.now()
      const u = n.update.updateData
      notifBytes += ((u.delta && u.delta.length) || 0) + ((u.state && u.state.length) || 0)
      notifs++
      const variant = f.sdk.UpdateDataType[n.update.updateDataType]
      variants[variant] = (variants[variant] || 0) + 1
      for (const e of f.notificationEntries(n)) {
        const t = sent.get(e.s)
        if (t === undefined) continue
        sent.delete(e.s)
        samples.push(at - t)
        if (samples.length === count) done()
      }
    }
  })
  await sub.subscribe(key)
  let updateErrors = 0
  const started = f.now()
  await new Promise((resolve) => {
    let i = 0
    const tick = () => {
      const entry = { l: 'p4', r: 'host', s: i, t: Date.now(), d: false, p: 'x'.repeat(64) }
      sent.set(i, f.now())
      pub.api.update(f.deltaUpdate(key, f.enc({ e: [entry] }))).catch(() => updateErrors++)
      if (++i === count) { clearInterval(timer); resolve() }
    }
    const timer = setInterval(tick, 1000 / hz)
    tick()
  })
  await Promise.race([all, new Promise((resolve) => setTimeout(resolve, 15000))])
  return {
    hz, contract: id, sent: count, notified: samples.length, lost: count - samples.length,
    updateErrors, wallS: Math.round((f.now() - started) / 100) / 10,
    notificationVariants: variants,
    avgNotificationBytes: notifs ? Math.round(notifBytes / notifs) : 0,
    putToNotificationMs: samples.length ? f.stats(samples) : null
  }
}

// Offer -> answer -> connected, each message a contract update the other side learns of only
// through its subscription. Two WebSocket clients, one per role, as two processes would have.
async function connectViaContract(libName) {
  const { key, id, pub: hostApi } = await freshContract(`p4-rtc-${libName}`)
  const deliverTo = { host: [], viewer: [] } // queue of deliver callbacks, in seq order, per reader
  const seen = { host: new Set(), viewer: new Set() }
  const pending = { host: new Map(), viewer: new Map() }
  const hops = []
  let closed = false
  const onNote = (reader) => (n) => {
    const at = f.now()
    for (const e of f.notificationEntries(n)) {
      if (e.r === reader || e.l !== 'link') continue // own entries
      if (seen[reader].has(e.s)) continue
      seen[reader].add(e.s)
      const p = pending[reader].get(e.s)
      if (p && !closed) {
        hops.push(at - p.t)
        try { p.deliver(JSON.parse(e.p)) } catch (err) { console.log('deliver failed:', err.message) }
      }
    }
  }
  const hostSub = await f.connect(port, { notification: onNote('host') })
  const viewer = await f.connect(port, { notification: onNote('viewer') })
  await hostSub.subscribe(key)
  await viewer.subscribe(key)
  const seq = { a: 0, b: 0 }
  const chain = { a: Promise.resolve(), b: Promise.resolve() }
  let messages = 0
  // route(): side 'a' is the host, 'b' the viewer. Updates of one writer are serialised,
  // because the SDK correlates update responses by contract key.
  const signal = (from, msg, deliver) => {
    const role = from === 'a' ? 'host' : 'viewer'
    const reader = from === 'a' ? 'viewer' : 'host'
    const s = seq[from]++
    const api = from === 'a' ? hostApi.api : viewer.api
    messages++
    chain[from] = chain[from].then(() => {
      pending[reader].set(s, { t: f.now(), deliver })
      const entry = { l: 'link', r: role, s, t: Date.now(), d: false, p: JSON.stringify(msg) }
      return api.update(f.deltaUpdate(key, f.enc({ e: [entry] }))).catch((err) => console.log('update failed:', err.message))
    })
  }
  const t0 = f.now()
  const pair = await libs[libName]({ signal })
  const totalMs = f.now() - t0
  closed = true
  pair.a.close(); pair.b.close(); pair.cleanup()
  return {
    lib: libName, contract: id, signallingMessages: messages,
    offerToConnectedMs: Math.round(totalMs), perHopMs: hops.length ? f.stats(hops) : null
  }
}

;(async () => {
  for (const hz of rates) console.log(JSON.stringify(await latency(hz)))
  for (const lib of ['node-datachannel', 'werift', '@roamhq/wrtc']) {
    try {
      console.log(JSON.stringify(await connectViaContract(lib)))
    } catch (err) {
      console.log(JSON.stringify({ lib, failure: err.message }))
    }
  }
  setTimeout(() => process.exit(0), 200)
})().catch((err) => {
  console.error('P-4 FAILED:', err.stack || err)
  process.exit(1)
})
