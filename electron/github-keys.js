// Fetches a GitHub user's published SSH public keys (`https://github.com/<u>.keys`).
//
// This lives in the Electron shell for the same reason `ssh-keys.js` does: the
// Bare worker has no HTTP client (see docs/identity-providers_plan.md, "Repo
// facts"). The worker asks for a lookup over the `identity:resolve-request`
// engine event and gets the answer back through `identity.resolveResult`.
//
// Deliberately free of any `electron` require so tests can load it under plain
// Node. Fingerprints come from `engine/identity/claim.js` - never re-implement
// them here, they must match `ssh-keygen -lf`.
const http = require('http')
const https = require('https')
const b4a = require('b4a')

const { fingerprint } = require('../engine/identity/claim')

const DEFAULT_BASE_URL = 'https://github.com'
const DEFAULT_TIMEOUT_MS = 8000
// `.keys` for a human is a few hundred bytes; 64 KiB is already absurd and
// there is no reason to buffer more of a body we did not ask for.
const MAX_BODY_BYTES = 64 * 1024
const MAX_REDIRECTS = 2
// Keys we know how to name. Anything else on the line is ignored outright -
// the *caller* is what narrows this to ed25519 (v1 only verifies ed25519).
const KEY_TYPES = ['ssh-ed25519', 'ssh-rsa']
const ECDSA_PREFIX = 'ecdsa-'

function baseUrlDefault() {
  const configured = process.env.ZBTERM_GITHUB_KEYS_BASE
  return typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_BASE_URL
}

function isKnownKeyType(keyType) {
  return KEY_TYPES.includes(keyType) || keyType.startsWith(ECDSA_PREFIX)
}

// GitHub serves one key per line: `<type> <base64>` with no comment. We accept
// a trailing comment anyway (that is what `~/.ssh/*.pub` looks like, and a
// hand-fed fixture will have one).
function parseKeysBody(body) {
  const keys = []
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 2) continue
    const keyType = parts[0]
    if (!isKnownKeyType(keyType)) continue
    let blob = null
    try {
      blob = b4a.from(parts[1], 'base64')
    } catch {
      continue
    }
    // A base64 decode never throws on garbage, it truncates - so re-encode and
    // compare rather than trusting the length alone.
    if (!blob.length || b4a.toString(blob, 'base64') !== parts[1]) continue
    keys.push({ keyType, blobBase64: parts[1], fingerprint: fingerprint(blob) })
  }
  return keys
}

function requestOnce(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed = null
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error('invalid github keys url: ' + url))
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('unsupported protocol for github keys url: ' + parsed.protocol))
      return
    }

    const transport = parsed.protocol === 'http:' ? http : https
    let settled = false
    let request = null

    function finish(err, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (request) request.destroy()
      } catch {}
      if (err) reject(err)
      else resolve(value)
    }

    const timer = setTimeout(() => {
      finish(new Error('github keys request timed out after ' + timeoutMs + 'ms'))
    }, timeoutMs)

    request = transport.get(parsed, { headers: { accept: 'text/plain' } }, (res) => {
      const chunks = []
      let bytes = 0
      let capped = false
      res.on('data', (chunk) => {
        if (capped) return
        bytes += chunk.length
        if (bytes > MAX_BODY_BYTES) {
          capped = true
          finish(new Error('github keys response exceeded ' + MAX_BODY_BYTES + ' bytes'))
          return
        }
        chunks.push(chunk)
      })
      res.on('error', (err) => finish(err))
      res.on('end', () => {
        if (capped) return
        finish(null, {
          statusCode: res.statusCode,
          location: res.headers.location || null,
          body: Buffer.concat(chunks).toString('utf8')
        })
      })
    })
    request.on('error', (err) => finish(err))
  })
}

// Resolves `{ status: 'ok' | 'not-found', keys: [{ keyType, blobBase64,
// fingerprint }] }`. A 200 with an empty body is `ok` with no keys - that user
// simply publishes none, which is a different thing from "no such user" and
// must still fail verification later. Any other non-2xx rejects.
async function fetchKeys(username, opts = {}) {
  const name = String(username === null || username === undefined ? '' : username).trim()
  if (!name) throw new Error('github username is required')
  const baseUrl = opts.baseUrl || baseUrlDefault()
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS

  let url = String(baseUrl).replace(/\/+$/, '') + '/' + encodeURIComponent(name) + '.keys'
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await requestOnce(url, timeoutMs)
    const status = response.statusCode
    if (status === 404) return { status: 'not-found', keys: [] }
    if (status >= 300 && status < 400) {
      if (!response.location) throw new Error('github keys redirect without a location header')
      // A renamed account 301s `/<OldName>.keys` to the new one. Follow it, but
      // a redirect that lands anywhere other than another `.keys` document is
      // not something we should be parsing as keys.
      const next = new URL(response.location, url)
      if (!next.pathname.endsWith('.keys')) {
        throw new Error('github keys redirect left the .keys path: ' + next.pathname)
      }
      url = next.toString()
      continue
    }
    if (status < 200 || status > 299) {
      throw new Error('github responded with HTTP ' + status + ' for ' + name + '.keys')
    }
    return { status: 'ok', keys: parseKeysBody(response.body) }
  }
  throw new Error('github keys request exceeded ' + MAX_REDIRECTS + ' redirects')
}

module.exports = {
  fetchKeys,
  parseKeysBody,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_REDIRECTS
}
