// The demo driver's toolkit (scripts/demo/demo.js): starts scratch ZBTerm
// instances and drives them through the debug server - real keys, typed text
// and mouse events (POST /input/*), the demo overlay (captions, key badges,
// the drawn pointer) and the debug server's reads for every wait.
//
// Nothing here touches the user's own ZBTerm: every instance gets the demo's
// scratch storage, HOME, XDG dirs and Electron user data, and a free debug
// port. Only processes this file started are ever signalled.
'use strict'

const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..', '..')

const opts = {
  speed: 1,
  captions: true,
  step: false,
  verbose: false
}

const children = []
let stopRequested = false

function log(...args) {
  console.log(`[demo ${new Date().toTimeString().slice(0, 8)}]`, ...args)
}

function sleepRaw(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A pause the viewer needs (reading a caption, watching a change): scaled by
// --speed. Waits for the app itself never go through here.
function pause(ms) {
  return sleepRaw(Math.max(0, ms / opts.speed))
}

// How long a caption of this text stays before the next action.
function readingMs(text) {
  const plain = String(text || '').replace(/<[^>]+>/g, '')
  return Math.min(9000, 1500 + plain.length * 48)
}

function plainText(text) {
  return String(text || '').replace(/<[^>]+>/g, '')
}

// How long each caption stayed up, for --verbose: one that is replaced before
// it can be read is a pacing bug in the script.
const captionLog = []
const captionOpen = new Map()
function noteCaption(app, title, text) {
  const now = Date.now()
  const open = captionOpen.get(app.name)
  if (open) captionLog.push({ ...open, shownMs: now - open.at })
  if (text) captionOpen.set(app.name, { app: app.name, title, text: plainText(text), at: now })
  else captionOpen.delete(app.name)
}

function reportCaptionTiming() {
  const now = Date.now()
  const all = [
    ...captionLog,
    ...[...captionOpen.values()].map((c) => ({ ...c, shownMs: now - c.at }))
  ]
  const short = all.filter((c) => c.shownMs * opts.speed < readingMs(c.text) * 0.8)
  log(`captions: ${all.length} shown, ${short.length} up for less than their reading time`)
  for (const c of short) {
    log(
      `  short: ${c.app} "${c.title}" ${(c.shownMs / 1000).toFixed(1)} s of ` +
        `${(readingMs(c.text) / opts.speed / 1000).toFixed(1)} s - ${c.text.slice(0, 60)}`
    )
  }
}

async function waitFor(fn, label, timeoutMs = 30000, everyMs = 200) {
  const end = Date.now() + timeoutMs
  let lastError = null
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    if (Date.now() >= end) {
      const why = lastError ? ` (${lastError.message})` : ''
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}${why}`)
    }
    await sleepRaw(everyMs)
  }
}

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

// --- Locating the app -------------------------------------------------------

function platformArch() {
  const platform = process.platform
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
  return { platform, arch }
}

function sandboxNeedsFlag(helper) {
  if (process.platform !== 'linux') return false
  try {
    const st = fs.statSync(helper)
    return !(st.uid === 0 && (st.mode & 0o4000) !== 0)
  } catch {
    return true
  }
}

// { command, args, kind }: the packaged app under `outRoot`, or Electron on
// this checkout.
function resolveApp({ packaged, outRoot }) {
  const { platform, arch } = platformArch()
  const pkg = require(path.join(ROOT, 'package.json'))
  const name = pkg.productName || pkg.name
  if (packaged) {
    const dir = path.resolve(ROOT, outRoot || 'out', `${name}-${platform}-${arch}`)
    const candidates =
      platform === 'darwin'
        ? [path.join(dir, `${name}.app`, 'Contents', 'MacOS', name)]
        : [path.join(dir, `${name}-${pkg.version}`), path.join(dir, name)]
    const found = candidates
      .filter((file) => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
    if (!found) {
      throw new Error(
        `No packaged build in ${dir} - run 'npm run package' first, or drop --packaged.`
      )
    }
    const args = sandboxNeedsFlag(path.join(dir, 'chrome-sandbox')) ? ['--no-sandbox'] : []
    return { command: found, args, kind: 'packaged', cwd: dir }
  }
  // `require('electron')` in plain Node is the path of its binary.
  const electron = require(path.join(ROOT, 'node_modules', 'electron'))
  const args = [ROOT, '--no-updates']
  if (sandboxNeedsFlag(path.join(path.dirname(electron), 'chrome-sandbox'))) {
    // Unprivileged user namespaces make the sandbox work without the setuid
    // helper; only where they are restricted does Electron need the flag.
    const restricted = [
      'kernel/apparmor_restrict_unprivileged_userns',
      'user/max_user_namespaces'
    ].map((name) => {
      try {
        return fs.readFileSync(`/proc/sys/${name}`, 'utf8').trim()
      } catch {
        return null
      }
    })
    if (restricted[0] === '1' || restricted[1] === '0') args.push('--no-sandbox')
  }
  return { command: electron, args, kind: 'source', cwd: ROOT }
}

// The sidecar an instance runs: the caller's ZXTERM_CORE_BIN, else the one a
// packaged build carries (nothing to set), else the one staged in this
// checkout.
function sidecarEnv(app) {
  if (process.env.ZXTERM_CORE_BIN) return { ZXTERM_CORE_BIN: process.env.ZXTERM_CORE_BIN }
  const { platform, arch } = platformArch()
  const rel = path.join('npm', `zxterm-core-${platform}-${arch}`, 'zxterm-core')
  if (app.kind === 'packaged') {
    const resources =
      platform === 'darwin'
        ? path.join(path.dirname(path.dirname(app.command)), 'Resources', 'app')
        : path.join(app.cwd, 'resources', 'app')
    if (fs.existsSync(path.join(resources, rel))) return {}
  }
  const staged = path.join(ROOT, rel)
  return fs.existsSync(staged) ? { ZXTERM_CORE_BIN: staged } : {}
}

function bashPath() {
  for (const file of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) {
    if (fs.existsSync(file)) return file
  }
  throw new Error("bash not found: the demo's shells are bash")
}

// --- One app instance -------------------------------------------------------

class App {
  constructor(name, port, child) {
    this.name = name
    this.port = port
    this.child = child
    this.base = `http://127.0.0.1:${port}`
    this.captionPosition = 'bottom'
  }

  async api(method, route, body) {
    const init = { method, headers: {} }
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    init.signal = AbortSignal.timeout(120000)
    const res = await fetch(this.base + route, init)
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text }
    }
    if (!res.ok) {
      const message = (json && json.error && json.error.message) || text || res.statusText
      const err = new Error(`${this.name}: ${method} ${route} -> ${res.status} ${message}`)
      err.status = res.status
      throw err
    }
    return json
  }

  cmd(command, extra = {}) {
    return this.api('POST', '/renderer/command', { command, ...extra })
  }

  ui() {
    return this.cmd('ui-state')
  }

  // --- overlay ---

  async caption(title, text, extra = {}) {
    if (!opts.captions) return
    if (extra.position) this.captionPosition = extra.position
    if (opts.verbose) log(`${this.name}: ${title} - ${plainText(text)}`)
    await this.cmd('demo-caption', { title, text, position: this.captionPosition })
    noteCaption(this, title, text)
  }

  // A caption, then a pause before the action it announces. The caption stays
  // up through that action, until the next one replaces it.
  async say(title, text, extra = {}) {
    await this.caption(title, text, extra)
    if (opts.captions) await pause(extra.ms === undefined ? readingMs(text) : extra.ms)
  }

  async clearCaption() {
    if (!opts.captions) return
    await this.cmd('demo-caption', { text: '' })
    noteCaption(this, null, null)
  }

  keysBadge(keys, ms) {
    return this.cmd('demo-keys', { keys, ms })
  }

  spotlight(selector, extra = {}) {
    return this.cmd('demo-spotlight', { selector, ...extra })
  }

  card(title, subtitle, extra = {}) {
    return this.cmd('demo-card', { title, subtitle, ...extra })
  }

  hideCard() {
    return this.cmd('demo-card', { hide: true })
  }

  // --- input ---

  focus() {
    return this.api('POST', '/window/focus', {})
  }

  // A chord ("Ctrl+Shift+F"), shown as a badge by the overlay itself; `badge`
  // names it for the keys the overlay leaves alone (Enter, Esc, arrows).
  async key(chord, extra = {}) {
    if (extra.badge) await this.keysBadge(extra.badge === true ? chord : extra.badge)
    await this.api('POST', '/input/key', { chord, count: extra.count, delayMs: extra.delayMs })
    await pause(extra.after === undefined ? 350 : extra.after)
  }

  // Typed like a person: a key at a time, a little unevenly.
  async type(text, extra = {}) {
    const fast = opts.speed >= 3
    await this.api('POST', '/input/text', {
      text,
      enter: false,
      delayMs: extra.delayMs === undefined ? (fast ? 4 : 38) : extra.delayMs,
      jitterMs: fast ? 0 : 45
    })
    if (extra.enter) {
      await pause(extra.beforeEnter === undefined ? 260 : extra.beforeEnter)
      await this.api('POST', '/input/key', { chord: 'Enter' })
    }
    await pause(extra.after === undefined ? 300 : extra.after)
  }

  // A shell command typed into the terminal and run.
  run(text, extra = {}) {
    return this.type(text, { enter: true, ...extra })
  }

  mouse(body) {
    return this.api('POST', '/input/mouse', body)
  }

  async rect(selector, extra = {}) {
    const found = await this.cmd('demo-rect', { selector, ...extra })
    return found && found.found ? found : null
  }

  async waitRect(selector, extra = {}, timeoutMs = 15000) {
    return waitFor(
      async () => {
        const found = await this.rect(selector, extra)
        return found && found.visible && found.rect.width > 0 ? found : null
      },
      `${this.name}: ${selector}${extra.text ? ` "${extra.text}"` : ''} on screen`,
      timeoutMs
    )
  }

  // A point: { x, y }, or a selector (its centre; `at: [fx, fy]` picks another
  // place inside it, as fractions of its width and height).
  async point(target, extra = {}) {
    if (target && typeof target === 'object' && Number.isFinite(target.x)) return target
    const found = await this.waitRect(target, extra)
    const [fx, fy] = extra.at || [0.5, 0.5]
    return {
      x: Math.round(found.rect.left + found.rect.width * fx),
      y: Math.round(found.rect.top + found.rect.height * fy)
    }
  }

  moveMs() {
    return Math.round(650 / Math.max(1, opts.speed))
  }

  async moveTo(target, extra = {}) {
    const p = await this.point(target, extra)
    await this.mouse({
      type: 'move',
      x: p.x,
      y: p.y,
      durationMs: extra.durationMs || this.moveMs()
    })
    await pause(extra.after === undefined ? 200 : extra.after)
    return p
  }

  // Glides to the target and clicks it.
  async click(target, extra = {}) {
    const p = await this.point(target, extra)
    await this.mouse({ type: 'move', x: p.x, y: p.y, durationMs: this.moveMs() })
    await pause(180)
    await this.mouse({
      type: 'click',
      x: p.x,
      y: p.y,
      button: extra.button,
      count: extra.count,
      modifiers: extra.modifiers
    })
    await pause(extra.after === undefined ? 450 : extra.after)
    return p
  }

  async wheel(target, deltaY, extra = {}) {
    const p = await this.point(target, extra)
    await this.mouse({ type: 'move', x: p.x, y: p.y, durationMs: this.moveMs() })
    await this.mouse({
      type: 'wheel',
      x: p.x,
      y: p.y,
      deltaY,
      deltaX: extra.deltaX,
      count: extra.count || 1,
      delayMs: extra.delayMs === undefined ? Math.round(220 / opts.speed) : extra.delayMs,
      modifiers: extra.modifiers
    })
    await pause(extra.after === undefined ? 400 : extra.after)
  }

  // Press at `from`, glide to `to`, release.
  async drag(from, to, extra = {}) {
    const a = await this.point(from, extra.fromExtra || {})
    const b = await this.point(to, extra.toExtra || {})
    await this.mouse({ type: 'move', x: a.x, y: a.y, durationMs: this.moveMs() })
    await pause(250)
    await this.mouse({ type: 'down', x: a.x, y: a.y })
    await pause(200)
    // A first short move, so a drag that needs a few pixels to start does.
    await this.mouse({
      type: 'move',
      x: a.x + (b.x >= a.x ? 6 : -6),
      y: a.y + (b.y >= a.y ? 6 : -6),
      durationMs: 80
    })
    await this.mouse({
      type: 'move',
      x: b.x,
      y: b.y,
      durationMs: extra.durationMs || Math.round(1400 / Math.max(1, opts.speed))
    })
    await pause(extra.hold === undefined ? 500 : extra.hold)
    // With the button still down (a screenshot of the drag, say).
    if (extra.onHold) await extra.onHold()
    await this.mouse({ type: 'up', x: b.x, y: b.y })
    await pause(extra.after === undefined ? 500 : extra.after)
  }

  // --- reads ---

  async termText() {
    const display = await this.api('GET', '/renderer/terminal-display')
    const terminal = (display && (display.terminal || display.renderer)) || {}
    return (terminal.visibleRows || []).map((row) => row.text).join('\n')
  }

  // `text`: a string, or a RegExp.
  waitTerm(text, timeoutMs = 20000) {
    return waitFor(
      async () => {
        const screen = await this.termText()
        return text instanceof RegExp ? text.test(screen) : screen.includes(text)
      },
      `${this.name}: "${text}" in the terminal`,
      timeoutMs
    )
  }

  async sessions() {
    return this.api('GET', '/sessions')
  }

  async sessionByName(name) {
    const list = await this.sessions()
    return list.filter((session) => session.name === name).pop() || null
  }

  waitSession(name, timeoutMs = 20000) {
    return waitFor(() => this.sessionByName(name), `${this.name}: session "${name}"`, timeoutMs)
  }

  rowSelector(sessionId) {
    return `.session-row[data-session-id="${sessionId}"]`
  }

  waitModal(predicate, label, timeoutMs = 15000) {
    return waitFor(
      async () => {
        const state = await this.ui()
        return predicate(state.modal) ? state.modal || true : null
      },
      `${this.name}: ${label}`,
      timeoutMs
    )
  }

  // Saves the window as it is drawn now.
  async screenshot(file) {
    const shot = await this.api('GET', '/window/screenshot')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(shot.png, 'base64'))
    return file
  }

  async windowBounds() {
    return this.api('GET', '/window/bounds')
  }

  // Moves and resizes the window in a few steps, so the change can be followed.
  async glideWindow(to, ms = 900) {
    const from = (await this.windowBounds()).bounds
    const steps = Math.max(1, Math.round(ms / opts.speed / 40))
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
      await this.api('POST', '/window/bounds', {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        width: from.width + (to.width - from.width) * e,
        height: from.height + (to.height - from.height) * e
      })
      await sleepRaw(25)
    }
    await sleepRaw(300)
    return (await this.windowBounds()).bounds
  }
}

// Starts one instance and waits for its debug server. `env` is added to the
// scratch environment; `args` to the app's flags.
async function startApp(name, scratch, launch) {
  const port = await freePort()
  const app = resolveApp(launch)
  const userData = path.join(scratch, `el-${name}`)
  fs.mkdirSync(userData, { recursive: true })
  const args = [
    ...app.args,
    '--storage',
    path.join(scratch, 'data'),
    '--electron-user-data',
    userData,
    '--debug-server',
    '--debug-server-port',
    String(port),
    ...(launch.args || [])
  ]
  const env = { ...process.env }
  // Nothing of the caller's ZBTerm, Electron or Node setup may reach the
  // instances: a variable could point them at real data, a real Freenet node
  // or a pinned relay.
  for (const key of Object.keys(env)) {
    if (/^(ZBTERM_|ELECTRON_|NODE_OPTIONS$|SSH_AUTH_SOCK$)/.test(key)) delete env[key]
  }
  Object.assign(env, sidecarEnv(app), scratchEnv(scratch), launch.env || {})
  // The fixtures are a bash prompt and bash scripts; the app starts $SHELL.
  env.SHELL = bashPath()
  if (process.platform === 'linux' && launch.x11 !== false) {
    // X11 (XWayland on a Wayland desktop): a Wayland client cannot place its
    // own window, and part two puts two windows side by side.
    env.XDG_SESSION_TYPE = 'x11'
    env.GDK_BACKEND = 'x11'
    env.ELECTRON_OZONE_PLATFORM_HINT = 'x11'
    delete env.WAYLAND_DISPLAY
  }
  if (stopRequested) throw new Error('the demo is closing')
  const logFile = path.join(scratch, `${name}.log`)
  const out = fs.openSync(logFile, 'a')
  const child = spawn(app.command, args, {
    cwd: app.cwd,
    env,
    stdio: ['ignore', out, out],
    detached: true
  })
  fs.closeSync(out)
  children.push(child)
  let exited = null
  child.once('exit', (code, signal) => {
    exited = { code, signal }
  })
  // A failed spawn (no such file, no permission) is reported like an exit.
  child.once('error', (err) => {
    exited = { error: err.message }
  })
  log(
    `${name}: started ${app.kind} app, pid ${child.pid}, debug server on ${port} (log: ${logFile})`
  )
  const instance = new App(name, port, child)
  await waitFor(
    async () => {
      if (exited) {
        throw new Error(`${name} exited early (${JSON.stringify(exited)}); see ${logFile}`)
      }
      return await instance.api('GET', '/window/bounds').catch(() => null)
    },
    `${name}: debug server`,
    90000,
    300
  ).catch((err) => {
    if (exited) throw new Error(`${name} exited early (${JSON.stringify(exited)}); see ${logFile}`)
    throw err
  })
  return instance
}

function scratchEnv(scratch) {
  const home = path.join(scratch, 'home')
  return {
    HOME: home,
    TMPDIR: path.join(scratch, 't'),
    XDG_CONFIG_HOME: path.join(scratch, 'config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state')
  }
}

// The scratch root: short and under /tmp, because the sidecar's socket lives
// inside the profile directory and a Unix socket path stops at 108 bytes.
function makeScratch() {
  const base = process.platform === 'win32' ? os.tmpdir() : '/tmp'
  const scratch = fs.mkdtempSync(path.join(base, 'zbdemo.'))
  for (const dir of ['home', 't', 'config', 'data']) {
    fs.mkdirSync(path.join(scratch, dir), { recursive: true })
  }
  return scratch
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The last resort (a second Ctrl+C, a crash): kills this run's process groups
// at once, without waiting.
function killAppsNow() {
  stopRequested = true
  for (const child of children.splice(0)) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
}

// Ends the instances this run started: each is its own process group (the
// app, its Bare worker, the sidecar and the shells), signalled by the PID
// this file got from spawn().
async function stopApps() {
  stopRequested = true
  const mine = children.slice()
  for (const child of mine) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
  }
  const end = Date.now() + 10000
  while (Date.now() < end && mine.some((child) => alive(child.pid))) await sleepRaw(200)
  for (const child of mine) {
    if (!child.pid || !alive(child.pid)) continue
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
  children.length = 0
}

function removeScratch(scratch) {
  // Only ever a directory this run made with makeScratch().
  if (!scratch || !/[\\/]zbdemo\.[A-Za-z0-9]+$/.test(scratch)) return
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}

module.exports = {
  ROOT,
  opts,
  log,
  pause,
  sleepRaw,
  waitFor,
  readingMs,
  reportCaptionTiming,
  startApp,
  stopApps,
  killAppsNow,
  makeScratch,
  removeScratch,
  scratchEnv,
  App
}
