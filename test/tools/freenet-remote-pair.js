// The Freenet backend between two machines, with the shipped code and no
// SessionEngine (docs/projects/260924_freenet-backend/plan.md, F9 step 7; R-13,
// A-15). Each side is a FreenetBackend and the default ICE servers (D-11),
// talking to the Freenet node at `nodeUrl`. Since K11 of zxterm-core (ZBTerm
// D-34) the backend is a proxy to a Rust zxterm-core sidecar of its own
// (started through electron/zxterm-core-host.js, as the app does), which runs
// WebRTC; the selected candidate pair is no longer visible from here, so the
// result reports the connection's path() only.
//
//   node test/tools/freenet-remote-pair.js host <nodeUrl>
//     announces one link and prints `INVITE <base64 JSON>` on stdout; answers
//     every offer and echoes every message on the echo channel. Exits when
//     the viewer's connection closes, or after HOST_CAP_MS.
//   node test/tools/freenet-remote-pair.js viewer <nodeUrl> <invite>
//     dials the link, opens the echo channel, sends ECHO_COUNT messages and
//     waits for every echo, and prints `RESULT <JSON>`: dial -> connected, the
//     connection's path and the echo round trip. Exits by itself after
//     VIEWER_CAP_MS whatever happens. (K17 of zxterm-core, ZBTerm D-40: the
//     history leg this tool had, a Hypercore log over the connection, is gone
//     with that replication; a session's history is the core's and needs a
//     session, not a bare connection.)
//
// A measurement tool, not a test: nothing here is gated. It runs under Node
// (the backend under Bare is covered by test/backends/freenet-bare.test.js and
// the GUI proof).

const FreenetBackend = require('../../engine/backends/freenet')
const { setCoreHost } = require('../../engine/zxterm/core')
const { transportKeyPair } = require('../../engine/crypto')

setCoreHost(require('../../electron/zxterm-core-host'))

const LINK_ID = 'f9-remote-pair'
const ECHO_PROTOCOL = 'zbterm/f9-echo'
const ECHO_ID = Buffer.from('echo')
const ECHO_COUNT = 1000
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

async function start(nodeUrl) {
  const backend = new FreenetBackend({ nodeUrl })
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
  const backend = await start(nodeUrl)
  backend.setAdmission(true)
  let finish
  const done = new Promise((resolve) => (finish = resolve))
  const cap = setTimeout(() => finish('cap'), HOST_CAP_MS)
  backend.on('connection', (conn) => {
    log('connection', JSON.stringify({ path: conn.path() }))
    conn.onChannel(ECHO_PROTOCOL, (id) => {
      const channel = conn.openChannel(ECHO_PROTOCOL, id, {
        onmessage: (message) => channel.send(message),
        onclose: () => {}
      })
    })
    conn.on('close', () => finish('viewer closed'))
  })
  const announced = now()
  const { route } = await backend.announce(LINK_ID)
  log('announced in', Math.round(now() - announced), 'ms')
  const invite = {
    route,
    hostKey: Buffer.from(backend.localPeerKey()).toString('hex')
  }
  console.log(`INVITE ${Buffer.from(JSON.stringify(invite)).toString('base64')}`)
  const why = await done
  clearTimeout(cap)
  log('host done:', why)
  await backend.stop()
}

async function viewer(nodeUrl, inviteText) {
  const invite = JSON.parse(Buffer.from(inviteText, 'base64').toString('utf8'))
  const backend = await start(nodeUrl)
  const result = { ok: false }

  const d0 = now()
  const dial = backend.dial(invite.route, Buffer.from(invite.hostKey, 'hex'))
  const conn = await dial.connected
  result.dialToConnectedMs = Math.round(now() - d0)
  result.path = conn.path()
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

  result.ok = result.echo.inOrder
  console.log(`RESULT ${JSON.stringify(result)}`)

  conn.close('done')
  await backend.stop()
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
