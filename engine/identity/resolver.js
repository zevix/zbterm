// Worker-side resolver for "does <provider> user <subject> publish this SSH
// key?".
//
// The worker owns no HTTP client, so a lookup is a round trip across the
// shell seam: the resolver emits the `identity:resolve-request` engine event
// (a name in `LOW_RATE_EVENTS`, JSON-encoded - keep the payload plain data,
// Buffers silently degrade), the Electron shell answers with the
// `identity.resolveResult` invoke, and `handleResponse` settles the pending
// promise. Tests and headless runs skip the seam entirely by passing
// `fetchImpl`.
//
// Answers - positive *and* negative - are cached under the profile's account
// dir so a handshake does not hit the network for every join.
const { EngineError, CODES } = require('../errors')
const { getProvider } = require('./providers')
const { randomHex } = require('./claim')

const DEFAULT_TIMEOUT_MS = 10000
const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000
const NEGATIVE_TTL_MS = 10 * 60 * 1000
const RESOLVE_REQUEST_EVENT = 'identity:resolve-request'
const STATUSES = ['ok', 'not-found']

class IdentityResolver {
  constructor(opts = {}) {
    this.store = opts.store || null
    this.emit = typeof opts.emit === 'function' ? opts.emit : () => {}
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
    this.fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : null
    this.positiveTtlMs = Number.isFinite(opts.positiveTtlMs) ? opts.positiveTtlMs : POSITIVE_TTL_MS
    this.negativeTtlMs = Number.isFinite(opts.negativeTtlMs) ? opts.negativeTtlMs : NEGATIVE_TTL_MS
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    // requestId -> { resolve, reject, timer }
    this.pending = new Map()
    // `<provider>/<subject>` -> in-flight resolve promise
    this.inflight = new Map()
    this.closed = false
  }

  // Never rejects for "no such user": that is `{ status: 'not-found' }`. It
  // rejects only when the lookup itself could not be completed *and* there is
  // no stale cache entry to fall back on.
  //
  // `opts.refresh` skips the fresh-cache short circuit. The identity wizard
  // uses it so a key the user has just added on GitHub is picked up without
  // waiting out the positive TTL; the answer is still written back to the
  // cache. The inflight key carries the flag, so a refresh never joins - and
  // is never satisfied by - a plain lookup already in flight.
  resolve(provider, subject, opts = {}) {
    const providerId = getProvider(provider).id
    const normalized = getProvider(provider).validateSubject(subject)
    const refresh = !!opts.refresh
    const key = `${providerId}/${normalized}${refresh ? '#refresh' : ''}`
    const existing = this.inflight.get(key)
    if (existing) return existing
    // Registered synchronously, before the first await, so two concurrent
    // callers share one promise (and therefore one emitted request).
    const promise = this._resolve(providerId, normalized, refresh)
    this.inflight.set(key, promise)
    const clear = () => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key)
    }
    promise.then(clear, clear)
    return promise
  }

  async _resolve(provider, subject, refresh = false) {
    const cached = await this._readCache(provider, subject)
    if (cached && !refresh && !this._isStale(cached)) {
      return {
        status: cached.status,
        keys: cached.keys,
        fetchedAt: cached.fetchedAt,
        source: 'cache'
      }
    }
    let answer = null
    try {
      answer = normalizeAnswer(await this._fetch(provider, subject))
    } catch (err) {
      // A live lookup failed. A stale answer is better than none - the caller
      // is told so via `source`, and Phase 5 must not refuse a connection on a
      // resolver failure.
      if (cached) {
        return {
          status: cached.status,
          keys: cached.keys,
          fetchedAt: cached.fetchedAt,
          source: 'cache-stale'
        }
      }
      throw EngineError.from(err, CODES.E_NET)
    }
    const fetchedAt = this.now()
    await this._writeCache(provider, subject, answer, fetchedAt)
    return { status: answer.status, keys: answer.keys, fetchedAt, source: 'remote' }
  }

  async _fetch(provider, subject) {
    if (this.fetchImpl) return await this.fetchImpl(provider, subject)
    return await this._request(provider, subject)
  }

  _request(provider, subject) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new EngineError(CODES.E_NET, 'Identity resolver is closed'))
        return
      }
      const requestId = randomHex(16)
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(
          new EngineError(
            CODES.E_NET,
            `Timed out after ${this.timeoutMs}ms waiting for the ZBTerm shell to look up ` +
              `${subject}@${provider} - the app shell may still be starting; try again`
          )
        )
      }, this.timeoutMs)
      // Not unref'd on purpose: an unref'd timer never fires in an otherwise
      // idle process, which turns "the shell never answered" into a hang.
      // `close()` (called from SessionEngine.close) clears it instead.
      this.pending.set(requestId, { resolve, reject, timer })
      // Deferred one microtask: `emit` is synchronous, and a shell (or a test)
      // that answers inline would otherwise call `handleResponse` before the
      // pending entry above exists.
      queueMicrotask(() => {
        if (!this.pending.has(requestId)) return
        try {
          this.emit(RESOLVE_REQUEST_EVENT, { requestId, provider, subject })
        } catch (err) {
          this._settle(requestId, false, null, { message: err.message || String(err) })
        }
      })
    })
  }

  // Called from the `identity.resolveResult` invoke. Returns true when the
  // request was still pending (a late answer after a timeout is dropped).
  handleResponse(message = {}) {
    const requestId = message && message.requestId ? String(message.requestId) : ''
    if (!requestId) return false
    return this._settle(requestId, !!message.ok, message.result, message.error)
  }

  _settle(requestId, ok, result, error) {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    if (ok) entry.resolve(result)
    else {
      const message = (error && error.message) || 'Identity key lookup failed in the ZBTerm shell'
      entry.reject(new EngineError(CODES.E_NET, message))
    }
    return true
  }

  // Rejects every in-flight request; used by SessionEngine.close() so a
  // shutting-down worker never leaves a timer (or a caller) hanging.
  close() {
    this.closed = true
    for (const requestId of Array.from(this.pending.keys())) {
      this._settle(requestId, false, null, { message: 'ZBTerm engine is shutting down' })
    }
    this.pending.clear()
    this.inflight.clear()
  }

  _isStale(record) {
    const ttl = record.status === 'not-found' ? this.negativeTtlMs : this.positiveTtlMs
    const age = this.now() - (record.fetchedAt || 0)
    return !(age >= 0 && age < ttl)
  }

  async _readCache(provider, subject) {
    if (!this.store || typeof this.store.readProviderCache !== 'function') return null
    return await this.store.readProviderCache(provider, subject)
  }

  async _writeCache(provider, subject, answer, fetchedAt) {
    if (!this.store || typeof this.store.writeProviderCache !== 'function') return
    await this.store.writeProviderCache(provider, subject, {
      status: answer.status,
      keys: answer.keys,
      fetchedAt
    })
  }
}

// The shell's answer crosses a JSON seam and is not trusted: keep only the
// three fields the cache record defines, and only for a known status.
function normalizeAnswer(answer) {
  if (!answer || typeof answer !== 'object') {
    throw new EngineError(CODES.E_NET, 'Identity key lookup returned no result')
  }
  const status = String(answer.status || '')
  if (!STATUSES.includes(status)) {
    throw new EngineError(CODES.E_NET, `Identity key lookup returned an unknown status: ${status}`)
  }
  const source = Array.isArray(answer.keys) ? answer.keys : []
  const keys = []
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue
    if (!entry.keyType || !entry.blobBase64 || !entry.fingerprint) continue
    keys.push({
      keyType: String(entry.keyType),
      blobBase64: String(entry.blobBase64),
      fingerprint: String(entry.fingerprint)
    })
  }
  return { status, keys }
}

module.exports = {
  IdentityResolver,
  RESOLVE_REQUEST_EVENT,
  POSITIVE_TTL_MS,
  NEGATIVE_TTL_MS,
  DEFAULT_TIMEOUT_MS
}
