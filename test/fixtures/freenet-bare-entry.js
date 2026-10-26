// Bare sidecar entrypoint for test/backends/freenet-bare.test.js: proves the
// Freenet backend under the Bare the product ships. Since K11 of zxterm-core
// (ZBTerm D-34) the backend is a proxy to the Rust zxterm-core sidecar, so
// this is the proxy starting that sidecar from inside a Bare worker (through
// the host module, electron/zxterm-core-host.js, and bare-subprocess, as the
// real worker does) and reaching a local node through it. Spawned through
// engine/spawn-worker.js::spawnWorker with argv [nodeUrl, idleMs, coreHost,
// secretKeyHex, publicKeyHex]; writes one JSON line on Bare.IPC:
// { ok, health, routeOk, error, idleHealth, stopped }. With idleMs the node
// connection is left idle that long first (S-29, F9).
//
// The same three globals engine/worker.js installs before anything else.
globalThis.process = require('bare-process')
globalThis.navigator = globalThis.navigator || { userAgent: 'bare' }
globalThis.performance = globalThis.performance || { now: () => Date.now() }

const [nodeUrl, idle, coreHost, secretHex, publicHex] = Bare.argv.slice(2)
const idleMs = Number(idle) || 0

function reply(body) {
  Bare.IPC.write(JSON.stringify(body) + '\n')
}

async function main() {
  const { setCoreHost } = require('../../engine/zxterm/core')
  setCoreHost(require(coreHost))
  const FreenetBackend = require('../../engine/backends/freenet/index.js')
  const backend = new FreenetBackend({ nodeUrl, iceServers: [] })
  const keyPair = {
    publicKey: Buffer.from(publicHex, 'hex'),
    secretKey: Buffer.from(secretHex, 'hex')
  }
  await backend.start({ keyPair: () => keyPair })
  const health = backend.health()
  let idleHealth = null
  if (idleMs) {
    await new Promise((resolve) => setTimeout(resolve, idleMs))
    idleHealth = backend.health()
  }
  const route = await backend.routeFor('bare-link', null)
  const routeOk =
    typeof route.sig === 'string' &&
    /^[0-9a-f]{64}$/.test(route.code) &&
    route.params.host === publicHex
  await backend.stop()
  await backend.stop()
  return {
    ok: health.started === true && routeOk,
    health,
    routeOk,
    idleHealth,
    stopped: backend.health()
  }
}

main().then(reply, (err) =>
  reply({ ok: false, error: String((err && err.stack) || err), code: err && err.code })
)
