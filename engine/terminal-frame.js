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
  }

  get cols() {
    return this.term.cols
  }

  get rows() {
    return this.term.rows
  }

  resize(cols, rows) {
    this.term.resize(cols || this.cols, rows || this.rows)
  }

  write(data) {
    return new Promise((resolve) => {
      this.term.write(data, resolve)
    })
  }

  async restore(frame) {
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
    this.term.dispose()
  }
}

module.exports = { TerminalFrame, DEFAULT_COLS, DEFAULT_ROWS, DEFAULT_SCROLLBACK, LIVE_SCROLLBACK }
