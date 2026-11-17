#!/usr/bin/env node
// zbterm-relay: the standalone blind-relay server for ZBTerm.
//
// Run this on a publicly reachable box (a VPS, not behind NAT) so that
// hosts and viewers that can't reach each other directly (eg. two peers
// behind the same NAT) can fall back to relaying their connection through
// it. It never sees decrypted terminal data - it just forwards the
// already-encrypted noise stream between the two peers.
//
// Usage:
//   zbterm-relay                       start the relay (node relay/server.js from a checkout)
//   zbterm-relay --rotate-access-key   write a new access salt; a running relay switches to it
//   zbterm-relay --print-key           print the access key line and exit
//   zbterm-relay --check               check the keys and say where they come from
//   zbterm-relay --version | --help
//
// Two keys (relay/keys.js):
// - the relay secret: ZBTERM_RELAY_SEED, else ~/.zbterm/relay-secret, else
//   generated and saved there. It never leaves this box.
// - the access salt: ZBTERM_RELAY_ACCESS_SALT, else ~/.zbterm/relay-access,
//   else generated and saved there.
// The relay listens on a key pair derived from both; its public key is the
// access key ZBTerm users paste into "ZBTerm relay access key…" in the
// settings menu. Rotating the salt changes the access key, so the old key
// stops reaching this relay; the running relay watches the salt file.
//
// Binds a single, fixed UDP port (default 49737, override with
// ZBTERM_RELAY_PORT) so there is exactly one port to open in your
// firewall/security group. Needs INBOUND UDP open on that port - this is
// the one process in the whole setup that has to be dialable from the
// internet; everything else (hosts, viewers) only makes outbound
// connections.
//
// With ZBTERM_REGISTRY_SEED set (only the maintainer's official relay), it
// also publishes its current access key to the DHT registry record the app
// resolves its default relay from (engine/backends/pear/index.js::
// REGISTRY_PUBLIC_KEY), every 20 minutes and right after a rotation. Without
// it, nothing is published: a private relay's access key stays private.
//
// blind-relay pairs *any* two peers that show up with a matching token -
// it has no concept of "is this a ZBTerm client". The access key limits who
// can reach the relay to whoever was given it; these caps bound the worst
// case beyond that: how many connections total, how many from one identity,
// and how long any single relayed session can run.
'use strict'

const os = require('os')
const fs = require('fs')
const DHT = require('hyperdht')
const BlindRelayServer = require('blind-relay').Server
const b4a = require('b4a')
const goodbye = require('graceful-goodbye')

const keys = require('./keys')
const { version } = require('../package.json')

const USAGE = `zbterm-relay v${version} - ZBTerm's blind relay

Usage:
  zbterm-relay                       start the relay
  zbterm-relay --rotate-access-key   write a new access salt and print the new access key;
                                     a running relay switches to it
  zbterm-relay --print-key           print the access key line and exit
  zbterm-relay --check               check the keys (variables and files) and say what would be used
  zbterm-relay --version, -v         print the version
  zbterm-relay --help, -h            this help

Files (mode 0600, in ~/.zbterm, mode 0700):
  ~/.zbterm/relay-secret   the relay secret (64 hex); ZBTERM_RELAY_SEED overrides it
  ~/.zbterm/relay-access   the access salt (64 hex); ZBTERM_RELAY_ACCESS_SALT overrides it

Environment: ZBTERM_RELAY_PORT (UDP, default 49737), ZBTERM_RELAY_MAX_SESSIONS,
ZBTERM_RELAY_MAX_SESSIONS_PER_PEER, ZBTERM_RELAY_MAX_SESSION_MS,
ZBTERM_REGISTRY_SEED (official relay only: publish the access key to the registry).`

// Must match engine/backends/pear/index.js::REGISTRY_PUBLIC_KEY (the app's
// default-relay lookup address). Only used to warn when ZBTERM_REGISTRY_SEED
// derives to a different record than the one the app reads.
const DEFAULT_REGISTRY_PUBLIC_KEY =
  '9fa15b9590a55c63d14069c27d8e8cbc12bd0a0ec0f76e5a79f1c8c57f1e283b'
const REPUBLISH_INTERVAL_MS = 20 * 60 * 1000
const STATS_INTERVAL_MS = 5 * 60 * 1000
const WATCH_INTERVAL_MS = 1000

const MODES = {
  '--rotate-access-key': 'rotate',
  '--print-key': 'print-key',
  '--check': 'check',
  '--version': 'version',
  '-v': 'version',
  '--help': 'help',
  '-h': 'help'
}

function parseMode(argv) {
  let mode = 'start'
  for (const arg of argv) {
    const m = MODES[arg]
    if (!m) {
      console.error(`[error] Unknown argument: ${arg}\n\n${USAGE}`)
      process.exit(2)
    }
    if (mode !== 'start' && mode !== m) {
      console.error(`[error] Give only one of ${Object.keys(MODES).join(', ')}.`)
      process.exit(2)
    }
    mode = m
  }
  return mode
}

function fail(message) {
  console.error(`[error] ${message}`)
  process.exit(1)
}

function report(result, out = console.log) {
  for (const line of result.infos) out(`[info] ${line}`)
  for (const line of result.notes) out(`[note] ${line}`)
  for (const line of result.errors) console.error(`[error] ${line}`)
}

function envInt(name, fallback) {
  const text = process.env[name]
  if (text === undefined || text === '') return fallback
  const n = Number(text)
  if (!Number.isInteger(n) || n < 0) fail(`${name} must be a non-negative integer, got "${text}".`)
  return n
}

function formatDuration(ms) {
  if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`
  if (ms >= 60000) return `${Math.round(ms / 60000)}min`
  return `${Math.round(ms / 1000)}s`
}

// null when publishing is off; throws KeyError on a malformed seed.
function registryKeyPair() {
  const text = process.env.ZBTERM_REGISTRY_SEED
  if (!text) return null
  const seed = keys.parseHex(text)
  if (!seed) {
    throw new keys.KeyError('ZBTERM_REGISTRY_SEED is not valid: expected 64 hex characters.')
  }
  return DHT.keyPair(seed)
}

function registryLine(registry) {
  if (!registry) {
    return 'Registry: not publishing (ZBTERM_REGISTRY_SEED is not set) - this relay and its access key stay private.'
  }
  return (
    `Registry: publishing the access key under registry key ` +
    `${b4a.toString(registry.publicKey, 'hex')} every ${REPUBLISH_INTERVAL_MS / 60000} min.`
  )
}

function registryMismatchWarning(registry) {
  if (!registry || b4a.toString(registry.publicKey, 'hex') === DEFAULT_REGISTRY_PUBLIC_KEY) {
    return null
  }
  return (
    '[warn] ZBTERM_REGISTRY_SEED does not derive to the registry key ZBTerm reads ' +
    `(${DEFAULT_REGISTRY_PUBLIC_KEY}); the app will not find this relay through it.`
  )
}

function resolveBoth(home, create, out) {
  const secret = keys.resolveKey('secret', { home, env: process.env, create })
  report(secret, out)
  const salt = keys.resolveKey('salt', { home, env: process.env, create })
  report(salt, out)
  return { secret, salt }
}

function describeSource(r) {
  if (r.source === 'env') return `${keys.KEYS[r.which].envName}`
  if (r.source === 'file') return r.file
  return `newly generated${r.saved === false ? ' (not saved)' : ` (saved to ${r.file})`}`
}

// --check: everything resolved without creating files or touching the network.
function runCheck(home) {
  const problems = []
  const resolved = {}
  for (const which of ['secret', 'salt']) {
    try {
      const r = keys.resolveKey(which, { home, env: process.env, create: false })
      report(r)
      console.log(`${keys.KEYS[which].label}: from ${describeSource(r)}`)
      resolved[which] = r
    } catch (err) {
      if (!(err instanceof keys.KeyError)) throw err
      problems.push(err.message)
      console.log(`${keys.KEYS[which].label}: not usable (see below)`)
    }
  }
  let registry = null
  try {
    registry = registryKeyPair()
  } catch (err) {
    problems.push(err.message)
  }
  const port = process.env.ZBTERM_RELAY_PORT
  if (port && !(Number.isInteger(Number(port)) && Number(port) >= 0 && Number(port) < 65536)) {
    problems.push(`ZBTERM_RELAY_PORT is not a valid UDP port: "${port}".`)
  }
  if (resolved.secret && resolved.salt) {
    console.log(keys.accessKeyLine(keys.deriveKeyPair(resolved.secret.value, resolved.salt.value)))
  }
  if (!problems.length) {
    console.log(registryLine(registry))
    const warning = registryMismatchWarning(registry)
    if (warning) console.log(warning)
    console.log(`UDP port: ${port || 49737}`)
    console.log('OK: zbterm-relay can start with these keys.')
    process.exit(0)
  }
  for (const p of problems) console.error(`[error] ${p}`)
  console.error('Not usable: see the errors above.')
  process.exit(1)
}

function runPrintKey(home) {
  try {
    const { secret, salt } = resolveBoth(home, false, console.error)
    console.log(keys.accessKeyLine(keys.deriveKeyPair(secret.value, salt.value)))
    process.exit(0)
  } catch (err) {
    if (!(err instanceof keys.KeyError)) throw err
    fail(err.message)
  }
}

function runRotate(home) {
  let secret
  try {
    secret = keys.resolveKey('secret', { home, env: process.env, create: true })
  } catch (err) {
    if (!(err instanceof keys.KeyError)) throw err
    fail(err.message)
  }
  report(secret)
  if (secret.saved === false) {
    fail(
      'Not rotating: without a saved relay secret the new access key would not survive a restart.'
    )
  }
  let rotated
  try {
    rotated = keys.rotateSalt(home)
  } catch (err) {
    fail(`Could not write the new access salt to ${keys.keyFile(home, 'salt')}: ${err.message}`)
  }
  console.log(`[info] Wrote a new access salt to ${rotated.file}.`)
  console.log(keys.accessKeyLine(keys.deriveKeyPair(secret.value, rotated.value)))
  if (process.env.ZBTERM_RELAY_ACCESS_SALT) {
    console.log(
      '[note] ZBTERM_RELAY_ACCESS_SALT is set: it overrides the file for any relay started with ' +
        'that variable, so such a relay keeps its old access key.'
    )
  } else {
    console.log(
      'A running zbterm-relay switches to this key within seconds; the old key no longer reaches it.'
    )
  }
  console.log(
    "Send the new key only to the people who should use this relay; they paste it into ZBTerm's settings."
  )
  process.exit(0)
}

async function runRelay(home) {
  let secret, salt, registry
  try {
    ;({ secret, salt } = resolveBoth(home, true))
    registry = registryKeyPair()
  } catch (err) {
    if (!(err instanceof keys.KeyError)) throw err
    fail(err.message)
  }

  const port = envInt('ZBTERM_RELAY_PORT', 49737)
  if (port > 65535) fail(`ZBTERM_RELAY_PORT is not a valid UDP port: ${port}.`)
  const MAX_SESSIONS = envInt('ZBTERM_RELAY_MAX_SESSIONS', 64)
  const MAX_SESSIONS_PER_PEER = envInt('ZBTERM_RELAY_MAX_SESSIONS_PER_PEER', 4)
  const MAX_SESSION_MS = envInt('ZBTERM_RELAY_MAX_SESSION_MS', 6 * 60 * 60 * 1000)

  // Test-only: a local hyperdht testnet instead of the public DHT.
  const bootstrap = process.env.ZBTERM_RELAY_BOOTSTRAP
    ? process.env.ZBTERM_RELAY_BOOTSTRAP.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined

  const dht = new DHT(bootstrap ? { port, bootstrap } : { port })
  const relay = new BlindRelayServer()
  const sessionsPerPeer = new Map() // hex publicKey -> active session count

  function onConnection(socket) {
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
  }

  let keyPair = keys.deriveKeyPair(secret.value, salt.value)
  let currentSalt = salt.value
  let server = dht.createServer(onConnection)
  let closing = false

  // Registry publishing (official relay only). Mutable records need a
  // strictly increasing seq, and an old higher-seq record can linger on some
  // DHT nodes and shadow a restart that counts from 0 again - so resume from
  // what the DHT holds.
  let seq = null
  let publishing = Promise.resolve()
  function publish() {
    if (!registry) return Promise.resolve()
    publishing = publishing
      .then(async () => {
        if (seq === null) {
          const existing = await dht.mutableGet(registry.publicKey).catch(() => null)
          seq = existing ? existing.seq + 1 : 0
        }
        const value = keyPair.publicKey
        await dht.mutablePut(registry, value, { seq })
        console.log(
          `[registry] ${new Date().toISOString()} published access key ${b4a.toString(value, 'hex')} seq=${seq}`
        )
        seq++
      })
      .catch((err) => console.error(`[error] registry publish failed: ${err.message}`))
    return publishing
  }

  await server.listen(keyPair)
  console.log(`ZBTerm relay v${version} listening on UDP port ${port}`)
  console.log(keys.accessKeyLine(keyPair))
  console.log('  (paste it into ZBTerm: settings menu, "ZBTerm relay access key…")')
  console.log(
    `Caps: ${MAX_SESSIONS} total sessions, ${MAX_SESSIONS_PER_PEER} per peer, ${formatDuration(MAX_SESSION_MS)} max lifetime`
  )
  console.log(registryLine(registry))
  const mismatch = registryMismatchWarning(registry)
  if (mismatch) console.log(mismatch)

  try {
    await dht.fullyBootstrapped()
  } catch {}
  if (dht.firewalled) {
    console.log(
      `[warn] The DHT reports this node as firewalled: UDP port ${port} is not reachable from outside, ` +
        'so this relay will not work for others. Open inbound UDP on that port (OS firewall and any ' +
        'cloud security group) on a host with a public IP.'
    )
  }

  publish()
  const publishTimer = registry ? setInterval(publish, REPUBLISH_INTERVAL_MS) : null

  // Rotation: a valid change to the salt file moves the relay to the new key
  // pair. Relayed streams already running continue; new connections to the
  // old key fail once its listener is closed.
  const saltFile = keys.keyFile(home, 'salt')
  let switching = Promise.resolve()
  function onSaltChange() {
    switching = switching.then(async () => {
      if (closing) return
      const read = keys.readSaltFile(home)
      if (read.error) {
        console.error(`[error] ${read.error} Keeping the current access key.`)
        return
      }
      if (b4a.equals(read.value, currentSalt)) return
      const nextKeyPair = keys.deriveKeyPair(secret.value, read.value)
      const nextServer = dht.createServer(onConnection)
      try {
        await nextServer.listen(nextKeyPair)
      } catch (err) {
        console.error(
          `[error] Could not listen on the new access key (${err.message}); keeping the current one.`
        )
        await nextServer.close().catch(() => {})
        return
      }
      const oldServer = server
      server = nextServer
      keyPair = nextKeyPair
      currentSalt = read.value
      await oldServer.close().catch(() => {})
      console.log(
        `[rotate] ${saltFile} changed: now listening on the new access key; the old key no longer reaches this relay.`
      )
      console.log(keys.accessKeyLine(keyPair))
      publish()
    })
  }
  const watching = salt.source !== 'env' && salt.saved !== false
  if (watching) fs.watchFile(saltFile, { interval: WATCH_INTERVAL_MS }, onSaltChange)

  const statsTimer = setInterval(() => {
    const { sessions, pairings, streams } = relay.stats
    console.log(
      `[stats] sessions active=${sessions.active} total=${sessions.accepted} | ` +
        `pairings matched=${pairings.matched} pending=${pairings.pending} | ` +
        `streams active=${streams.active}`
    )
  }, STATS_INTERVAL_MS)

  goodbye(async () => {
    closing = true
    if (watching) fs.unwatchFile(saltFile, onSaltChange)
    clearInterval(statsTimer)
    if (publishTimer) clearInterval(publishTimer)
    await switching.catch(() => {})
    await server.close()
    await dht.destroy()
  })
}

const mode = parseMode(process.argv.slice(2))
const home = os.homedir()

if (mode === 'version') {
  console.log(version)
  process.exit(0)
} else if (mode === 'help') {
  console.log(USAGE)
  process.exit(0)
} else if (mode === 'check') {
  runCheck(home)
} else if (mode === 'print-key') {
  runPrintKey(home)
} else if (mode === 'rotate') {
  runRotate(home)
} else {
  runRelay(home).catch((err) => {
    console.error(`[error] ${err.stack || err.message}`)
    process.exit(1)
  })
}
