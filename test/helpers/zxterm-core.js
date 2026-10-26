// Gives this test process the Rust `zxterm-core` sidecar (K9 of
// zxterm-core, in `zevix/zxterm`) every identity path now goes through: it
// installs the host's own module (electron/zxterm-core-host.js) as the
// process-wide core host, exactly as the Bare worker does with the path
// EngineClient passes it. Require it before anything that reaches the
// identity code (engine/crypto.js, engine/account-store.js,
// engine/identity/*, a SessionEngine, a ShareManager).
//
// The binary is the `zxterm-core-prebuilds` package's, or `ZXTERM_CORE_BIN`.
const os = require('os')
const fs = require('fs')
const path = require('path')

const host = require('../../electron/zxterm-core-host')
const { setCoreHost, Core } = require('../../engine/zxterm/core')

const CORE_HOST = require.resolve('../../electron/zxterm-core-host')

setCoreHost(host)

// K11: the Freenet backend is a proxy to this sidecar, and its default node
// is 127.0.0.1:7509 - the owner's. In a test process any backend made without
// a node address gets a closed port instead (engine/backends/freenet/
// index.js::DEFAULT_NODE_KEY), so none can reach a real node by accident.
globalThis[Symbol.for('zbterm.freenetDefaultNode')] = 'ws://127.0.0.1:1/v1/contract/command'

// A host whose sidecar gets `env` on top of this process's environment
// (a loopback `ZBTERM_GITHUB_KEYS_BASE`, a scratch HOME).
function hostWithEnv(env = {}) {
  return {
    bin: host.bin,
    spawn(file, args) {
      const { spawn } = require('child_process')
      return spawn(file, args, {
        stdio: ['pipe', 'ignore', 'inherit'],
        env: { ...process.env, ...env }
      })
    }
  }
}

// A sidecar of the test's own on `dir` (a fresh short scratch directory
// when omitted), closed at teardown. `opts.env` is added to its environment.
function testCore(t, opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'zxt-'))
  const core = new Core(dir, { host: hostWithEnv(opts.env) })
  if (t && typeof t.teardown === 'function') t.teardown(() => core.close())
  return core
}

function coreBinary() {
  try {
    return host.bin()
  } catch {
    return null
  }
}

module.exports = { CORE_HOST, host, hostWithEnv, testCore, coreBinary }
