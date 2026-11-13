// Does Terminal.reset() drop data handed to write() but not yet parsed? (xterm 6, headless core)
const { Terminal } = require('@xterm/headless')
const { SerializeAddon } = require('@xterm/addon-serialize')
const src = new Terminal({ cols: 40, rows: 5, scrollback: 100, allowProposedApi: true })
const ser = new SerializeAddon(); src.loadAddon(ser)
const lines = []; for (let i = 1; i <= 8; i++) lines.push(`line ${i}\r\n`)
src.write(lines.join(''), () => {
  const frame = ser.serialize({ scrollback: 100 })             // the engine's frame: lines 1..8
  const t = new Terminal({ cols: 40, rows: 5, scrollback: 100, allowProposedApi: true })
  t.write('line 7\r\nline 8\r\n')                              // live output already in the frame, still queued
  const pending = t._core._writeBuffer._pendingData
  t.reset()                                                    // renderLiveFrame: term.reset()
  t.write('\x1b[?1049l\x1b[?47l\x1b[?1048l\x1b[?25h\x1b[0m')   // VISIBLE_TERMINAL_RESET
  t.write(frame, () => {
    const b = t.buffer.active; const out = []
    for (let i = 0; i < b.length; i++) { const s = b.getLine(i).translateToString(true); if (s) out.push(s) }
    console.log(JSON.stringify({ pendingAtReset: pending, count8: out.filter((s) => s === 'line 8').length, buffer: out }))
  })
})
