// Bare-worker fixture for test/zxterm-seam.test.js (K7, spike S3): runs
// `engine/zxterm/client.js`'s `SeamClient` under a real Bare runtime (this
// phase's own Goal: "a 16 MiB flood from `test.flood` to a client running
// under Bare recovers within the same latency-ratio bound..."), spawned by
// the test via `bare-sidecar` exactly as `engine/spawn-worker.js` spawns
// ZBTerm's real worker. Talks back to the Node test process over
// `Bare.IPC` with newline-delimited JSON - a small protocol of this test
// fixture's own, not ZBTerm's production `engine/rpc/` framing (nothing
// here is production code).
//
// argv: [profileDir, zxtermCoreBinPath]
//
// Supplies `SeamClient`'s injected `spawn` function: process spawning is a
// host capability with no adapter contract in the core
// (`engine/zxterm/client.js`'s own header comment, `test/core-boundary.
// test.js`), so `SeamClient` never spawns itself. This file is the "host"
// standing in for whatever K9 wires up for real, and it is not under
// `engine/`, so it is free to name `bare-subprocess`/`child_process`
// directly - the exact swap `bare-sidecar`'s own `package.json` declares
// for the same need.
globalThis.process = require('bare-process')

function spawnSidecar(bin, args) {
  if (typeof Bare === 'undefined') {
    const { spawn } = require('child_process')
    return spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  }
  const { spawn } = require('bare-subprocess')
  return spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
}

const { SeamClient } = require('../../engine/zxterm/client')

function send(obj) {
  Bare.IPC.write(Buffer.from(`${JSON.stringify(obj)}\n`))
}

function readCommands(onCommand) {
  let buf = Buffer.alloc(0)
  Bare.IPC.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      const nl = buf.indexOf(0x0a)
      if (nl === -1) break
      const line = buf.subarray(0, nl).toString('utf8')
      buf = buf.subarray(nl + 1)
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch (err) {
        send({ type: 'error', message: `bad command JSON: ${err.message}` })
        continue
      }
      onCommand(msg)
    }
  })
}

const profile = Bare.argv[2]
const bin = Bare.argv[3]

const client = new SeamClient({ profile, bin, spawn: spawnSidecar })

client.on('output', ({ stream, bytes }) => {
  send({ type: 'output', stream, length: bytes.length })
})
client.on('event', ({ name, data }) => {
  send({ type: 'event', name, data })
})
client.on('error', (err) => {
  send({ type: 'client-error', message: err.message, code: err.code })
})

async function main() {
  try {
    await client.start()
    send({ type: 'ready' })
  } catch (err) {
    send({ type: 'fatal', message: err.message, code: err.code })
    Bare.exit(1)
    return
  }

  readCommands(async (msg) => {
    if (msg.type === 'request') {
      const t0 = Date.now()
      try {
        const result = await client.request(msg.method, msg.args)
        send({ type: 'reply', id: msg.id, ok: true, result, ms: Date.now() - t0 })
      } catch (err) {
        send({
          type: 'reply',
          id: msg.id,
          ok: false,
          code: err.code,
          message: err.message,
          ms: Date.now() - t0
        })
      }
      return
    }
    if (msg.type === 'close') {
      await client.close()
      send({ type: 'closed' })
      setTimeout(() => Bare.exit(0), 20)
    }
  })
}

main()
