#!/usr/bin/env node
// Publishes "which relay is currently active" to the Holepunch DHT as a
// mutable record, so ZBTerm clients can discover the relay's public key
// without any env var / config on their end - they just look up the fixed
// registry public key that ships hardcoded in engine/share-manager.js.
//
// Run this alongside relay/server.js (same box or elsewhere - it only needs
// network access to the DHT, not to be the relay itself). Keep it running;
// it re-publishes periodically because DHT-stored records are not
// permanent and expire if not refreshed.
//
// Usage:
//   ZBTERM_REGISTRY_SEED=<32-byte-hex>   node relay/registry-publish.js <relayPublicKeyHex>
//
// ZBTERM_REGISTRY_SEED is the *secret* that controls the registry record -
// treat it like a password. Never commit it or ship it in the app. Only the
// public key it derives to is hardcoded in engine/share-manager.js.
const DHT = require('hyperdht')
const b4a = require('b4a')

const { version } = require('../package.json')

const REPUBLISH_INTERVAL_MS = 20 * 60 * 1000

async function main() {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    console.log(version)
    process.exit(0)
  }

  const seedHex = process.env.ZBTERM_REGISTRY_SEED
  const relayPublicKeyHex = process.argv[2]

  if (!seedHex || !relayPublicKeyHex) {
    console.error(
      'Usage: ZBTERM_REGISTRY_SEED=<hex> node relay/registry-publish.js <relayPublicKeyHex>'
    )
    process.exit(1)
  }

  const keyPair = DHT.keyPair(b4a.from(seedHex, 'hex'))
  const relayPublicKey = b4a.from(relayPublicKeyHex, 'hex')
  const dht = new DHT()

  console.log(`ZBTerm registry-publish v${version}`)
  console.log(`Registry public key: ${b4a.toString(keyPair.publicKey, 'hex')}`)
  console.log('(this must match REGISTRY_PUBLIC_KEY in engine/share-manager.js)')

  // Mutable records require a strictly increasing seq to update, and old
  // higher-seq records can otherwise linger on some DHT nodes and shadow a
  // fresh restart that begins counting from 0 again - so pick up where the
  // last run left off instead of resetting.
  const existing = await dht.mutableGet(keyPair.publicKey).catch(() => null)
  let seq = existing ? existing.seq + 1 : 0

  async function publish() {
    await dht.mutablePut(keyPair, relayPublicKey, { seq })
    console.log(`[${new Date().toISOString()}] published relay=${relayPublicKeyHex} seq=${seq}`)
    seq++
  }

  await publish()
  setInterval(() => publish().catch((err) => console.error('publish failed:', err.message)), REPUBLISH_INTERVAL_MS)
}

main().catch((err) => {
  console.error('FAIL', err)
  process.exit(1)
})
