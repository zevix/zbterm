// No migration (D-23, zxterm-core X-01, ZBTerm D-32): a profile whose
// identity was made by the old identity-key scheme gets a fresh identity from
// the Rust `zxterm-core` sidecar on its first start, its self claim is
// cleared, and exactly one log line says so. The fixture
// (test/fixtures/identity/old-scheme-account/) is an account the old scheme
// wrote; see test/fixtures/identity/README.md.
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('brittle')

require('./helpers/zxterm-core')
const SessionEngine = require('../engine')
const { OLD_SCHEME_IDENTITY_LOG } = require('../engine')

const FIXTURE = path.join(__dirname, 'fixtures', 'identity', 'old-scheme-account')

class NoPty {
  on() {}
}

function captureLog(t) {
  const lines = []
  const original = console.log
  console.log = (...args) => {
    lines.push(args.join(' '))
    original.apply(console, args)
  }
  t.teardown(() => {
    console.log = original
  })
  return lines
}

test('an old-scheme profile starts with a fresh identity, a cleared claim and one log line', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-nomig-'))
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  const profilePath = path.join(dir, 'p')
  const account = path.join(profilePath, 'account')
  await fs.promises.cp(FIXTURE, account, { recursive: true })
  const oldProfile = JSON.parse(
    await fs.promises.readFile(path.join(account, 'profile', 'self.json'), 'utf8')
  )
  // A self claim that names the old identity key, as that profile had one.
  await fs.promises.mkdir(path.join(account, 'identity'), { recursive: true })
  await fs.promises.writeFile(
    path.join(account, 'identity', 'self.json'),
    JSON.stringify({
      version: 2,
      provider: 'github',
      subject: 'octocat',
      identityKey: oldProfile.identityKey,
      authKey: 'ab'.repeat(32),
      sshPublicKey: null,
      sshKeyType: 'ssh-ed25519',
      sshFingerprint: 'SHA256:placeholder',
      issuedAt: 1750000000000,
      nonce: 'cd'.repeat(16),
      signature: 'not checked on read',
      createdAt: 1750000000000
    })
  )
  const lines = captureLog(t)

  const first = new SessionEngine({ userData: dir, profilePath, ptyHost: new NoPty() })
  await first.ready()
  const got = await first.invoke('identity.get')
  const self = await first.invoke('identity.self')
  await first.close()

  t.not(got.identityKey, oldProfile.identityKey, 'the identity key is fresh')
  t.is(got.provider, 'unknown', 'the self claim was cleared')
  t.is(self.configured, false)
  t.is(self.identityKey, got.identityKey, 'the cleared claim names the fresh identity')
  t.is(
    lines.filter((line) => line === OLD_SCHEME_IDENTITY_LOG).length,
    1,
    'the log line appears once'
  )

  const second = new SessionEngine({ userData: dir, profilePath, ptyHost: new NoPty() })
  await second.ready()
  const again = await second.invoke('identity.get')
  await second.close()

  t.is(again.identityKey, got.identityKey, 'a second start keeps the fresh identity')
  t.is(
    lines.filter((line) => line === OLD_SCHEME_IDENTITY_LOG).length,
    1,
    'and logs nothing more: exactly once across both starts'
  )
})
