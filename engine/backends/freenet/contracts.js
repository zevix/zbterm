// The contract code this build ships (design §5.2), as raw WASM bytes keyed by
// the hex BLAKE3 of those bytes: every signalling version (a link minted by
// one is served by it for its whole life) and the pointer record.
//
// contracts/<name>-v<n>.wasm is the raw `.wasm` a crate under contracts/src/
// compiles to, not the package `fdev build` writes (which prefixes 8 version
// bytes and the 32-byte code hash; probes.md P-2 finding 4).
// scripts/build-contracts.sh builds them and writes contracts/hashes.json
// ({ "<name>-v<n>": { blake3, bytes } }); the hashes are read from there, not
// computed here, so loading costs no hashing.
// test/backends/freenet-contracts.test.js pins every file to its entry.
const fs = require('fs')
const path = require('path')

const DIR = path.join(__dirname, 'contracts')
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'hashes.json'), 'utf8'))

// The signalling version routeFor() mints new links with.
const CURRENT = 'signalling-v1'
const POINTER = 'pointer-v1'

function load(name) {
  const entry = manifest[name]
  if (!entry) throw new Error(`contracts/hashes.json has no ${name}`)
  return {
    name,
    code: entry.blake3,
    wasm: new Uint8Array(fs.readFileSync(path.join(DIR, `${name}.wasm`)))
  }
}

// codeHex -> Uint8Array, signalling versions only: a route's `code` must be
// one of these (design §5.1).
const known = new Map()
for (const name of Object.keys(manifest)) {
  if (/^signalling-v\d+$/.test(name)) {
    const { code, wasm } = load(name)
    known.set(code, wasm)
  }
}

const current = manifest[CURRENT] && manifest[CURRENT].blake3
if (!known.has(current)) throw new Error(`contracts/hashes.json has no ${CURRENT}`)
const pointer = load(POINTER)

module.exports = { known, current, pointer, manifest }
