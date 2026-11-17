// relay/keys.js and relay/server.js (261115_quit-pins-reorder R11-R17, R20, U5):
// the relay secret and access salt (env over file over generated), the access
// key derived from both, and a running relay moving to a rotated key.
// Temp dirs only: every HOME here is a fresh scratch directory.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')
const test = require('brittle')
const createTestnet = require('hyperdht/testnet')

const keys = require('../relay/keys')

const SERVER = path.join(__dirname, '..', 'relay', 'server.js')
const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const KEY_LINE = /^ZBTerm relay access key: ([0-9a-f]{64})$/m

function scratchHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbrelay-'))
  t.teardown(() => {
    try {
      fs.chmodSync(dir, 0o700)
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function mode(file) {
  return fs.statSync(file).mode & 0o777
}

// An env for a child relay: the parent's, minus every relay key variable.
function childEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, ...extra }
  for (const name of ['ZBTERM_RELAY_SEED', 'ZBTERM_RELAY_ACCESS_SALT', 'ZBTERM_REGISTRY_SEED']) {
    if (!(name in extra)) delete env[name]
  }
  return env
}

function runCli(home, args, extra) {
  return spawnSync(process.execPath, [SERVER, ...args], {
    env: childEnv(home, extra),
    encoding: 'utf8',
    timeout: 20000
  })
}

test('parseHex: 64 hex characters, surrounding whitespace allowed', (t) => {
  t.alike(keys.parseHex(HEX_A + '\n'), Buffer.from(HEX_A, 'hex'))
  t.alike(keys.parseHex('  ' + HEX_A.toUpperCase() + ' \n'), Buffer.from(HEX_A, 'hex'))
  t.is(keys.parseHex(HEX_A.slice(1)), null)
  t.is(keys.parseHex(HEX_A + 'a'), null)
  t.is(keys.parseHex('g'.repeat(64)), null)
  t.is(keys.parseHex(''), null)
  t.is(keys.parseHex(undefined), null)
})

test('nothing anywhere: generated, saved 0600 in a 0700 ~/.zbterm, with an info line', (t) => {
  const home = scratchHome(t)
  const r = keys.resolveKey('secret', { home, env: {} })
  t.is(r.source, 'generated')
  t.is(r.value.length, 32)
  t.is(r.infos.length, 1)
  t.ok(r.infos[0].includes(path.join(home, '.zbterm', 'relay-secret')))
  t.is(r.errors.length, 0)
  const file = keys.keyFile(home, 'secret')
  t.is(fs.readFileSync(file, 'utf8').trim(), r.value.toString('hex'))
  if (process.platform !== 'win32') {
    t.is(mode(file), 0o600)
    t.is(mode(keys.keyDir(home)), 0o700)
  }
  const again = keys.resolveKey('secret', { home, env: {} })
  t.is(again.source, 'file')
  t.alike(again.value, r.value)
  t.is(again.infos.length + again.notes.length, 0)
})

test('env over file: a different value is used with a note, the file is left alone', (t) => {
  const home = scratchHome(t)
  const file = keys.keyFile(home, 'salt')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, HEX_A + '\n')
  const r = keys.resolveKey('salt', { home, env: { ZBTERM_RELAY_ACCESS_SALT: HEX_B } })
  t.is(r.source, 'env')
  t.alike(r.value, Buffer.from(HEX_B, 'hex'))
  t.is(r.notes.length, 1)
  t.ok(r.notes[0].includes('ZBTERM_RELAY_ACCESS_SALT') && r.notes[0].includes(file))
  t.is(fs.readFileSync(file, 'utf8'), HEX_A + '\n')

  const same = keys.resolveKey('salt', { home, env: { ZBTERM_RELAY_ACCESS_SALT: HEX_A } })
  t.is(same.source, 'env')
  t.is(same.notes.length, 0, 'same value: no note')
})

test('env without a file: used, nothing written', (t) => {
  const home = scratchHome(t)
  const r = keys.resolveKey('secret', { home, env: { ZBTERM_RELAY_SEED: HEX_A } })
  t.is(r.source, 'env')
  t.is(fs.existsSync(keys.keyFile(home, 'secret')), false)
})

test('an invalid file is an error naming it, and is never overwritten', (t) => {
  const home = scratchHome(t)
  const file = keys.keyFile(home, 'secret')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'not hex\n')
  t.exception(() => keys.resolveKey('secret', { home, env: {} }), new RegExp(escape(file)))
  t.is(fs.readFileSync(file, 'utf8'), 'not hex\n')
})

test('an invalid variable is an error', (t) => {
  const home = scratchHome(t)
  t.exception(
    () => keys.resolveKey('salt', { home, env: { ZBTERM_RELAY_ACCESS_SALT: 'xyz' } }),
    /ZBTERM_RELAY_ACCESS_SALT/
  )
})

test('create: false refuses to generate a missing key', (t) => {
  const home = scratchHome(t)
  t.exception(() => keys.resolveKey('salt', { home, env: {}, create: false }), /does not exist/)
  t.is(fs.existsSync(keys.keyDir(home)), false)
})

test('U5: an unwritable home still yields a key, with an error that it was not saved', (t) => {
  if (process.platform === 'win32' || process.getuid() === 0) {
    t.comment('needs a non-root POSIX user to make a directory read-only')
    return
  }
  const home = scratchHome(t)
  fs.chmodSync(home, 0o500)
  const r = keys.resolveKey('secret', { home, env: {} })
  t.is(r.source, 'generated')
  t.is(r.value.length, 32)
  t.is(r.saved, false)
  t.is(r.errors.length, 1)
  t.ok(r.errors[0].includes('will change on the next restart'))
})

test('access key: sha256(domain || secret || salt) as the DHT key pair seed', (t) => {
  const secret = Buffer.from(HEX_A, 'hex')
  const salt = Buffer.from(HEX_B, 'hex')
  const kp = keys.deriveKeyPair(secret, salt)
  const seed = crypto
    .createHash('sha256')
    .update('zbterm-relay-access-v1')
    .update(secret)
    .update(salt)
    .digest()
  t.alike(kp.publicKey, require('hyperdht').keyPair(seed).publicKey)
  t.unlike(kp.publicKey, keys.deriveKeyPair(secret, secret).publicKey, 'the salt changes the key')
  t.ok(KEY_LINE.test(keys.accessKeyLine(kp)))
})

test('rotateSalt writes a fresh 0600 salt atomically (no temp file left)', (t) => {
  const home = scratchHome(t)
  const first = keys.rotateSalt(home)
  const second = keys.rotateSalt(home)
  t.unlike(first.value, second.value)
  t.is(fs.readFileSync(second.file, 'utf8').trim(), second.value.toString('hex'))
  t.alike(fs.readdirSync(keys.keyDir(home)), ['relay-access'])
  if (process.platform !== 'win32') t.is(mode(second.file), 0o600)
})

test(
  'CLI: --print-key and --check write nothing; rotate prints the new key',
  { timeout: 60000 },
  (t) => {
    const home = scratchHome(t)
    const missing = runCli(home, ['--print-key'])
    t.is(missing.status, 1)
    t.ok(/does not exist/.test(missing.stderr))
    const check = runCli(home, ['--check'])
    t.is(check.status, 1)
    t.is(fs.existsSync(keys.keyDir(home)), false, 'nothing written')

    const rotated = runCli(home, ['--rotate-access-key'])
    t.is(rotated.status, 0)
    const key = rotated.stdout.match(KEY_LINE)[1]
    const printed = runCli(home, ['--print-key'])
    t.is(printed.status, 0)
    t.is(printed.stdout.trim(), `ZBTerm relay access key: ${key}`)
    const ok = runCli(home, ['--check'])
    t.is(ok.status, 0)
    t.ok(ok.stdout.includes(key))

    const noted = runCli(home, ['--rotate-access-key'], { ZBTERM_RELAY_ACCESS_SALT: HEX_A })
    t.is(noted.status, 0)
    t.ok(/ZBTERM_RELAY_ACCESS_SALT is set/.test(noted.stdout))
  }
)

test(
  'a running relay serves its access key and moves to a rotated one',
  { timeout: 90000 },
  async (t) => {
    const home = scratchHome(t)
    const testnet = await createTestnet(5, t.teardown)
    const bootstrap = testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',')

    const child = spawn(process.execPath, [SERVER], {
      env: childEnv(home, { ZBTERM_RELAY_BOOTSTRAP: bootstrap, ZBTERM_RELAY_PORT: '0' }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    t.teardown(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    })

    const firstKey = (
      await waitFor(
        () => out.match(KEY_LINE),
        20000,
        () => out
      )
    )[1]
    t.is(out.match(/^ZBTerm relay access key: /gm).length, 1, 'one access key line on start')

    const client = testnet.createNode()
    t.ok(await canConnect(client, firstKey), 'connects to the access key')

    const rotated = runCli(home, ['--rotate-access-key'])
    t.is(rotated.status, 0)
    const newKey = rotated.stdout.match(KEY_LINE)[1]
    t.not(newKey, firstKey)

    await waitFor(
      () => out.includes(`ZBTerm relay access key: ${newKey}`),
      20000,
      () => out
    )
    t.ok(await canConnect(client, newKey), 'connects to the new key')
    t.absent(await canConnect(client, firstKey), 'the old key no longer reaches the relay')

    // An invalid salt file: the relay keeps the current key and says why.
    fs.writeFileSync(keys.keyFile(home, 'salt'), 'garbage\n')
    await waitFor(
      () => /not a valid access salt/.test(out),
      20000,
      () => out
    )
    t.ok(await canConnect(client, newKey), 'still on the last good key')

    child.kill('SIGTERM')
    await new Promise((resolve) =>
      child.exitCode !== null ? resolve() : child.once('exit', resolve)
    )
  }
)

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function waitFor(fn, ms, describe) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const v = fn()
    if (v) return v
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out after ${ms} ms; output so far:\n${describe ? describe() : ''}`)
}

function canConnect(node, hex, ms = 20000) {
  return new Promise((resolve) => {
    const socket = node.connect(Buffer.from(hex, 'hex'))
    const timer = setTimeout(() => done(false), ms)
    function done(ok) {
      clearTimeout(timer)
      socket.removeAllListeners('open')
      socket.on('error', () => {})
      socket.destroy()
      resolve(ok)
    }
    socket.once('open', () => done(true))
    socket.once('error', () => done(false))
  })
}
