const { EventEmitter } = require('events')

const PtySession = require('./pty-session')

// Owns every live PtySession, keyed by sessionId. This is the Electron-side
// implementation of the PTY host adapter contract documented in
// docs/ARCHITECTURE.md "Core boundary": the core (engine/) never requires this
// file, it only ever calls the injected `opts.ptyHost`. engine/pty-remote.js is
// the worker-side proxy for the same interface.
class PtyHost extends EventEmitter {
  constructor() {
    super()
    this.sessions = new Map()
  }

  spawn(sessionId, opts = {}) {
    if (this.sessions.has(sessionId)) return null
    const pty = new PtySession(opts)
    this.sessions.set(sessionId, pty)
    pty.on('data', (data) => this.emit('data', { sessionId, data }))
    pty.once('exit', (exit) => {
      this.sessions.delete(sessionId)
      this.emit('exit', { sessionId, exit })
    })
    return {
      write: (data) => this.write(sessionId, data),
      resize: (cols, rows) => this.resize(sessionId, cols, rows),
      pause: () => this.pause(sessionId),
      resume: () => this.resume(sessionId),
      kill: () => this.kill(sessionId)
    }
  }

  write(sessionId, data) {
    const pty = this.sessions.get(sessionId)
    if (!pty) return
    pty.write(data)
  }

  resize(sessionId, cols, rows) {
    const pty = this.sessions.get(sessionId)
    if (!pty) return
    pty.resize(cols, rows)
  }

  pause(sessionId) {
    const pty = this.sessions.get(sessionId)
    if (!pty) return
    pty.pause()
  }

  resume(sessionId) {
    const pty = this.sessions.get(sessionId)
    if (!pty) return
    pty.resume()
  }

  kill(sessionId) {
    const pty = this.sessions.get(sessionId)
    if (!pty) return
    pty.kill()
  }
}

module.exports = PtyHost
