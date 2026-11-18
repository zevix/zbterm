// Real input for the debug server (`POST /input/*`, `POST /window/focus`), and
// `GET /window/screenshot`:
// keys, typed text, and mouse moves, presses and wheel turns are handed to
// Chromium with `webContents.sendInputEvent`, so the page gets trusted events
// and every hotkey, the terminal and the dialogs behave as under a person's
// hands. It needs no OS-level tool (xdotool) and does not move the real
// pointer or touch the real keyboard, so it works the same on X11, Wayland
// and macOS. Used by `demo.sh` (scripts/demo/demo.js); see docs/debug_server_howto.md.

const MODIFIER_NAMES = {
  ctrl: 'control',
  control: 'control',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta'
}

// Names a chord may use for a key, mapped to Electron's keyCode.
const KEY_NAMES = {
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  home: 'Home',
  end: 'End',
  plus: 'Plus'
}

const MAX_TEXT = 4096
const MAX_DELAY_MS = 1000
const MAX_MOVE_MS = 10000

function createDebugInput({ getWindow }) {
  // The pointer's last place, per window, in page (CSS) pixels: a glide
  // starts there.
  const pointers = new WeakMap()

  function contents() {
    const win = getWindow()
    return { win, wc: win.webContents }
  }

  function pointerOf(win) {
    let pointer = pointers.get(win)
    if (!pointer) {
      const [width, height] = win.getContentSize()
      pointer = { x: Math.round(width / 2), y: Math.round(height / 2) }
      pointers.set(win, pointer)
    }
    return pointer
  }

  // The page must hold the focus for a key to reach it. The window is not
  // raised: `focus()` on the web contents is enough, and keeps a second
  // instance on screen from stealing the desktop's focus on every key.
  function focusPage(wc) {
    if (!wc.isFocused()) wc.focus()
  }

  // { chord: "Ctrl+Shift+F" } or { key: "F", modifiers: ["ctrl", "shift"] };
  // `count` repeats it, `delayMs` apart.
  async function key(body = {}) {
    const { wc } = contents()
    const chord = parseChord(body)
    const count = clampInt(body.count, 1, 200, 1)
    const delayMs = clampInt(body.delayMs, 0, MAX_DELAY_MS, 40)
    focusPage(wc)
    for (let i = 0; i < count; i++) {
      if (i) await delay(delayMs)
      pressKey(wc, chord)
    }
    return { sent: count, key: chord.keyCode, modifiers: chord.modifiers }
  }

  // { text, delayMs?, enter? }: typed one key at a time into whatever holds
  // the focus (the terminal, the search box, a dialog field).
  async function text(body = {}) {
    const { wc } = contents()
    const value = String(body.text === undefined ? '' : body.text)
    if (value.length > MAX_TEXT) throw badRequest(`text is longer than ${MAX_TEXT} characters`)
    const delayMs = clampInt(body.delayMs, 0, MAX_DELAY_MS, 0)
    const jitterMs = clampInt(body.jitterMs, 0, MAX_DELAY_MS, 0)
    focusPage(wc)
    let sent = 0
    for (const char of value) {
      if (sent && (delayMs || jitterMs)) {
        await delay(delayMs + Math.floor(Math.random() * (jitterMs + 1)))
      }
      typeChar(wc, char)
      sent++
    }
    if (body.enter) {
      if (delayMs) await delay(delayMs)
      pressKey(wc, { keyCode: 'Enter', modifiers: [], char: '\r' })
    }
    return { sent, enter: !!body.enter }
  }

  // { type, x, y, ... } in page (CSS) pixels:
  //   move   glides there in `durationMs` (0: jumps), from the last place
  //   down / up   a button (`button`: left, right, middle)
  //   click  down and up there (`count: 2` for a double click)
  //   wheel  `deltaX` / `deltaY` in pixels, as a wheel event's own deltas
  //          (positive deltaY scrolls down)
  // `modifiers` (ctrl, shift, alt, meta) apply to all of them.
  async function mouse(body = {}) {
    const { win, wc } = contents()
    const type = String(body.type || 'move')
    const pointer = pointerOf(win)
    const zoom = wc.getZoomFactor() || 1
    const modifiers = parseModifiers(body.modifiers)
    const button = ['left', 'right', 'middle'].includes(body.button) ? body.button : 'left'
    const target = {
      x: finite(body.x, pointer.x),
      y: finite(body.y, pointer.y)
    }
    const send = (event) => {
      wc.sendInputEvent({
        ...event,
        x: Math.round(pointer.x * zoom),
        y: Math.round(pointer.y * zoom)
      })
    }
    const heldModifiers = pointer.down ? [...modifiers, `${pointer.down}ButtonDown`] : modifiers
    const moveTo = async (durationMs) => {
      const from = { x: pointer.x, y: pointer.y }
      const distance = Math.hypot(target.x - from.x, target.y - from.y)
      const steps = durationMs > 0 ? Math.max(1, Math.min(240, Math.round(durationMs / 16))) : 1
      for (let i = 1; i <= steps; i++) {
        const t = ease(i / steps)
        pointer.x = from.x + (target.x - from.x) * t
        pointer.y = from.y + (target.y - from.y) * t
        send({
          type: 'mouseMove',
          modifiers: heldModifiers,
          button: pointer.down || undefined
        })
        if (i < steps) await delay(durationMs / steps)
      }
      return distance
    }

    if (type === 'move') {
      await moveTo(clampInt(body.durationMs, 0, MAX_MOVE_MS, 0))
    } else if (type === 'down') {
      await moveTo(0)
      focusPage(wc)
      pointer.down = button
      send({ type: 'mouseDown', button, clickCount: 1, modifiers })
    } else if (type === 'up') {
      await moveTo(0)
      const held = pointer.down || button
      pointer.down = null
      send({ type: 'mouseUp', button: held, clickCount: 1, modifiers })
    } else if (type === 'click') {
      await moveTo(clampInt(body.durationMs, 0, MAX_MOVE_MS, 0))
      focusPage(wc)
      const count = clampInt(body.count, 1, 3, 1)
      const holdMs = clampInt(body.holdMs, 0, MAX_DELAY_MS, 60)
      pointer.down = null
      for (let i = 1; i <= count; i++) {
        send({ type: 'mouseDown', button, clickCount: i, modifiers })
        await delay(holdMs)
        send({ type: 'mouseUp', button, clickCount: i, modifiers })
        if (i < count) await delay(60)
      }
    } else if (type === 'wheel') {
      await moveTo(0)
      const count = clampInt(body.count, 1, 200, 1)
      const delayMs = clampInt(body.delayMs, 0, MAX_DELAY_MS, 30)
      for (let i = 0; i < count; i++) {
        if (i) await delay(delayMs)
        // Chromium's wheel deltas point the other way from the DOM's.
        send({
          type: 'mouseWheel',
          deltaX: -finite(body.deltaX, 0),
          deltaY: -finite(body.deltaY, 0),
          modifiers,
          canScroll: true
        })
      }
    } else {
      throw badRequest(`Unknown mouse event type: ${type}`)
    }
    return { type, x: pointer.x, y: pointer.y, down: pointer.down || null }
  }

  // Raises the window and gives it the keyboard focus.
  function focus() {
    const { win, wc } = contents()
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    wc.focus()
    return { focused: win.isFocused(), pageFocused: wc.isFocused() }
  }

  // The page as it is drawn now, as a PNG (base64): what a window screenshot
  // would show, without the desktop around it.
  async function screenshot() {
    const { win, wc } = contents()
    const image = await wc.capturePage()
    const size = image.getSize()
    return {
      width: size.width,
      height: size.height,
      bounds: win.getBounds(),
      png: image.toPNG().toString('base64')
    }
  }

  return { key, text, mouse, focus, screenshot }
}

function pressKey(wc, chord) {
  const { keyCode, modifiers, char } = chord
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  // A printable key with no Ctrl/Alt/Meta also types its character.
  if (char && !modifiers.some((m) => m === 'control' || m === 'alt' || m === 'meta')) {
    wc.sendInputEvent({ type: 'char', keyCode: char, modifiers })
  }
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

function typeChar(wc, char) {
  if (char === '\n' || char === '\r') {
    return pressKey(wc, { keyCode: 'Enter', modifiers: [], char: '\r' })
  }
  if (char === '\t') return pressKey(wc, { keyCode: 'Tab', modifiers: [], char: null })
  if (char === ' ') return pressKey(wc, { keyCode: 'Space', modifiers: [], char: ' ' })
  // Outside ASCII there is no key to press: the character is inserted, as an
  // input method would.
  if (char.codePointAt(0) > 0x7e) return void wc.insertText(char)
  const shifted = char !== char.toLowerCase() && char === char.toUpperCase()
  pressKey(wc, { keyCode: char, modifiers: shifted ? ['shift'] : [], char })
}

function parseChord(body) {
  let modifiers = parseModifiers(body.modifiers)
  let name = body.key
  if (typeof body.chord === 'string' && body.chord) {
    // "Ctrl+Shift+F"; a trailing "+" is the plus key ("Ctrl++").
    const parts = body.chord.endsWith('++')
      ? [...body.chord.slice(0, -2).split('+'), '+']
      : body.chord.split('+')
    name = parts.pop()
    modifiers = parseModifiers([...parts, ...modifiers])
  }
  if (typeof name !== 'string' || !name) throw badRequest('Missing key')
  const known = KEY_NAMES[name.toLowerCase()]
  if (known) {
    // Enter types a carriage return: a form is submitted by that character,
    // not by the key going down.
    const char = known === 'Space' ? ' ' : known === 'Enter' ? '\r' : null
    return { keyCode: known, modifiers, char }
  }
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(name)) {
    return { keyCode: name.toUpperCase(), modifiers, char: null }
  }
  if ([...name].length !== 1) throw badRequest(`Unknown key: ${name}`)
  const shift = modifiers.includes('shift')
  return {
    keyCode: /[a-z]/i.test(name) ? name.toUpperCase() : name,
    modifiers,
    char: /[a-z]/i.test(name) ? (shift ? name.toUpperCase() : name.toLowerCase()) : name
  }
}

function parseModifiers(list) {
  const out = []
  if (list !== undefined && list !== null && !Array.isArray(list)) {
    throw badRequest('modifiers is a list, e.g. ["ctrl", "shift"]')
  }
  for (const item of list || []) {
    const name = MODIFIER_NAMES[String(item).trim().toLowerCase()]
    if (!name) throw badRequest(`Unknown modifier: ${item}`)
    if (!out.includes(name)) out.push(name)
  }
  return out
}

function ease(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

function finite(value, fallback) {
  const n = Number(value)
  return value === undefined || value === null || !Number.isFinite(n) ? fallback : n
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (value === undefined || value === null || !Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function badRequest(message) {
  const err = new Error(message)
  err.statusCode = 400
  return err
}

module.exports = { createDebugInput, parseChord, parseModifiers }
