// Z4 (`docs/projects/260928_zbterm-fork/requirements.md` Z-4, `D-23`): a Pear invite, a
// Freenet invite and a signed identity claim made by the predecessor code (see
// `test/fixtures/former-name/README.md`) are all refused by ZBTerm, with a message that
// says why, well under `engine/share-manager.js`'s JOIN_TIMEOUT_MS.
//
// The fixtures are hex-encoded so the predecessor's name never appears as raw bytes in
// this tree (test/name.test.js). This file mirrors that: it never spells the name out
// either, so the scheme a rejected invite carried is read back out of the decoded fixture
// bytes at run time, never typed here.
const fs = require('fs')
const path = require('path')
const test = require('brittle')

const ShareManager = require('../engine/share-manager')
const { decodeLink, LINK_PREFIX } = require('../engine/invite')
const { CODES } = require('../engine/errors')
const { inspectClaim } = require('../engine/identity/verify')
const { verifySshSignature } = require('../engine/identity/claim')

// Mirrors engine/share-manager.js's own JOIN_TIMEOUT_MS (not exported). A join that fails
// synchronously (decodeLink throws before any network/timer code runs) should take low
// single-digit milliseconds, not seconds - this is the margin "well under" is checked against.
const JOIN_TIMEOUT_MS = 30 * 1000
const FIXTURES = path.join(__dirname, 'fixtures', 'former-name')

function loadHexBuffer(name) {
  const hex = fs.readFileSync(path.join(FIXTURES, name), 'utf8').trim()
  return Buffer.from(hex, 'hex')
}

function loadHex(name) {
  return loadHexBuffer(name).toString('utf8')
}

function schemeOf(uri) {
  const match = uri.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)
  return match ? match[0] : uri.slice(0, 32)
}

const PEAR_INVITE = loadHex('pear-invite.hex')
const FREENET_INVITE = loadHex('freenet-invite.hex')
const CLAIM = JSON.parse(loadHex('claim.hex'))
const CLAIM_MESSAGE = loadHexBuffer('claim-message.hex')

test('sanity: the fixtures are not ZBTerm-scheme links', (t) => {
  t.absent(PEAR_INVITE.startsWith(LINK_PREFIX), 'pear fixture does not use zbterm://join/')
  t.absent(FREENET_INVITE.startsWith(LINK_PREFIX), 'freenet fixture does not use zbterm://join/')
  t.ok(PEAR_INVITE.includes('://join/'), 'sanity: still looks like an invite URI')
  t.ok(FREENET_INVITE.includes('://join/'), 'sanity: still looks like an invite URI')
})

test('decodeLink refuses a former-name Pear invite at once, naming the scheme it got', (t) => {
  const scheme = schemeOf(PEAR_INVITE)
  const started = Date.now()
  let caught = null
  try {
    decodeLink(PEAR_INVITE)
  } catch (err) {
    caught = err
  }
  const elapsed = Date.now() - started
  t.ok(caught, 'decodeLink throws')
  t.is(caught.code, CODES.E_AUTH)
  t.ok(/not a ZBTerm link/.test(caught.message), 'says it is not a ZBTerm link')
  t.ok(caught.message.includes(scheme), `quotes the scheme it got (${scheme})`)
  t.ok(elapsed < JOIN_TIMEOUT_MS / 10, `fails at once (${elapsed}ms), not near the join timeout`)
})

test('decodeLink refuses a former-name Freenet invite at once, naming the scheme it got', (t) => {
  const scheme = schemeOf(FREENET_INVITE)
  const started = Date.now()
  let caught = null
  try {
    decodeLink(FREENET_INVITE)
  } catch (err) {
    caught = err
  }
  const elapsed = Date.now() - started
  t.ok(caught, 'decodeLink throws')
  t.is(caught.code, CODES.E_AUTH)
  t.ok(/not a ZBTerm link/.test(caught.message), 'says it is not a ZBTerm link')
  t.ok(caught.message.includes(scheme), `quotes the scheme it got (${scheme})`)
  t.ok(elapsed < JOIN_TIMEOUT_MS / 10, `fails at once (${elapsed}ms), not near the join timeout`)
})

test('ShareManager.join refuses a former-name Pear invite at once, with E_AUTH', async (t) => {
  const manager = new ShareManager({ sessions: new Map() })
  t.teardown(() => manager.close())
  const started = Date.now()
  await t.exception(
    () => manager.join(PEAR_INVITE),
    /not a ZBTerm link/,
    'join fails the same way decodeLink does - it calls decodeLink first'
  )
  const elapsed = Date.now() - started
  t.ok(
    elapsed < JOIN_TIMEOUT_MS / 10,
    `fails at once (${elapsed}ms), never hangs to the join timeout`
  )
})

test('ShareManager.join refuses a former-name Freenet invite at once, with E_AUTH', async (t) => {
  const manager = new ShareManager({ sessions: new Map() })
  t.teardown(() => manager.close())
  const started = Date.now()
  await t.exception(
    () => manager.join(FREENET_INVITE),
    /not a ZBTerm link/,
    'join fails the same way decodeLink does - it calls decodeLink first'
  )
  const elapsed = Date.now() - started
  t.ok(
    elapsed < JOIN_TIMEOUT_MS / 10,
    `fails at once (${elapsed}ms), never hangs to the join timeout`
  )
})

test("a former-name-signed identity claim does not verify under ZBTerm's namespace", async (t) => {
  t.ok(CLAIM.signature.includes('BEGIN SSH SIGNATURE'), 'sanity: fixture carries a real SSHSIG')
  const outcome = await inspectClaim({ claim: CLAIM })
  t.is(outcome.status, 'failed', 'a claim signed under the predecessor namespace is not verified')
  t.ok(outcome.reason, 'the error says why')
  t.ok(/does not verify/.test(outcome.reason), `reason names the cause: ${outcome.reason}`)
})

// Isolates the NAMESPACE check itself, decoupled from CLAIM_MAGIC (which also differs from
// the predecessor and would otherwise mask a reverted NAMESPACE behind an unrelated digest
// mismatch): CLAIM_MESSAGE is the exact byte string the fixture's signature was made over, so
// recomputing claimBytes() from current code never enters this comparison. This is the half of
// the suite the acceptance check ("fails if NAMESPACE is set back") is aimed at - flip
// engine/identity/claim.js's NAMESPACE to the predecessor's own and this test goes red; revert
// it and it's green again.
test("the predecessor SSHSIG namespace does not verify against ZBTerm's own", (t) => {
  t.absent(
    verifySshSignature({ message: CLAIM_MESSAGE, armored: CLAIM.signature }),
    'a signature namespaced for the predecessor does not verify under the current NAMESPACE default'
  )
})
