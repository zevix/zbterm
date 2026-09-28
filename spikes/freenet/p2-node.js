// Probe P-2: the Freenet TypeScript SDK under Node. Run: node spikes/freenet/p2-node.js [port]
const fs = require('fs')
const path = require('path')
const run = require('./p12-core')

const wasm = new Uint8Array(
  fs.readFileSync(path.join(__dirname, 'contracts/signalling/target/wasm32-unknown-unknown/release/zbterm_signalling.wasm'))
)
const port = Number(process.argv[2] || process.env.FREENET_PORT || 7519)
run({ wasm, port, runtime: `node ${process.version}`, nonce: `${Date.now()}-${process.pid}` })
  .then((out) => {
    console.log(JSON.stringify(out, null, 2))
    process.exit(0)
  })
  .catch((err) => {
    console.error('P-2 FAILED:', err && err.stack ? err.stack : err)
    process.exit(1)
  })
