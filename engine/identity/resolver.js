// "Does <provider> user <subject> publish this SSH key?" - a thin
// call-through to the Rust `zxterm-core` sidecar (K9 of zxterm-core, in
// `zevix/zxterm`; not this directory's own JS package, `zbterm-core`).
//
// The sidecar fetches `https://github.com/<user>.keys` itself
// (`zxterm_core::identity::github`, base URL overridable with
// `ZBTERM_GITHUB_KEYS_BASE`) and caches answers, positive and negative,
// under `<profile>/identity/provider-cache/` with the same TTLs as before
// (`zxterm_core::identity::resolver`). The old round trip through the shell
// (an `identity:resolve-request` event answered by an
// `identity.resolveResult` invoke) is gone.
const { EngineError, CODES } = require('../errors')
const { getProvider } = require('./providers')

const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000
const NEGATIVE_TTL_MS = 10 * 60 * 1000

class IdentityResolver {
  // `opts.core` is the profile's `Core`; `opts.store` (an `IdentityStore`)
  // lends it its own when no core is given.
  constructor(opts = {}) {
    this.core = opts.core || (opts.store && opts.store.core) || null
    this.closed = false
  }

  // Resolves `{ status, keys: [{ keyType, blobBase64, fingerprint }],
  // fetchedAt, source: 'cache' | 'cache-stale' | 'remote' }`. Never rejects
  // for "no such user" (`status: 'not-found'`); rejects (E_NET) only when the
  // lookup failed and no stale cache entry was left to fall back on. An
  // unknown provider or an invalid subject throws before anything is asked.
  // `opts.refresh` skips a fresh cache entry.
  resolve(provider, subject, opts = {}) {
    const providerId = getProvider(provider).id
    const normalized = getProvider(provider).validateSubject(subject)
    if (this.closed) {
      return Promise.reject(new EngineError(CODES.E_NET, 'Identity resolver is closed'))
    }
    if (!this.core) {
      return Promise.reject(
        new EngineError(CODES.E_BACKEND_UNAVAILABLE, 'Identity resolver has no zxterm-core')
      )
    }
    return this.core.request('identity.resolve', {
      provider: providerId,
      subject: normalized,
      refresh: !!opts.refresh
    })
  }

  close() {
    this.closed = true
  }
}

module.exports = { IdentityResolver, POSITIVE_TTL_MS, NEGATIVE_TTL_MS }
