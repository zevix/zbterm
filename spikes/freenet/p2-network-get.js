// Probe P-2 (read-only half): open the WebSocket API of the user's network-mode node on 7509
// and Get a contract id that does not exist. Deliberately no Put: a Put on a network-mode node
// publishes the spike contract to the public network.
// Run: node spikes/freenet/p2-network-get.js [port]
const f = require('./lib/fnet')
const port = Number(process.argv[2] || 7509)
;(async () => {
  const c = await f.connect(port, { err: () => {} })
  const key = new f.sdk.ContractKey(f.contractKey(f.enc('zbterm-probe-missing'), f.enc(String(Date.now()))).key.bytes())
  const t = f.now()
  let result
  try {
    const res = await c.api.get(new f.sdk.GetRequest(key, false))
    result = `unexpected state, ${res.state.length} bytes`
  } catch (err) {
    result = `rejected: ${err.message}`
  }
  console.log(JSON.stringify({ port, wsOpenMs: Math.round(c.openMs * 100) / 100, getMissing: result, getMissingMs: Math.round(f.now() - t) }, null, 2))
  process.exit(0)
})().catch((err) => {
  console.error('FAILED:', err.message)
  process.exit(1)
})
