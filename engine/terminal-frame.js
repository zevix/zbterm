const { Terminal } = require('@xterm/headless')
const { SerializeAddon } = require('@xterm/addon-serialize')

const DEFAULT_COLS = 100
const DEFAULT_ROWS = 30
const DEFAULT_SCROLLBACK = 0
const LIVE_SCROLLBACK = 5000
const MOUSE_ENCODINGS = { SGR: '\x1b[?1006h', SGR_PIXELS: '\x1b[?1016h' }

class TerminalFrame {
  constructor(cols = DEFAULT_COLS, rows = DEFAULT_ROWS, opts = {}) {
    this.scrollback = Number.isFinite(opts.scrollback)
      ? Math.max(0, opts.scrollback)
      : DEFAULT_SCROLLBACK
    this.term = new Terminal({
      cols,
      rows,
      scrollback: this.scrollback,
      allowProposedApi: true
    })
    this.serializeAddon = new SerializeAddon()
    this.term.loadAddon(this.serializeAddon)
    // Bumped by restore(), set by dispose(): a reader that yields between
    // slices (session.searchBuffer) checks them to see that the screen it
    // started on is still the one it reads.
    this.generation = 0
    this.disposed = false
  }

  get cols() {
    return this.term.cols
  }

  get rows() {
    return this.term.rows
  }

  resize(cols, rows) {
    this.term.resize(cols || this.cols, rows || this.rows)
    this._repairBuffers()
  }

  // @xterm/headless 6.0.0, scrollback 0 (the archive and playback screens): a
  // resize can leave a buffer with fewer lines than `ybase + rows` - a
  // scrolled-off base with no scrollback to hold it, then a taller grid that
  // is not padded for it. The cursor may then sit on a row that does not
  // exist, and the next printed character throws inside xterm's own write
  // timer, where nothing can catch it: the whole worker dies with "Cannot
  // read properties of undefined (reading 'getWidth')". Give the base back
  // and pad the grid, so every row the cursor can reach exists.
  _repairBuffers() {
    const buffers = this.term._core && this.term._core.buffers
    if (!buffers) return
    const rows = this.term.rows
    for (const buffer of [buffers.normal, buffers.alt]) {
      const lines = buffer && buffer.lines
      // The alternate buffer holds no lines while the normal one is shown.
      if (!lines || !lines.length || typeof buffer.getBlankLine !== 'function') continue
      let missing = buffer.ybase + rows - lines.length
      if (missing <= 0) continue
      while (missing > 0 && buffer.ybase > 0) {
        buffer.ybase--
        buffer.y++
        missing--
      }
      for (; missing > 0 && lines.length < lines.maxLength; missing--) {
        lines.push(buffer.getBlankLine(buffer.getNullCell()))
      }
      buffer.ydisp = Math.min(buffer.ydisp, buffer.ybase)
      buffer.y = Math.max(0, Math.min(buffer.y, rows - 1))
      buffer.savedY = Math.max(0, Math.min(buffer.savedY, lines.length - 1))
    }
  }

  write(data) {
    return new Promise((resolve) => {
      this.term.write(data, resolve)
    })
  }

  async restore(frame) {
    this.generation++
    this.resize(frame.cols || DEFAULT_COLS, frame.rows || DEFAULT_ROWS)
    this.term.reset()
    if (frame.data) await this.write(frame.data)
  }

  // `opts.scrollback` caps the lines of scrollback serialised (the frame's
  // `scrollback` stays the mirror's capacity); a smaller screen for a viewer
  // that is being resynced mid-flood.
  snapshot(seq, tsMs = Date.now(), opts = {}) {
    const scrollback = Number.isFinite(opts.scrollback)
      ? Math.max(0, Math.min(opts.scrollback, this.scrollback))
      : this.scrollback
    return {
      seq,
      cols: this.cols,
      rows: this.rows,
      scrollback: this.scrollback,
      data: this.serializeAddon.serialize({ scrollback }) + this._mouseEncoding(),
      tsMs
    }
  }

  // SerializeAddon restores mouse tracking but not its encoding, so a program
  // that asked for SGR reports (Claude Code, vim, tmux) would get legacy X10
  // reports after a snapshot is replayed, and ignore every click.
  _mouseEncoding() {
    const mouse = this.term._core && this.term._core.coreMouseService
    const encoding = mouse && mouse.activeEncoding
    return MOUSE_ENCODINGS[encoding] || ''
  }

  dispose() {
    this.disposed = true
    this.term.dispose()
  }
}

module.exports = { TerminalFrame, DEFAULT_COLS, DEFAULT_ROWS, DEFAULT_SCROLLBACK, LIVE_SCROLLBACK }
