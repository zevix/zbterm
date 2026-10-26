// A throwaway local-mode Freenet node for tests (design §10 "Mode"; S-04).
//
// Each node gets its own WebSocket port and its own config, data and log
// directories under os.tmpdir(), and is stopped by the pid this helper
// spawned, never by name: the owner's own node (network mode, 127.0.0.1:7509)
// must never be touched. Tests skip when the `freenet` binary is not on PATH
// (A-7).
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')

const BINARY = 'freenet'
const READY_TIMEOUT_MS = 30000

function findBinary(env = process.env) {
  const dirs = String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, BINARY)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

function freenetAvailable() {
  return findBinary() !== null
}

// A port nothing listens on right now.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

// Spawns `freenet local` and resolves once its WebSocket port accepts TCP.
// Returns { port, pid, url, stop() }; stop() signals that pid only, waits for
// it to exit and removes the directories.
async function startLocalNode({ port } = {}) {
  const binary = findBinary()
  if (!binary) throw new Error('freenet binary not on PATH')
  if (!port) port = await freePort()
  if (port === 7509) throw new Error('port 7509 belongs to the owner node')
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-freenet-node-'))
  // The node refuses a config directory that does not exist yet.
  for (const sub of ['config', 'data', 'log']) await fs.promises.mkdir(path.join(dir, sub))
  const child = spawn(
    binary,
    [
      'local',
      '--ws-api-port',
      String(port),
      '--config-dir',
      path.join(dir, 'config'),
      '--data-dir',
      path.join(dir, 'data'),
      '--log-dir',
      path.join(dir, 'log'),
      '--disable-auto-update'
    ],
    { stdio: 'ignore' }
  )
  const pid = child.pid
  let exited = child.exitCode !== null
  const exitedPromise = new Promise((resolve) => {
    child.once('exit', () => {
      exited = true
      resolve()
    })
  })
  child.once('error', () => {})
  // A test process that dies early must not leave the node behind.
  const onProcessExit = () => {
    if (!exited) child.kill('SIGKILL')
  }
  process.once('exit', onProcessExit)

  let stopped = null
  const stop = () => {
    if (stopped) return stopped
    stopped = (async () => {
      process.removeListener('exit', onProcessExit)
      if (!exited) {
        child.kill('SIGTERM')
        const late = setTimeout(() => {
          if (!exited) child.kill('SIGKILL')
        }, 5000)
        await exitedPromise
        clearTimeout(late)
      }
      await fs.promises.rm(dir, { recursive: true, force: true })
    })()
    return stopped
  }

  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    if (exited) {
      await stop()
      throw new Error(`freenet local exited before port ${port} opened`)
    }
    if (await canConnect(port)) break
    if (Date.now() > deadline) {
      await stop()
      throw new Error(`freenet local did not open port ${port} within ${READY_TIMEOUT_MS} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  return {
    port,
    pid,
    dir,
    url: `ws://127.0.0.1:${port}/v1/contract/command`,
    stop
  }
}

module.exports = { freenetAvailable, startLocalNode, freePort }
