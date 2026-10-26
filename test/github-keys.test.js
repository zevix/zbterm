const fs = require('fs')
const os = require('os')
const http = require('http')
const path = require('path')
const { spawnSync } = require('child_process')
const test = require('brittle')

const { testCore } = require('./helpers/zxterm-core')

// K9 of zxterm-core: the provider fetch lives in the Rust `zxterm-core`
// sidecar now (`identity.fetchKeys` / `identity.parseKeysBody` over the seam).
// The cap is the same frozen 64 KiB the old `electron/github-keys.js` exported.
const MAX_BODY_BYTES = 65536

const NO_SSH_KEYGEN = !hasSshKeygen()

function hasSshKeygen() {
  const result = spawnSync('ssh-keygen', ['-h'], { encoding: 'utf8' })
  return !result.error
}

function keygen(dir, name, type) {
  const file = path.join(dir, name)
  const result = spawnSync(
    'ssh-keygen',
    [
      '-q',
      '-t',
      type,
      '-b',
      type === 'rsa' ? '2048' : '256',
      '-N',
      '',
      '-C',
      `${name}@test`,
      '-f',
      file
    ],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) throw new Error(`ssh-keygen failed: ${result.stderr || result.stdout}`)
  return file
}

// `ssh-keygen -lf` prints `<bits> SHA256:<base64> <comment> (<TYPE>)`.
function keygenFingerprint(file) {
  const result = spawnSync('ssh-keygen', ['-lf', file], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`ssh-keygen -lf failed: ${result.stderr}`)
  return result.stdout.trim().split(/\s+/)[1]
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbterm-ghkeys-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A throwaway loopback server standing in for github.com. `handler` sees every
// request, so a test can count hits, redirect, stall, or return garbage.
async function serve(t, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(resolve)))
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

// A sidecar of the test's own on a short scratch directory, closed and then
// removed at teardown. Every fetch passes an explicit loopback `baseUrl`.
function makeCore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zxt-'))
  const core = testCore(t, { dir })
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return core
}

// The seam twin of the old `fetchKeys(subject, { baseUrl, timeoutMs })`.
function fetchKeys(core, subject, { baseUrl, timeoutMs } = {}) {
  return core.request('identity.fetchKeys', { subject, baseUrl, timeoutMs })
}

// The seam twin of the old `parseKeysBody(body)` (which returned the array).
async function parseKeysBody(core, body) {
  const { keys } = await core.request('identity.parseKeysBody', { body })
  return keys
}

test('a 200 body parses every key type and matches ssh-keygen fingerprints', async (t) => {
  if (NO_SSH_KEYGEN) return t.pass('ssh-keygen not available')
  const core = makeCore(t)
  const dir = tmpdir(t)
  const ed = keygen(dir, 'ed', 'ed25519')
  const rsa = keygen(dir, 'rsa', 'rsa')
  const commented = keygen(dir, 'commented', 'ed25519')
  const edLine = fs
    .readFileSync(ed + '.pub', 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ')
  const rsaLine = fs
    .readFileSync(rsa + '.pub', 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ')
  // Kept verbatim, comment and all: `~/.ssh/*.pub` looks like this and the
  // parser must not choke on the trailing field.
  const commentedLine = fs.readFileSync(commented + '.pub', 'utf8').trim()

  const { baseUrl } = await serve(t, (req, res) => {
    t.is(req.url, '/octocat.keys', 'requests <user>.keys')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end([edLine, rsaLine, commentedLine, ''].join('\n'))
  })

  const result = await fetchKeys(core, 'octocat', { baseUrl })
  t.is(result.status, 'ok')
  t.is(result.keys.length, 3, 'all three key types are kept - the caller filters to ed25519')
  t.is(result.keys[0].keyType, 'ssh-ed25519')
  t.is(result.keys[1].keyType, 'ssh-rsa')
  t.is(result.keys[2].keyType, 'ssh-ed25519')
  t.is(result.keys[0].fingerprint, keygenFingerprint(ed + '.pub'))
  t.is(result.keys[1].fingerprint, keygenFingerprint(rsa + '.pub'))
  t.is(result.keys[2].fingerprint, keygenFingerprint(commented + '.pub'))
  t.is(result.keys[2].blobBase64, commentedLine.split(/\s+/)[1], 'blob excludes the comment')
})

test('404 is not-found, not an error', async (t) => {
  const core = makeCore(t)
  const { baseUrl } = await serve(t, (req, res) => {
    res.writeHead(404)
    res.end('Not Found')
  })
  const result = await fetchKeys(core, 'nobody', { baseUrl })
  t.alike(result, { status: 'not-found', keys: [] })
})

test('a 200 with an empty body is ok with no keys', async (t) => {
  const core = makeCore(t)
  const { baseUrl } = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('')
  })
  const result = await fetchKeys(core, 'keyless', { baseUrl })
  t.is(result.status, 'ok')
  t.is(result.keys.length, 0, 'a user with no published keys is ok, not not-found')
})

test('a non-2xx other than 404 rejects', async (t) => {
  const core = makeCore(t)
  const { baseUrl } = await serve(t, (req, res) => {
    res.writeHead(503)
    res.end('nope')
  })
  await t.exception(fetchKeys(core, 'octocat', { baseUrl }), /HTTP 503/)
})

test('follows a redirect for a renamed account', async (t) => {
  const core = makeCore(t)
  const { baseUrl } = await serve(t, (req, res) => {
    if (req.url === '/OldName.keys') {
      res.writeHead(301, { location: '/newname.keys' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ssh-ed25519 ' + 'A'.repeat(68) + '\n')
  })
  const result = await fetchKeys(core, 'OldName', { baseUrl })
  t.is(result.status, 'ok')
  t.is(result.keys.length, 1)
})

test('rejects a redirect that leaves the .keys path', async (t) => {
  const core = makeCore(t)
  const { baseUrl } = await serve(t, (req, res) => {
    res.writeHead(302, { location: '/login' })
    res.end()
  })
  await t.exception(fetchKeys(core, 'octocat', { baseUrl }), /left the \.keys path/)
})

test('rejects more than two redirects', async (t) => {
  const core = makeCore(t)
  let hops = 0
  const { baseUrl } = await serve(t, (req, res) => {
    hops++
    res.writeHead(302, { location: `/hop${hops}.keys` })
    res.end()
  })
  await t.exception(fetchKeys(core, 'octocat', { baseUrl }), /redirects/)
  t.is(hops, 3, 'the original request plus exactly two follows')
})

test('aborts a body over the 64 KiB cap', async (t) => {
  const core = makeCore(t)
  const { baseUrl } = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ssh-ed25519 ' + 'A'.repeat(MAX_BODY_BYTES + 1024) + '\n')
  })
  await t.exception(fetchKeys(core, 'octocat', { baseUrl }), /exceeded 65536 bytes/)
})

test('times out on a stalled response', async (t) => {
  const core = makeCore(t)
  const { baseUrl } = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.write('ssh-ed25519 ')
    // never ends
  })
  await t.exception(
    fetchKeys(core, 'octocat', { baseUrl, timeoutMs: 150 }),
    /timed out after 150ms/
  )
})

test('ignores lines that are not recognisable key lines', async (t) => {
  const core = makeCore(t)
  const keys = await parseKeysBody(
    core,
    [
      '# a comment',
      '',
      'sk-ssh-ed25519@openssh.com AAAA',
      'not-a-key',
      'ssh-dss AAAAB3NzaC1kc3MAAA',
      'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY=',
      ''
    ].join('\n')
  )
  t.is(keys.length, 1, 'only the ecdsa line survives')
  t.is(keys[0].keyType, 'ecdsa-sha2-nistp256')
  t.ok(keys[0].fingerprint.startsWith('SHA256:'))
})
