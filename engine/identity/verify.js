// Verifies one peer's presented identity claim during a join handshake.
//
// Two layers, both required (docs/identity-providers_plan.md, "Two-layer
// proof"):
//
//   1. the SSH-signed *claim* binds provider+subject -> identityKey -> authKey,
//      and the provider (github) must actually publish the SSH key that signed
//      it;
//   2. the live *challenge* signed by that authKey binds the claim to the peer
//      on this socket - the DHT keys inside the signed bytes are never
//      transmitted, so a relayed response cannot verify.
//
// Pure and injectable on purpose: nothing here imports ShareManager, and the
// resolver/store are parameters so the handshake tests can stub them.
const b4a = require('b4a')

const {
  claimBytes,
  fingerprint,
  parseArmoredSignature,
  verifyChallenge,
  verifySshSignature
} = require('./claim')
const { UNKNOWN, getProvider } = require('./providers')

// How long a verifier waits for the other side to answer its challenge. A
// timeout with a claim presented is a refusal (the caller turns a missing
// signature into `status:'failed'` via the check below).
const IDENTITY_TIMEOUT_MS = 15000
// The one non-refusing failure: we could not ask the provider whether it
// publishes this key. Encoded as `status:'unknown'` so the caller has nothing
// to special-case - an unreachable resolver downgrades, never refuses.
const RESOLVER_UNREACHABLE = 'resolver-unreachable'

async function verifyPeerIdentity(opts = {}) {
  const identityKey = String(opts.identityKey || '')
  const outcome = await evaluate(opts, identityKey)
  await persist(opts.store, identityKey, outcome)
  return outcome
}

// Layer 1 alone: the claim is validly signed and the provider publishes the
// signing key. Layer 2 (the live challenge) is exactly what this does NOT do,
// so a pass here means "this claim is genuine", never "the party in front of
// me holds it" - `verifyPeerIdentity` is still the only thing that decides
// whether a connection is allowed.
//
// Used to inspect an identity carried inside an invite link, where there is no
// connection to challenge yet. Nothing is persisted: a link someone pasted is
// not a peer this profile has met.
async function inspectClaim(opts = {}) {
  const claim = opts.claim
  const identityKey = String(opts.identityKey || (claim && claim.identityKey) || '')
  const shape = claimShape(claim, identityKey)
  if (shape.outcome) return shape.outcome
  const proof = await claimProof(claim, shape.provider, shape.subject, identityKey, opts.resolver)
  if (proof.outcome) return proof.outcome
  return {
    status: 'verified',
    displayId: shape.provider.displayId(shape.subject),
    provider: shape.provider.id,
    subject: shape.subject,
    sshFingerprint: proof.sshFingerprint,
    reason: null
  }
}

async function evaluate(opts, identityKey) {
  const claim = opts.claim
  const shape = claimShape(claim, identityKey)
  if (shape.outcome) return shape.outcome
  const { provider, subject } = shape

  // Connection-bound checks, between the two halves inspectClaim shares: they
  // run before the crypto so a peer that never answered is reported as such
  // rather than as whatever the resolver happened to say.
  //
  // A challenge that was never answered (timeout, or a peer that ignores the
  // message) is a refusal, so it must not fall through to the resolver - a
  // resolver hiccup would otherwise downgrade a silent prover to `unknown`.
  if (!opts.challenge || !opts.signature) {
    return failed(identityKey, claim, 'peer did not answer the identity challenge')
  }

  const authKey = String(opts.authKey || '')
  if (!authKey || String(claim.authKey || '') !== authKey) {
    return failed(
      identityKey,
      claim,
      'identity claim is not bound to the device auth key used on this connection'
    )
  }
  if (identityKey && String(claim.identityKey || '') !== identityKey) {
    return failed(identityKey, claim, 'identity claim is not bound to this peer identity key')
  }

  const proof = await claimProof(claim, provider, subject, identityKey, opts.resolver)
  if (proof.outcome) return proof.outcome

  if (!verifyChallenge(authKey, opts.challenge, opts.signature)) {
    return failed(identityKey, claim, 'identity challenge signature does not verify')
  }

  return {
    status: 'verified',
    displayId: provider.displayId(subject),
    provider: provider.id,
    subject,
    sshFingerprint: proof.sshFingerprint,
    reason: null
  }
}

// Does this even name a provider and a subject, and is it signed at all?
// Returns `{ provider, subject }` to carry on with, or `{ outcome }` that ends
// the evaluation.
function claimShape(claim, identityKey) {
  // No claim at all (older build, or the user chose UNKNOWN) is a first-class
  // allowed state, not a failure.
  if (!claim || typeof claim !== 'object') return { outcome: unknown(identityKey) }

  let provider = null
  try {
    provider = getProvider(claim.provider)
  } catch {
    return {
      outcome: failed(identityKey, claim, `unknown identity provider: ${String(claim.provider)}`)
    }
  }
  if (provider.id === UNKNOWN) return { outcome: unknown(identityKey) }

  let subject = null
  try {
    subject = provider.validateSubject(claim.subject)
  } catch {
    return {
      outcome: failed(
        identityKey,
        claim,
        `identity claim carries an invalid ${provider.label} username: ${String(claim.subject)}`
      )
    }
  }

  if (!claim.signature) {
    return { outcome: failed(identityKey, claim, 'identity claim is not signed') }
  }
  return { provider, subject }
}

// The SSHSIG over the canonical claim bytes, plus "does the provider actually
// publish this key". Needs no connection, so both the handshake gate and a
// link inspection run exactly this code.
async function claimProof(claim, provider, subject, identityKey, resolver) {
  let sshFingerprint = null
  try {
    const parsed = parseArmoredSignature(claim.signature)
    const blob = claim.sshPublicKey ? b4a.from(claim.sshPublicKey, 'base64') : parsed.pubkeyBlob
    if (!b4a.equals(blob, parsed.pubkeyBlob)) {
      return {
        outcome: failed(
          identityKey,
          claim,
          'identity claim public key does not match its signature'
        )
      }
    }
    sshFingerprint = fingerprint(blob)
    if (claim.sshFingerprint && claim.sshFingerprint !== sshFingerprint) {
      return {
        outcome: failed(
          identityKey,
          claim,
          'identity claim fingerprint does not match its signature'
        )
      }
    }
    if (
      !verifySshSignature({
        message: claimBytes(claim),
        armored: claim.signature,
        expectedPublicKeyBlob: blob
      })
    ) {
      return { outcome: failed(identityKey, claim, 'identity claim signature does not verify') }
    }
  } catch (err) {
    return {
      outcome: failed(
        identityKey,
        claim,
        `identity claim signature is unusable: ${(err && err.message) || err}`
      )
    }
  }

  if (provider.needsResolver) {
    let answer = null
    try {
      if (!resolver) throw new Error('no identity resolver')
      // Phase 3: resolve() can throw synchronously; `await` inside this try
      // catches both shapes.
      answer = await resolver.resolve(provider.id, subject)
    } catch {
      // Non-refusing by contract: we could not reach the provider, so we
      // cannot say the claim is wrong - downgrade to unknown.
      return { outcome: unknown(identityKey, RESOLVER_UNREACHABLE) }
    }
    const keys = answer && Array.isArray(answer.keys) ? answer.keys : []
    if (!answer || answer.status !== 'ok' || !keys.length) {
      return {
        outcome: failed(
          identityKey,
          claim,
          `${provider.displayId(subject)} publishes no SSH keys, so this identity claim cannot be checked`
        )
      }
    }
    if (!keys.some((key) => key && key.fingerprint === sshFingerprint)) {
      return {
        outcome: failed(
          identityKey,
          claim,
          `SSH key ${sshFingerprint} is not published by ${provider.displayId(subject)}`
        )
      }
    }
  }

  return { sshFingerprint }
}

function unknown(identityKey, reason = null) {
  return {
    status: 'unknown',
    displayId: getProvider(UNKNOWN).displayId(identityKey),
    provider: UNKNOWN,
    subject: null,
    sshFingerprint: null,
    reason
  }
}

// A failed claim keeps its *claimed* provider/subject in the result (so the UI
// and the emitted event can say what was claimed) but never gets that
// provider's displayId - an unverified peer always renders as UNKNOWN.
function failed(identityKey, claim, reason) {
  return {
    status: 'failed',
    displayId: getProvider(UNKNOWN).displayId(identityKey),
    provider: claim && claim.provider ? String(claim.provider) : UNKNOWN,
    subject: claim && claim.subject !== undefined ? claim.subject : null,
    sshFingerprint: claim && claim.sshFingerprint ? String(claim.sshFingerprint) : null,
    reason
  }
}

// Only a verified outcome writes a real provider/subject: a failed or unknown
// peer must not leave a record that renders as `alice@github`. putPeer merges,
// so localName/localComment survive.
async function persist(store, identityKey, outcome) {
  if (!store || typeof store.putPeer !== 'function') return
  if (!/^[0-9a-f]{2,128}$/.test(identityKey)) return
  const now = Date.now()
  const verified = outcome.status === 'verified'
  const patch = {
    provider: verified ? outcome.provider : UNKNOWN,
    subject: verified ? outcome.subject : null,
    status: outcome.status,
    sshFingerprint: outcome.sshFingerprint || null,
    failureReason: outcome.reason || null,
    lastSeenAt: now
  }
  if (verified) patch.lastVerifiedAt = now
  try {
    await store.putPeer(identityKey, patch)
  } catch {
    // Persisting is bookkeeping for the UI: a write failure must never turn
    // into a refused connection.
  }
}

module.exports = { verifyPeerIdentity, inspectClaim, IDENTITY_TIMEOUT_MS, RESOLVER_UNREACHABLE }
