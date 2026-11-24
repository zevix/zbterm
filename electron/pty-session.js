const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const pty = require('@lydell/node-pty')

const { EngineError, CODES } = require('../engine/errors')
const { adopt } = require('./pty-scope')

class PtySession extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.cols = opts.cols || 100
    this.rows = opts.rows || 30
    this._exited = false
    this._paused = false
    const shell = opts.shell || defaultShell()
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }
    // With no SHELL in the app's own environment the shell above is a
    // fallback; name it, so a launch that ends in `exec "$SHELL"` (the launch
    // plugins' interactive ending) has one to run.
    if (!env.SHELL && process.platform !== 'win32') env.SHELL = shell
    // A session's command runs through the user's shell, so it can carry
    // arguments, pipes and `~` exactly as typed at a prompt.
    this._pty = pty.spawn(shell, commandArgs(opts.command, process.platform, shell), {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: resolveCwd(opts.cwd),
      env
    })

    // Contain this tab in its own systemd scope so an OOM kill here cannot
    // stop the unit the app itself runs in - see electron/pty-scope.js. Anything
    // the shell spawns from here on inherits the scope; only work started
    // during the few ms before this lands stays behind in the app's cgroup.
    this.scoped = adopt(this._pty.pid)

    this._pty.onData((data) => this.emit('data', Buffer.from(data, 'utf8')))
    this._pty.onExit(({ exitCode, signal }) => {
      this._exited = true
      this.emit('exit', { code: exitCode, signal })
    })
  }

  write(data) {
    if (this._exited) {
      throw new EngineError(CODES.E_INTERNAL, 'Cannot write to an exited terminal')
    }
    this._pty.write(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
  }

  resize(cols, rows) {
    if (this._exited) return
    this.cols = Math.max(2, cols | 0)
    this.rows = Math.max(2, rows | 0)
    this._pty.resize(this.cols, this.rows)
  }

  pause() {
    if (this._pty.pause && !this._paused) {
      this._paused = true
      this._pty.pause()
    }
  }

  resume() {
    if (this._pty.resume && this._paused) {
      this._paused = false
      this._pty.resume()
    }
  }

  kill() {
    if (this._exited) return
    this._pty.kill()
  }
}

module.exports = PtySession
module.exports._test = { defaultShell, resolveCwd, commandArgs }

// 261121_dialog-and-command-plugins R4, U5: a command runs as it would at the
// session's own prompt. A shell known to take it gets `-i`: the rc file the
// prompt reads (aliases, functions, a PATH set there) and alias expansion,
// which bash turns off without it. On macOS, where an app started from the
// Finder has only the system PATH and terminals start login shells, `-l` too.
// Any other shell keeps the plain `-c`. C5 (F5): matched on the basename, a
// login shell's leading `-` dropped, and a version suffix allowed
// (`bash5`, `zsh-5.9`).
const INTERACTIVE_SHELL = /^(bash|zsh|fish|ksh|mksh|sh|dash)(-?[0-9.]+)?$/

function commandArgs(command, platform = process.platform, shell = '') {
  const text = typeof command === 'string' ? command.trim() : ''
  if (!text) return []
  if (platform === 'win32') return ['/c', text]
  const base = path.basename(String(shell || '')).replace(/^-/, '')
  if (!INTERACTIVE_SHELL.test(base)) return ['-c', text]
  return platform === 'darwin' ? ['-l', '-i', '-c', text] : ['-i', '-c', text]
}

// `~` and `~/x` expand to the home directory; a directory that does not exist
// (deleted since it was saved, or typed wrong) falls back to home rather than
// failing the spawn.
function resolveCwd(cwd, home = os.homedir()) {
  const text = typeof cwd === 'string' ? cwd.trim() : ''
  if (!text) return home
  const expanded =
    text === '~' ? home : /^~[\\/]/.test(text) ? path.join(home, text.slice(2)) : text
  try {
    if (fs.statSync(expanded).isDirectory()) return expanded
  } catch {}
  return home
}

function defaultShell(platform = process.platform, env = process.env, userShell = loginShell) {
  if (platform === 'win32') return env.ComSpec || env.COMSPEC || 'cmd.exe'
  if (env.SHELL) return env.SHELL
  // Started from a launcher with no SHELL: the user's login shell.
  return userShell() || 'bash'
}

function loginShell() {
  try {
    return os.userInfo().shell || ''
  } catch {
    return ''
  }
}
