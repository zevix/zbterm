#!/usr/bin/env node
// The ZBTerm walk-through: starts ZBTerm on scratch data and drives its real
// UI through the debug server, with a caption for every feature shown. Run it
// with ./demo.sh (see `./demo.sh --help`); docs/OVERVIEW.md is the text it
// follows, docs/demo.md the storyboard.
//
// Part one: one window - sessions, time travel, search, pins, the window
// chrome. Part two: that window moves to the right half of the screen, a
// second ZBTerm opens in the left half with a profile of its own, and the two
// share a terminal: invite link, approval, live view, keyboard sharing.
'use strict'

const path = require('path')
const readline = require('readline')
const lib = require('./lib')
const { writeFixtures, writeDotSsh, writeAppPreferences } = require('./fixtures')
const { opts, log, pause, sleepRaw, waitFor } = lib

const HELP = `Usage: ./demo.sh [options]

Runs the ZBTerm walk-through on scratch data (never your own profile).
Don't touch the mouse or keyboard over the demo's windows while it runs.

  --part <1|2|all>     which part to run (default: all)
                         1  one window: sessions, time travel, search, pins
                         2  two windows side by side: invite, approval, live sharing
  --speed <n>          pacing: 1 is the recording pace, 2 twice as fast (default: 1)
  --fast               the same as --speed 4: a quick check that every step works
  --step               wait for Enter in this terminal before each scene
  --no-captions        no caption cards (title cards and key badges stay)
  --packaged           run the packaged app from out/ instead of this checkout
  --out <dir>          where the packaged build is (default: out, or $ZBTERM_FORGE_OUT_DIR)
  --screen <WxH+X+Y>   the screen area to use (default: the display's work area)
  --wayland            don't force X11; on Wayland the windows cannot be placed
  --keep               keep the scratch directory (logs, storage) afterwards
  --close              close the windows when the demo ends instead of waiting
  --shots <dir>        save a picture of each window as every scene ends
  --verbose            print every caption as it is shown
  -h, --help           this text
`

function parseArgs(argv) {
  const args = { part: 'all', packaged: false, keep: false, close: false, x11: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`)
      return argv[++i]
    }
    if (arg === '-h' || arg === '--help') args.help = true
    else if (arg === '--part') args.part = value()
    else if (arg === '--speed') opts.speed = Number(value())
    else if (arg === '--fast') opts.speed = 4
    else if (arg === '--step') opts.step = true
    else if (arg === '--no-captions') opts.captions = false
    else if (arg === '--packaged') args.packaged = true
    else if (arg === '--out') args.outRoot = value()
    else if (arg === '--screen') args.screen = value()
    else if (arg === '--wayland') args.x11 = false
    else if (arg === '--keep') args.keep = true
    else if (arg === '--close') args.close = true
    else if (arg === '--verbose') opts.verbose = true
    else if (arg === '--shots') args.shots = path.resolve(process.env.ZBDEMO_CWD || '.', value())
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!['1', '2', 'all'].includes(args.part)) throw new Error('--part takes 1, 2 or all')
  if (!Number.isFinite(opts.speed) || opts.speed < 0.1 || opts.speed > 20) {
    throw new Error('--speed takes a number from 0.1 to 20')
  }
  if (args.screen) {
    const m = /^(\d+)x(\d+)(?:\+(-?\d+)\+(-?\d+))?$/.exec(args.screen)
    if (!m) throw new Error('--screen takes WxH or WxH+X+Y')
    args.area = { width: +m[1], height: +m[2], x: +(m[3] || 0), y: +(m[4] || 0) }
    if (args.area.width < 800 || args.area.height < 500) {
      throw new Error('--screen takes an area of at least 800x500')
    }
  }
  if (!args.outRoot && process.env.ZBTERM_FORGE_OUT_DIR) {
    args.outRoot = process.env.ZBTERM_FORGE_OUT_DIR
  }
  return args
}

// --- scene plumbing ---------------------------------------------------------

let sceneNo = 0
let sceneTitle = ''
let shots = null
// --shots: a picture of every window as each scene ends.
async function shoot(label) {
  if (!shots) return
  for (const app of shots.apps()) {
    const slug = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    const file = path.join(shots.dir, `${String(sceneNo).padStart(2, '0')}-${slug}-${app.name}.png`)
    await app.screenshot(file).catch(() => null)
  }
}
// A picture in the middle of a scene.
function snap(label) {
  return shoot(`${sceneTitle}-${label}`)
}
async function scene(title) {
  if (sceneNo) await shoot(sceneTitle)
  sceneTitle = title
  sceneNo++
  log(`scene ${sceneNo}: ${title}`)
  if (!opts.step || !process.stdin.isTTY) return
  await ask(`  Enter for scene ${sceneNo} (${title}) `)
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    // readline swallows Ctrl+C on a terminal; hand it on as the signal it is.
    rl.on('SIGINT', () => {
      rl.close()
      process.kill(process.pid, 'SIGINT')
    })
    rl.question(question, () => {
      rl.close()
      resolve()
    })
  })
}

// The engine is up, a profile is open and the terminal is drawn.
async function waitReady(app, timeoutMs = 90000) {
  return waitFor(
    async () => {
      const health = await app.api('GET', '/health')
      const picker = (health.popups || []).some((popup) => popup.type === 'profile-picker')
      return health.ok && !picker ? health : null
    },
    `${app.name}: app ready`,
    timeoutMs,
    300
  )
}

// The demo needs what this checkout adds to the debug server; an older
// packaged build has neither the input routes nor the overlay.
async function checkInstrumentation(app) {
  try {
    await app.cmd('demo-overlay', { on: true })
    await app.mouse({ type: 'move', x: 5, y: 5 })
  } catch (err) {
    throw new Error(
      `${app.name}: this build has no demo instrumentation (${err.message}).\n` +
        "  A packaged build must be made from this checkout: run 'npm run package', or drop --packaged."
    )
  }
}

async function identityWizardOpen(app) {
  const state = await app.cmd('modal-state').catch(() => null)
  return !!(state && state.title === 'Choose your identity')
}

// The identity wizard opens by itself on a profile with no identity.
async function waitIdentityWizard(app, timeoutMs = 8000) {
  return waitFor(() => identityWizardOpen(app), `${app.name}: identity wizard`, timeoutMs).catch(
    () => false
  )
}

// Clicks a button of the open dialog by its label.
async function clickDialogButton(app, text, extra = {}) {
  const selector = extra.selector || '.modal-overlay button, .session-editor button'
  await app.click(selector, { text, ...extra })
}

// Replaces what a focused text field holds.
async function fillField(app, selector, text, extra = {}) {
  await app.click(selector, { after: 200 })
  await app.api('POST', '/input/key', { chord: 'Ctrl+A' })
  await sleepRaw(80)
  await app.type(text, { after: extra.after === undefined ? 350 : extra.after })
}

async function playbackState(app) {
  return app.cmd('playback-state')
}

function waitMode(app, mode, timeoutMs = 15000) {
  return waitFor(
    async () => (await playbackState(app)).mode === mode,
    `${app.name}: ${mode} mode`,
    timeoutMs
  )
}

async function selectedSessionId(app) {
  return (await app.ui()).selectedId
}

// A field of one launch step in the open session dialog (the steps editor,
// renderer/plugins/steps-editor.js): `cwd` of Change Directory, `command` of
// Shell Command.
function stepField(index, name) {
  return `.session-editor .launch-step[data-index="${index}"] input[name="${name}"]`
}

async function launchState(app) {
  return app.cmd('launch-state').catch(() => null)
}

// "+ Add", then a plugin from its menu.
async function addStep(app, plugin, title, extra = {}) {
  const before = ((await launchState(app)) || { steps: [] }).steps.length
  await app.click('.session-editor .launch-add', { after: 500 })
  await waitFor(
    async () => {
      const state = await launchState(app)
      return state && state.menuOpen
    },
    `${app.name}: the + Add menu`,
    8000
  )
  await pause(extra.menuMs || 900)
  await app.click(`.session-editor .launch-add-item[data-plugin="${plugin}"]`, { text: title })
  const field = { cd: 'cwd', shell: 'command', ssh: 'ssh-host', 'ssh-cd': 'remote-cwd' }[plugin]
  await app.waitRect(stepField(before, field))
}

// A session made through the real New dialog. A new session's steps are
// Change Directory (`~/`) and an empty Shell Command (the default shell).
async function newSessionViaDialog(app, { name, cwd, record }) {
  await app.click('#newSession')
  await app.waitRect('#sessionEditorName')
  await fillField(app, '#sessionEditorName', name)
  if (cwd) await fillField(app, stepField(0, 'cwd'), cwd)
  if (record === false) {
    await app.click('.session-editor-record input', { after: 500 })
  }
  return async function submit() {
    await app.click('.session-editor button[type="submit"]')
    const session = await app.waitSession(name)
    await waitFor(
      async () => (await selectedSessionId(app)) === session.sessionId,
      `${app.name}: "${name}" selected`
    )
    await waitPrompt(app)
    return session
  }
}

function waitPrompt(app, timeoutMs = 20000) {
  return waitFor(
    async () => /@laptop:.*\$\s*$/m.test(await app.termText()),
    `${app.name}: a shell prompt`,
    timeoutMs
  )
}

// --- part one: one window ---------------------------------------------------

async function partOne(ctx) {
  const { alice } = ctx

  await scene('intro')
  await alice.card('ZBTerm', 'Secure terminal recording, playback and peer-to-peer sharing', {
    lines: [
      'Every session recorded and encrypted · time travel · live sharing over Pear or Freenet'
    ]
  })
  // Behind the card: the identity wizard a fresh profile opens with. Part two
  // shows it; here it is put aside.
  if (await waitIdentityWizard(alice, 6000)) {
    await alice.cmd('click', { text: 'Not now' })
  }
  await pause(4200)
  await alice.hideCard()
  await pause(900)
  await alice.say(
    'Welcome',
    'One window: your sessions on the left, the terminal on the right, the time slider below.',
    { ms: 5600 }
  )

  // -- a recorded session --
  await scene('a new session')
  await alice.caption('New session', 'A session is a profile: a name, and the steps that start it.')
  const submitBuild = await newSessionViaDialog(alice, { name: 'build', cwd: '~/shop-api' })
  await alice.say(
    'New session',
    'It is recorded from its first byte, encrypted on disk. Untick <b>Record session</b> to keep one off the record.',
    { ms: 4200 }
  )
  ctx.build = await submitBuild()
  await alice.say(
    'A real shell',
    'A PTY-backed shell: anything that runs in a terminal runs here.',
    {
      ms: 2200
    }
  )
  await alice.run('ls')
  await alice.run('./build.sh', { after: 200 })
  await alice.waitTerm('Build succeeded', 30000)
  await pause(900)
  await alice.run('./deploy.sh staging', { after: 200 })
  await alice.waitTerm('rolled back', 20000)
  await pause(1200)

  // -- time travel --
  await scene('time travel')
  await alice.say(
    'Time travel',
    'Scrolled away, or cleared by a full-screen program? Hold <kbd>Alt</kbd> and turn the wheel: one notch back is one frame back.',
    { ms: 3600 }
  )
  await alice.wheel('#terminal', -120, { count: 9, modifiers: ['alt'], at: [0.5, 0.35] })
  await waitMode(alice, 'playback')
  await pause(900)
  await snap('alt-wheel')
  await alice.say(
    'The time slider',
    'Green marks are activity. The bubble shows the wall-clock time of the frame under the pointer.',
    { ms: 1200 }
  )
  await alice.moveTo('#scrubber', { at: [0.8, 0.5] })
  await alice.moveTo('#scrubber', { at: [0.25, 0.5], durationMs: 1800 / opts.speed })
  await pause(900)
  await alice.click('#scrubber', { at: [0.3, 0.5] })
  await pause(1100)
  await alice.say(
    'History toolbar',
    '<b>|<<</b> first frame · <b>|<</b> and <b>>|</b> one frame · <b>▶</b> replay as it happened · <b>>>|</b> back to live.',
    { ms: 1400 }
  )
  await alice.click('#jumpStart')
  await alice.click('#stepForward', { after: 380 })
  await alice.click('#stepForward', { after: 380 })
  await alice.click('#stepForward', { after: 380 })
  await alice.say(
    'Compressed time',
    'Nothing happened for seconds while the artifact uploaded. This button folds idle stretches longer than 2 s, on the slider and in playback.',
    { ms: 3400 }
  )
  await alice.spotlight('#collapseGaps', { ms: 2600 })
  await alice.click('#collapseGaps', { after: 900 })
  await alice.moveTo('#timeLabel')
  await pause(1700)
  await snap('collapsed')
  await alice.caption('Replay', 'Play it back, at up to 8x.')
  await alice.click('#playPause', { after: 300 })
  await waitFor(async () => (await playbackState(alice)).playing, 'playback running', 8000).catch(
    () => null
  )
  await pause(5200)
  await alice.say(
    'Select in history',
    'Dragging over the text pauses the replay and copies the selection.',
    { ms: 900 }
  )
  await alice.drag('#terminal', '#terminal', {
    fromExtra: { at: [0.02, 0.12] },
    toExtra: { at: [0.45, 0.12] },
    durationMs: 1100 / opts.speed
  })
  await pause(1400)
  await snap('selection')
  await alice.say('Back to now', '<b>Live</b> returns to the running shell: it never stopped.', {
    ms: 1100
  })
  await alice.click('#goLive')
  await waitMode(alice, 'live')
  await alice.click('#collapseGaps', { after: 300 })
  await pause(700)

  // -- more sessions --
  await scene('more sessions')
  await alice.caption(
    'Templates',
    'Any profile can be the template for a way of starting a session. This one: whatever <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> opens.'
  )
  const submitLogs = await newSessionViaDialog(alice, { name: 'logs', cwd: '~/shop-api' })
  await alice.click('.session-editor-advanced summary', { after: 700 })
  await alice.spotlight('.session-editor-advanced select', { ms: 2200 })
  await alice.moveTo('.session-editor-advanced select')
  const chosen = await alice.cmd('dialog-set', {
    field: 'Set this profile as default for new sessions when:',
    value: 'CTRL+SHIFT+T is pressed'
  })
  if (!chosen || !chosen.set) throw new Error('the template choice was not found in the dialog')
  await pause(1500)
  await alice.click('.session-editor-advanced label', {
    text: 'Skip new/edit profile dialog and open directly',
    at: [0.04, 0.5],
    after: 1200
  })
  await snap('template')
  ctx.logs = await submitLogs()
  await alice.run('./logs.sh', { after: 300 })
  await alice.waitTerm('payment gateway timeout', 20000)
  await pause(1500)

  await alice.say(
    'One chord, one session',
    '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> now opens a copy of that profile at once: same directory, same settings, no dialog.',
    { ms: 3400 }
  )
  const before = new Set((await alice.sessions()).map((session) => session.sessionId))
  await alice.key('Ctrl+Shift+T', { after: 300 })
  const third = await waitFor(
    async () => (await alice.sessions()).find((session) => !before.has(session.sessionId)),
    'the Ctrl+Shift+T session'
  )
  await waitFor(
    async () => (await selectedSessionId(alice)) === third.sessionId,
    'the new session selected'
  )
  await waitPrompt(alice)
  await pause(2200)
  await alice.say('Rename', '<kbd>F2</kbd> edits the selected session.', { ms: 1300 })
  await alice.key('F2', { after: 300 })
  await alice.waitRect('#sessionEditorName')
  await fillField(alice, '#sessionEditorName', 'deploy')
  await alice.key('Enter', { badge: 'Enter', after: 300 })
  ctx.deploy = await alice.waitSession('deploy')
  await pause(500)
  // A click in the terminal gives it the keyboard back.
  await alice.click('#terminal', { at: [0.5, 0.6], after: 250 })
  await alice.run('git status 2>/dev/null || echo "ready to deploy"', { after: 900 })

  await alice.say(
    'Switch sessions',
    '<kbd>Ctrl</kbd>+<kbd>PgUp</kbd> and <kbd>Ctrl</kbd>+<kbd>PgDn</kbd> walk the list. Every session keeps running.',
    { ms: 1600 }
  )
  await alice.key('Ctrl+PageDown', { after: 1300 })
  await alice.key('Ctrl+PageDown', { after: 1300 })
  await alice.key('Ctrl+PageUp', { after: 1300 })

  // -- pins and order --
  await scene('pins and order')
  await alice.say(
    'Pins',
    'Pin the sessions you live in. <kbd>Ctrl</kbd>+<kbd>1</kbd> … <kbd>Ctrl</kbd>+<kbd>9</kbd> jump to them.',
    { ms: 1400 }
  )
  for (const session of [ctx.build, ctx.logs]) {
    const row = alice.rowSelector(session.sessionId)
    await alice.moveTo(row)
    await alice.click(`${row} .session-action[data-action="pin"]`, { after: 700 })
  }
  await alice.moveTo('#terminal', { at: [0.5, 0.5] })
  await alice.key('Ctrl+2', { after: 300 })
  await waitFor(
    async () => (await selectedSessionId(alice)) === ctx.logs.sessionId,
    'Ctrl+2 selected the second pin',
    8000
  )
  await pause(1000)
  await alice.key('Ctrl+1', { after: 300 })
  await waitFor(
    async () => (await selectedSessionId(alice)) === ctx.build.sessionId,
    'Ctrl+1 selected the first pin',
    8000
  )
  await pause(1000)
  await alice.say(
    'Your order',
    'Drag a session by its icon to where you want it. The order survives a restart.',
    {
      ms: 1200
    }
  )
  await alice.moveTo(alice.rowSelector(ctx.logs.sessionId))
  await alice.drag(
    `${alice.rowSelector(ctx.logs.sessionId)} .session-handle`,
    `${alice.rowSelector(ctx.build.sessionId)}`,
    {
      toExtra: { at: [0.3, 0.1] },
      durationMs: 1300 / opts.speed,
      onHold: () => snap('dragging')
    }
  )
  await pause(1500)
  await snap('reordered')

  // -- search --
  await scene('search')
  await alice.say(
    'Search',
    '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>: one box filters the sessions by name and searches what they hold in memory.',
    { ms: 2200 }
  )
  await alice.key('Ctrl+Shift+F', { after: 500 })
  await alice.type('error', { after: 600 })
  await waitFor(
    async () => {
      const state = await alice.cmd('search-state')
      return state.inSession && state.inSession.total > 0
    },
    'search matches',
    15000
  ).catch(() => null)
  await pause(1800)
  await alice.say(
    'Search',
    'Every match is highlighted, with the count in the box. <kbd>Enter</kbd> and <kbd>Shift</kbd>+<kbd>Enter</kbd> step through them.',
    { ms: 3000 }
  )
  await alice.key('Enter', { badge: 'Enter', after: 900 })
  await alice.key('Enter', { badge: 'Enter', after: 900 })
  await alice.key('Shift+Enter', { badge: 'Shift+Enter', after: 1100 })
  await snap('matches')
  await alice.say(
    'Search',
    '<b>Session buffer matches</b> lists every live session holding the text. <kbd>↓</kbd> and <kbd>↑</kbd> pick one without leaving the box.',
    { ms: 1600 }
  )
  await alice.key('Down', { badge: '↓', after: 1300 })
  await alice.key('Down', { badge: '↓', after: 1300 })
  await alice.key('Up', { badge: '↑', after: 1300 })
  await snap('buffer-matches')
  await alice.say('Search', '<kbd>Esc</kbd> clears it and returns to the terminal.', { ms: 1500 })
  await alice.key('Escape', { badge: 'Esc', after: 2200 })

  // -- the window --
  await scene('the window')
  await alice.say(
    'More room',
    '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> (or a click on the logo) folds the side pane away.',
    { ms: 1400 }
  )
  await alice.key('Ctrl+Shift+B', { after: 1900 })
  await snap('collapsed-pane')
  await alice.key('Ctrl+Shift+B', { after: 1100 })
  await alice.say(
    'Font size',
    '<kbd>Ctrl</kbd>+<kbd>+</kbd> and <kbd>Ctrl</kbd>+<kbd>-</kbd> resize the terminal font.',
    {
      ms: 900
    }
  )
  await alice.key('Ctrl+=', { after: 600 })
  await alice.key('Ctrl+=', { after: 900 })
  await alice.key('Ctrl+-', { after: 500 })
  await alice.key('Ctrl+-', { after: 800 })
  await alice.say('Themes', 'Dark or light.', { ms: 500 })
  await alice.click('#themeToggle', { after: 2000 })
  await snap('light')
  await alice.click('#themeToggle', { after: 900 })
  await alice.say(
    'Settings',
    'Hotkey mappings, the template behind each way of starting a session, STUN and relay settings.',
    { ms: 600 }
  )
  await alice.click('#settingsToggle', { after: 3200 })
  await snap('settings')
  await alice.key('Escape', { badge: 'Esc', after: 700 })

  // -- end, compose the launch, resume --
  await scene('end and resume')
  await alice.click(alice.rowSelector(ctx.build.sessionId), { after: 700 })
  await waitFor(
    async () => (await selectedSessionId(alice)) === ctx.build.sessionId,
    'the build session selected'
  )
  await alice.click('#terminal', { at: [0.5, 0.6], after: 250 })
  await alice.say(
    'The end is not the end',
    'When a shell exits, its recording stays in the list.',
    {
      ms: 1400
    }
  )
  await alice.run('exit', { after: 300 })
  await waitFor(
    async () => {
      const session = await alice.sessionByName('build')
      return session && !session.active
    },
    'the build session ended',
    15000
  )
  await pause(1500)
  await alice.say(
    'Launch steps',
    '<kbd>F2</kbd> opens its profile: let it do the routine by itself.',
    { ms: 3400 }
  )
  await alice.key('F2', { after: 300 })
  await alice.waitRect(stepField(1, 'command'))
  await pause(600)
  await alice.spotlight('.session-editor .launch-steps', { ms: 2600 })
  await alice.say(
    'Launch steps',
    'Steps run top to bottom: a directory, then a command. Empty, it is the default shell.',
    { ms: 5400 }
  )
  await alice.caption('Shell Command', 'This one runs the build.')
  await fillField(alice, stepField(1, 'command'), './build.sh', { after: 900 })
  await alice.caption(
    '+ Add',
    'Offers what fits after the last step: a command, a directory, or <b>SSH</b> to another machine.'
  )
  await addStep(alice, 'shell', 'Shell Command', { menuMs: 3200 })
  await pause(400)
  await alice.caption('Another command', 'Deploy to canary once the build has passed.')
  await alice.type('./deploy.sh canary', { after: 2700 })
  await alice.say(
    'Keep the shell',
    'A launch that ends on a command ends with it. An empty <b>Shell Command</b> at the end keeps a shell open.',
    { ms: 1800 }
  )
  await addStep(alice, 'shell', 'Shell Command')
  await pause(1600)
  const composed = await launchState(alice)
  const command = (composed && composed.launch && composed.launch.command) || ''
  if (!/\.\/build\.sh && \.\/deploy\.sh canary && exec /.test(command)) {
    throw new Error(
      `the launch steps compiled to an unexpected command: ${JSON.stringify(command)}`
    )
  }
  await snap('steps')
  await alice.click('.session-editor button[type="submit"]', { after: 500 })
  await waitFor(async () => !(await launchState(alice)), 'the session dialog closed', 8000)
  await alice.say(
    'Resume',
    '<kbd>Ctrl</kbd>+<kbd>R</kbd> (or <b>Extend</b>) starts it again from its steps, on a fresh line under the old screen, in the same recording.',
    { ms: 2200 }
  )
  await alice.key('Ctrl+R', { after: 400 })
  await waitFor(
    async () => {
      const session = await alice.sessionByName('build')
      return session && session.active
    },
    'the build session resumed',
    20000
  )
  // The old screen already holds a "Build succeeded"; only the canary deploy is new.
  await alice.waitTerm('Deployed', 40000)
  await waitPrompt(alice)
  await alice.say('Resume', 'Built, deployed, and a shell in <b>~/shop-api</b>.', { ms: 3400 })
  await alice.clearCaption()
}

// --- part two: two windows --------------------------------------------------

function halves(area) {
  const gap = 0
  const leftWidth = Math.floor(area.width / 2)
  return {
    left: { x: area.x, y: area.y, width: leftWidth - gap, height: area.height },
    right: { x: area.x + leftWidth, y: area.y, width: area.width - leftWidth, height: area.height }
  }
}

async function partTwo(ctx) {
  const { alice, area } = ctx
  const slots = halves(area)
  if (slots.left.width <= 780) {
    log(
      `note: half of this screen is ${slots.left.width} px wide; at 780 px or less ZBTerm shows a ` +
        'drop-down instead of the session list'
    )
  }

  await scene('side by side')
  await alice.card('Sharing', 'A live terminal, peer to peer, end-to-end encrypted', {
    lines: ['Alice hosts on the right · Bob joins on the left'],
    ms: 0
  })
  await pause(3200)
  await alice.hideCard()
  await pause(500)
  await alice.glideWindow(slots.right, 1100)
  await alice.caption(
    'Alice · host',
    'Alice makes room: a colleague is about to join her terminal.'
  )

  // The session to share: Alice's own live "build".
  let build = await alice.sessionByName('build')
  if (!build || !build.active) {
    const submit = await newSessionViaDialog(alice, { name: 'build', cwd: '~/shop-api' })
    build = await submit()
  } else if ((await selectedSessionId(alice)) !== build.sessionId) {
    await alice.click(alice.rowSelector(build.sessionId))
  }
  ctx.build = build

  // -- the second instance --
  await scene('a second ZBTerm')
  const bob = await lib.startApp('bob', ctx.scratch, {
    ...ctx.launch,
    env: { ...ctx.launch.env, USER: 'bob', LOGNAME: 'bob', ZBDEMO_WHO: 'bob' }
  })
  ctx.bob = bob
  await bob.api('POST', '/window/bounds', slots.left)
  await checkInstrumentation(bob)
  // Alice's default profile is open, so this instance asks which one to use.
  const pickerShown = await waitFor(
    async () => {
      const popups = await bob.api('GET', '/popups')
      return popups.some((popup) => popup.type === 'profile-picker')
    },
    'bob: profile picker',
    20000
  ).catch(() => false)
  await bob.api('POST', '/window/bounds', slots.left)
  if (pickerShown) {
    await bob.say(
      'Bob · a second ZBTerm',
      'One profile, one running app. A second ZBTerm asks which profile to open: each has its own sessions, keys and identity.',
      { ms: 3200 }
    )
    await bob.click('#profileName', { after: 250 })
    await bob.type('Bob', { after: 500 })
    await snap('profile')
    await bob.click('#createProfile', { after: 300 })
  }
  await waitReady(bob)
  await bob.api('POST', '/window/bounds', slots.left)
  if (await waitIdentityWizard(bob, 10000)) {
    await bob.say(
      'Bob · identity',
      'Who are you to your peers? Prove a GitHub username by signing with one of your SSH keys, or stay unverified.',
      { ms: 4200, position: 'top' }
    )
    await snap('identity')
    await bob.click('.modal-overlay button', { text: 'Not now', after: 500 })
  }
  await bob.caption('Bob · viewer', 'Bob is ready to join.', { position: 'bottom' })
  await pause(1200)

  // -- the invite --
  await scene('the invite')
  await alice.say('Alice · share', '<b>Share</b> makes an invite link for this session.', {
    ms: 2400
  })
  await alice.click('#shareSession')
  await alice.waitModal((modal) => modal && modal.title === 'Share session', 'share dialog')
  await alice.say(
    'Alice · the link',
    '<b>Single-use</b>: one viewer, consumed on joining. <b>Group</b>: several viewers, each approved by the host.',
    { ms: 4200 }
  )
  await alice.click('.modal-overlay .share-option', { text: 'Group', after: 900 })
  await alice.say(
    'Alice · the link',
    '<b>Require approval to join</b> is on for a group link. <b>Only verified people can join</b> admits GitHub-verified identities only.',
    { ms: 3600 }
  )
  await snap('share-dialog')
  await clickDialogButton(alice, 'Share')
  await alice.waitModal((modal) => modal && modal.title === 'Share key', 'the share key', 60000)
  await alice.say(
    'Alice · the invite',
    'A <b>zbterm://join/…</b> link. It goes to Bob over any channel: chat, mail, a QR code.',
    { ms: 2400 }
  )
  await clickDialogButton(alice, 'Copy', { after: 900 })
  await snap('share-key')
  await clickDialogButton(alice, 'Done', { after: 500 })
  await alice.caption('Alice · host', 'Waiting for Bob.')

  await scene('joining')
  await bob.say('Bob · join', '<b>Join</b>, paste the invite.', { ms: 900 })
  await bob.click('#joinLink')
  await bob.waitModal((modal) => modal && modal.title === 'Join session', 'join dialog')
  await clickDialogButton(bob, 'Paste', { after: 900 })
  await waitFor(
    async () => {
      const layout = await bob.api('GET', '/renderer/layout')
      const modal = layout.renderer && layout.renderer.modal
      return modal && String(modal.inputValue || '').startsWith('zbterm://join/')
    },
    'bob: the pasted link',
    10000
  )
  await pause(900)
  await snap('pasted')
  await clickDialogButton(bob, 'Join', { after: 300 })
  await bob.caption(
    'Bob · join',
    'Connecting to Alice, peer to peer. Nothing passes through a server in the clear.'
  )

  await scene('approval')
  await waitFor(
    async () => {
      const popups = await alice.api('GET', '/popups')
      return popups.find((popup) => popup.type === 'share-approval')
    },
    'alice: the approval request',
    120000,
    400
  )
  await alice.waitRect('.modal-overlay button', { text: 'Approve' })
  await alice.say(
    'Alice · approval',
    'Alice sees who is asking, and what is known about their identity. Nobody watches before she says so.',
    { ms: 3800 }
  )
  await snap('request')
  await clickDialogButton(alice, 'Approve', { after: 400 })
  await alice.caption('Alice · host', 'Approved. Joining rotates the session key.')

  await scene('live')
  const joined = await waitFor(
    async () => {
      const list = await bob.sessions()
      return list.find((session) => session.owner !== 'my' && !session.pending)
    },
    'bob: the joined session',
    120000,
    400
  )
  ctx.joined = joined
  await waitFor(async () => /@laptop/.test(await bob.termText()), 'bob: the shared terminal', 60000)
  await bob.say(
    'Bob · live',
    'Bob sees the live terminal at once. Its history downloads in the background.',
    { ms: 2600 }
  )
  await alice.click('#terminal', { at: [0.5, 0.6], after: 250 })
  await alice.caption('Alice · host', 'Alice keeps working.')
  await alice.run('./build.sh', { after: 200 })
  await alice.waitTerm('Build succeeded', 40000)
  await bob.waitTerm('Build succeeded', 40000)
  await pause(1500)

  // -- the viewer's own time --
  await scene('the viewer in history')
  await bob.say(
    'Bob · his own time',
    'Bob can go back through what he missed while Alice carries on: <kbd>Alt</kbd>+wheel, the slider, replay.',
    { ms: 1600 }
  )
  await bob.wheel('#terminal', -120, { count: 8, modifiers: ['alt'], at: [0.5, 0.4] })
  await pause(900)
  await snap('behind')
  await alice.run('./deploy.sh staging', { after: 200 })
  await alice.waitTerm('rolled back', 20000)
  await pause(1200)
  await bob.say('Bob · back to live', 'The <b>Live</b> button blinks while he is behind.', {
    ms: 1800
  })
  await bob.click('#goLive')
  await waitMode(bob, 'live').catch(() => null)
  await pause(1500)

  // -- keyboard sharing --
  await scene('keyboard sharing')
  await alice.say(
    'Alice · keyboard',
    'Viewers only watch. The host can hand them the keyboard, for everyone at once, and take it back.',
    { ms: 2600 }
  )
  await alice.click('#inputMode')
  await alice.waitRect('.modal-overlay button', { text: 'Share Keyboard' })
  await pause(1600)
  await snap('confirm')
  await clickDialogButton(alice, 'Share Keyboard', { after: 600 })
  await waitFor(
    async () => {
      const found = await bob.rect('#inputMode')
      return found && /shared/i.test(found.text)
    },
    'bob: keyboard shared',
    20000
  )
  await bob.caption('Bob · typing', "Now Bob types into Alice's shell.")
  await bob.click('#terminal', { at: [0.5, 0.6], after: 300 })
  await bob.run('echo "bob here - try api-3 again"', { after: 400 })
  await alice.waitTerm('bob here', 20000)
  await pause(2200)
  await alice.say('Alice · keyboard', 'One click takes the keyboard back.', { ms: 700 })
  await alice.click('#inputMode', { after: 1500 })

  // -- a session on another machine --
  await scene('ssh')
  await sshSession(ctx)

  // -- outro --
  await scene('outro')
  await bob.clearCaption()
  await alice.clearCaption()
  await pause(600)
  const lines = [
    'Encrypted at rest and in transit · the key rotates on every join',
    'Pear (Hyperswarm) with relay fallback · Freenet (experimental)',
    'Open source, Apache-2.0'
  ]
  await bob.card('ZBTerm', 'Record. Replay. Share.', { lines })
  await alice.card('ZBTerm', 'github.com/zevix/zbterm', { lines: ['Thanks for watching'] })
  await pause(6000)
}

// A session whose launch is one SSH step, shared with a single-use link. The
// host is starwarstel.net (Host "starwars" in the demo's ssh config), which
// plays Star Wars in ASCII to anyone who connects, no account needed.
async function sshSession(ctx) {
  const { alice, bob } = ctx
  await bob.clearCaption()
  await alice.say(
    'Alice · SSH',
    'A session can start on another machine. Alice opens one over <b>SSH</b>, and shares it too.',
    { ms: 2600 }
  )
  await alice.click('#newSession')
  await alice.waitRect('#sessionEditorName')
  await fillField(alice, '#sessionEditorName', 'star wars', { after: 500 })
  // The new session's empty Shell Command goes: SSH takes over the terminal.
  const fresh = await launchState(alice)
  if (fresh && fresh.steps.length > 1 && fresh.steps[1].plugin === 'shell') {
    await alice.click('.session-editor .launch-step[data-index="1"] .launch-step-remove', {
      after: 600
    })
  }
  const at = ((await launchState(alice)) || { steps: [] }).steps.length
  await addStep(alice, 'ssh', 'SSH', { menuMs: 1500 })
  await alice.caption(
    'SSH · host',
    '<b>user@host</b>, or a Host from the ssh config: typing filters the list.'
  )
  await alice.type('st', { after: 3900, delayMs: 220 })
  await alice.waitRect('.session-editor .launch-combo-item', { text: 'starwars' })
  await snap('ssh-hosts')
  await alice.caption(
    'SSH · host',
    '<kbd>Down</kbd> walks the list, <kbd>Enter</kbd> takes a name.'
  )
  await alice.key('ArrowDown', { after: 1100 })
  await alice.key('Enter', { after: 900 })
  await alice.click(stepField(at, 'ssh-identity'), { after: 300 })
  await alice.key('ArrowDown', { after: 300 })
  await alice.waitRect('.session-editor .launch-combo-item', { text: 'id_ed25519' })
  await alice.say(
    'SSH · identity file',
    'The keys in the ssh directory, the same way. This host needs none.',
    { ms: 2200 }
  )
  await snap('ssh-keys')
  await alice.key('Escape', { after: 500 })
  const composed = await launchState(alice)
  const command = (composed && composed.launch && composed.launch.command) || ''
  if (!/^ssh .*starwars$/.test(command)) {
    throw new Error(`the SSH step compiled to an unexpected command: ${JSON.stringify(command)}`)
  }
  await alice.click('.session-editor button[type="submit"]')
  const session = await alice.waitSession('star wars')
  await waitFor(
    async () => (await selectedSessionId(alice)) === session.sessionId,
    'alice: "star wars" selected'
  )
  await alice.say('Alice · SSH', '<b>starwarstel.net</b> plays a film to anyone who connects.', {
    ms: 2400
  })
  await alice.waitTerm(/C\s*E\s*N\s*T\s*U\s*R\s*Y|E\s?p\s?i\s?s\s?o\s?d\s?e/, 45000)
  await pause(1600)

  await alice.say(
    'Alice · share',
    'This time a <b>Single-use</b> link: it lets one viewer in, then it is spent.',
    { ms: 1600 }
  )
  await alice.click('#shareSession')
  await alice.waitModal((modal) => modal && modal.title === 'Share session', 'share dialog')
  await alice.click('.modal-overlay .share-option', { text: 'Single-use', after: 1200 })
  await clickDialogButton(alice, 'Share')
  await alice.waitModal((modal) => modal && modal.title === 'Share key', 'the share key', 60000)
  await clickDialogButton(alice, 'Copy', { after: 800 })
  await clickDialogButton(alice, 'Done', { after: 400 })
  await alice.clearCaption()

  await bob.say('Bob · join', 'Bob joins the second session the same way.', { ms: 700 })
  await bob.click('#joinLink')
  await bob.waitModal((modal) => modal && modal.title === 'Join session', 'join dialog')
  await clickDialogButton(bob, 'Paste', { after: 700 })
  await waitFor(
    async () => {
      const layout = await bob.api('GET', '/renderer/layout')
      const modal = layout.renderer && layout.renderer.modal
      return modal && String(modal.inputValue || '').startsWith('zbterm://join/')
    },
    'bob: the pasted link',
    10000
  )
  await clickDialogButton(bob, 'Join', { after: 300 })
  // A single-use link still asks the host when she wants to be asked.
  const joined = await waitFor(
    async () => {
      const popups = await alice.api('GET', '/popups')
      if (popups.some((popup) => popup.type === 'share-approval')) {
        const approve = await alice.rect('.modal-overlay button', { text: 'Approve' })
        if (approve) await clickDialogButton(alice, 'Approve', { after: 300 }).catch(() => null)
      }
      const list = await bob.sessions()
      return list.find(
        (entry) =>
          entry.owner !== 'my' &&
          !entry.pending &&
          (!ctx.joined || entry.sessionId !== ctx.joined.sessionId)
      )
    },
    'bob: the joined SSH session',
    120000,
    500
  )
  if ((await selectedSessionId(bob)) !== joined.sessionId) {
    await bob.click(bob.rowSelector(joined.sessionId), { after: 400 })
  }
  await bob.waitTerm(/<<|C\s*E\s*N\s*T|E\s?p\s?i|r\s?e\s?b\s?e\s?l/i, 60000)
  await bob.say(
    'Bob · live',
    "The film plays on Alice's machine, over her ssh, and reaches Bob end-to-end encrypted.",
    { ms: 5200 }
  )
  await snap('ssh-shared')
  await pause(4000)
}

// --- main -------------------------------------------------------------------

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`demo: ${err.message}\n`)
    console.error(HELP)
    process.exit(2)
  }
  if (args.help) {
    console.log(HELP)
    return
  }

  const scratch = lib.makeScratch()
  const ctx = { scratch, launch: { packaged: args.packaged, outRoot: args.outRoot, x11: args.x11 } }
  let failed = null
  let stopping = false

  const finish = async (code) => {
    if (stopping) return
    stopping = true
    await lib.stopApps()
    if (args.keep || failed) log(`scratch directory kept: ${scratch}`)
    else lib.removeScratch(scratch)
    process.exit(code)
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      const code = signal === 'SIGINT' ? 130 : 143
      if (stopping) {
        // A second signal: no more waiting for a clean exit.
        lib.killAppsNow()
        process.exit(code)
      }
      log(`${signal}: closing the demo's windows`)
      finish(code)
    })
  }
  process.on('uncaughtException', (err) => {
    console.error(`demo: ${err.stack || err.message}`)
    lib.killAppsNow()
    log(`scratch directory kept: ${scratch}`)
    process.exit(1)
  })

  try {
    const env = lib.scratchEnv(scratch)
    writeFixtures(env.HOME)
    // The SSH step lists this directory's hosts and keys, not the presenter's.
    ctx.launch.args = ['--custom-dot-ssh-path', writeDotSsh(env.HOME)]
    const pkg = require(path.join(lib.ROOT, 'package.json'))
    writeAppPreferences(env.XDG_CONFIG_HOME, pkg.productName || pkg.name)
    log(`scratch directory: ${scratch}`)
    log(`pace: ${opts.speed}x${opts.step ? ', one scene per Enter' : ''}; part: ${args.part}`)

    if (args.shots) shots = { dir: args.shots, apps: () => [ctx.alice, ctx.bob].filter(Boolean) }
    ctx.launch.env = { USER: 'alice', LOGNAME: 'alice', ZBDEMO_WHO: 'alice' }
    const alice = await lib.startApp('alice', scratch, ctx.launch)
    ctx.alice = alice
    const info = await alice.windowBounds()
    const work = (info.display && info.display.workArea) || { x: 0, y: 0, width: 1280, height: 800 }
    ctx.area = args.area || work
    // One window, centred, with room around it.
    const width = Math.min(1240, ctx.area.width - 40)
    const height = Math.min(800, ctx.area.height - 40)
    ctx.single = {
      x: Math.round(ctx.area.x + (ctx.area.width - width) / 2),
      y: Math.round(ctx.area.y + (ctx.area.height - height) / 2),
      width,
      height
    }
    await alice.api('POST', '/window/bounds', ctx.single)
    await waitReady(alice)
    await checkInstrumentation(alice)
    await alice.api('POST', '/window/bounds', ctx.single)
    await alice.focus().catch(() => null)

    if (args.part === '2') {
      if (await waitIdentityWizard(alice, 6000)) await alice.cmd('click', { text: 'Not now' })
    } else {
      await partOne(ctx)
    }
    if (args.part !== '1') await partTwo(ctx)
    await shoot(sceneTitle)
    log('the demo ran to its end')
    if (opts.verbose) lib.reportCaptionTiming()
  } catch (err) {
    // A signal is closing the windows: the step in flight fails with them,
    // and finish() ends the process.
    if (stopping) return
    failed = err
    for (const app of [ctx.alice, ctx.bob].filter(Boolean)) {
      const file = path.join(scratch, `failed-${app.name}.png`)
      if (await app.screenshot(file).catch(() => null)) log(`picture of the failure: ${file}`)
    }
    console.error(`\ndemo: FAILED in scene ${sceneNo}: ${err.message}`)
    if (opts.verbose && err.stack) console.error(err.stack)
  }

  if (!args.close && process.stdin.isTTY && !stopping) {
    await ask(
      failed
        ? '\nThe windows are left open for a look. Enter closes them. '
        : '\nDone. The windows stay open so you can try things. Enter closes them. '
    )
  }
  await finish(failed ? 1 : 0)
}

main()
