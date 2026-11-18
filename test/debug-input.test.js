// The debug server's real-input routes (electron/debug-input.js): what a
// chord and a typed text become as Chromium input events, and that the
// routes answer 404 where the host gave no input handler.
const net = require('net')
const test = require('brittle')

const { createDebugServer } = require('../electron/debug-server')
const { createDebugInput, parseChord } = require('../electron/debug-input')

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

// A stand-in window: records every input event the handler sends.
function fakeWindow({ zoom = 1 } = {}) {
  const events = []
  let focused = false
  const webContents = {
    sendInputEvent: (event) => events.push(event),
    isFocused: () => focused,
    focus: () => {
      focused = true
    },
    getZoomFactor: () => zoom
  }
  return {
    events,
    win: { webContents, getContentSize: () => [1000, 600] },
    focusedPage: () => focused
  }
}

test('debug input: a chord is parsed into a key and its modifiers', (t) => {
  t.alike(parseChord({ chord: 'Ctrl+Shift+F' }), {
    keyCode: 'F',
    modifiers: ['control', 'shift'],
    char: 'F'
  })
  t.alike(parseChord({ chord: 'ctrl+pgdn' }), {
    keyCode: 'PageDown',
    modifiers: ['control'],
    char: null
  })
  t.alike(parseChord({ chord: 'F2' }), { keyCode: 'F2', modifiers: [], char: null })
  t.alike(parseChord({ chord: 'Ctrl++' }), { keyCode: '+', modifiers: ['control'], char: '+' })
  t.alike(parseChord({ chord: 'Ctrl+=' }), { keyCode: '=', modifiers: ['control'], char: '=' })
  t.alike(parseChord({ key: 'a', modifiers: ['Alt'] }), {
    keyCode: 'A',
    modifiers: ['alt'],
    char: 'a'
  })
  t.is(parseChord({ chord: 'Enter' }).char, '\r', 'Enter types a carriage return')
  t.exception(() => parseChord({ chord: 'Ctrl+Nope' }), /Unknown key/)
  t.exception(() => parseChord({ chord: 'Hyper+A' }), /Unknown modifier/)
  t.exception(() => parseChord({}), /Missing key/)
})

test('debug input: a chord with Ctrl sends no character, typed text does', async (t) => {
  const fake = fakeWindow()
  const input = createDebugInput({ getWindow: () => fake.win })

  await input.key({ chord: 'Ctrl+Shift+T' })
  t.alike(
    fake.events.map((event) => event.type),
    ['keyDown', 'keyUp'],
    'no char event: the chord must not type a letter'
  )
  t.ok(fake.focusedPage(), 'the page got the focus before the key')

  fake.events.length = 0
  await input.text({ text: 'aB ', enter: true })
  t.alike(
    fake.events.map((event) => `${event.type}:${event.keyCode}`),
    [
      'keyDown:a',
      'char:a',
      'keyUp:a',
      'keyDown:B',
      'char:B',
      'keyUp:B',
      'keyDown:Space',
      'char: ',
      'keyUp:Space',
      'keyDown:Enter',
      'char:\r',
      'keyUp:Enter'
    ]
  )
  t.alike(fake.events[3].modifiers, ['shift'], 'a capital is typed with Shift')
})

test('debug input: mouse events are in page pixels, scaled by the zoom factor', async (t) => {
  const fake = fakeWindow({ zoom: 2 })
  const input = createDebugInput({ getWindow: () => fake.win })

  const moved = await input.mouse({ type: 'move', x: 100, y: 50 })
  t.is(moved.x, 100)
  t.is(moved.y, 50)
  const last = fake.events[fake.events.length - 1]
  t.is(last.type, 'mouseMove')
  t.is(last.x, 200, 'page pixels become view pixels')
  t.is(last.y, 100)

  fake.events.length = 0
  await input.mouse({ type: 'click', x: 10, y: 10, modifiers: ['shift'], holdMs: 0 })
  t.alike(
    fake.events.map((event) => event.type),
    ['mouseMove', 'mouseDown', 'mouseUp']
  )
  t.alike(fake.events[1].modifiers, ['shift'])

  fake.events.length = 0
  await input.mouse({ type: 'wheel', deltaY: 120, modifiers: ['alt'] })
  const wheel = fake.events.find((event) => event.type === 'mouseWheel')
  t.is(wheel.deltaY, -120, "a DOM wheel delta is Chromium's, negated")
  t.alike(wheel.modifiers, ['alt'])

  fake.events.length = 0
  await input.mouse({ type: 'down', x: 10, y: 10 })
  await input.mouse({ type: 'move', x: 30, y: 10 })
  const up = await input.mouse({ type: 'up', x: 30, y: 10 })
  const dragMove = fake.events.filter((event) => event.type === 'mouseMove').pop()
  t.ok(dragMove.modifiers.includes('leftButtonDown'), 'a move during a drag holds the button')
  t.is(up.down, null)

  await t.exception(() => input.mouse({ type: 'spin' }), /Unknown mouse event type/)
})

test('debug server: the input routes reach the host handler, or answer 404', async (t) => {
  const calls = []
  const input = {
    key: (body) => {
      calls.push(['key', body])
      return { sent: 1 }
    }
  }
  const withInput = createDebugServer({ getEngine: () => null, port: await freePort(), input })
  const a = await withInput.start()
  t.teardown(() => withInput.stop())
  const ok = await fetch(`http://${a.host}:${a.port}/input/key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chord: 'F2' })
  })
  t.is(ok.status, 200, 'answers before the engine is ready')
  t.alike(calls, [['key', { chord: 'F2' }]])

  const without = createDebugServer({ getEngine: () => null, port: await freePort() })
  const b = await without.start()
  t.teardown(() => without.stop())
  const missing = await fetch(`http://${b.host}:${b.port}/input/key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
  t.is(missing.status, 404)
})
