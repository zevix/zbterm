#!/usr/bin/env node
// Headless proof that `zbterm-core` needs no Electron: plain Node launches
// the sidecar (engine/worker.js under the Bare runtime), injects a fake PTY
// host, creates a session, records terminal output through it, and reads the
// catalog back.
//
//   node scripts/core-headless-smoke.js
//   ZBTERM_CORE=/tmp/prefix/lib/node_modules/zbterm-core node scripts/core-headless-smoke.js
//
// ZBTERM_CORE points the script at an installed copy of the core package
// instead of the in-repo one, which is how the packed tarball is validated.
// Exit 0 = the whole create -> record -> read-catalog cycle completed and no
// Electron process was involved.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { execFileSync } = require('child_process')

const CORE = process.env.ZBTERM_CORE || path.join(__dirname, '..', 'engine')
const { EngineClient } = require(path.join(CORE, 'client.js'))

const TIMEOUT_MS = Number(process.env.ZBTERM_SMOKE_TIMEOUT_MS || 120000)
const BANNER = 'zbterm-core headless smoke\r\n'

// The host half of the PTY contract (docs/CORE-CONTRACT.md "PTY host
// interface"), faked: spawn() hands back a live handle, write() echoes, and
// kill() ends the terminal. No node-pty, no shell, no Electron.
class FakePtyHost extends EventEmitter {
  constructor() {
    super()
    this.sessions = new Map()
  }

  spawn(sessionId, { cols, rows } = {}) {
    const handle = {
      write: (data) => this.write(sessionId, data),
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => this.kill(sessionId)
    }
    this.sessions.set(sessionId, { handle, cols, rows })
    setImmediate(() => this.emit('data', { sessionId, data: Buffer.from(BANNER) }))
    return handle
  }

  write(sessionId, data) {
    if (!this.sessions.has(sessionId)) return
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
    setImmediate(() => this.emit('data', { sessionId, data: buf }))
  }

  resize() {}
  pause() {}
  resume() {}

  kill(sessionId) {
    if (!this.sessions.delete(sessionId)) return
    setImmediate(() => this.emit('exit', { sessionId, exit: { code: 0, signal: null } }))
  }
}

function log(...args) {
  console.log('[core-headless-smoke]', ...args)
}

// Walks the real process table and returns every descendant of this process,
// so "no Electron in the process tree" is an observation, not an assumption.
function descendants(rootPid) {
  let table
  try {
    table = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
  } catch (err) {
    return { supported: false, rows: [], reason: err.message }
  }
  const byParent = new Map()
  for (const line of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const row = { pid: Number(match[1]), ppid: Number(match[2]), args: match[3] }
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, [])
    byParent.get(row.ppid).push(row)
  }
  const rows = []
  const queue = [rootPid]
  while (queue.length) {
    for (const child of byParent.get(queue.shift()) || []) {
      rows.push(child)
      queue.push(child.pid)
    }
  }
  return { supported: true, rows }
}

function assertNoElectron() {
  if (process.versions.electron) {
    throw new Error(`running inside Electron (${process.versions.electron})`)
  }
  for (const key of Object.keys(require.cache)) {
    if (/[\\/]node_modules[\\/]electron[\\/]/.test(key)) {
      throw new Error(`the electron package was loaded: ${key}`)
    }
  }
  const tree = descendants(process.pid)
  if (!tree.supported) {
    log(`process tree: could not run ps (${tree.reason}); skipping tree check`)
    return
  }
  log(`process tree below pid ${process.pid}:`)
  for (const row of tree.rows) log(`  ${row.pid} (ppid ${row.ppid}) ${row.args}`)
  const offenders = tree.rows.filter((row) => /electron/i.test(row.args))
  if (offenders.length) {
    throw new Error(`electron found in the process tree: ${offenders[0].args}`)
  }
  log(`no electron in ${tree.rows.length} descendant process(es)`)
}

function waitFor(emitter, event, predicate, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent)
      reject(new Error(`timed out waiting for ${label}`))
    }, TIMEOUT_MS)
    function onEvent(payload) {
      if (!predicate(payload)) return
      clearTimeout(timer)
      emitter.removeListener(event, onEvent)
      resolve(payload)
    }
    emitter.on(event, onEvent)
  })
}

async function main() {
  log(`core: ${CORE}`)
  log(`node: ${process.version} (electron: ${process.versions.electron || 'none'})`)

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zbterm-core-smoke-'))
  // An explicit profile path rather than a profile id: a bare directory needs
  // no pre-existing profile registry, which is what a non-ZBTerm host has.
  const profilePath = path.join(userData, 'storage')
  const ptyHost = new FakePtyHost()
  const client = new EngineClient({
    userData,
    profileId: '',
    profilePath,
    ptyHost
  })

  let failure = null
  try {
    const boot = await client.ready()
    log(`sidecar ready (pid ${client.pid}), known sessions: ${boot.sessionIds.length}`)
    assertNoElectron()

    const recorded = []
    client.on('session:data', (payload) => recorded.push(payload))

    // The banner is recorded (and re-emitted as session:data) before
    // session.create's own reply comes back, so the waiter has to be armed
    // first - awaiting the invoke and only then listening loses the event.
    const banner = waitFor(
      client,
      'session:data',
      (p) => String(p.data).includes('headless smoke'),
      'the spawn banner to be recorded'
    )
    const created = await client.invoke('session.create', {
      name: 'headless-smoke',
      cols: 80,
      rows: 24
    })
    log(`created session ${created.sessionId} (${created.name})`)
    await banner

    const marker = `echo core-headless-smoke-${Date.now()}\r\n`
    const echoed = waitFor(
      client,
      'session:data',
      (p) => p.sessionId === created.sessionId && String(p.data).includes('core-headless-smoke-'),
      'the typed marker to be recorded'
    )
    await client.invoke('session.input', { sessionId: created.sessionId, data: marker })
    await echoed
    log(`recorded ${recorded.length} session:data payload(s)`)

    await client.invoke('session.close', { sessionId: created.sessionId })

    const sessions = await client.invoke('session.list')
    const entry = (sessions.sessions || sessions).find((s) => s.sessionId === created.sessionId)
    if (!entry) throw new Error('created session is missing from the catalog')
    log('catalog entry: ' + JSON.stringify(entry))
    assertNoElectron()
  } catch (err) {
    failure = err
  } finally {
    await client.close().catch(() => {})
    fs.rmSync(userData, { recursive: true, force: true })
  }

  if (failure) throw failure
  log('OK: create -> record -> read-catalog completed with no Electron')
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[core-headless-smoke] FAILED:', err && err.stack ? err.stack : err)
    process.exit(1)
  }
)
