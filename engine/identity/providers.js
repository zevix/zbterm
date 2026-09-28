// Identity provider registry. v1 ships `unknown` (never proven) and `github`
// (proven by an SSH signature over a claim plus the published .keys list).
// Adding a provider means adding an entry here; nothing else in the identity
// pipeline knows provider names.
const { EngineError, CODES } = require('../errors')

const UNKNOWN = 'unknown'
const GITHUB = 'github'
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

const PROVIDERS = {
  [UNKNOWN]: {
    id: UNKNOWN,
    label: 'Unverified',
    needsResolver: false,
    // The `subject` of an unknown identity is the identity key hex; only the
    // first 12 hex chars are ever shown.
    displayId(subject) {
      return `${String(subject || '').slice(0, 12)}@UNKNOWN`
    },
    validateSubject(subject) {
      return String(subject || '').toLowerCase()
    }
  },
  [GITHUB]: {
    id: GITHUB,
    label: 'GitHub',
    needsResolver: true,
    displayId(subject) {
      return `${String(subject || '').toLowerCase()}@github`
    },
    validateSubject(subject) {
      const value = String(subject === null || subject === undefined ? '' : subject).trim()
      if (!GITHUB_USERNAME.test(value)) {
        throw new EngineError(CODES.E_AUTH, `Invalid github username: ${value}`)
      }
      return value.toLowerCase()
    }
  }
}

function getProvider(id) {
  const provider = PROVIDERS[id]
  if (!provider) throw new EngineError(CODES.E_AUTH, `Unknown identity provider: ${id}`)
  return provider
}

function displayIdFor(providerId, subject) {
  return getProvider(providerId).displayId(subject)
}

function listProviders() {
  return Object.values(PROVIDERS).map((provider) => ({
    id: provider.id,
    label: provider.label,
    needsResolver: provider.needsResolver
  }))
}

module.exports = {
  PROVIDERS,
  UNKNOWN,
  GITHUB,
  GITHUB_USERNAME,
  getProvider,
  displayIdFor,
  listProviders
}
