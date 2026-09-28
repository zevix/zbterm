const { EngineClient: CoreEngineClient } = require('../engine/client')

const PtyHost = require('./pty-host')

// Dev-mode terminal colors so worker output is visually distinguishable from
// the shell's own console.log lines: cyan for the worker's stdout, yellow
// for its stderr. Previously only stderr was piped at all - stdout was
// silently dropped, so any console.log from the engine worker (Bare process,
// corestore, hyperswarm, etc.) never reached the dev terminal.
const WORKER_STDOUT_COLOR = '\x1b[36m'
const WORKER_STDERR_COLOR = '\x1b[33m'
const COLOR_RESET = '\x1b[0m'

// The Electron shell's EngineClient. Everything reusable - spawning the
// sidecar, frame codec, invoke/reply correlation, respawn, the reattach
// protocol, PTY buffering - lives in the core package (engine/client.js,
// published as zbterm-core; see docs/CORE-CONTRACT.md). What is left here
// is exactly what is Electron's: the real PTY host implementation
// (electron/pty-host.js, node-pty + the systemd scope) and colouring the
// sidecar's console output in the dev terminal.
class EngineClient extends CoreEngineClient {
  constructor(opts = {}) {
    super({ ...opts, ptyHost: opts.ptyHost || new PtyHost() })
  }

  _attachWorkerOutput(worker) {
    worker.stdout?.on('data', (chunk) =>
      process.stdout.write(`${WORKER_STDOUT_COLOR}${chunk}${COLOR_RESET}`)
    )
    worker.stderr?.on('data', (chunk) =>
      process.stderr.write(`${WORKER_STDERR_COLOR}${chunk}${COLOR_RESET}`)
    )
  }
}

module.exports = { EngineClient }
