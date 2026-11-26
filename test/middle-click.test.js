// renderer/middle-click.js: a middle click in the terminal is a paste or a
// click reported to the program, never both (the double paste in vim with
// mouse=a and in Claude Code). Each click below is played the way Chromium and
// xterm.js handle it: the app's capture-phase mousedown, xterm's own mousedown
// (it reports the press when tracking is on and Shift is not held), the
// mouseup (Chromium pastes PRIMARY natively on Linux unless it was
// default-prevented), then auxclick (the app's clipboard paste elsewhere).
const fs = require('fs')
const path = require('path')
const test = require('brittle')
const { createMiddleClick, middleClickReported } = require('../renderer/middle-click.js')

const ROOT = path.join(__dirname, '..')

function fakeTerm(mouseTrackingMode, shouldForceSelection) {
  const term = { modes: { mouseTrackingMode } }
  if (shouldForceSelection) term._core = { _selectionService: { shouldForceSelection } }
  return term
}

function mouseEvent(type, { button = 1, shiftKey = false } = {}) {
  return {
    type,
    button,
    shiftKey,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    }
  }
}

// One middle click on a platform with (Linux) or without (macOS) the native
// PRIMARY paste. Returns what reached the program.
async function click(term, { nativePaste, shiftKey = false }) {
  const out = { reports: 0, nativePastes: 0, clipboardPastes: 0 }
  const handlers = createMiddleClick({
    getTerm: () => term,
    nativePaste,
    pasteClipboard: () => {
      out.clipboardPastes++
    }
  })
  const down = mouseEvent('mousedown', { shiftKey })
  handlers.mousedown(down)
  // xterm.js's mousedown (CoreBrowserTerminal.bindMouse), on the non-mac rule.
  const tracking = term.modes.mouseTrackingMode !== 'none'
  const forced = term._core ? term._core._selectionService.shouldForceSelection(down) : shiftKey
  const xtermReports = tracking && !forced
  if (xtermReports) out.reports++
  const up = mouseEvent('mouseup', { shiftKey })
  handlers.mouseup(up)
  if (xtermReports) out.reports++ // the release, from xterm's document mouseup
  if (nativePaste && !up.defaultPrevented) out.nativePastes++
  await handlers.auxclick(mouseEvent('auxclick', { shiftKey }))
  out.pastes = out.nativePastes + out.clipboardPastes
  return out
}

test('tracking on, plain middle click: reported, never pasted (Linux and elsewhere)', async (t) => {
  for (const mode of ['x10', 'vt200', 'drag', 'any']) {
    for (const nativePaste of [true, false]) {
      const got = await click(fakeTerm(mode), { nativePaste })
      t.is(got.pastes, 0, `${mode}, native paste ${nativePaste}: no paste`)
      t.is(got.reports, 2, `${mode}, native paste ${nativePaste}: press and release reported`)
    }
  }
})

test('tracking on, Shift+middle click: exactly one paste, not reported', async (t) => {
  const linux = await click(fakeTerm('vt200'), { nativePaste: true, shiftKey: true })
  t.is(linux.nativePastes, 1, 'Linux: the native PRIMARY paste, once')
  t.is(linux.clipboardPastes, 0, 'Linux: no clipboard paste on top')
  t.is(linux.reports, 0, 'Linux: not reported')
  const mac = await click(fakeTerm('vt200'), { nativePaste: false, shiftKey: true })
  t.is(mac.clipboardPastes, 1, 'elsewhere: the clipboard, once')
  t.is(mac.nativePastes, 0, 'elsewhere: no native paste')
  t.is(mac.reports, 0, 'elsewhere: not reported')
})

test('tracking off: one paste, as before', async (t) => {
  for (const shiftKey of [false, true]) {
    const linux = await click(fakeTerm('none'), { nativePaste: true, shiftKey })
    t.alike(
      [linux.nativePastes, linux.clipboardPastes, linux.reports],
      [1, 0, 0],
      `Linux, shift ${shiftKey}: one native paste`
    )
    const mac = await click(fakeTerm('none'), { nativePaste: false, shiftKey })
    t.alike(
      [mac.nativePastes, mac.clipboardPastes, mac.reports],
      [0, 1, 0],
      `elsewhere, shift ${shiftKey}: one clipboard paste`
    )
  }
})

test('the selection service decides, as it does for xterm (paused playback forces selection)', async (t) => {
  const forcedAlways = fakeTerm('vt200', () => true)
  const got = await click(forcedAlways, { nativePaste: true })
  t.is(got.reports, 0, 'forced selection: xterm does not report')
  t.is(got.pastes, 1, 'forced selection: one paste')
  t.ok(
    middleClickReported(
      fakeTerm('vt200', () => false),
      mouseEvent('mousedown')
    )
  )
  t.absent(middleClickReported(fakeTerm('vt200'), mouseEvent('mousedown', { button: 0 })))
  t.absent(middleClickReported(null, mouseEvent('mousedown')), 'no terminal yet')
})

test('a reported press does not cancel a later, unreported middle release', (t) => {
  const term = fakeTerm('vt200')
  const handlers = createMiddleClick({ getTerm: () => term, nativePaste: true })
  handlers.mousedown(mouseEvent('mousedown'))
  const first = mouseEvent('mouseup')
  handlers.mouseup(first)
  t.ok(first.defaultPrevented, 'the reported click is cancelled')
  // A middle release with no press in the terminal (the press was elsewhere).
  const stray = mouseEvent('mouseup')
  handlers.mouseup(stray)
  t.absent(stray.defaultPrevented, 'a later release elsewhere still pastes')
  // Other buttons are never touched.
  term.modes.mouseTrackingMode = 'vt200'
  handlers.mousedown(mouseEvent('mousedown', { button: 0 }))
  const left = mouseEvent('mouseup', { button: 0 })
  handlers.mouseup(left)
  t.absent(left.defaultPrevented, 'left button untouched')
})

test('the renderer loads and wires the middle click', (t) => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8')
  const js = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8')
  t.ok(html.includes('<script src="middle-click.js"></script>'), 'index.html loads it')
  t.ok(html.indexOf('middle-click.js') < html.indexOf('<script src="app.js">'), 'before app.js')
  t.ok(
    js.includes("els.terminal.addEventListener('mousedown', terminalMiddleClick.mousedown, true)"),
    'the press in the capture phase, before xterm decides to report it'
  )
  t.ok(
    js.includes("window.addEventListener('mouseup', terminalMiddleClick.mouseup, true)"),
    'the release on the window'
  )
  t.ok(
    js.includes("els.terminal.addEventListener('auxclick', guard(terminalMiddleClick.auxclick))"),
    'the clipboard paste on auxclick'
  )
  t.absent(js.includes('handleTerminalAuxClick'), 'the old unconditional handler is gone')
})

// What renderer/middle-click.js assumes of xterm.js: re-read on an upgrade.
test('xterm.js reports a press only with tracking on and selection not forced (Shift)', (t) => {
  const src = path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'src', 'browser')
  const core = fs.readFileSync(path.join(src, 'CoreBrowserTerminal.ts'), 'utf8')
  const selection = fs.readFileSync(path.join(src, 'services', 'SelectionService.ts'), 'utf8')
  t.ok(
    core.includes(
      'if (!this.coreMouseService.areMouseEventsActive || this._selectionService!.shouldForceSelection(ev)) {'
    ),
    'mousedown skips the report when tracking is off or selection is forced'
  )
  t.ok(
    /shouldForceSelection\(event: MouseEvent\): boolean \{[\s\S]{0,200}return event\.shiftKey;/.test(
      selection
    ),
    'Shift forces selection off macOS'
  )
  t.ok(
    core.includes('moveTextAreaUnderMouseCursor(event, this.textarea!, this.screenElement!);'),
    'Linux: the middle click moves the textarea under the pointer (native paste target)'
  )
})
