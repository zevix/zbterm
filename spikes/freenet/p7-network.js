// Probe P-7 (plan F2): two network-mode nodes on two hosts. The host role puts a fresh
// instance of the probe signalling contract and answers; the viewer role, on the other node,
// polls Get until the instance is readable, measures put -> notification of the host's ack
// across the network, then opens a node-datachannel connection with every SDP/candidate
// message carried through the contract. One JSON object per measurement on stdout; exit 0.
// Throwaway spike code.
//
// Run: node spikes/freenet/p7-network.js host <port> <nonceB64> [rounds] [--ice <list>] [--cap-s N]
//      node spikes/freenet/p7-network.js viewer <port> <instanceId> [rounds] [--ice <list>] [--rates 1,5]
// --ice is a comma-separated list of ICE URLs; '' means host candidates only. Default: the
// Q-4 / D-11 list. Every latency is measured on one machine, so clock skew never enters.
const fs = require('fs')
const path = require('path')
const bs58 = require('bs58').default || require('bs58')
const f = require('./lib/fnet')
const { blake3 } = require('./lib/blake3')

const DEFAULT_ICE = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']
const TTL_MS = 120000

const argv = process.argv.slice(2)
const opts = { ice: DEFAULT_ICE, capS: 420, rates: [1, 5] }
const pos = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const take = (name) => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i])
  if (a.startsWith('--ice')) {
    const v = take('ice')
    opts.ice = v ? v.split(',').filter(Boolean) : []
  } else if (a.startsWith('--cap-s')) opts.capS = Number(take())
  else if (a.startsWith('--rates')) opts.rates = take().split(',').map(Number)
  else pos.push(a)
}
const [role, portArg, arg3, roundsArg] = pos
const port = Number(portArg || 7509)
const rounds = Number(roundsArg || 30)

// The raw WASM: the cargo output when present (this machine), else fdev's package with its
// 8 version bytes and 32-byte code hash stripped (the rsync to the remote excludes target/).
function loadWasm() {
  const dir = path.join(__dirname, 'contracts/signalling')
  const raw = path.join(dir, 'target/wasm32-unknown-unknown/release/zbterm_signalling.wasm')
  if (fs.existsSync(raw)) return { wasm: new Uint8Array(fs.readFileSync(raw)), from: 'target' }
  const pkg = new Uint8Array(fs.readFileSync(path.join(dir, 'build/freenet/zbterm_signalling')))
  const wasm = pkg.slice(40)
  const hash = Buffer.from(blake3(wasm)).toString('hex')
  if (hash !== Buffer.from(pkg.slice(8, 40)).toString('hex')) throw new Error('fdev package: code hash mismatch')
  return { wasm, from: 'build/freenet' }
}
const { wasm, from: wasmFrom } = loadWasm()

const t0 = f.now()
const r2 = (x) => Math.round(x * 100) / 100
const out = (m, obj) => console.log(JSON.stringify({ role, m, atMs: r2(f.now() - t0), ...obj }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const within = (p, ms, what) =>
  Promise.race([p, new Promise((resolve, reject) => setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms))])

// Addresses are classified, never printed: the JSON lands in the repo.
function addrClass(a) {
  if (!a) return 'unknown'
  if (a.includes(':')) {
    const l = a.toLowerCase()
    if (l.startsWith('fe80')) return 'v6-link-local'
    if (l.startsWith('fd7a:115c:a1e0')) return 'v6-tailscale'
    if (/^f[cd]/.test(l)) return 'v6-ula'
    if (l === '::1') return 'v6-loopback'
    return 'v6-public'
  }
  const [x, y] = a.split('.').map(Number)
  if (x === 10 || (x === 172 && y >= 16 && y < 32) || (x === 192 && y === 168)) return 'v4-private'
  if (x === 100 && y >= 64 && y < 128) return 'v4-cgnat-or-tailscale'
  if (x === 127) return 'v4-loopback'
  if (x === 169 && y === 254) return 'v4-link-local'
  return 'v4-public'
}
function candInfo(c) {
  const parts = String(c).replace(/^a=/, '').split(/\s+/)
  const typ = parts[parts.indexOf('typ') + 1]
  return { type: typ, transport: (parts[2] || '').toLowerCase(), addr: addrClass(parts[4]) }
}
function pairInfo(pc) {
  try {
    const p = pc.getSelectedCandidatePair()
    if (!p) return null
    const side = (s) => ({ type: s.type, transportType: s.transportType, addr: addrClass(s.address) })
    return { local: side(p.local), remote: side(p.remote) }
  } catch (err) {
    return { error: err.message }
  }
}
const tally = (list) => list.reduce((acc, c) => ((acc[`${c.type}/${c.addr}`] = (acc[`${c.type}/${c.addr}`] || 0) + 1), acc), {})

// Delivers one writer's 'rtc' entries in seq order, each once. Notifications carry the whole
// state (S-05 d), so every entry is seen many times.
function orderedReader(apply) {
  let next = 0
  const buf = new Map()
  return (e) => {
    if (e.s < next || buf.has(e.s)) return
    buf.set(e.s, JSON.parse(e.p))
    while (buf.has(next)) {
      const m = buf.get(next)
      buf.delete(next)
      next++
      apply(m)
    }
  }
}

// Each message is its own update, sent at once (no chaining on the response: a network
// node's update answer can be slow, and the SDK correlates answers by contract key only).
function rtcSender(api, key, who, counters) {
  let seq = 0
  return (msg) => {
    counters.messagesSent++
    const entry = { l: 'rtc', r: who, s: seq++, t: Date.now(), d: false, p: JSON.stringify(msg) }
    api.update(f.deltaUpdate(key, f.enc({ e: [entry] }))).catch(() => counters.updateErrors++)
  }
}

async function host() {
  const nonce = arg3
  if (!nonce) throw new Error('host needs <nonceB64>')
  const ndc = require('node-datachannel')
  const params = f.enc({ ttl_ms: TTL_MS, n: nonce })
  const { key, id } = f.contractKey(wasm, params)
  const acked = new Set()
  const counters = { messagesSent: 0, messagesReceived: 0, updateErrors: 0, ackUpdates: 0, hostErrors: [] }
  const localCands = []
  const remoteCands = []
  let pc = null
  let api = null
  let finished = false
  const finish = (why) => {
    if (finished) return
    finished = true
    out('hostDone', {
      why, instance: id, ackedEntries: acked.size, ...counters,
      selectedPair: pc ? pairInfo(pc) : null, pcRttMs: pc ? pc.rtt() : null,
      localCandidates: tally(localCands), remoteCandidates: tally(remoteCands)
    })
    try { pc && pc.close() } catch {}
    setTimeout(() => process.exit(0), 300)
  }
  let send = null
  const readRtc = orderedReader((m) => {
    counters.messagesReceived++
    if (m.sdp) {
      pc = new ndc.PeerConnection('host', { iceServers: opts.ice })
      pc.onLocalDescription((sdp, type) => send({ sdp, type }))
      pc.onLocalCandidate((candidate, mid) => {
        localCands.push(candInfo(candidate))
        send({ candidate, mid })
      })
      pc.onDataChannel((dc) => {
        dc.onMessage((msg) => {
          if (String(msg) === 'bye') return finish('viewer said bye')
          dc.sendMessageBinary(Buffer.isBuffer(msg) ? msg : Buffer.from(msg))
        })
      })
      pc.setRemoteDescription(m.sdp, m.type)
    } else if (pc) {
      remoteCands.push(candInfo(m.candidate))
      pc.addRemoteCandidate(m.candidate, m.mid)
    }
  })
  const onNote = (n) => {
    const acks = []
    for (const e of f.notificationEntries(n)) {
      if (e.r !== 'viewer') continue
      if (e.l === 'rtc') readRtc(e)
      else if (e.l.startsWith('lat') && !acked.has(`${e.l}/${e.s}`)) {
        acked.add(`${e.l}/${e.s}`)
        acks.push({ l: e.l, r: 'host', s: e.s, t: Date.now(), d: false, p: '' })
      }
    }
    if (acks.length) {
      counters.ackUpdates++
      api.update(f.deltaUpdate(key, f.enc({ e: acks }))).catch(() => counters.updateErrors++)
    }
  }
  const c = await f.connect(port, { notification: onNote, err: (e) => counters.hostErrors.push(String(e.cause).slice(0, 200)) })
  api = c.api
  send = rtcSender(api, key, 'host', counters)
  const tp = f.now()
  await within(api.put(f.putRequest(wasm, params, f.enc({ e: [] }))), 60000, 'put')
  const putMs = f.now() - tp
  const putDoneEpochMs = Date.now()
  const ts = f.now()
  let subscribeMs = null
  let subscribeError = null
  try {
    await c.subscribe(key)
    subscribeMs = r2(f.now() - ts)
  } catch (err) {
    subscribeError = err.message
  }
  out('host', {
    instance: id, port, wasmFrom, wasmBytes: wasm.length, ice: opts.ice, node: process.version,
    wsOpenMs: r2(c.openMs), putMs: r2(putMs), putDoneEpochMs, subscribeMs, subscribeError
  })
  setTimeout(() => finish(`cap ${opts.capS} s`), opts.capS * 1000)
}

async function viewer() {
  const instanceId = arg3
  if (!instanceId) throw new Error('viewer needs <instanceId>')
  const ndc = require('node-datachannel')
  const key = new f.sdk.ContractKey(bs58.decode(instanceId), blake3(wasm))
  const listeners = new Set()
  const hostErrors = []
  let notifications = 0
  let notificationBytes = 0
  const c = await f.connect(port, {
    notification: (n) => {
      const at = f.now()
      notifications++
      const u = n.update.updateData
      notificationBytes += ((u.delta && u.delta.length) || 0) + ((u.state && u.state.length) || 0)
      const entries = f.notificationEntries(n)
      for (const fn of listeners) fn(entries, at)
    },
    err: (e) => hostErrors.push(String(e.cause).slice(0, 200))
  })
  out('viewer', { instance: instanceId, port, wasmFrom, ice: opts.ice, node: process.version, wsOpenMs: r2(c.openMs), startEpochMs: Date.now() })

  // 1. Poll Get until the instance is readable: 1 s gap after a miss, 120 s cap.
  const tg = f.now()
  const attempts = []
  let firstGetMs = null
  let stateBytes = null
  while (f.now() - tg < 120000) {
    const ta = f.now()
    try {
      const res = await within(c.api.get(new f.sdk.GetRequest(key, true)), 35000, 'get')
      firstGetMs = f.now() - tg
      stateBytes = res.state ? res.state.length : null
      attempts.push({ ms: r2(f.now() - ta), ok: true })
      break
    } catch (err) {
      attempts.push({ ms: r2(f.now() - ta), error: err.message.slice(0, 120) })
      await sleep(1000)
    }
  }
  const misses = attempts.filter((a) => !a.ok).length
  out('firstGet', { firstGetMs: firstGetMs === null ? null : r2(firstGetMs), misses, found: firstGetMs !== null, stateBytes, readableEpochMs: firstGetMs === null ? null : Date.now(), attempts, hostErrors: hostErrors.splice(0) })
  if (firstGetMs === null) return exit()

  // 2. Subscribe (the fnet.js workaround: the ack is a PutResponse, S-05 a).
  const ts = f.now()
  try {
    await c.subscribe(key)
    out('subscribe', { subscribeMs: r2(f.now() - ts) })
  } catch (err) {
    out('subscribe', { subscribeMs: null, error: err.message })
  }

  // 3. Put -> notification of the host's ack, per rate. Own echo = own put -> own notification.
  for (const hz of opts.rates) {
    const l = `lat${hz}`
    const sent = new Map()
    const samples = []
    const echo = []
    const ownSeen = new Set()
    let updateErrors = 0
    let done
    const all = new Promise((resolve) => (done = resolve))
    const n0 = notifications
    const b0 = notificationBytes
    const fn = (entries, at) => {
      for (const e of entries) {
        if (e.l !== l) continue
        if (e.r === 'viewer' && sent.has(e.s) && !ownSeen.has(e.s)) {
          ownSeen.add(e.s)
          echo.push(at - sent.get(e.s))
        } else if (e.r === 'host' && sent.has(e.s)) {
          const t = sent.get(e.s)
          sent.set(e.s, -1)
          if (t >= 0) {
            samples.push(at - t)
            if (samples.length === rounds) done()
          }
        }
      }
    }
    listeners.add(fn)
    const started = f.now()
    for (let i = 0; i < rounds; i++) {
      const entry = { l, r: 'viewer', s: i, t: Date.now(), d: false, p: '' }
      sent.set(i, f.now())
      c.api.update(f.deltaUpdate(key, f.enc({ e: [entry] }))).catch(() => updateErrors++)
      await sleep(1000 / hz)
    }
    await Promise.race([all, sleep(20000)])
    listeners.delete(fn)
    const notes = notifications - n0
    out('latency', {
      hz, sent: rounds, acked: samples.length, lost: rounds - samples.length, updateErrors,
      wallS: r2((f.now() - started) / 1000),
      putToAckNotificationMs: samples.length ? f.stats(samples) : null,
      ownEchoMs: echo.length ? f.stats(echo) : null,
      notifications: notes, avgNotificationBytes: notes ? Math.round((notificationBytes - b0) / notes) : 0,
      samplesMs: samples.map(r2), hostErrors: hostErrors.splice(0)
    })
  }

  // 4. Offer -> connected through the contract, then 20 pings over the channel.
  const counters = { messagesSent: 0, messagesReceived: 0, updateErrors: 0 }
  const send = rtcSender(c.api, key, 'viewer', counters)
  const pc = new ndc.PeerConnection('viewer', { iceServers: opts.ice })
  const localCands = []
  const remoteCands = []
  const states = []
  const tr = f.now()
  pc.onStateChange((s) => states.push([s, r2(f.now() - tr)]))
  pc.onLocalDescription((sdp, type) => send({ sdp, type }))
  pc.onLocalCandidate((candidate, mid) => {
    localCands.push(candInfo(candidate))
    send({ candidate, mid })
  })
  const readRtc = orderedReader((m) => {
    counters.messagesReceived++
    if (m.sdp) pc.setRemoteDescription(m.sdp, m.type)
    else {
      remoteCands.push(candInfo(m.candidate))
      pc.addRemoteCandidate(m.candidate, m.mid)
    }
  })
  listeners.add((entries) => {
    for (const e of entries) if (e.l === 'rtc' && e.r === 'host') readRtc(e)
  })
  const dc = pc.createDataChannel('p7')
  let connectedMs = null
  let failure = null
  try {
    await within(new Promise((resolve) => dc.onOpen(resolve)), 30000, 'data channel open')
    connectedMs = f.now() - tr
  } catch (err) {
    failure = err.message
  }
  const rtc = {
    ice: opts.ice, offerToConnectedMs: connectedMs === null ? null : r2(connectedMs), failure,
    signallingMessages: counters.messagesSent + counters.messagesReceived, ...counters,
    selectedPair: connectedMs === null ? null : pairInfo(pc), states,
    localCandidates: tally(localCands), remoteCandidates: tally(remoteCands)
  }
  if (connectedMs === null) {
    out('rtc', { ...rtc, hostErrors: hostErrors.splice(0) })
    return exit()
  }
  const rtts = []
  let waiter = null
  dc.onMessage((msg) => waiter && waiter(msg))
  for (let i = 0; i < 20; i++) {
    const tp = f.now()
    const got = new Promise((resolve) => (waiter = resolve))
    dc.sendMessageBinary(Buffer.from(`ping ${i}`))
    try {
      await within(got, 5000, 'ping')
      rtts.push(f.now() - tp)
    } catch {}
    await sleep(100)
  }
  out('rtc', { ...rtc, pcRttMs: pc.rtt(), pings: 20, pongs: rtts.length, pingRttMs: rtts.length ? f.stats(rtts) : null, hostErrors: hostErrors.splice(0) })
  try { dc.sendMessage('bye') } catch {}
  await sleep(500)
  try { pc.close() } catch {}
  exit()
}

function exit() {
  out('exit', {})
  setTimeout(() => process.exit(0), 200)
}

;(role === 'host' ? host : role === 'viewer' ? viewer : () => Promise.reject(new Error('role must be host or viewer')))().catch((err) => {
  out('failure', { error: err.stack || String(err) })
  setTimeout(() => process.exit(1), 200)
})
