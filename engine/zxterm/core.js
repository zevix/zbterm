// Access to the Rust `zxterm-core` sidecar (K9 of zxterm-core, in
// `zevix/zxterm`): one sidecar process per profile, reached over K7's seam
// (`./client.js`). Not to be confused with this directory's own npm
// package, `zbterm-core` (`engine/package.json`): that is ZBTerm's JS
// worker; this file talks to the separate Rust binary.
//
// Every identity path goes through here: SSH-key discovery and signing,
// the identity claim, verification and the provider key lookup, and the
// identity key (`idkey.*`) that `../crypto.js` and `../account-store.js`
// used an upstream package for.
//
// Spawning a process is a host capability (`test/core-boundary.test.js`),
// so this file never spawns anything itself. The host injects a
// `{ spawn(bin, args), bin() }` object with `setCoreHost()` before the
// first identity call: the Electron shell does it inside the Bare worker
// (`electron/zxterm-core-host.js`, loaded by `engine/worker.js` from the
// path the host passes as its 6th argument), and a test does it with
// `test/helpers/zxterm-core.js`. Without a host every call fails at once
// with a named `E_BACKEND_UNAVAILABLE`, never a hang.
//
// The sidecar is spawned with `--exit-on-stdin-eof` and a stdin pipe
// nobody writes to, so it exits with whatever process spawned it.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

const { EngineError, CODES } = require('../errors')
const { SeamClient } = require('./client')

const HOST_KEY = Symbol.for('zbterm.zxtermCoreHost')
const START_ATTEMPTS = 5
const START_RETRY_MS = 100
const CORES_KEY = Symbol.for('zbterm.zxtermCores')

function setCoreHost(host) {
  if (host !== null && (!host || typeof host.spawn !== 'function')) {
    throw new EngineError(CODES.E_INTERNAL, 'A zxterm-core host needs a spawn(bin, args) function')
  }
  globalThis[HOST_KEY] = host
}

function coreHost() {
  return globalThis[HOST_KEY] || null
}

// Module state lives on globalThis so a second copy of this file (a test
// that loads `engine/` through two paths) still shares one sidecar per
// profile directory.
function cores() {
  if (!globalThis[CORES_KEY]) globalThis[CORES_KEY] = new Map()
  return globalThis[CORES_KEY]
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function unavailable(message) {
  return new EngineError(CODES.E_BACKEND_UNAVAILABLE, message)
}

// One running sidecar for one profile directory. `request()` starts it on
// first use; `health()` answers synchronously in the backend
// `HealthReport` shape (`engine/backends/types.js`).
//
// Events (K11, for the Freenet backend's proxy, engine/backends/freenet/
// index.js): `'event'` ({name, data}) for every seam `Event` frame, `'chan'`
// ({chan, bytes}) for every `Chan` frame, `'drain'` when the socket takes
// more after a `sendChan()` that returned false, and `'exit'` when a running
// sidecar goes away (the next request starts a fresh one, with none of the
// old one's state).
class Core extends EventEmitter {
  // `opts.host` overrides the process-wide host for this one sidecar (a test
  // that needs its own environment for it).
  constructor(profileDir, opts = {}) {
    super()
    this.profileDir = profileDir
    this._host = opts.host || null
    this._client = null
    this._starting = null
    this._error = null
    this._closed = false
  }

  _start() {
    if (!this._starting) {
      this._starting = this._launch().catch((err) => {
        this._starting = null
        this._error = err
        throw EngineError.from(err)
      })
    }
    return this._starting
  }

  // A sidecar that is still exiting (its engine just closed, or its worker
  // just crashed) holds the profile lock for a moment, so a new one refuses
  // the profile and exits. That is retried a few times, briefly; anything
  // else fails at once. Never a hang: every attempt is bounded by
  // SeamClient's own connect timeout.
  async _launch() {
    const host = this._host || coreHost()
    if (!host) {
      throw unavailable(
        'zxterm-core is not available: no host has provided a way to spawn the sidecar ' +
          '(engine/zxterm/core.js setCoreHost)'
      )
    }
    let bin
    try {
      bin = typeof host.bin === 'function' ? host.bin() : host.bin
    } catch (err) {
      throw unavailable(err.message)
    }
    if (!bin) throw unavailable('zxterm-core is not available: the sidecar binary is missing')
    await fs.promises.mkdir(this.profileDir, { recursive: true })
    let lastError = null
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
      if (this._closed) throw unavailable('zxterm-core seam client is closed')
      if (attempt > 0) await delay(START_RETRY_MS)
      const client = this._newClient(host, bin)
      try {
        // A socket file left by a sidecar that died with its parent would be
        // mistaken for the new one's; the new sidecar replaces it anyway
        // once it holds the profile lock.
        await fs.promises.unlink(client.socketPath()).catch(() => {})
        await client.start()
      } catch (err) {
        lastError = err
        try {
          client.close()
        } catch {}
        if (!/exited before its socket appeared/.test(err.message || '')) break
        continue
      }
      if (this._closed) {
        client.close()
        throw unavailable('zxterm-core seam client is closed')
      }
      this._client = client
      this._error = null
      unrefClient(client)
      return client
    }
    throw lastError
  }

  _newClient(host, bin) {
    const client = new SeamClient({
      profile: this.profileDir,
      bin,
      spawn: (file, args) => host.spawn(file, [...args, '--exit-on-stdin-eof'])
    })
    client.on('error', (err) => {
      if (this._client === client) this._error = err
    })
    client.on('exit', ({ code, signal }) => {
      if (this._client !== client) return
      this._error = unavailable(`zxterm-core sidecar exited (code=${code}, signal=${signal})`)
      // The next request starts a fresh sidecar.
      this._client = null
      this._starting = null
      this.emit('exit', { code, signal })
    })
    client.on('event', (event) => this.emit('event', event))
    client.on('chan', (frame) => this.emit('chan', frame))
    client.on('drain', () => this.emit('drain'))
    return client
  }

  async request(method, args = {}) {
    if (this._closed) throw unavailable('zxterm-core seam client is closed')
    const client = this._client || (await this._start())
    return client.request(method, args)
  }

  // One `Chan` frame to the running sidecar (`SeamClient#sendChan`); false,
  // and nothing sent, when none is running.
  sendChan(chan, bytes) {
    return this._client ? this._client.sendChan(chan, bytes) : false
  }

  health() {
    return {
      started: !!this._client,
      listening: !!(this._client && this._client._socket),
      detail: this._error ? this._error.message : null
    }
  }

  close() {
    this._closed = true
    if (cores().get(this.profileDir) === this) cores().delete(this.profileDir)
    const client = this._client
    this._client = null
    this._starting = null
    if (client) client.close()
  }
}

// The sidecar and its socket must never keep a process alive on their own:
// a finished test run, or a worker whose engine has closed, exits, and the
// sidecar follows through `--exit-on-stdin-eof`.
function unrefClient(client) {
  const child = client._child
  if (child) {
    if (typeof child.unref === 'function') child.unref()
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (stream && typeof stream.unref === 'function') stream.unref()
    }
  }
  const socket = client._socket
  if (socket && typeof socket.unref === 'function') socket.unref()
}

// The sidecar for `profileDir` (created on first use, shared afterwards).
function openCore(profileDir) {
  const dir = path.resolve(String(profileDir))
  let core = cores().get(dir)
  if (!core) {
    core = new Core(dir)
    cores().set(dir, core)
  }
  return core
}

// For the stateless calls made without a profile (`crypto.js` and
// `account-store.js` called on their own, as tests do): one sidecar on a
// scratch directory of this process's own.
let defaultDir = null
function defaultCore() {
  if (!defaultDir) {
    defaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxc-'))
  }
  return openCore(defaultDir)
}

// `core` may be a `Core`, a profile directory, or nothing (the default).
function coreFor(core) {
  if (core && typeof core.request === 'function') return core
  if (typeof core === 'string' && core) return openCore(core)
  return defaultCore()
}

module.exports = { setCoreHost, coreHost, openCore, defaultCore, coreFor, Core }
