// The Freenet backend between two machines, with the shipped code and no
// SessionEngine (docs/projects/260924_freenet-backend/plan.md, F9 step 7; R-13,
// A-15). Each side is a FreenetBackend with an in-process
// electron/rtc-host.js RtcHost (A-8) and the default ICE servers (D-11),
// talking to the Freenet node at `nodeUrl`.
//
//   node test/tools/freenet-remote-pair.js host <nodeUrl>
//     announces one link and prints `INVITE <base64 JSON>` on stdout; answers
//     every offer, echoes every message on the echo channel, and serves a
//     4 MiB Hypercore log as the connection's history. Exits when the viewer's
//     connection closes, or after HOST_CAP_MS.
//   node test/tools/freenet-remote-pair.js viewer <nodeUrl> <invite>
//     dials the link, opens the echo channel, sends ECHO_COUNT messages and
//     waits for every echo, attaches the history and fetches all of it, and
//     prints `RESULT <JSON>`: dial -> connected, the selected candidate pair
//     (types and transport only, never an address), the echo round trip, and
//     the history MiB/s. Exits by itself after VIEWER_CAP_MS whatever happens.
//
// A measurement tool, not a test: nothing here is gated. It runs under Node
// (the backend under Bare is covered by test/backends/freenet-bare.test.js and
// the GUI proof).
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Hypercore = require('hypercore')

const FreenetBackend = require('../../engine/backends/freenet')
const { RtcHost } = require('../../electron/rtc-host')
const { transportKeyPair } = require('../../engine/crypto')

const LINK_ID = 'f9-remote-pair'
const ECHO_PROTOCOL = 'zbterm/f9-echo'
const ECHO_ID = Buffer.from('echo')
const ECHO_COUNT = 1000
const HISTORY_BYTES = 4 * 1024 * 1024
const BLOCK_BYTES = 16 * 1024
// Generous: between nodes of different versions a signalling update took
// minutes to propagate (docs/projects/260924_freenet-backend/measurements.md,
// F9).
const HOST_CAP_MS = 20 * 60 * 1000
const VIEWER_CAP_MS = 15 * 60 * 1000

const now = () => performance.now()
const log = (...args) => console.error(`[${new Date().toISOString()}]`, ...args)

function percentile(values, p) {
  if (!values.length) return null
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

function round(n) {
  return n === null ? null : Math.round(n * 100) / 100
}

// The selected pair of the only peer connection this RtcHost holds.
function candidatePair(rtc) {
  for (const conn of rtc.conns.values()) {
    try {
      const pair = conn.pc.getSelectedCandidatePair()
      if (!pair) return null
      const end = (c) => (c ? { type: c.type, transport: c.transportType || c.protocol } : null)
      return { local: end(pair.local), remote: end(pair.remote) }
    } catch {
      return null
    }
  }
  return null
}

function scratchDir(role) {
  const base = process.env.ZBTERM_PAIR_TMP || os.tmpdir()
  return fs.promises.mkdtemp(path.join(base, `zbterm-remote-pair-${role}-`))
}

async function start(nodeUrl, rtc) {
  rtc.on('channel', (body) => log('rtc channel', JSON.stringify(body)))
  rtc.on('flow', (body) => log('rtc flow', JSON.stringify(body)))
  const backend = new FreenetBackend({ nodeUrl, rtcHost: rtc })
  backend.on('debug', ({ event, details }) => {
    if (
      /connected|announce|answer|offer|refused|lost|failed|node:|get-miss|subscribed/.test(event)
    ) {
      log(event, JSON.stringify(details))
    }
  })
  const keyPair = transportKeyPair()
  await backend.start({ keyPair: () => keyPair })
  return backend
}

async function host(nodeUrl) {
  const dir = await scratchDir('host')
  const store = { log: new Hypercore(path.join(dir, 'log')), metaCore: null }
  store.metaCore = new Hypercore(path.join(dir, 'meta'))
  await store.log.ready()
  await store.metaCore.ready()
  const blocks = HISTORY_BYTES / BLOCK_BYTES
  const batch = []
  for (let i = 0; i < blocks; i++) {
    const block = crypto.randomBytes(BLOCK_BYTES)
    block.writeUInt32LE(i, 0)
    batch.push(block)
  }
  await store.log.append(batch)
  await store.metaCore.append(Buffer.from('meta-0'))

  const rtc = new RtcHost()
  const backend = await start(nodeUrl, rtc)
  backend.setAdmission(true)
  let finish
  const done = new Promise((resolve) => (finish = resolve))
  const cap = setTimeout(() => finish('cap'), HOST_CAP_MS)
  backend.on('connection', (conn) => {
    log('connection', JSON.stringify({ path: conn.path(), pair: candidatePair(rtc) }))
    conn.onChannel(ECHO_PROTOCOL, (id) => {
      const channel = conn.openChannel(ECHO_PROTOCOL, id, {
        onmessage: (message) => channel.send(message),
        onclose: () => {}
      })
    })
    backend.serveHistory(conn, store)
    conn.on('close', () => finish('viewer closed'))
  })
  const announced = now()
  const { route } = await backend.announce(LINK_ID)
  log('announced in', Math.round(now() - announced), 'ms')
  const invite = {
    route,
    hostKey: Buffer.from(backend.localPeerKey()).toString('hex'),
    logKey: store.log.key.toString('hex'),
    metaKey: store.metaCore.key.toString('hex'),
    length: store.log.length
  }
  console.log(`INVITE ${Buffer.from(JSON.stringify(invite)).toString('base64')}`)
  const why = await done
  clearTimeout(cap)
  log('host done:', why)
  await backend.stop()
  rtc.closeAll('done')
  await store.log.close()
  await store.metaCore.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
  RtcHost.cleanup()
}

async function viewer(nodeUrl, inviteText) {
  const invite = JSON.parse(Buffer.from(inviteText, 'base64').toString('utf8'))
  const dir = await scratchDir('viewer')
  const store = {
    log: new Hypercore(path.join(dir, 'log'), Buffer.from(invite.logKey, 'hex')),
    metaCore: new Hypercore(path.join(dir, 'meta'), Buffer.from(invite.metaKey, 'hex'))
  }
  await store.log.ready()
  await store.metaCore.ready()
  const rtc = new RtcHost()
  const backend = await start(nodeUrl, rtc)
  const result = { ok: false }

  const d0 = now()
  const dial = backend.dial(invite.route, Buffer.from(invite.hostKey, 'hex'))
  const conn = await dial.connected
  result.dialToConnectedMs = Math.round(now() - d0)
  result.path = conn.path()
  result.candidatePair = candidatePair(rtc)
  log('connected', JSON.stringify(result))

  // Echo: every message sent at once, each timed from send to its echo.
  const sentAt = new Map()
  const rtts = []
  let inOrder = true
  let expected = 0
  const e0 = now()
  const echoed = new Promise((resolve) => {
    const channel = conn.openChannel(ECHO_PROTOCOL, ECHO_ID, {
      onmessage: (message) => {
        if (message.n !== expected) inOrder = false
        expected = message.n + 1
        rtts.push(now() - sentAt.get(message.n))
        if (rtts.length === ECHO_COUNT) resolve()
      },
      onclose: () => {}
    })
    for (let n = 0; n < ECHO_COUNT; n++) {
      sentAt.set(n, now())
      channel.send({ n, pad: 'x'.repeat(64) })
    }
  })
  await echoed
  const echoMs = now() - e0
  result.echo = {
    messages: ECHO_COUNT,
    totalMs: Math.round(echoMs),
    perSecond: Math.round((ECHO_COUNT / echoMs) * 1000),
    rttP50Ms: round(percentile(rtts, 50)),
    rttP95Ms: round(percentile(rtts, 95)),
    inOrder
  }
  log('echo', JSON.stringify(result.echo))

  // History: the whole 4 MiB log.
  const h0 = now()
  let firstBlockMs = null
  store.log.on('download', () => {
    if (firstBlockMs === null) firstBlockMs = now() - h0
  })
  const progress = setInterval(() => {
    log(
      'history progress',
      JSON.stringify({ blocks: store.log.contiguousLength, of: invite.length })
    )
  }, 5000)
  const handle = backend.attachHistory(conn, store, {
    logKey: invite.logKey,
    metaKey: invite.metaKey
  })
  await handle.fetch({ start: 0, end: invite.length }).done()
  const historyMs = now() - h0
  clearInterval(progress)
  const last = await store.log.get(invite.length - 1, { wait: false })
  handle.close()
  result.history = {
    bytes: invite.length * BLOCK_BYTES,
    blocks: invite.length,
    ms: Math.round(historyMs),
    firstBlockMs: firstBlockMs === null ? null : Math.round(firstBlockMs),
    mibPerSecond: round((invite.length * BLOCK_BYTES) / (1024 * 1024) / (historyMs / 1000)),
    lastBlockOk: !!last && last.readUInt32LE(0) === invite.length - 1
  }
  result.ok = result.echo.inOrder && result.history.lastBlockOk
  console.log(`RESULT ${JSON.stringify(result)}`)

  conn.close('done')
  await backend.stop()
  rtc.closeAll('done')
  await store.log.close()
  await store.metaCore.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
  RtcHost.cleanup()
}

function main() {
  const [role, nodeUrl, invite] = process.argv.slice(2)
  if (!['host', 'viewer'].includes(role) || !nodeUrl || (role === 'viewer' && !invite)) {
    console.error('usage: freenet-remote-pair.js host <nodeUrl> | viewer <nodeUrl> <invite>')
    process.exit(2)
  }
  // Whatever happens, a role ends by itself (the remote runs unattended).
  const cap = setTimeout(
    () => {
      console.error(`${role}: cap reached, exiting`)
      process.exit(3)
    },
    (role === 'host' ? HOST_CAP_MS : VIEWER_CAP_MS) + 30 * 1000
  )
  cap.unref()
  const run = role === 'host' ? host(nodeUrl) : viewer(nodeUrl, invite)
  run.then(
    () => process.exit(0),
    (err) => {
      console.error(`${role} failed:`, err && err.stack ? err.stack : err)
      process.exit(1)
    }
  )
}

main()
