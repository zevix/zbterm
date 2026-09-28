const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  screen,
  nativeTheme,
  clipboard,
  dialog
} = require('electron')
const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { EngineLifecycle } = require('./engine-lifecycle')
const { BACKEND_CHOICES, resolveBackendLimit } = require('./backend-limit')
const { iceServersFlag, resolveIceServers } = require('./ice-servers')
const { createDebugServer, DEFAULT_PORT } = require('./debug-server')
const { detectChannel, checkForUpdate } = require('./update-channel')
const sshKeys = require('./ssh-keys')
const githubKeys = require('./github-keys')
const { listProviders, GITHUB_USERNAME } = require('../engine/identity/providers')
const { command, flag } = require('paparam')
const pkg = require('../package.json')
const { name, productName, version } = pkg

const appName = productName ?? name
const CLI_OPTIONS = [
  ['--storage <dir>', 'use a custom ZBTerm data directory (default: app user data dir)'],
  [
    '--electron-user-data <dir>',
    'pass custom Chromium/Electron user data dir (default: per-process temp dir)'
  ],
  [
    '--profile <id-or-name>',
    'open a specific ZBTerm profile by id or name (default: auto-select default profile or show picker)'
  ],
  ['--profile-path <dir>', 'open an explicit ZBTerm profile data directory (default: none)'],
  [
    '--backend <pear|freenet|none>',
    'limit sharing to one network backend, or none for local-only (default: every backend in this build)'
  ],
  [
    '--ice-servers <list>',
    "STUN/TURN servers for direct (Freenet) connections, comma-separated ICE URLs; '' for none (default: Google and Cloudflare STUN)"
  ],
  ['--no-updates', 'accepted for compatibility; has no effect (the OTA updater was removed)'],
  [
    '--no-update-check',
    'start without the npm registry update check (default: enabled on npm installs)'
  ],
  ['--debug', 'enable verbose packaged debug logging (default: off)'],
  ['--debug-server', 'start a localhost REST API for debugging and automation (default: off)'],
  ['--debug-server-port <port>', `port for --debug-server (default: ${DEFAULT_PORT})`],
  ['--devtools', 'open renderer developer tools on startup (default: off)'],
  ['--no-sandbox', 'start without Chromium sandbox (default: sandbox enabled)'],
  ['--disable-gpu', 'start without Chromium GPU acceleration (default: GPU enabled)'],
  [
    '--ozone-platform <platform>',
    'pass Chromium ozone platform (default: Electron/Chromium default)'
  ],
  [
    '--ozone-platform-hint <platform>',
    'pass Chromium ozone platform hint (default: Electron/Chromium default)'
  ],
  ['--help|-h', 'show this help and exit']
]

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(formatHelp(appName, CLI_OPTIONS))
  console.log('[EXIT] process.exit requested: command-line help')
  console.error('[EXIT] process.exit requested: command-line help')
  process.exit(0)
}

// ZBTerm's own data (profile registry, corestore, window state, prefs,
// debug log) must stay at this stable path across launches, even though we
// later repoint Chromium's own userData at a private per-process scratch
// dir (see the `app.setPath('userData', ...)` block below) - capture it
// before anything can change it.
const stableUserData = app.getPath('userData')

function debugLog(...args) {
  const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
  const line = new Date().toISOString() + ' ' + msg + '\n'
  for (const file of debugLogPaths()) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, line)
      return
    } catch {}
  }
}
debugLog('=== main.js loaded ===')

// Green so the shell/main-process' own console.log lines are visually
// distinguishable in the dev terminal from worker stdout (cyan) / stderr
// (yellow, see electron/engine-client.js) and renderer-forwarded logs.
const MAIN_LOG_COLOR = '\x1b[32m'
const COLOR_RESET = '\x1b[0m'

function debugPrefix(scope) {
  const time = new Date().toISOString().slice(11, 23)
  return `${MAIN_LOG_COLOR}[DEBUG ${time} ${scope}]${COLOR_RESET}`
}

function debugLogPaths() {
  const files = []
  try {
    files.push(path.join(stableUserData, 'debug_main.log'))
  } catch {}
  files.push(path.join(os.tmpdir(), 'zbterm-debug_main.log'))
  return files
}

let firstExitTrigger = null

// Only the chords that a window close could plausibly be blamed on are
// noted, and only the chord itself is recorded - never the rest of what is
// typed into a terminal.
const QUIT_KEY_WATCHLIST = new Set(['w', 'q'])

function exitLog(event, details = {}) {
  const record = {
    event,
    pid: process.pid,
    ppid: process.ppid,
    uptimeSeconds: Number(process.uptime().toFixed(3)),
    firstExitTrigger,
    ...details
  }
  const line = `[EXIT] ${JSON.stringify(record)}`
  console.log(line)
  console.error(line)
  debugLog('[EXIT]', record)
}

function markExitTrigger(event, details = {}) {
  if (!firstExitTrigger) {
    firstExitTrigger = {
      event,
      at: new Date().toISOString(),
      ...details
    }
  }
  exitLog(event, details)
}

function requestAppQuit(event, details = {}) {
  markExitTrigger(event, details)
  app.quit()
}

process.on('exit', (code) => {
  exitLog('process:exit', { code })
})

process.on('uncaughtExceptionMonitor', (err, origin) => {
  exitLog('process:uncaughtException', {
    origin,
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack : null
  })
})

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatHelp(name, options) {
  const maxFlagLength = Math.max(...options.map(([help]) => help.length))
  const lines = [`Usage: ${name} [options]`, '', 'Options:']

  for (const [help, description] of options) {
    lines.push(`  ${help.padEnd(maxFlagLength)}  ${description}`)
  }

  return lines.join('\n')
}

const { isMac } = require('which-runtime')

const protocol = name
let debugServer = null
let debugSelectedSession = null
let debugServerStarting = null
let debugServerEventsWired = false
let activeWindowProfileKey = null
const pendingPopups = new Map()

const cmd = command(
  appName,
  ...CLI_OPTIONS.filter(([help]) => help !== '--help|-h').map(([help, description]) =>
    flag(help, description)
  )
)

const cliArgs = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2)
// --ice-servers is read by ./ice-servers.js: paparam refuses its empty form,
// which is a value here (no STUN at all).
const iceFlag = iceServersFlag(cliArgs)

cmd.parse(iceFlag.strip)

const debugMode = !!cmd.flags.debug || process.env.ZBTERM_DEBUG === '1'
const debugServerEnabled = !!cmd.flags.debugServer || process.env.ZBTERM_DEBUG_SERVER === '1'
const debugServerPortFlag = Number(
  cmd.flags.debugServerPort || process.env.ZBTERM_DEBUG_SERVER_PORT
)
const openDevTools = !!cmd.flags.devtools || process.env.ZBTERM_DEVTOOLS === '1'
const requestedProfileId = cmd.flags.profile || process.env.ZBTERM_PROFILE || null
const requestedProfilePath = cmd.flags.profilePath || process.env.ZBTERM_PROFILE_PATH || null
// --backend, then ZBTERM_BACKEND. Handed to the core worker as a spawn
// argument (never an invoke, so nothing can race it).
const backendLimit = resolveBackendLimit({ flag: cmd.flags.backend, env: process.env })
// D-11: the settings field (pushed by the renderer, app:setIceServers) wins
// over --ice-servers, which wins over ZBTERM_ICE_SERVERS; the default list
// otherwise. Applied to new peer connections.
let iceSetting = ''
function currentIceServers() {
  return resolveIceServers({ setting: iceSetting, flag: iceFlag.value, env: process.env })
}
if (!backendLimit.known) {
  console.error(
    `[backend] unknown share backend '${backendLimit.value}' (expected ${BACKEND_CHOICES.join(', ')}); sharing is disabled`
  )
}

if (process.argv.includes('--disable-gpu')) app.commandLine.appendSwitch('disable-gpu')
if (cmd.flags.ozonePlatform) app.commandLine.appendSwitch('ozone-platform', cmd.flags.ozonePlatform)
if (cmd.flags.ozonePlatformHint) {
  app.commandLine.appendSwitch('ozone-platform-hint', cmd.flags.ozonePlatformHint)
}
if (debugMode) {
  app.commandLine.appendSwitch('enable-logging', 'stderr')
  app.commandLine.appendSwitch('v', '1')
  process.env.ELECTRON_ENABLE_LOGGING = '1'
  process.env.NODE_DEBUG = process.env.NODE_DEBUG || 'net,tls,dns'
}

const pearStore = cmd.flags.storage

// How this build was installed decides whether the npm registry update check
// applies: only an npm install is updated through npm. There is no OTA updater
// in any build (D-08).
const appRootPath = (() => {
  try {
    return app.getAppPath()
  } catch {
    return path.join(__dirname, '..')
  }
})()
const channel = detectChannel({
  appPath: appRootPath,
  isPackaged: app.isPackaged,
  env: process.env
})
const isNpmChannel = channel === 'npm'
// A registry to ask instead of registry.npmjs.org. Setting it is also the
// only way to keep the check on under --debug-server: an automated run must
// never reach the live registry, but pointing it at a local fake is exactly
// how the npm-channel update path gets tested end to end.
const registryUrlOverride = process.env.ZBTERM_REGISTRY_URL || null
// Off unless this really is an npm install, and off under --debug-server
// unless a registry was explicitly named.
const updateCheckEnabled =
  isNpmChannel &&
  cmd.flags.updateCheck !== false &&
  (process.env.ZBTERM_NO_UPDATE_CHECK ?? '') !== '1' &&
  (!debugServerEnabled || !!registryUrlOverride)
debugLog('[app:channel]', {
  channel,
  appPath: appRootPath,
  isPackaged: app.isPackaged,
  updateCheckEnabled
})

const electronUserData = cmd.flags.electronUserData || process.env.ZBTERM_ELECTRON_USER_DATA
let electronUserDataIsScratch = false
if (electronUserData) {
  app.setPath('userData', electronUserData)
} else {
  // Two ZBTerm processes are meant to run side by side (separate windows,
  // possibly separate profiles), but Electron/Chromium was never told to
  // treat that as supported - by default every launch points at the same
  // Chromium userData dir, so concurrent processes fight over Chromium's own
  // profile-locking (SingletonLock/SingletonSocket, GPU cache, disk cache,
  // cookie/localStorage sqlite files). That contention - not ZBTerm's own
  // (fast) profile-lock check - is what makes a second launch stall for
  // several seconds. Giving each Electron process a private scratch
  // userData dir removes the contention entirely.
  const scratchDir = path.join(
    os.tmpdir(),
    `zbterm-electron-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  )
  app.setPath('userData', scratchDir)
  electronUserDataIsScratch = true
}

// pearDataRoot/debugPrefix/debugLog/setApprovalPopup/setProfilePickerPopup/
// clearPopup/sendToAll/startDebugServer/wireDebugServerEvents are all
// `function` declarations defined further down this file - referencing them
// here is safe because these callbacks only run later, after hoisting has
// made every declaration available.
const lifecycle = new EngineLifecycle({
  pearDataRoot: () => pearDataRoot(),
  requestedProfileId,
  requestedProfilePath,
  backendLimit: backendLimit.value,
  iceServers: currentIceServers().servers,
  debugServerEnabled,
  onEngineStarting: (userData, opts) => {
    console.log(
      debugPrefix('app:mode'),
      JSON.stringify({ debugMode, openDevTools, argv: process.argv })
    )
    debugLog('[app:mode]', { debugMode, openDevTools, argv: process.argv })
  },
  onEngineEvent: (name, data) => {
    if (name === 'share:approval-pending') setApprovalPopup(data)
    if (name === 'share:approval-cancelled') clearShareApprovalPopup(data)
    // Fire-and-forget on purpose: the worker is waiting on its own timeout,
    // and the event dispatch path must never block on the network.
    if (name === 'identity:resolve-request') handleIdentityResolveRequest(data)
    // The renderer can complete the wizard on its own (setSelf or clear); the
    // shell popup registry has to follow, or /popups keeps offering a wizard
    // the user already finished.
    if (name === 'identity:changed') clearIdentityPopup()
    if (name === 'share:debug') {
      console.log(debugPrefix('share'), data.event, JSON.stringify(data.details || {}))
      debugLog('[share]', data.event, data.details || {})
    }
    // 'engine:restarting' is synthesized by EngineLifecycle itself (worker
    // crash/restart supervision) and its give-up path also synthesizes a
    // fatal 'engine:error' the same way - neither goes through
    // EngineClient's own emit, so wireDebugServerEvents' engine.on(...)
    // listeners never see them; record here so /events can observe them.
    // (A worker-forwarded 'engine:error' gets recorded twice - harmless.)
    if ((name === 'engine:restarting' || name === 'engine:error') && debugServer) {
      debugServer.recordEvent(name, data)
    }
    sendToAll('zbterm:event', { name, data })
  },
  onProfileSelected: async ({ userData, profileId, profilePath, identity }) => {
    console.log(debugPrefix('engine:ready'), JSON.stringify({ userData, identity }))
    debugLog('[engine:ready]', { userData, identity })
    clearPopup('profile-picker')
    restoreProfileWindowState(profileId, profilePath, { animate: true })
    await startDebugServer()
    if (debugServer) wireDebugServerEvents(debugServer)
    const profileName = await selectedProfileName(profileId, profilePath)
    sendToAll('zbterm:event', {
      name: 'profile:selected',
      data: { profileId, profilePath, profileName, selectedProfileName: profileName, identity }
    })
    sendToAll('pear:ready', { profileId, profilePath, profileName, identity })
    await registerIdentityPopupIfUnclaimed()
  },
  onEngineStartError: (err) => {
    sendToAll('pear:error', String(err && err.stack ? err.stack : err))
    sendToAll('zbterm:event', {
      name: 'engine:error',
      data: err && err.toJSON ? err.toJSON() : { message: err.message || String(err) }
    })
  },
  onProfileRequired: async (userData) => {
    await setProfilePickerPopup(userData)
    sendToAll('zbterm:event', { name: 'profile:required', data: {} })
  },
  onStartupBegin: () => startDebugServer()
})

function pearDataRoot() {
  return pearStore || stableUserData
}

ipcMain.on('pkg', (evt) => {
  evt.returnValue = pkg
})

const RENDERER_LOG_COLOR = '\x1b[35m'

ipcMain.on('renderer:log', (evt, level, msg) => {
  if (level === 'error') {
    console.error(`${RENDERER_LOG_COLOR}[Renderer Error]${COLOR_RESET}`, msg)
  } else {
    console.log(`${RENDERER_LOG_COLOR}[Renderer Log]${COLOR_RESET}`, msg)
  }
})

ipcMain.on('renderer:fileLog', (evt, msg) => {
  debugLog('[Renderer]', msg)
})

function sendToAll(name, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(name, data)
  }
}

function popupList() {
  return Array.from(pendingPopups.values()).sort((a, b) => a.createdAt - b.createdAt)
}

function setPopup(popup) {
  pendingPopups.set(popup.id, {
    createdAt: Date.now(),
    ...popup,
    updatedAt: Date.now()
  })
}

function clearPopup(id) {
  pendingPopups.delete(id)
}

function clearShareApprovalPopup(request) {
  if (!request || !request.sessionId || !request.requestId) return
  const exactId = approvalPopupId(request.sessionId, request.requestId)
  for (const popup of popupList()) {
    if (
      popup.id === exactId ||
      (popup.type === 'share-approval' &&
        popup.data &&
        popup.data.sessionId === request.sessionId &&
        popup.data.requestId === request.requestId)
    ) {
      clearPopup(popup.id)
    }
  }
}

function updatePopup(id, update) {
  const popup = pendingPopups.get(id)
  if (!popup) return null
  const next = { ...popup, ...update, updatedAt: Date.now() }
  pendingPopups.set(id, next)
  return next
}

async function setProfilePickerPopup(userData) {
  const manager = await lifecycle.ensureProfileManager(userData)
  const registry = await manager.listProfiles()
  setPopup({
    id: 'profile-picker',
    type: 'profile-picker',
    title: 'Select profile',
    data: {
      selectedProfileId: lifecycle.selectedProfileId,
      profiles: registry.profiles,
      lastUsedProfileId: registry.lastUsedProfileId
    },
    actions: ['fill-name', 'select', 'create-and-select']
  })
}

function setApprovalPopup(request) {
  if (!request || !request.sessionId || !request.requestId) return
  setPopup({
    id: approvalPopupId(request.sessionId, request.requestId),
    type: 'share-approval',
    title: 'Approve join request',
    data: request,
    actions: ['approve', 'deny']
  })
}

function approvalPopupId(sessionId, requestId) {
  return `share-approval:${sessionId}:${requestId}`
}

const IDENTITY_POPUP_ID = 'identity-setup'
const IDENTITY_DISMISS_PREFERENCE = 'identity.setupDismissed'
const IDENTITY_POPUP_ACTIONS = [
  'choose-unknown',
  'fill-username',
  'select-key',
  'add-key',
  'submit',
  'dismiss'
]

function setIdentityPopup(self) {
  setPopup({
    id: IDENTITY_POPUP_ID,
    type: 'identity-setup',
    title: 'Choose your identity',
    data: {
      displayId: (self && self.displayId) || '',
      providers: listProviders().map((provider) => ({ id: provider.id, label: provider.label })),
      candidates: []
    },
    actions: IDENTITY_POPUP_ACTIONS
  })
}

function clearIdentityPopup() {
  clearPopup(IDENTITY_POPUP_ID)
}

// Registered from `onProfileSelected` only: the wizard needs a live worker for
// `identity.beginClaim`/`identity.setSelf`, and it must never gate startup.
async function registerIdentityPopupIfUnclaimed() {
  if (!lifecycle.engine) return
  try {
    const self = await lifecycle.engine.invoke('identity.self')
    if (self && self.configured) {
      clearIdentityPopup()
      return
    }
    const dismissed = await lifecycle.engine.invoke('preference.get', {
      key: IDENTITY_DISMISS_PREFERENCE
    })
    if (String(dismissed === null || dismissed === undefined ? '' : dismissed) === '1') return
    setIdentityPopup(self)
  } catch (err) {
    console.error(debugPrefix('identity'), 'popup registration failed', err && err.message)
  }
}

function windowStatePath() {
  return path.join(stableUserData, 'window-state.json')
}

function windowStateLockPath() {
  return path.join(stableUserData, 'window-state.lock')
}

function currentResolutionKeys() {
  const primary = screen.getPrimaryDisplay()
  const displays = screen.getAllDisplays().sort((a, b) => {
    if (a.id === primary.id) return -1
    if (b.id === primary.id) return 1
    return 0
  })
  return Array.from(new Set(displays.map(resolutionKeyForDisplay)))
}

function resolutionKeyForDisplay(display) {
  const size = display && display.size ? display.size : { width: 0, height: 0 }
  const scaleFactor =
    display && Number.isFinite(display.scaleFactor) ? Math.round(display.scaleFactor * 100) : 100
  return `${Math.round(size.width)}x${Math.round(size.height)}@${scaleFactor}`
}

function profileWindowKey(profileId, profilePath = null) {
  if (profilePath) return `path:${path.resolve(profilePath)}`
  if (profileId) return `id:${profileId}`
  return null
}

function preferencesPath() {
  return path.join(stableUserData, 'preferences.json')
}

function readPreferences() {
  try {
    const prefs = JSON.parse(fs.readFileSync(preferencesPath(), 'utf8'))
    return prefs && typeof prefs === 'object' ? prefs : {}
  } catch {
    return {}
  }
}

function writePreferences(prefs) {
  fs.mkdirSync(path.dirname(preferencesPath()), { recursive: true })
  fs.writeFileSync(preferencesPath(), JSON.stringify(prefs, null, 2))
}

// The registry answer survives restarts so the 24h TTL is real rather than
// per-process. preferences.json is already the small mutable blob for this
// kind of state.
const UPDATE_CHECK_PREF_KEY = 'zbterm.updateCheck'

function updateCheckCache() {
  return {
    get() {
      const value = readPreferences()[UPDATE_CHECK_PREF_KEY]
      return value && typeof value === 'object' ? value : null
    },
    set(value) {
      const prefs = readPreferences()
      prefs[UPDATE_CHECK_PREF_KEY] = value
      writePreferences(prefs)
    }
  }
}

function readWindowState(profileKey = null, opts = {}) {
  try {
    const state = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'))
    return normalizeWindowStateEntry(selectWindowStateEntry(state, profileKey, opts))
  } catch {
    return null
  }
}

function writeWindowState(win, profileKey = currentWindowProfileKey(win)) {
  if (!win || win.isDestroyed()) return
  withWindowStateLock(() => {
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const resolutionKey = resolutionKeyForDisplay(display)
    const entry = {
      bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds(),
      isMaximized: win.isMaximized(),
      display: {
        id: display.id,
        scaleFactor: display.scaleFactor,
        size: display.size,
        workArea: display.workArea
      },
      updatedAt: Date.now()
    }
    const state = readRawWindowState()
    state.version = 2
    state.global = state.global && typeof state.global === 'object' ? state.global : {}
    state.profiles = state.profiles && typeof state.profiles === 'object' ? state.profiles : {}
    state.global[resolutionKey] = entry
    if (profileKey) {
      state.lastProfileKey = profileKey
      state.profiles[profileKey] =
        state.profiles[profileKey] && typeof state.profiles[profileKey] === 'object'
          ? state.profiles[profileKey]
          : {}
      state.profiles[profileKey][resolutionKey] = entry
    }
    writeRawWindowState(state)
  })
}

function windowProfileKey(win) {
  return win && !win.isDestroyed() && win.__zbtermProfileKey ? win.__zbtermProfileKey : null
}

function currentWindowProfileKey(win) {
  return (
    windowProfileKey(win) ||
    profileWindowKey(lifecycle.selectedProfileId, requestedProfilePath) ||
    activeWindowProfileKey
  )
}

function setWindowProfileKey(win, profileKey) {
  if (!win || win.isDestroyed()) return
  win.__zbtermProfileKey = profileKey || null
}

function readRawWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'))
    return state && typeof state === 'object' ? state : {}
  } catch {
    return {}
  }
}

function writeRawWindowState(state) {
  fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true })
  const tmp = `${windowStatePath()}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, windowStatePath())
}

function withWindowStateLock(fn) {
  const lockPath = windowStateLockPath()
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fs.mkdirSync(lockPath)
      try {
        return fn()
      } finally {
        fs.rmSync(lockPath, { recursive: true, force: true })
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      clearStaleWindowStateLock(lockPath)
      sleepSync(20)
    }
  }
  throw new Error('Timed out waiting for window state lock')
}

function clearStaleWindowStateLock(lockPath) {
  try {
    const stat = fs.statSync(lockPath)
    if (Date.now() - stat.mtimeMs > 10000) fs.rmSync(lockPath, { recursive: true, force: true })
  } catch {}
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function selectWindowStateEntry(state, profileKey, opts = {}) {
  if (!state || typeof state !== 'object') return null
  const resolutionKeys = currentResolutionKeys()
  if (profileKey && state.profiles && state.profiles[profileKey]) {
    const profileEntry = selectResolutionEntry(state.profiles[profileKey], resolutionKeys)
    if (profileEntry) return profileEntry
  }
  if (opts.profileOnly) return null
  const globalEntry = selectResolutionEntry(state.global, resolutionKeys)
  if (globalEntry) return globalEntry
  if (state.bounds) return state
  return null
}

function selectResolutionEntry(entries, resolutionKeys) {
  if (!entries || typeof entries !== 'object') return null
  for (const key of resolutionKeys) {
    if (entries[key]) return entries[key]
  }
  return null
}

function normalizeWindowStateEntry(entry) {
  const bounds = entry && entry.bounds
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null
  if (bounds.width < 640 || bounds.height < 420) return null

  const display = screen.getDisplayMatching(bounds)
  const area = display.workArea
  const width = Math.min(Math.round(bounds.width), area.width)
  const height = Math.min(Math.round(bounds.height), area.height)
  const minVisible = 80
  const minX = area.x - width + minVisible
  const maxX = area.x + area.width - minVisible
  const minY = area.y
  const maxY = area.y + area.height - minVisible
  return {
    bounds: {
      width,
      height,
      x: Number.isFinite(bounds.x) ? clamp(Math.round(bounds.x), minX, maxX) : area.x,
      y: Number.isFinite(bounds.y) ? clamp(Math.round(bounds.y), minY, maxY) : area.y
    },
    isMaximized: !!entry.isMaximized
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function restoreProfileWindowState(profileId, profilePath = null, opts = {}) {
  const profileKey = profileWindowKey(profileId, profilePath)
  if (!profileKey) return false
  activeWindowProfileKey = profileKey
  const state = readWindowState(profileKey, { profileOnly: true })
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    setWindowProfileKey(win, profileKey)
    if (!state) continue
    applyWindowState(win, state, opts)
  }
  return !!state
}

function applyWindowState(win, state, opts = {}) {
  if (!win || win.isDestroyed() || !state) return
  if (win.isMaximized()) win.unmaximize()
  try {
    win.setBounds(state.bounds, !!opts.animate)
  } catch {
    win.setBounds(state.bounds)
  }
  if (state.isMaximized) win.maximize()
}

// Folder picker for a session's home directory. Paths under the home
// directory come back as `~/...`, the form the session editor shows and the
// PTY host expands again at spawn time.
async function chooseDirectory(evt, args = {}) {
  const home = os.homedir()
  const current = typeof args.defaultPath === 'string' ? args.defaultPath.trim() : ''
  const defaultPath =
    !current || current === '~'
      ? home
      : /^~[\\/]/.test(current)
        ? path.join(home, current.slice(2))
        : current
  const win = BrowserWindow.fromWebContents(evt.sender)
  const result = await dialog.showOpenDialog(win, {
    title: 'Home Directory',
    defaultPath,
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths.length) return null
  const chosen = result.filePaths[0]
  if (chosen === home) return '~/'
  if (chosen.startsWith(home + path.sep)) return '~/' + path.relative(home, chosen)
  return chosen
}

function handleAppInvoke(method, args = {}) {
  if (method === 'app.info') {
    const port =
      debugServerEnabled && Number.isFinite(debugServerPortFlag) && debugServerPortFlag > 0
        ? debugServerPortFlag
        : debugServerEnabled
          ? DEFAULT_PORT
          : null
    return {
      name: appName,
      debugServer: debugServerEnabled ? { port } : null,
      channel,
      updateCheckEnabled
    }
  }
  if (method === 'app.updateCheck') {
    if (!isNpmChannel) return Promise.resolve({ available: false, reason: 'channel', channel })
    if (!updateCheckEnabled) {
      return Promise.resolve({ available: false, reason: 'disabled', channel })
    }
    return checkForUpdate({
      currentVersion: version,
      registryUrl: registryUrlOverride || undefined,
      cache: updateCheckCache()
    })
  }
  if (method === 'app.preference.get') {
    const prefs = readPreferences()
    return Object.prototype.hasOwnProperty.call(prefs, args.key) ? prefs[args.key] : null
  }
  if (method === 'app.preference.set') {
    if (!args.key || typeof args.key !== 'string') throw new Error('Preference key is required')
    const prefs = readPreferences()
    prefs[args.key] = String(args.value)
    writePreferences(prefs)
    return { key: args.key, value: prefs[args.key] }
  }
  return null
}

function wireDebugServerEvents(server) {
  if (!lifecycle.engine || debugServerEventsWired) return
  debugServerEventsWired = true
  const engine = lifecycle.engine
  const record = (name) => (data) => server.recordEvent(name, data)
  engine.on('session:data', ({ sessionId, data }) => {
    server.recordEvent('session:data', {
      sessionId,
      bytes: data ? data.byteLength : 0
    })
  })
  engine.on('session:exit', record('session:exit'))
  engine.on('session:hd-changed', record('session:hd-changed'))
  engine.on('session:restored', record('session:restored'))
  engine.on('session:list-changed', record('session:list-changed'))
  engine.on('share:changed', record('share:changed'))
  engine.on('share:join-changed', (status) => {
    record('share:join-changed')(status)
    if (status && status.status === 'joined' && status.sessionId && server.selectSession) {
      server.selectSession({ sessionId: status.sessionId, mode: 'live' })
    }
  })
  engine.on('share:approval-pending', (request) => {
    setApprovalPopup(request)
    record('share:approval-pending')(request)
  })
  // Recorded so the identity e2e can assert a peer's verification outcome
  // through `GET /events` instead of scraping logs.
  engine.on('share:peer-identity', record('share:peer-identity'))
  engine.on('share:debug', record('share:debug'))
  engine.on('player:frame', record('player:frame'))
  engine.on('player:data', ({ sessionId, data, ...rest }) => {
    server.recordEvent('player:data', {
      sessionId,
      ...rest,
      bytes: data ? data.byteLength : 0
    })
  })
  engine.on('player:end', record('player:end'))
  engine.on('engine:error', record('engine:error'))
  // Recorded so an automated wizard drive can assert that a rejected username
  // never reached the engine.
  engine.on('identity:changed', record('identity:changed'))
}

function startDebugServer() {
  if (!debugServerEnabled) return
  if (debugServer || debugServerStarting) return debugServerStarting
  const port =
    Number.isFinite(debugServerPortFlag) && debugServerPortFlag > 0
      ? debugServerPortFlag
      : DEFAULT_PORT
  debugServerStarting = Promise.resolve().then(async () => {
    debugServer = createDebugServer({
      port,
      getEngine: () => lifecycle.engine,
      getPopups: popupList,
      handlePopup: handlePopupAction,
      getRendererLayout: async () => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        if (!win) {
          const err = new Error('No window is available')
          err.statusCode = 503
          throw err
        }
        const renderer = await win.webContents.executeJavaScript(
          'window.__zbtermDebugLayout ? window.__zbtermDebugLayout() : null'
        )
        return {
          zoomFactor: win.webContents.getZoomFactor(),
          zoomLevel: win.webContents.getZoomLevel(),
          windowBounds: win.getBounds(),
          contentBounds: win.getContentBounds(),
          display: screen.getDisplayMatching(win.getBounds()),
          renderer
        }
      },
      getRendererTerminalDisplay: async () => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        if (!win) {
          const err = new Error('No window is available')
          err.statusCode = 503
          throw err
        }
        const terminal = await win.webContents.executeJavaScript(
          'window.__zbtermDebugTerminalDisplay ? window.__zbtermDebugTerminalDisplay() : null'
        )
        return {
          zoomFactor: win.webContents.getZoomFactor(),
          zoomLevel: win.webContents.getZoomLevel(),
          windowBounds: win.getBounds(),
          contentBounds: win.getContentBounds(),
          display: screen.getDisplayMatching(win.getBounds()),
          terminal
        }
      },
      executeRendererCommand: async (command) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        if (!win) {
          const err = new Error('No window is available')
          err.statusCode = 503
          throw err
        }
        const payload = JSON.stringify(command || {})
        return await win.webContents.executeJavaScript(
          `window.__zbtermDebugCommand ? window.__zbtermDebugCommand(JSON.parse(${JSON.stringify(
            payload
          )})) : null`
        )
      },
      getWindowBounds: () => {
        const win = firstWindow()
        return windowBoundsResponse(win)
      },
      setWindowBounds: async (bounds) => {
        const win = firstWindow()
        const next = normalizeDebugWindowBounds(bounds)
        if (win.isMaximized()) win.unmaximize()
        try {
          win.setBounds(next, !!bounds.animate)
        } catch {
          win.setBounds(next)
        }
        await delay(100)
        writeWindowState(win)
        return windowBoundsResponse(win)
      },
      onSelectSession: (selection) => {
        debugSelectedSession = selection
        sendToAll('zbterm:event', { name: 'debug:select-session', data: selection })
      }
    })
    try {
      const address = await debugServer.start()
      wireDebugServerEvents(debugServer)
      console.log(`[ZBTerm debug server] http://${address.host}:${address.port}`)
      debugLog('[debug-server:ready]', address)
    } catch (err) {
      debugServer = null
      console.error('Failed to start debug server:', err)
      debugLog('[debug-server:error]', { message: err.message, code: err.code })
    }
  })
  return debugServerStarting
}

function firstWindow() {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) {
    const err = new Error('No window is available')
    err.statusCode = 503
    throw err
  }
  return win
}

function windowBoundsResponse(win) {
  return {
    bounds: win.getBounds(),
    contentBounds: win.getContentBounds(),
    isMaximized: win.isMaximized(),
    display: screen.getDisplayMatching(win.getBounds())
  }
}

function normalizeDebugWindowBounds(bounds = {}) {
  const width = Number(bounds.width)
  const height = Number(bounds.height)
  const x = Number(bounds.x)
  const y = Number(bounds.y)
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    const err = new Error('Window bounds require finite x, y, width and height')
    err.statusCode = 400
    throw err
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(640, Math.round(width)),
    height: Math.max(420, Math.round(height))
  }
}

async function handleProfileInvoke(method, args = {}) {
  const userData = pearDataRoot()
  const manager = await lifecycle.ensureProfileManager(userData)
  if (method === 'profile.current') {
    const registry = await manager.listProfiles()
    const selectedProfile = registry.profiles.find(
      (profile) => profile.id === lifecycle.selectedProfileId
    )
    return {
      selectedProfileId: lifecycle.selectedProfileId,
      selectedProfileName:
        (selectedProfile && selectedProfile.name) ||
        lifecycle.selectedProfileId ||
        profileNameFromPath(requestedProfilePath),
      selectedProfilePath: requestedProfilePath || null,
      engineReady: lifecycle.engineReady,
      engineStarting: !!lifecycle.engineStarting,
      pearRuntimeInitializing: lifecycle.pearRuntimeInitializing,
      debugAutoSelect: lifecycle.shouldAutoSelectProfile()
    }
  }
  if (method === 'profile.list') return await manager.listProfiles()
  if (method === 'profile.create') return await manager.createProfile(args)
  if (method === 'profile.rename') return await manager.renameProfile(args.profileId, args.name)
  if (method === 'profile.deleteEmpty') return await manager.deleteEmptyProfile(args.profileId)
  if (method === 'profile.select') {
    const profileId = args.profileId || lifecycle.selectedProfileId
    if (!profileId && !requestedProfilePath) throw new Error('No profile selected')
    await lifecycle.startEngineForProfile(userData, {
      profileId,
      profilePath: args.profilePath || requestedProfilePath || null
    })
    return {
      selectedProfileId: profileId,
      selectedProfileName: await selectedProfileName(
        profileId,
        args.profilePath || requestedProfilePath || null
      ),
      selectedProfilePath: args.profilePath || requestedProfilePath || null,
      identity: await lifecycle.engine.invoke('identity.get')
    }
  }
  return null
}

async function selectedProfileName(profileId, profilePath = null) {
  if (!profileId) return profileNameFromPath(profilePath)
  const manager = await lifecycle.ensureProfileManager(pearDataRoot())
  const registry = await manager.listProfiles()
  const profile = registry.profiles.find((item) => item.id === profileId)
  return profile && profile.name ? profile.name : profileId
}

function profileNameFromPath(profilePath) {
  return profilePath ? path.basename(profilePath) : null
}

// SSH key discovery/signing runs in the shell: the Bare worker cannot read
// `~/.ssh` and has no unix-socket client for ssh-agent. Returns null for any
// other method so it falls through to the worker.
async function handleIdentitySshInvoke(method, args = {}) {
  try {
    if (method === 'identity.sshCandidates') {
      return await sshKeys.listCandidates({})
    }
    if (method === 'identity.sshInspect') {
      return await sshKeys.inspectKey({ keyPath: args.keyPath })
    }
    if (method === 'identity.sshSign') {
      return await sshKeys.signBytes({
        messageBase64: args.messageBase64,
        keyPath: args.keyPath || null,
        publicKeyBlobBase64: args.publicKeyBlobBase64 || null
      })
    }
    return null
  } catch (err) {
    console.error(debugPrefix('zbterm:invoke'), 'ERROR', method, err.message)
    return {
      error: {
        name: err.name || 'Error',
        code: 'E_AUTH',
        message: err.message || String(err),
        details: null
      }
    }
  }
}

// The worker cannot fetch `https://github.com/<user>.keys` itself, so it emits
// `identity:resolve-request` and we answer with the `identity.resolveResult`
// invoke. This never throws into the event handler: a failure is reported as
// `{ ok: false }` so the worker settles immediately instead of waiting out its
// timeout.
function handleIdentityResolveRequest(data) {
  const requestId = data && data.requestId ? String(data.requestId) : ''
  if (!requestId) return
  Promise.resolve()
    .then(() => {
      if (data.provider !== 'github') {
        throw new Error('Unsupported identity provider: ' + String(data.provider))
      }
      return githubKeys.fetchKeys(data.subject)
    })
    .then(
      (result) => sendIdentityResolveResult(requestId, true, result, null),
      (err) =>
        sendIdentityResolveResult(requestId, false, null, {
          message: (err && err.message) || String(err)
        })
    )
    .catch(() => {})
}

function sendIdentityResolveResult(requestId, ok, result, error) {
  if (!lifecycle.engine) return
  lifecycle.engine
    .invoke('identity.resolveResult', { requestId, ok, result, error })
    .catch((err) => {
      console.error(debugPrefix('identity'), 'resolveResult failed', err && err.message)
    })
}

function handleDebugInvoke(method, args = {}) {
  if (method === 'debug.currentSelection') {
    return debugSelectedSession
  }
  if (method === 'debug.popupVisible') {
    const popupId = args.popupId
    if (!popupId) return false
    const popup = updatePopup(popupId, {
      renderer: {
        visible: true,
        visibleAt: Date.now()
      }
    })
    return !!popup
  }
  if (method === 'debug.popupHidden') {
    const popupId = args.popupId
    if (!popupId) return false
    const popup = updatePopup(popupId, {
      renderer: {
        visible: false,
        hiddenAt: Date.now()
      }
    })
    return !!popup
  }
  if (method === 'debug.popupFilled') {
    const popupId = args.popupId
    if (!popupId) return false
    const popup = pendingPopups.get(popupId)
    const renderer = popup && popup.renderer ? popup.renderer : {}
    const next = updatePopup(popupId, {
      renderer: {
        ...renderer,
        filledName: String(args.name || ''),
        filledAt: Date.now()
      }
    })
    return !!next
  }
  return null
}

async function handlePopupAction(popupId, action, body = {}) {
  const popup = pendingPopups.get(popupId)
  if (!popup) {
    const err = new Error('Popup is not pending')
    err.statusCode = 404
    throw err
  }

  if (popup.type === 'profile-picker') {
    const userData = pearDataRoot()
    const manager = await lifecycle.ensureProfileManager(userData)
    let profileId = body.profileId
    if (action === 'fill-name') {
      const name = String(body.name || '')
      updatePopup(popupId, {
        data: {
          ...popup.data,
          pendingName: name
        }
      })
      sendToAll('zbterm:event', {
        name: 'popup:fill',
        data: { popupId, type: popup.type, name }
      })
      return { popupId, action, name }
    }
    if (action === 'create-and-select') {
      const profile = await manager.createProfile({ name: body.name || 'New profile' })
      profileId = profile.id
    } else if (action !== 'select') {
      const err = new Error('Unsupported profile popup action')
      err.statusCode = 400
      throw err
    }
    if (!profileId) {
      const err = new Error('Missing profileId')
      err.statusCode = 400
      throw err
    }
    const selected = await handleProfileInvoke('profile.select', { profileId })
    sendToAll('zbterm:event', {
      name: 'popup:resolved',
      data: { popupId, type: popup.type, action, selected }
    })
    return { popupId, action, selected }
  }

  if (popup.type === 'share-approval') {
    if (!lifecycle.engine) {
      const err = new Error('ZBTerm engine is not ready')
      err.statusCode = 503
      throw err
    }
    const request = popup.data || {}
    if (action === 'approve') {
      const result = await lifecycle.engine.invoke('share.approveJoin', {
        sessionId: request.sessionId,
        requestId: request.requestId
      })
      clearShareApprovalPopup(request)
      sendToAll('zbterm:event', {
        name: 'popup:resolved',
        data: { popupId, type: popup.type, action, request }
      })
      return { popupId, action, result }
    }
    if (action === 'deny') {
      const result = await lifecycle.engine.invoke('share.denyJoin', {
        sessionId: request.sessionId,
        requestId: request.requestId
      })
      clearShareApprovalPopup(request)
      sendToAll('zbterm:event', {
        name: 'popup:resolved',
        data: { popupId, type: popup.type, action, request }
      })
      return { popupId, action, result }
    }
  }

  if (popup.type === 'identity-setup') {
    return await handleIdentityPopupAction(popupId, popup, action, body)
  }

  const err = new Error('Unsupported popup action')
  err.statusCode = 400
  throw err
}

function popupError(message, statusCode = 400) {
  const err = new Error(message)
  err.statusCode = statusCode
  return err
}

function resolveIdentityPopup(popupId, action, extra = {}) {
  clearIdentityPopup()
  sendToAll('zbterm:event', {
    name: 'popup:resolved',
    data: { popupId, type: 'identity-setup', action, ...extra }
  })
}

// Fingerprints the provider publishes for `subject`. A lookup failure (offline,
// rate limited) must not block the wizard - it only costs the `on GitHub` mark.
async function providerFingerprints(provider, subject) {
  try {
    const answer = await lifecycle.engine.invoke('identity.lookup', { provider, subject })
    return (answer && answer.keys ? answer.keys : []).map((key) => key.fingerprint)
  } catch (err) {
    console.error(debugPrefix('identity'), 'lookup failed', err && err.message)
    return []
  }
}

function markIdentityCandidates(candidates, fingerprints) {
  const known = new Set(fingerprints)
  return candidates.map((candidate) => ({
    ...candidate,
    onProvider: !!candidate.fingerprint && known.has(candidate.fingerprint)
  }))
}

// The headless twin of the renderer wizard: the same sequence
// (beginClaim -> sshSign -> setSelf), driven over the debug server.
async function handleIdentityPopupAction(popupId, popup, action, body = {}) {
  const data = popup.data || {}
  if (action === 'dismiss') {
    resolveIdentityPopup(popupId, action)
    return { popupId, action }
  }
  if (!IDENTITY_POPUP_ACTIONS.includes(action)) {
    throw popupError('Unsupported identity popup action')
  }
  if (!lifecycle.engine) throw popupError('ZBTerm engine is not ready', 503)

  if (action === 'choose-unknown') {
    const identity = await lifecycle.engine.invoke('identity.clear')
    resolveIdentityPopup(popupId, action, { identity })
    return { popupId, action, identity }
  }

  if (action === 'fill-username') {
    const username = String(body.name || body.username || body.value || '').trim()
    if (!GITHUB_USERNAME.test(username)) {
      throw popupError(`Invalid github username: ${username}`)
    }
    const subject = username.toLowerCase()
    const fingerprints = await providerFingerprints('github', subject)
    const candidates = markIdentityCandidates(await sshKeys.listCandidates({}), fingerprints)
    const preselected = candidates.find((candidate) => candidate.signable && candidate.onProvider)
    const selectedFingerprint = preselected ? preselected.fingerprint : null
    updatePopup(popupId, {
      data: {
        ...data,
        provider: 'github',
        username: subject,
        fingerprints,
        candidates,
        selectedFingerprint
      }
    })
    return { popupId, action, username: subject, candidates, selectedFingerprint }
  }

  if (action === 'add-key') {
    let candidate = null
    try {
      candidate = await sshKeys.inspectKey({ keyPath: body.keyPath || body.path })
    } catch (err) {
      throw popupError((err && err.message) || String(err))
    }
    const existing = (data.candidates || []).filter(
      (item) => item.fingerprint !== candidate.fingerprint
    )
    const candidates = markIdentityCandidates([...existing, candidate], data.fingerprints || [])
    updatePopup(popupId, { data: { ...data, candidates } })
    return { popupId, action, candidate: candidates[candidates.length - 1], candidates }
  }

  if (action === 'select-key') {
    const fingerprint = String(body.fingerprint || '')
    const candidate = (data.candidates || []).find((item) => item.fingerprint === fingerprint)
    if (!candidate) throw popupError(`Unknown SSH key fingerprint: ${fingerprint}`)
    if (!candidate.signable) {
      throw popupError(candidate.reason || 'That SSH key cannot be used to sign a claim')
    }
    updatePopup(popupId, { data: { ...data, selectedFingerprint: fingerprint } })
    return { popupId, action, selectedFingerprint: fingerprint }
  }

  // submit
  if (data.provider !== 'github' || !data.username) {
    throw popupError('Choose a provider and enter a username first')
  }
  const candidate = (data.candidates || []).find(
    (item) => item.fingerprint === data.selectedFingerprint
  )
  if (!candidate) throw popupError('Select an SSH key first')
  if (!candidate.signable) {
    throw popupError(candidate.reason || 'That SSH key cannot be used to sign a claim')
  }
  const { claim, bytes } = await lifecycle.engine.invoke('identity.beginClaim', {
    provider: 'github',
    subject: data.username,
    sshPublicKey: candidate.publicKeyBlobBase64,
    sshKeyType: candidate.keyType
  })
  const signed = await sshKeys.signBytes({
    messageBase64: bytes,
    keyPath: candidate.path || null,
    publicKeyBlobBase64: candidate.publicKeyBlobBase64 || null
  })
  const identity = await lifecycle.engine.invoke('identity.setSelf', {
    claim,
    signature: signed.signature
  })
  resolveIdentityPopup(popupId, action, { identity })
  return { popupId, action, identity }
}

async function startupWindowProfileKey() {
  if (requestedProfilePath) return profileWindowKey(null, requestedProfilePath)
  if (!requestedProfileId) return null
  try {
    const manager = await lifecycle.ensureProfileManager(pearDataRoot())
    return profileWindowKey(await manager.resolveProfileId(requestedProfileId))
  } catch (err) {
    console.error('Failed to resolve startup profile window state:', err.message || err)
    debugLog('[window-state:profile-resolve-error]', {
      requestedProfileId,
      message: err.message || String(err)
    })
    return null
  }
}

function createWindow(opts = {}) {
  installAppMenu()
  if (opts.profileKey) activeWindowProfileKey = opts.profileKey
  const savedWindowState = readWindowState(opts.profileKey || null)
  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#16181b' : '#dfe5ea'
  const windowIcon = path.join(__dirname, '..', 'build', 'icon.png')
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    icon: windowIcon,
    ...(savedWindowState ? savedWindowState.bounds : {}),
    backgroundColor,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  })
  setWindowProfileKey(win, opts.profileKey || null)
  if (savedWindowState && savedWindowState.isMaximized) win.maximize()

  let saveWindowTimer = null
  const scheduleWindowStateSave = () => {
    const profileKey = currentWindowProfileKey(win)
    if (saveWindowTimer) clearTimeout(saveWindowTimer)
    saveWindowTimer = setTimeout(() => {
      saveWindowTimer = null
      writeWindowState(win, profileKey)
    }, 300)
  }
  win.on('resize', scheduleWindowStateSave)
  win.on('move', scheduleWindowStateSave)
  win.on('maximize', scheduleWindowStateSave)
  win.on('unmaximize', scheduleWindowStateSave)
  // Every in-app path that can close a window goes through requestAppQuit(),
  // which stamps firstExitTrigger before app.quit() reaches the window - so a
  // close that arrives with no trigger recorded came from outside the app:
  // the window manager (title-bar close, Alt+F4, session logout) or an
  // accelerator we did not install. `lastQuitKey` separates those two: the
  // chords that used to be bound to quit/close are noted as they pass through
  // to the renderer, so a close right after one is attributable to it instead
  // of having to be guessed at afterwards.
  let lastQuitKey = null
  let lastQuitKeyAt = 0
  installAppShortcuts(win)
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    if (!input.control && !input.meta) return
    const key = String(input.key || '').toLowerCase()
    if (!QUIT_KEY_WATCHLIST.has(key)) return
    lastQuitKey = { key: `${input.control ? 'Ctrl+' : ''}${input.meta ? 'Meta+' : ''}${key}` }
    lastQuitKeyAt = Date.now()
  })
  win.on('close', (event) => {
    const details = {
      windowId: win.id,
      defaultPrevented: event.defaultPrevented,
      windowCount: BrowserWindow.getAllWindows().length,
      source: firstExitTrigger ? 'in-app-quit' : 'external',
      // agoMs rather than a fixed staleness cutoff: on the in-app-quit path
      // the close event only arrives after the engine has been closed
      // (seconds later), so any threshold short enough to be meaningful for
      // an external close would throw the evidence away there.
      lastQuitKey: lastQuitKey ? { ...lastQuitKey, agoMs: Date.now() - lastQuitKeyAt } : null
    }
    if (details.windowCount === 1) markExitTrigger('window:last-window-close', details)
    else exitLog('window:close', details)
    if (saveWindowTimer) clearTimeout(saveWindowTimer)
    writeWindowState(win)
  })
  win.on('closed', () => {
    exitLog('window:closed', {
      windowId: win.id,
      windowCount: BrowserWindow.getAllWindows().length
    })
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    exitLog('window:render-process-gone', {
      windowId: win.id,
      reason: details.reason,
      exitCode: details.exitCode
    })
  })

  return win
}

async function loadAppWindow(win, opts = {}) {
  if (!win || win.isDestroyed()) return
  const devServerUrl = process.env.PEAR_DEV_SERVER_URL

  if (devServerUrl) {
    const suffix = opts.profilePicker ? '#profile-picker' : ''
    await win.loadURL(devServerUrl + suffix)
    win.webContents.openDevTools()
    return
  }

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    hash: opts.profilePicker ? 'profile-picker' : undefined
  })
  if (openDevTools) win.webContents.openDevTools({ mode: 'detach' })
}

// Electron installs its own default menu on `ready`, i.e. before the first
// createWindow() call gets here - so the `if (Menu.getApplicationMenu())
// return` guard this used to open with always bailed, and the default menu
// stayed. For a terminal that menu is actively destructive: its Window
// submenu binds Ctrl+W to `close` (which, being the last window, quits the
// app - see the `window:last-window-close` records in debug_main.log), its
// View submenu binds Ctrl+R/Shift+Ctrl+R to reload (throwing away the live
// renderer), and its Edit submenu claims Ctrl+C/Ctrl+X/Ctrl+A. Registered
// accelerators are consumed natively, ahead of the page, so xterm never
// sees those keys - yet Ctrl+W (kill-word), Ctrl+R (reverse-i-search) and
// Ctrl+C (SIGINT) are all ordinary typing in a shell.
//
// On Linux and Windows there is no menu at all: a null application menu has
// no bar to show (not even on Alt) and registers no accelerators. The two
// app shortcuts that still matter are handled per window in
// installAppShortcuts() instead.
//
// macOS is deliberately left on the default menu: there, Cmd+C/Cmd+V are
// routed through the Edit menu by the OS (removing it breaks copy/paste
// outright), Cmd+W-closes-window is the platform convention, and none of
// those chords collide with terminal keys the way the Ctrl+ ones do.
let appMenuInstalled = false
function installAppMenu() {
  if (appMenuInstalled) return
  appMenuInstalled = true
  if (isMac) {
    debugLog('[menu:install]', { platform: process.platform, menu: 'electron-default' })
    return
  }
  debugLog('[menu:install]', {
    platform: process.platform,
    menu: 'none',
    replacedDefaultMenu: !!Menu.getApplicationMenu()
  })
  Menu.setApplicationMenu(null)
}

// The shortcuts the removed menu used to carry: Ctrl+Q quits and
// Ctrl+Shift+I toggles DevTools. Matched on the exact chord and swallowed
// before the page sees it, as the menu accelerators were; every other key
// (Ctrl+R reverse-search included) still reaches the terminal.
function installAppShortcuts(win) {
  if (isMac) return
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return
    const key = String(input.key || '').toLowerCase()
    if (key === 'q' && !input.shift) {
      event.preventDefault()
      requestAppQuit('shortcut:quit')
    } else if (key === 'i' && input.shift) {
      event.preventDefault()
      win.webContents.toggleDevTools()
    }
  })
}

app.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder,DbusSystemdService')
ipcMain.handle('zbterm:invoke', async (evt, method, args) => {
  // `identity.ssh*` arguments carry key paths and raw claim bytes - never let
  // them reach the debug log.
  console.log(
    debugPrefix('zbterm:invoke'),
    method,
    method.startsWith('identity.ssh') ? '[redacted]' : JSON.stringify(args)
  )
  try {
    if (method === 'app.chooseDirectory') return await chooseDirectory(evt, args)
    if (method.startsWith('app.')) {
      const appResult = handleAppInvoke(method, args)
      // A preference that was never saved reads as null, which is an answer,
      // not "unknown method" - it must not fall through to the engine.
      if (appResult !== null || method === 'app.preference.get') return appResult
    }
    if (method.startsWith('debug.')) {
      const debugResult = handleDebugInvoke(method, args)
      if (debugResult !== null) return debugResult
    }
    if (method.startsWith('profile.')) {
      const profileResult = await handleProfileInvoke(method, args)
      if (profileResult !== null) return profileResult
    }
    if (method.startsWith('identity.ssh')) {
      // Deliberately ahead of the engineReady gate: the identity wizard reads
      // the user's SSH keys while the worker is still booting.
      const sshResult = await handleIdentitySshInvoke(method, args)
      if (sshResult !== null) return sshResult
    }
    if (!lifecycle.engineReady) {
      // A profile was already selected and the engine previously started -
      // `engineReady` is only false right now because the worker
      // crashed/is respawning (EngineLifecycle._onWorkerCrash) or the
      // initial start is still in flight. That is a transient, retryable
      // state, not "no profile chosen" - report it as such instead of the
      // misleading profile-selection message (which sent users looking for
      // a profile picker that was never going to appear).
      if (lifecycle.selectedProfileId && lifecycle.isRecovering) {
        return {
          error: {
            name: 'EngineError',
            code: 'E_ENGINE_RESTARTING',
            message: 'ZBTerm engine is restarting - try again in a moment',
            details: null
          }
        }
      }
      return {
        error: {
          name: 'EngineError',
          code: 'E_PROFILE_REQUIRED',
          message: 'Select a ZBTerm profile before starting the engine',
          details: null
        }
      }
    }
    const result = await lifecycle.engine.invoke(method, args)
    console.log(debugPrefix('zbterm:invoke'), 'OK', method)
    return result
  } catch (err) {
    console.error(debugPrefix('zbterm:invoke'), 'ERROR', method, err.message, err.stack)
    if (err && err.toJSON) return { error: err.toJSON() }
    return {
      error: {
        name: err.name || 'Error',
        code: err.code || 'E_INTERNAL',
        message: err.message || String(err),
        details: err.details || null
      }
    }
  }
})
// The renderer's "STUN/TURN servers" setting (preload `app.setIceServers`).
ipcMain.handle('app:setIceServers', (evt, text) => {
  iceSetting = typeof text === 'string' ? text : ''
  const resolved = currentIceServers()
  console.log(
    debugPrefix('ice'),
    JSON.stringify({ source: resolved.source, count: resolved.servers.length })
  )
  return lifecycle.setIceServers(resolved.servers).then(() => ({
    source: resolved.source,
    count: resolved.servers.length
  }))
})

ipcMain.handle('clipboard:writeText', (evt, text) => {
  clipboard.writeText(String(text || ''))
  return true
})
ipcMain.handle('clipboard:readText', () => clipboard.readText())

function isJoinLink(url) {
  return url.startsWith(protocol + '://join/')
}

// True when the core lists at least one usable share backend. A core that
// predates `share.backends` is treated as able to share.
async function hasShareBackend(engine) {
  let info = null
  try {
    info = await engine.invoke('share.backends')
  } catch {
    return true
  }
  if (!info || !Array.isArray(info.backends)) return true
  return info.backends.some((backend) => backend && backend.state === 'available')
}

function handleDeepLink(url) {
  console.log('deep link:', url)
  if (!lifecycle.engine || !isJoinLink(url)) return
  const engine = lifecycle.engine
  hasShareBackend(engine)
    .then((usable) => {
      if (!usable) {
        // A build or launch with no share backend (R-9): say so, join nothing.
        sendToAll('zbterm:event', {
          name: 'app:toast',
          data: { message: 'This ZBTerm has no sharing backend, so it cannot open a join link.' }
        })
        return null
      }
      return engine.invoke('share.join', { uri: url })
    })
    .catch((err) =>
      sendToAll('zbterm:event', { name: 'engine:error', data: err.toJSON ? err.toJSON() : err })
    )
}

app.setAsDefaultProtocolClient(protocol)

app.on('open-url', (evt, url) => {
  evt.preventDefault()
  handleDeepLink(url)
})

{
  app.whenReady().then(async () => {
    const profileKey = await startupWindowProfileKey()
    const win = createWindow({ profileKey })
    try {
      await loadAppWindow(win)
    } catch (err) {
      console.error('Failed to create window:', err)
      requestAppQuit('startup:load-window-failed', {
        message: err && err.message ? err.message : String(err)
      })
      return
    }
    if (!win.isDestroyed()) win.show()

    lifecycle.startPearRuntime().catch((err) => {
      console.error('Failed to initialize ZBTerm:', err)
      const message = String(err && err.stack ? err.stack : err)
      if (win && !win.isDestroyed()) win.webContents.send('pear:error', message)
      sendToAll('zbterm:event', {
        name: 'engine:error',
        data: err && err.toJSON ? err.toJSON() : { message: err.message || String(err) }
      })
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        startupWindowProfileKey()
          .then((profileKey) => {
            const nextWin = createWindow({ profileKey })
            return loadAppWindow(nextWin).then(() => {
              return nextWin
            })
          })
          .then((nextWin) => {
            if (!nextWin.isDestroyed()) nextWin.show()
          })
          .catch((err) => console.error('Failed to create window:', err))
      }
    })
  })

  app.on('window-all-closed', () => {
    exitLog('app:window-all-closed', { platform: process.platform })
    if (process.platform !== 'darwin') {
      requestAppQuit('app:window-all-closed')
    }
  })

  let quitAfterEngineClose = false
  app.on('before-quit', (event) => {
    if (!firstExitTrigger) markExitTrigger('app:before-quit:unattributed')
    exitLog('app:before-quit', { quitAfterEngineClose })
    if (quitAfterEngineClose) return
    event.preventDefault()
    if (debugServer) {
      debugServer.stop().catch((err) => {
        exitLog('app:debug-server-stop-failed', {
          message: err && err.message ? err.message : String(err)
        })
        console.error('Failed to close debug server:', err)
      })
    }
    Promise.race([
      lifecycle.closeEngine().then(() => 'engine-closed'),
      delay(7000).then(() => 'timeout')
    ])
      .then((result) => exitLog('app:engine-close-finished', { result }))
      .catch((err) => {
        exitLog('app:engine-close-failed', {
          message: err && err.message ? err.message : String(err)
        })
        console.error('Failed to close engine before quit:', err)
      })
      .finally(() => {
        quitAfterEngineClose = true
        requestAppQuit('app:engine-close-finally')
      })
  })

  app.on('will-quit', () => {
    exitLog('app:will-quit', { electronUserDataIsScratch })
    if (!electronUserDataIsScratch) return
    fs.rm(app.getPath('userData'), { recursive: true, force: true }, () => {})
  })

  app.on('quit', (_event, exitCode) => {
    exitLog('app:quit', { exitCode })
  })

  app.on('child-process-gone', (_event, details) => {
    exitLog('app:child-process-gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name
    })
  })
}
