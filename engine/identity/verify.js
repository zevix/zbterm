// Verifies a peer's presented identity claim - a thin call-through to the
// Rust `zxterm-core` sidecar (K9 of zxterm-core, in `zevix/zxterm`; not this
// directory's own JS package, `zbterm-core`), whose
// `zxterm_core::identity::verify` runs both layers
// (docs/identity-providers_plan.md, "Two-layer proof"):
//
//   1. the SSH-signed *claim* binds provider+subject -> identityKey -> authKey,
//      and the provider (github) must actually publish the SSH key that signed
//      it;
//   2. the live *challenge* signed by that authKey binds the claim to the peer
//      on this socket - the DHT keys inside the signed bytes are never
//      transmitted, so a relayed response cannot verify.
//
// The sidecar resolves provider keys with its own resolver and records the
// outcome in its own peer store (`<profile>/identity/peers/`), which is why
// both functions take the profile's `Core`: `opts.core`, else the core of
// `opts.store` or `opts.resolver`, else this process's default sidecar.
const { coreFor } = require('../zxterm/core')
const { claimJson, challengeJson } = require('./claim')

// How long a verifier waits for the other side to answer its challenge. A
// timeout with a claim presented is a refusal.
const IDENTITY_TIMEOUT_MS = 15000
// The one non-refusing failure: we could not ask the provider whether it
// publishes this key (`status: 'unknown'`).
const RESOLVER_UNREACHABLE = 'resolver-unreachable'

function coreOf(opts) {
  return coreFor(
    opts.core || (opts.store && opts.store.core) || (opts.resolver && opts.resolver.core) || null
  )
}

function outcome(answer) {
  return {
    status: answer.status,
    displayId: answer.displayId,
    provider: answer.provider,
    subject: answer.subject,
    sshFingerprint: answer.sshFingerprint,
    reason: answer.reason
  }
}

function hexOf(value) {
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value === 'string') return value
  return Buffer.from(value).toString('hex')
}

async function verifyPeerIdentity(opts = {}) {
  const claim = opts.claim && typeof opts.claim === 'object' ? claimJson(opts.claim) : null
  const answer = await coreOf(opts).request('identity.verifyClaim', {
    claim,
    challenge: opts.challenge ? challengeJson(opts.challenge) : null,
    identityKeyHex: String(opts.identityKey || ''),
    authKeyHex: opts.authKey ? String(opts.authKey) : undefined,
    signatureHex: hexOf(opts.signature)
  })
  return outcome(answer)
}

// Layer 1 alone (an invite's claim, no connection to challenge yet); never
// recorded as a peer.
async function inspectClaim(opts = {}) {
  const claim = opts.claim && typeof opts.claim === 'object' ? claimJson(opts.claim) : null
  const answer = await coreOf(opts).request('identity.inspectInvite', { claim })
  return outcome(answer)
}

module.exports = { verifyPeerIdentity, inspectClaim, IDENTITY_TIMEOUT_MS, RESOLVER_UNREACHABLE }
