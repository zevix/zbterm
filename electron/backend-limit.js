// Resolves the share-backend limit the host hands to the core worker as its
// 4th spawn argument (docs/CORE-CONTRACT.md "Sidecar launch"). The flag wins
// over the environment variable. The value only ever LIMITS the backends a
// build carries - it never adds one - so an unknown value is passed through
// and selects nothing (fail closed) rather than being ignored.
const BACKEND_CHOICES = ['pear', 'freenet', 'none']

function resolveBackendLimit({ flag, env } = {}) {
  const fromFlag = normalise(flag)
  if (fromFlag) return describe(fromFlag, 'flag')
  const fromEnv = normalise(env && env.ZBTERM_BACKEND)
  if (fromEnv) return describe(fromEnv, 'env')
  return { value: '', source: null, known: true }
}

function describe(value, source) {
  return { value, source, known: BACKEND_CHOICES.includes(value) }
}

function normalise(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

module.exports = { BACKEND_CHOICES, resolveBackendLimit }
