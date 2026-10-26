// How this build was installed, and - for the npm channel only - whether a
// newer `zbterm` is on the registry.
//
// No build has an OTA updater any more (D-08), so the packaged channel has no
// update mechanism of its own. For an npm install the only honest update
// signal is the registry, polled at most once a day and
// never in a way that can block or fail startup.
const http = require('http')
const https = require('https')
const path = require('path')

const CHANNELS = ['npm', 'packaged', 'dev']
const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org/zbterm/latest'
const DEFAULT_TIMEOUT_MS = 5000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
// The registry's `latest` document is a few KB; anything larger is either a
// mistake or hostile, and there is no reason to buffer it.
const MAX_BODY_BYTES = 512 * 1024

const NPM_ROOT_SEGMENT = 'node_modules' + path.sep + 'zbterm'

function detectChannel({ appPath, isPackaged, env } = {}) {
  const environment = env || {}
  const forced =
    typeof environment.ZBTERM_CHANNEL === 'string' ? environment.ZBTERM_CHANNEL.trim() : ''
  // Only a known channel name overrides detection - a typo must not silently
  // put the app on a channel that behaves like none of the three.
  if (CHANNELS.includes(forced)) return forced

  const root = typeof appPath === 'string' ? appPath : ''
  if (root && (root + path.sep).includes(NPM_ROOT_SEGMENT + path.sep)) return 'npm'
  if (isPackaged) return 'packaged'
  return 'dev'
}

// MAJOR.MINOR.PATCH only. A prerelease/build suffix is dropped before the
// comparison, so 1.2.3-beta.1 and 1.2.3 compare equal - deliberately
// conservative: it can only ever suppress an update prompt, never invent one.
function parseVersion(value) {
  if (typeof value !== 'string') return null
  const core = value.trim().replace(/^v/, '').split(/[-+]/)[0]
  const parts = core.split('.')
  if (parts.length !== 3) return null
  const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : NaN))
  if (numbers.some((n) => !Number.isFinite(n))) return null
  return numbers
}

function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  }
  return 0
}

function requestJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed = null
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error('invalid registry url: ' + url))
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
      finish(new Error('registry request timed out after ' + timeoutMs + 'ms'))
    }, timeoutMs)

    request = transport.get(parsed, { headers: { accept: 'application/json' } }, (res) => {
      const chunks = []
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes <= MAX_BODY_BYTES) chunks.push(chunk)
      })
      res.on('error', (err) => finish(err))
      res.on('end', () => {
        finish(null, {
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        })
      })
    })
    request.on('error', (err) => finish(err))
  })
}

function readCache(cache) {
  if (!cache || typeof cache.get !== 'function') return null
  try {
    const value = cache.get()
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function writeCache(cache, value) {
  if (!cache || typeof cache.set !== 'function') return
  try {
    cache.set(value)
  } catch {}
}

// Never throws and never rejects: every failure - offline, DNS, timeout, 404
// (the package is not published yet), garbage body - resolves to
// `{ available: false }` so the caller has nothing to guard against.
async function checkForUpdate({
  currentVersion,
  registryUrl = DEFAULT_REGISTRY_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cache = null,
  now = Date.now()
} = {}) {
  const cached = readCache(cache)
  if (
    cached &&
    typeof cached.checkedAt === 'number' &&
    cached.current === currentVersion &&
    now - cached.checkedAt < CACHE_TTL_MS
  ) {
    return { ...cached, fromCache: true }
  }

  const base = { available: false, latest: null, current: currentVersion, checkedAt: now }

  let response = null
  try {
    response = await requestJson(registryUrl, timeoutMs)
  } catch (err) {
    // Not cached: a transient network failure must not silence the check for
    // a whole day.
    return { ...base, error: err.message }
  }

  if (response.statusCode === 404) {
    // The package has never been published (or was unpublished). That is a
    // legitimate "no update", not an error worth surfacing.
    const result = { ...base, reason: 'not-published' }
    writeCache(cache, result)
    return result
  }

  if (response.statusCode !== 200) {
    return { ...base, error: 'registry responded with HTTP ' + response.statusCode }
  }

  let latest = null
  try {
    const doc = JSON.parse(response.body)
    latest = doc && typeof doc.version === 'string' ? doc.version : null
  } catch (err) {
    return { ...base, error: 'registry response was not JSON: ' + err.message }
  }

  const comparison = compareVersions(latest, currentVersion)
  if (comparison === null) {
    return { ...base, error: 'unrecognised version in registry response: ' + String(latest) }
  }

  const result = { ...base, available: comparison > 0, latest }
  writeCache(cache, result)
  return result
}

module.exports = {
  detectChannel,
  checkForUpdate,
  compareVersions,
  parseVersion,
  CHANNELS,
  CACHE_TTL_MS,
  DEFAULT_REGISTRY_URL,
  DEFAULT_TIMEOUT_MS
}
