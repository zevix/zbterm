#!/usr/bin/env node
// Standalone blind-relay server for ZBTerm.
//
// Run this on a publicly reachable box (a VPS, not behind NAT) so that
// hosts and viewers that can't reach each other directly (eg. two peers
// behind the same NAT) can fall back to relaying their connection through
// it. It never sees decrypted terminal data - it just forwards the
// already-encrypted noise stream between the two peers.
//
// Usage:
//   ZBTERM_RELAY_SEED=<32-byte-hex-seed> node relay/server.js
//
// If ZBTERM_RELAY_SEED is not set, a random keypair is generated and
// printed once - save it and reuse it via the env var so the relay's
// public key (and therefore ZBTERM_RELAY_PUBLIC_KEY on your ZBTerm
// hosts/viewers) stays stable across restarts.
//
// Binds a single, fixed UDP port (default 49737, override with
// ZBTERM_RELAY_PORT) so there is exactly one port to open in your
// firewall/security group. Needs INBOUND UDP open on that port - this is
// the one process in the whole setup that has to be dialable from the
// internet; everything else (hosts, viewers, registry-publish.js) only
// makes outbound connections.
//
// blind-relay pairs *any* two peers that show up with a matching token -
// it has no concept of "is this a ZBTerm client", and the relay's public
// key is not a secret (anyone who reads the app source or watches DHT
// traffic can find it). Until there's a real capability-ticket system
// tying relay usage to genuine ZBTerm invites, these caps just bound the
// worst case: how many connections total, how many from one identity, and
// how long any single relayed session can run. They don't stop abuse, only
// limit its cost and make it visible in the logs.
const DHT = require('hyperdht')
const BlindRelayServer = require('blind-relay').Server
const b4a = require('b4a')
const crypto = require('crypto')
const goodbye = require('graceful-goodbye')

const { version } = require('../package.json')

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(version)
  process.exit(0)
}

const seedHex = process.env.ZBTERM_RELAY_SEED
const seed = seedHex ? b4a.from(seedHex, 'hex') : crypto.randomBytes(32)
const keyPair = DHT.keyPair(seed)
const port = process.env.ZBTERM_RELAY_PORT ? Number(process.env.ZBTERM_RELAY_PORT) : 49737

const MAX_SESSIONS = envInt('ZBTERM_RELAY_MAX_SESSIONS', 64)
const MAX_SESSIONS_PER_PEER = envInt('ZBTERM_RELAY_MAX_SESSIONS_PER_PEER', 4)
const MAX_SESSION_MS = envInt('ZBTERM_RELAY_MAX_SESSION_MS', 6 * 60 * 60 * 1000)
const STATS_INTERVAL_MS = 5 * 60 * 1000

function envInt(name, fallback) {
  return process.env[name] ? Number(process.env[name]) : fallback
}

function formatDuration(ms) {
  if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`
  if (ms >= 60000) return `${Math.round(ms / 60000)}min`
  return `${Math.round(ms / 1000)}s`
}

if (!seedHex) {
  console.log('No ZBTERM_RELAY_SEED set - generated a new one:')
  console.log(`  ZBTERM_RELAY_SEED=${b4a.toString(seed, 'hex')}`)
  console.log('Save this and pass it on every restart, or the relay public key will change.')
}

const dht = new DHT({ port })
const relay = new BlindRelayServer()
const sessionsPerPeer = new Map() // hex publicKey -> active session count

const server = dht.createServer((socket) => {
  const peerKey = b4a.toString(socket.remotePublicKey, 'hex')
  const peerShort = peerKey.slice(0, 12)

  if (relay.stats.sessions.active >= MAX_SESSIONS) {
    console.log(`[reject] ${peerShort} - global session cap reached (${MAX_SESSIONS})`)
    socket.on('error', () => {})
    socket.destroy()
    return
  }

  const peerCount = sessionsPerPeer.get(peerKey) || 0
  if (peerCount >= MAX_SESSIONS_PER_PEER) {
    console.log(`[reject] ${peerShort} - per-peer session cap reached (${MAX_SESSIONS_PER_PEER})`)
    socket.on('error', () => {})
    socket.destroy()
    return
  }

  sessionsPerPeer.set(peerKey, peerCount + 1)
  console.log(`[accept] ${peerShort} - sessions active=${relay.stats.sessions.active + 1}`)

  const lifetime = setTimeout(() => {
    console.log(`[timeout] ${peerShort} - exceeded max session duration`)
    socket.destroy()
  }, MAX_SESSION_MS)

  socket.on('error', () => {})
  socket.on('close', () => {
    clearTimeout(lifetime)
    const remaining = (sessionsPerPeer.get(peerKey) || 1) - 1
    if (remaining <= 0) sessionsPerPeer.delete(peerKey)
    else sessionsPerPeer.set(peerKey, remaining)
  })

  relay.accept(socket)
})

server.listen(keyPair).then(() => {
  console.log(`ZBTerm relay v${version} listening on UDP port ${port}`)
  console.log(`  ZBTERM_RELAY_PUBLIC_KEY=${b4a.toString(keyPair.publicKey, 'hex')}`)
  console.log('Pass that public key as the argument to relay/registry-publish.js.')
  console.log(
    `Caps: ${MAX_SESSIONS} total sessions, ${MAX_SESSIONS_PER_PEER} per peer, ${formatDuration(MAX_SESSION_MS)} max lifetime`
  )
})

const statsTimer = setInterval(() => {
  const { sessions, pairings, streams } = relay.stats
  console.log(
    `[stats] sessions active=${sessions.active} total=${sessions.accepted} | ` +
      `pairings matched=${pairings.matched} pending=${pairings.pending} | ` +
      `streams active=${streams.active}`
  )
}, STATS_INTERVAL_MS)

goodbye(async () => {
  clearInterval(statsTimer)
  await server.close()
  await dht.destroy()
})
