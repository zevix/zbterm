const test = require('brittle')

const { TerminalFrame } = require('../engine/terminal-frame')

test('terminal frame serializes visible screen only', async (t) => {
  const frame = new TerminalFrame(20, 5)

  for (let i = 0; i < 50; i++) {
    await frame.write(`line-${String(i).padStart(2, '0')}\r\n`)
  }

  const snapshot = frame.snapshot(50)
  t.ok(snapshot.data.length < 1000)
  t.is(snapshot.data.includes('line-00'), false)
  t.ok(snapshot.data.includes('line-49'))

  frame.dispose()
})

test('terminal frame preserves inverse video line attributes', async (t) => {
  const frame = new TerminalFrame(20, 4)

  await frame.write('\x1b[7mPID USER          \x1b[0m\r\nrow')

  const snapshot = frame.snapshot(1)
  t.ok(snapshot.data.includes('\x1b[7mPID USER'))
  t.ok(snapshot.data.includes('          '))

  frame.dispose()
})

test('terminal frame can serialize bounded scrollback', async (t) => {
  const frame = new TerminalFrame(20, 5, { scrollback: 50 })

  for (let i = 0; i < 20; i++) {
    await frame.write(`line-${String(i).padStart(2, '0')}\r\n`)
  }

  const snapshot = frame.snapshot(20)
  t.is(snapshot.scrollback, 50)
  t.ok(snapshot.data.includes('line-00'))
  t.ok(snapshot.data.includes('line-19'))

  frame.dispose()
})

test('terminal frame snapshot keeps the mouse report encoding', async (t) => {
  const frame = new TerminalFrame(20, 5)
  await frame.write('\x1b[?1002h\x1b[?1006hhi')
  const restored = new TerminalFrame(20, 5)
  await restored.restore(frame.snapshot(1))
  const mouse = restored.term._core.coreMouseService
  t.is(mouse.activeProtocol, 'DRAG')
  t.is(mouse.activeEncoding, 'SGR', 'SGR encoding survives the snapshot')
  frame.dispose()
  restored.dispose()
})

// @xterm/headless 6.0.0 leaves a scrollback-0 buffer shorter than the grid
// after this resize pair; the print that followed threw from xterm's write
// timer and took the Bare worker down ("reading 'getWidth'").
test('a resized scrollback-0 frame keeps every row the cursor can reach', async (t) => {
  const frame = new TerminalFrame(100, 30, { scrollback: 0 })
  t.teardown(() => frame.dispose())
  await frame.write('\x1b[32;124H' + '日本'.repeat(56) + '\x1b[12A')
  frame.resize(2, 31)
  frame.resize(130, 45)
  const buffer = frame.term._core.buffers.active
  t.ok(buffer.lines.length >= buffer.ybase + frame.rows, 'the grid has a line for every row')
  await frame.write('\x1b[64;98H' + '日本'.repeat(48))
  t.is(frame.snapshot(1).rows, 45)
})
