// Probe P-1: the Freenet TypeScript SDK under Bare. Run: bare spikes/freenet/p1-bare.js [port]
require('./lib/bare-shims')
const fs = require('bare-fs')
const path = require('bare-path')
const run = require('./p12-core')

const wasm = new Uint8Array(
  fs.readFileSync(path.join(__dirname, 'contracts/signalling/target/wasm32-unknown-unknown/release/zbterm_signalling.wasm'))
)
const port = Number(Bare.argv[2] || 7519)
run({ wasm, port, runtime: `bare ${Bare.version}`, nonce: `${Date.now()}-bare` })
  .then((out) => {
    console.log(JSON.stringify(out, null, 2))
    Bare.exit(0)
  })
  .catch((err) => {
    console.log('P-1 FAILED:', err && err.stack ? err.stack : err)
    Bare.exit(1)
  })
