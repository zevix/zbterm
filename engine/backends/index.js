// The share backend registry (backend-abstraction R-6, R-7, R-8).
//
// This is the ONLY file outside a backend directory that reaches into one
// (test/backend-boundary.test.js). Each backend is loaded through a guarded
// `require` with a literal specifier, so a packager can drop a backend's
// directory - or its dependencies - and the build still boots:
//
//   MODULE_NOT_FOUND (the backend or one of its dependencies)  -> absent
//   any other load error                                        -> broken
//
// The in-process loopback (./loopback.js) is a test backend and is
// deliberately NOT listed: it can never appear in `share.backends`. Tests hand
// it to the core through `opts.shareBackend` instead.
const { EngineError, CODES } = require('../errors')
const { assertBackend } = require('./types')

// Literal specifiers, one thunk per backend. The order is the preference
// order for the default backend.
const KNOWN = {
  pear: () => require('./pear'),
  freenet: () => require('./freenet')
}

const NONE = 'none'
const AVAILABLE = 'available'
const BROKEN = 'broken'
// A-11: how long share.backends waits for one backend's probe().
const PROBE_TIMEOUT_MS = 2000

function isModuleNotFound(err) {
  return !!err && err.code === 'MODULE_NOT_FOUND'
}

function errorDetail(err) {
  return err && err.message ? String(err.message) : String(err)
}

// Loads one backend. Returns null when it is absent, otherwise
// `{ id, state, detail, Backend, descriptor }`. Nothing is cached here:
// `require` caches a loaded module itself, and a failed load is cheap to retry.
// `ctx.hostCaps` is what the host process offers (the worker's 5th spawn
// argument, docs/CORE-CONTRACT.md 3): a comma-separated list, '' for nothing,
// undefined when the caller has no host to ask about.
function load(id, ctx = {}) {
  if (!Object.prototype.hasOwnProperty.call(KNOWN, id)) return null
  let Backend
  try {
    Backend = KNOWN[id]()
  } catch (err) {
    if (isModuleNotFound(err)) return null
    return { id, state: BROKEN, detail: errorDetail(err), Backend: null, descriptor: null }
  }
  try {
    if (typeof Backend !== 'function') throw new TypeError('backend module exports no constructor')
    // A backend that loads but must not be used (a stub, a failed self-check)
    // says so itself: `availability()` -> { state, detail }.
    const self = typeof Backend.availability === 'function' ? Backend.availability(ctx) : null
    const descriptor = new Backend().describe()
    const state = self && self.state && self.state !== AVAILABLE ? BROKEN : AVAILABLE
    return {
      id,
      state,
      detail: state === BROKEN ? (self && self.detail) || 'unavailable' : null,
      Backend,
      descriptor
    }
  } catch (err) {
    return { id, state: BROKEN, detail: errorDetail(err), Backend: null, descriptor: null }
  }
}

function entryOf(loaded) {
  const descriptor = loaded.descriptor || {}
  return {
    id: loaded.id,
    label: descriptor.label || loaded.id,
    capabilities: Number.isFinite(descriptor.capabilities) ? descriptor.capabilities : 0,
    state: loaded.state,
    detail: loaded.detail
  }
}

// Every backend this build carries, broken ones included (so a host can say
// why sharing is missing instead of silently hiding it). Absent ones are left
// out.
function available(ctx = {}) {
  const out = []
  for (const id of Object.keys(KNOWN)) {
    const loaded = load(id, ctx)
    if (loaded) out.push(entryOf(loaded))
  }
  return out
}

// '' / null / undefined -> no limit. 'none' -> nothing. Otherwise a backend id
// (a comma-separated list is tolerated). A limit only ever removes backends:
// an id this build does not carry selects nothing.
function parseLimit(limit) {
  const text = limit === null || limit === undefined ? '' : String(limit).trim().toLowerCase()
  if (!text) return null
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && part !== NONE)
}

function resolve({ limit, hostCaps } = {}) {
  const allowed = parseLimit(limit)
  const backends = available({ hostCaps }).filter((entry) => !allowed || allowed.includes(entry.id))
  const usable = backends.find((entry) => entry.state === AVAILABLE)
  return {
    backends,
    default: usable ? usable.id : null,
    limitedBy: allowed ? String(limit).trim().toLowerCase() : null
  }
}

// A new, unstarted backend. `ctx.limit` is the selection limit, `ctx.hostCaps`
// the host's capabilities (see load); `ctx.options` is handed to the backend's
// constructor.
function create(id, ctx = {}) {
  const entry = resolve({ limit: ctx.limit, hostCaps: ctx.hostCaps }).backends.find(
    (item) => item.id === id
  )
  if (!entry) {
    throw new EngineError(
      CODES.E_BACKEND_UNSUPPORTED,
      `The '${id}' share backend is not available in this build`,
      { backend: id }
    )
  }
  if (entry.state !== AVAILABLE) {
    throw new EngineError(
      CODES.E_BACKEND_UNSUPPORTED,
      `The '${id}' share backend cannot be used: ${entry.detail}`,
      { backend: id, detail: entry.detail }
    )
  }
  const { Backend } = load(id, { hostCaps: ctx.hostCaps })
  return assertBackend(new Backend(ctx.options))
}

// A-11: a backend whose module loads may still be unusable for a reason only
// the network can tell (the Freenet backend: no node at its address). Its
// optional static `probe(ctx)` answers `{ state, detail }`; `share.backends`
// awaits it, at most PROBE_TIMEOUT_MS. null when the backend has no probe or
// is absent; a probe that throws or does not answer in time is `broken`.
async function probe(id, ctx = {}) {
  const loaded = load(id, { hostCaps: ctx.hostCaps })
  if (!loaded || !loaded.Backend || typeof loaded.Backend.probe !== 'function') return null
  let timer = null
  const late = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ state: BROKEN, detail: `no answer within ${PROBE_TIMEOUT_MS} ms` }),
      PROBE_TIMEOUT_MS
    )
  })
  try {
    const answer = await Promise.race([
      Promise.resolve(loaded.Backend.probe({ ...ctx, timeoutMs: PROBE_TIMEOUT_MS })),
      late
    ])
    if (!answer || answer.state === AVAILABLE) return { state: AVAILABLE, detail: null }
    return { state: BROKEN, detail: answer.detail || 'unavailable' }
  } catch (err) {
    return { state: BROKEN, detail: errorDetail(err) }
  } finally {
    clearTimeout(timer)
  }
}

// The worker half of the host's WebRTC adapter (engine/worker.js, when the
// host offers `rtc`): the Freenet backend's RtcRemote, which turns calls into
// BACKEND_* frames. null in a build without the Freenet backend. Here, and not
// in the worker, because nothing else may reach into a backend directory.
function rtcRemote(send) {
  let RtcRemote
  try {
    RtcRemote = require('./freenet/rtc-remote')
  } catch (err) {
    if (isModuleNotFound(err)) return null
    throw err
  }
  return new RtcRemote(send)
}

module.exports = {
  KNOWN,
  PROBE_TIMEOUT_MS,
  available,
  resolve,
  create,
  probe,
  parseLimit,
  rtcRemote
}
