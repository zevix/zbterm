#!/usr/bin/env node
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const net = require('net')
const { spawn, spawnSync } = require('child_process')

let HOST_PORT = Number(process.env.ZBTERM_E2E_HOST_PORT || 0)
let CLIENT_PORT = Number(process.env.ZBTERM_E2E_CLIENT_PORT || 0)
let CLIENT2_PORT = Number(process.env.ZBTERM_E2E_CLIENT2_PORT || 0)
let CLIENT3_PORT = Number(process.env.ZBTERM_E2E_CLIENT3_PORT || 0)
const REMOTE_PORT = Number(process.env.ZBTERM_E2E_REMOTE_PORT || 0)
const TOP_COMMAND = process.env.ZBTERM_E2E_TOP_COMMAND || 'top -d 0.1'
const INSPECT =
  hasArgPrefix(process.argv, '--inspect') || hasArgPrefix(process.execArgv, '--inspect')
const REVIEW = process.argv.includes('--review') || process.argv.includes('--wait') || INSPECT
const KEEP = process.argv.includes('--keep-open')
const RESET_PROFILES = process.argv.includes('--reset-profiles')
const OPEN_PROFILES_ONLY = process.argv.includes('--open-profiles-only')
const WINDOW_BOUNDS_SMOKE = process.argv.includes('--window-bounds-smoke')
const DEMO_MODE = process.argv.includes('--demo-mode')
const VIA_UI = process.argv.includes('--via-ui')
// Runs only the identity end-to-end scenario (Phase 7 of
// docs/identity-providers_plan.md). The default full run includes it too.
const IDENTITY_ONLY = process.argv.includes('--identity-only')
const STOP_AFTER = readArgValue('--stop-after')
const KILL_EXISTING = process.argv.includes('--kill-existing')
const VERIFY_WINDOW_RESTORE =
  process.argv.includes('--verify-window-restore') ||
  (!REVIEW && (!STOP_AFTER || OPEN_PROFILES_ONLY))
const PLACE_WINDOWS = RESET_PROFILES || REVIEW
const CLEANUP_ON_EXIT =
  process.argv.includes('--cleanup-on-exit') || process.argv.includes('--kill-apps-on-exit')
const CLEANUP_ON_SIGNAL = CLEANUP_ON_EXIT || (!REVIEW && !KEEP)
const TIMEOUT_MS = Number(process.env.ZBTERM_E2E_TIMEOUT_MS || 120000)
const DEMO_APPROVAL_DELAY_MS = 1000
const DEMO_TYPING_DELAY_MS = 64
const DEMO_HOST_ENTER_DELAY_MS = 500
const RUN_TAG = `debug-e2e-${Date.now()}`
const REMOVE_ROOT_ON_CLEANUP = process.env.ZBTERM_E2E_REMOVE_ROOT === '1'

// Identity scenario fixtures. The usernames are stubbed by the local keys
// server below, never fetched from github.com.
const IDENTITY_USER = 'zbterm-e2e'
// A *different* username on purpose: the resolver caches a positive answer for
// six hours, so reusing IDENTITY_USER for the negative run would be answered
// from cache and pass for the wrong reason.
const IDENTITY_BAD_USER = 'zbterm-e2e-bad'
// engine/identity/verify.js IDENTITY_TIMEOUT_MS, plus the 5 s the acceptance
// criteria allow on top of it.
const IDENTITY_TIMEOUT_MS = 15000
const IDENTITY_REFUSAL_BUDGET_MS = IDENTITY_TIMEOUT_MS + 5000

const root =
  process.env.ZBTERM_E2E_ROOT || path.join(os.tmpdir(), 'zbterm-debug-e2e-profile-restore')
const storage = path.join(root, 'storage')

// `--storage` and `--electron-user-data` do NOT cover everything an app
// instance writes: electron/main.js captures `stableUserData =
// app.getPath('userData')` before it repoints Chromium (`:64`) and keeps
// `debug_main.log` (`:93`), `window-state.json` (`:497`), `window-state.lock`
// (`:501`) and `preferences.json` (`:528`) there for the lifetime of the
// process. Unless the environment says otherwise that path is the developer's
// own `~/.config/ZBTerm`, so every e2e-spawned app used to append to the
// developer's debug log and - with --reset-profiles, which moves windows into
// screen quarters - overwrite the window positions of their real app. Pointing
// XDG_CONFIG_HOME at one e2e-owned directory relocates all four files wholesale
// while keeping their existing cross-instance semantics (window-state.json is
// shared between instances and keyed per profile, see `profileWindowKey()`),
// which is what makes the isolation structural rather than a matter of passing
// the right flags.
const appConfigRoot = path.join(root, 'config')
// The directory the spawned apps would have used without that override. Nothing
// in a run may write here; `assertRealUserDataUntouched()` proves it.
const realAppConfigDir = defaultAppConfigDir()
let realAppConfigSnapshot = null

const children = []
let cleaningUp = false
let identityKeysServer = null

if (CLEANUP_ON_SIGNAL) {
  // SIGHUP is in the list because a run started from a terminal that goes away
  // (an agent harness cancelling the command, a closed ssh session) is exactly
  // the case that used to leave app windows on screen with nothing left to
  // close them.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, async () => {
      console.log(`\n${signal} received; cleaning up debug e2e apps.`)
      await cleanup({ force: true })
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

main().catch(async (err) => {
  console.error('\nE2E failed:', err.stack || err.message || err)
  if (REVIEW || KEEP) {
    await holdForReview('E2E failed')
    process.exitCode = 1
    return
  }
  await cleanup()
  process.exit(1)
})

async function main() {
  console.log('debug server e2e root:', root)
  console.log('debug server e2e reset profiles:', RESET_PROFILES ? 'yes' : 'no')
  await prepareStorageRoot()
  if (WINDOW_BOUNDS_SMOKE) {
    await runWindowBoundsSmokeTest()
    return
  }

  // Runs before the sharing scenario so an identity regression is reported in
  // the first minutes of a run rather than the last. It owns its own app
  // instances, profiles and HOMEs, and shuts them down before returning.
  await runIdentityScenario()
  if (IDENTITY_ONLY) {
    console.log('\nIdentity E2E passed.')
    if (REVIEW || KEEP) {
      await holdForReview('Identity E2E passed')
      return
    }
    await cleanup()
    return
  }

  HOST_PORT = HOST_PORT || (await freePort())
  CLIENT_PORT = CLIENT_PORT || (await freePort())
  CLIENT2_PORT = CLIENT2_PORT || (await freePort())
  step('launch host')
  startApp('host', storage, HOST_PORT, launchOpts('host'))
  await waitForHealth(HOST_PORT, 'host')
  await waitForRendererReady(HOST_PORT, 'host')
  assertRealUserDataUntouched('host')
  await dismissStartupIdentityWizard(HOST_PORT, 'host')
  const windowSlots = await computeWindowSlots(HOST_PORT)
  if (PLACE_WINDOWS) await setWindowSlot(HOST_PORT, 'host', windowSlots.host)
  else if (VERIFY_WINDOW_RESTORE) await verifyWindowSlot(HOST_PORT, 'host', windowSlots.host)

  step('launch client')
  startApp('client', storage, CLIENT_PORT, launchOpts('client'))
  if (RESET_PROFILES) await createProfileFromStartupPopup(CLIENT_PORT, 'client')
  await waitForHealth(CLIENT_PORT, 'client')
  await waitForRendererReady(CLIENT_PORT, 'client')
  await dismissStartupIdentityWizard(CLIENT_PORT, 'client')
  if (PLACE_WINDOWS) await setWindowSlot(CLIENT_PORT, 'client', windowSlots.client)
  else if (VERIFY_WINDOW_RESTORE) await verifyWindowSlot(CLIENT_PORT, 'client', windowSlots.client)

  step('launch client2')
  startApp('client2', storage, CLIENT2_PORT, launchOpts('client2'))
  if (RESET_PROFILES) await createProfileFromStartupPopup(CLIENT2_PORT, 'client2')
  await waitForHealth(CLIENT2_PORT, 'client2')
  await waitForRendererReady(CLIENT2_PORT, 'client2')
  await dismissStartupIdentityWizard(CLIENT2_PORT, 'client2')
  if (PLACE_WINDOWS) await setWindowSlot(CLIENT2_PORT, 'client2', windowSlots.client2)
  else if (VERIFY_WINDOW_RESTORE) {
    await verifyWindowSlot(CLIENT2_PORT, 'client2', windowSlots.client2)
  }

  if (OPEN_PROFILES_ONLY) {
    await openProfilesOnly(windowSlots)
    return
  }

  step('verify identities')
  const hostHealth = await api(HOST_PORT, 'GET', '/health')
  const clientHealth = await api(CLIENT_PORT, 'GET', '/health')
  const client2Health = await api(CLIENT2_PORT, 'GET', '/health')
  assert(hostHealth.identity.deviceKey !== clientHealth.identity.deviceKey, 'identities differ')
  assert(
    hostHealth.identity.deviceKey !== client2Health.identity.deviceKey,
    'client2 identity differs'
  )
  assert(
    clientHealth.identity.deviceKey !== client2Health.identity.deviceKey,
    'client identities differ'
  )

  step('create host session')
  const session = await createSession(HOST_PORT, 'host', {
    name: `${RUN_TAG} host top`,
    cols: 100,
    rows: 30
  })
  assert(session.sessionId, 'host session was created')

  await api(HOST_PORT, 'POST', `/sessions/${session.sessionId}/switch`)
  await api(HOST_PORT, 'POST', '/sessions/current/input', {
    text: TOP_COMMAND,
    enter: true
  })

  await sleep(2500)
  step('wait for host terminal output')
  const runningStats = await waitFor(async () => {
    const stats = await api(HOST_PORT, 'GET', `/sessions/${session.sessionId}/stats`)
    return frameText(stats).toLowerCase().includes('top') ? stats : null
  }, 'host top output')
  assert(runningStats.history.length > 0, 'host recorded terminal history')

  step('rename and share host session')
  const sharedName = 'debug e2e renamed before share'
  const renamed = await api(HOST_PORT, 'POST', '/invoke', {
    method: 'session.rename',
    args: { sessionId: session.sessionId, name: sharedName }
  })
  assert(renamed.name === sharedName, 'host session was renamed before sharing')

  const share = VIA_UI
    ? await shareSessionViaUi(HOST_PORT, session.sessionId)
    : await api(HOST_PORT, 'POST', `/sessions/${session.sessionId}/share`, {
        type: 'group',
        maxViewers: 8,
        autoJoin: false
      })
  assert(share.uri && share.uri.startsWith('zbterm://join/'), 'share uri was created')

  step('client join request')
  if (VIA_UI) await joinSessionViaUi(CLIENT_PORT)
  else await api(CLIENT_PORT, 'POST', '/join', { uri: share.uri })

  step('approve client join')
  const approval = await waitForApprovalPopup(HOST_PORT, session.sessionId)
  assert(approval.data.requestId, 'manual approval request was surfaced')

  if (DEMO_MODE) await demoPause('approving client join')
  await api(HOST_PORT, 'POST', `/popups/${encodeURIComponent(approval.id)}/actions/approve`)
  assert(true, 'manual approval request was approved')

  step('wait for client joined renderer')
  const joined = await waitForJoined(CLIENT_PORT, session.sessionId, 'client joined session')
  assert(joined.active, 'client joined session is active')
  assert(joined.name === sharedName, 'client sees renamed shared session')
  await waitForRendererJoined(
    CLIENT_PORT,
    session.sessionId,
    'client renderer selected joined session'
  )

  step('wait for client live data')
  const clientStats = await waitFor(async () => {
    const stats = await api(CLIENT_PORT, 'GET', `/sessions/${session.sessionId}/stats`)
    const text = frameText(stats).toLowerCase()
    const hasHistory = stats.history.length > 0 || stats.playback.length > 0
    return hasHistory && text.includes('top') ? stats : null
  }, 'client replicated live top output')
  assert(clientStats.location.owner === 'joined', 'client stats identify joined session')

  step('client2 join request')
  if (VIA_UI) await joinSessionViaUi(CLIENT2_PORT)
  else await api(CLIENT2_PORT, 'POST', '/join', { uri: share.uri })
  step('approve client2 join')
  const approval2 = await waitForApprovalPopup(
    HOST_PORT,
    session.sessionId,
    approval.data.requestId
  )
  assert(approval2.data.requestId, 'second manual approval request was surfaced')
  if (DEMO_MODE) await demoPause('approving client2 join')
  await api(HOST_PORT, 'POST', `/popups/${encodeURIComponent(approval2.id)}/actions/approve`)
  assert(true, 'second manual approval request was approved')

  step('wait for client2 joined renderer')
  const joined2 = await waitForJoined(CLIENT2_PORT, session.sessionId, 'client2 joined session')
  assert(joined2.active, 'client2 joined session is active')
  assert(joined2.name === sharedName, 'client2 sees renamed shared session')
  await waitForRendererJoined(
    CLIENT2_PORT,
    session.sessionId,
    'client2 renderer selected joined session'
  )

  step('wait for client2 live data')
  const client2Stats = await waitFor(async () => {
    const stats = await api(CLIENT2_PORT, 'GET', `/sessions/${session.sessionId}/stats`)
    const text = frameText(stats).toLowerCase()
    const hasHistory = stats.history.length > 0 || stats.playback.length > 0
    return hasHistory && text.includes('top') ? stats : null
  }, 'client2 replicated live top output')
  assert(client2Stats.location.owner === 'joined', 'client2 stats identify joined session')

  step('verify joined clients render the full original terminal frame')
  await assertTerminalDisplayVisible(CLIENT_PORT, session.sessionId, 'client')
  await assertTerminalDisplayVisible(CLIENT2_PORT, session.sessionId, 'client2')

  const hostShareStats = await api(HOST_PORT, 'GET', `/sessions/${session.sessionId}/stats`)
  assert(hostShareStats.share.isSharing, 'host reports active sharing')
  assert(hostShareStats.share.viewerCount >= 2, 'host reports two viewers')

  step('enable shared keyboard')
  const inputMode = await api(HOST_PORT, 'POST', '/invoke', {
    method: 'share.setInputMode',
    args: { sessionId: session.sessionId, mode: 'all' }
  })
  assert(inputMode.mode === 'all', 'host enabled shared keyboard mode')

  const hostInputDiagnostics = await api(
    HOST_PORT,
    'GET',
    `/sessions/${session.sessionId}/input/diagnostics`
  )
  const hostShare = hostInputDiagnostics.share.hostShares.find(
    (item) => item.sessionId === session.sessionId
  )
  assert(
    hostShare && hostShare.links.some((link) => link.canSendInput),
    'share link grants input capability'
  )
  assert(
    hostShare && hostShare.peerDetails.filter((peer) => peer.canSendInput).length >= 2,
    'joined peers can send input'
  )

  step('type into host session from client')
  await api(CLIENT_PORT, 'POST', `/sessions/${session.sessionId}/input`, { data: 'q' })
  await sleep(1000)
  await api(CLIENT_PORT, 'POST', `/sessions/${session.sessionId}/input`, {
    text: 'printf ZBTERM_CLIENT_INPUT_OK',
    enter: true
  })
  const clientTypedStats = await waitFor(async () => {
    const stats = await api(HOST_PORT, 'GET', `/sessions/${session.sessionId}/stats`)
    return frameText(stats).includes('ZBTERM_CLIENT_INPUT_OK') ? stats : null
  }, 'host terminal output from client keyboard input')
  assert(
    frameText(clientTypedStats).includes('ZBTERM_CLIENT_INPUT_OK'),
    'host terminal shows client keyboard input'
  )

  step('type into host session from client2')
  await api(CLIENT2_PORT, 'POST', `/sessions/${session.sessionId}/input`, {
    text: 'printf ZBTERM_CLIENT2_INPUT_OK',
    enter: true
  })
  const client2TypedStats = await waitFor(async () => {
    const stats = await api(HOST_PORT, 'GET', `/sessions/${session.sessionId}/stats`)
    return frameText(stats).includes('ZBTERM_CLIENT2_INPUT_OK') ? stats : null
  }, 'host terminal output from client2 keyboard input')
  assert(
    frameText(client2TypedStats).includes('ZBTERM_CLIENT2_INPUT_OK'),
    'host terminal shows client2 keyboard input'
  )

  if (DEMO_MODE) {
    step('demo slow remote keyboard typing')
    const demoClientLine = 'Hello from Client 1 !!!!!!'
    const demoClient2Line = 'Hello from Client 2 !!!!!!'
    await slowTypeLine(CLIENT_PORT, session.sessionId, demoClientLine)
    await slowTypeLine(CLIENT2_PORT, session.sessionId, demoClient2Line)
    const demoTypedStats = await waitFor(async () => {
      const stats = await api(HOST_PORT, 'GET', `/sessions/${session.sessionId}/stats`)
      const text = frameText(stats)
      return text.includes(demoClientLine) && text.includes(demoClient2Line) ? stats : null
    }, 'host terminal output from demo remote keyboard typing')
    assert(
      frameText(demoTypedStats).includes(demoClientLine) &&
        frameText(demoTypedStats).includes(demoClient2Line),
      'host terminal shows demo slow remote keyboard input'
    )

    step('demo slow host htop and HD mode')
    for (let i = 0; i < 3; i++) {
      await api(HOST_PORT, 'POST', `/sessions/${session.sessionId}/input`, { data: '\r' })
      await sleep(DEMO_HOST_ENTER_DELAY_MS)
    }
    await slowTypeLine(
      HOST_PORT,
      session.sessionId,
      'echo ---- The host will now run a fast htop demo, and then switch to HD mode ---- '
    )
    await sleep(1000)
    await slowTypeLine(HOST_PORT, session.sessionId, 'htop -d 0.1')
    await sleep(5000)
    const hdMode = await api(HOST_PORT, 'POST', '/invoke', {
      method: 'session.setHd',
      args: { sessionId: session.sessionId, enabled: true }
    })
    assert(hdMode.hd, 'host enabled HD mode for demo')
    await sleep(5000)
  }

  const inputEvents = await waitFor(async () => {
    const diagnostics = await api(
      HOST_PORT,
      'GET',
      `/sessions/${session.sessionId}/input/diagnostics`
    )
    const accepted = diagnostics.inputEvents.filter(
      (item) => item.data && item.data.event === 'host:input:accepted'
    )
    return accepted.length >= 2 ? diagnostics.inputEvents : null
  }, 'host input diagnostics events')
  assert(inputEvents.length >= 2, 'input diagnostics recorded accepted input')

  if (STOP_AFTER === 'keyboard-share') {
    await stopAfter('keyboard-share')
    return
  }

  if (REMOTE_PORT > 0) {
    step('remote client join')
    await assertRemoteJoin(REMOTE_PORT, share.uri, session.sessionId, sharedName)
  }

  step('exercise playback controls')
  const playback = await api(CLIENT_PORT, 'POST', `/sessions/${session.sessionId}/playback/open`)
  assert(playback.length > 0, 'client playback opened with history')
  assert(playback.timeline.length > 0, 'client playback exposes timeline')

  const seekTs = playback.timeline[Math.max(0, Math.floor(playback.timeline.length / 3) - 1)].tsMs
  const seekFrame = await api(CLIENT_PORT, 'POST', `/sessions/${session.sessionId}/playback/seek`, {
    tsMs: seekTs
  })
  assert(Number.isFinite(seekFrame.seq), 'client seek returned a frame')

  await api(CLIENT_PORT, 'POST', `/sessions/${session.sessionId}/playback/play`, { speed: 2 })
  await sleep(1000)
  await api(CLIENT_PORT, 'POST', `/sessions/${session.sessionId}/playback/pause`)

  const live = await api(CLIENT_PORT, 'POST', `/sessions/${session.sessionId}/live`)
  assert(live.active, 'client returned to live session')

  const finalStats = await api(CLIENT_PORT, 'GET', `/sessions/${session.sessionId}/stats`)
  assert(finalStats.selected, 'client session remains selected')
  assert(finalStats.mode === 'live', 'client debug mode returned to live')
  assert(frameText(finalStats).toLowerCase().includes('top'), 'client live frame still shows top')

  // Multi-session multiplex + rotation scenario (Phase 1 step 3). Note: this
  // does NOT have client (or client2) join a second session from the same
  // host - see docs/DESIGN-SWARM-AND-WORKER.md, "Phase 1 -> New pitfall 3
  // addendum" for why that specific shape isn't safe until join-side
  // consolidation (Phase 3) lands. A fresh viewer identity (client3) is used
  // instead, so this only exercises what Phase 1 actually changed: one
  // shared host swarm correctly serving multiple hosted sessions to
  // multiple distinct remote peers, with diagnostics reporting the new
  // shape. The "second viewer join triggers rotation, first viewer keeps
  // decrypting correctly" property is already covered above for the first
  // session (client2 joining after client) and isn't duplicated here.
  step('create second host session for multi-session hosting scenario')
  const session2 = await createSession(HOST_PORT, 'host session2', {
    name: `${RUN_TAG} host session2`,
    cols: 100,
    rows: 30
  })
  assert(session2.sessionId, 'second host session was created')
  await api(HOST_PORT, 'POST', `/sessions/${session2.sessionId}/switch`)
  await api(HOST_PORT, 'POST', '/sessions/current/input', {
    text: TOP_COMMAND,
    enter: true
  })
  await sleep(2000)
  const session2Stats = await waitFor(async () => {
    const stats = await api(HOST_PORT, 'GET', `/sessions/${session2.sessionId}/stats`)
    return frameText(stats).toLowerCase().includes('top') ? stats : null
  }, 'second host session top output')
  assert(session2Stats.history.length > 0, 'second host session recorded terminal history')

  const share2 = await api(HOST_PORT, 'POST', `/sessions/${session2.sessionId}/share`, {
    type: 'group',
    maxViewers: 8,
    autoJoin: true
  })
  assert(share2.uri && share2.uri.startsWith('zbterm://join/'), 'second share uri was created')

  step('launch client3')
  CLIENT3_PORT = CLIENT3_PORT || (await freePort())
  const client3App = startApp('client3', storage, CLIENT3_PORT, launchOpts('client3'))
  if (RESET_PROFILES) await createProfileFromStartupPopup(CLIENT3_PORT, 'client3')
  await waitForHealth(CLIENT3_PORT, 'client3')
  await waitForRendererReady(CLIENT3_PORT, 'client3')
  await dismissStartupIdentityWizard(CLIENT3_PORT, 'client3')
  if (PLACE_WINDOWS) await setWindowSlot(CLIENT3_PORT, 'client3', windowSlots.client3)
  else if (VERIFY_WINDOW_RESTORE) {
    await verifyWindowSlot(CLIENT3_PORT, 'client3', windowSlots.client3)
  }

  step(
    'client3 joins the second session (a distinct viewer identity, not a second join from client/client2)'
  )
  await api(CLIENT3_PORT, 'POST', '/join', { uri: share2.uri })
  const client3JoinedSession2 = await waitForJoined(
    CLIENT3_PORT,
    session2.sessionId,
    'client3 joined second session'
  )
  assert(client3JoinedSession2.active, 'client3 joined second session is active')
  await waitForRendererJoined(
    CLIENT3_PORT,
    session2.sessionId,
    'client3 renderer selected second session'
  )
  const client3Session2Stats = await waitFor(async () => {
    const stats = await api(CLIENT3_PORT, 'GET', `/sessions/${session2.sessionId}/stats`)
    const text = frameText(stats).toLowerCase()
    const hasHistory = stats.history.length > 0 || stats.playback.length > 0
    return hasHistory && text.includes('top') ? stats : null
  }, 'client3 replicated second session live top output')
  assert(client3Session2Stats.location.owner === 'joined', 'client3 stats identify second session')

  step('verify one host swarm serves both hosted sessions across distinct viewer identities')
  const multiplexDiagnostics = await api(HOST_PORT, 'GET', '/share/diagnostics')
  assert(multiplexDiagnostics.hostShares.length === 2, 'host diagnostics show two hosted sessions')
  assert(
    multiplexDiagnostics.hostSwarm && multiplexDiagnostics.hostSwarm.connections === 3,
    'host swarm reports one connection per connected viewer process (client, client2, client3)'
  )

  const clientSession1After = await api(CLIENT_PORT, 'GET', `/sessions/${session.sessionId}/stats`)
  assert(
    clientSession1After.location.owner === 'joined',
    'client session A is unaffected by a second session being hosted on the shared swarm'
  )

  if (RESET_PROFILES) await persistWindowSlots(windowSlots, { includeClient3: true })

  step('stop client3')
  client3App.kill()

  step('stop host top')
  await api(HOST_PORT, 'POST', `/sessions/${session.sessionId}/input`, { data: 'q' }).catch(
    () => {}
  )
  await api(HOST_PORT, 'POST', `/sessions/${session2.sessionId}/input`, { data: 'q' }).catch(
    () => {}
  )

  // Before the crash scenario, not after: that scenario deliberately tears the
  // host's engine down for good, and seeding the window slots is the whole
  // point of a --reset-profiles run - a later run has nothing to verify
  // restore against if the seeding step never gets reached.
  if (RESET_PROFILES) await persistWindowSlots(windowSlots)

  await runWorkerCrashScenario()

  assertRealUserDataUntouched('full run')
  console.log('\nE2E passed.')
  console.log('host debug server:', `http://127.0.0.1:${HOST_PORT}`)
  console.log('client debug server:', `http://127.0.0.1:${CLIENT_PORT}`)
  console.log('client2 debug server:', `http://127.0.0.1:${CLIENT2_PORT}`)

  if (REVIEW) {
    await holdForReview('E2E passed')
    return
  }

  await cleanup()
}

async function prepareStorageRoot() {
  const existing = findExistingE2eProcesses()
  if (existing.length) {
    if (!KILL_EXISTING) {
      const lines = existing
        .slice(0, 8)
        .map((proc) => `  pid ${proc.pid}, pgid ${proc.pgid}: ${proc.command}`)
        .join('\n')
      const suffix = existing.length > 8 ? `\n  ...and ${existing.length - 8} more` : ''
      throw new Error(
        `Found existing ZBTerm e2e process(es) using ${root}:\n${lines}${suffix}\n` +
          'Close those app windows, or rerun with --kill-existing to terminate only this e2e root.'
      )
    }

    console.warn(
      `Found ${existing.length} existing ZBTerm e2e process(es) using ${root}; terminating them.`
    )
    await killExistingE2eProcesses(existing)
  }

  if (RESET_PROFILES) fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(storage, { recursive: true })
  fs.mkdirSync(appConfigRoot, { recursive: true })
  if (process.platform === 'linux') {
    realAppConfigSnapshot = snapshotDir(realAppConfigDir)
    console.log('debug server e2e app config root:', appConfigRoot)
    console.log('debug server e2e must not touch:', realAppConfigDir)
  } else {
    // Only Linux resolves `app.getPath('userData')` through an environment
    // variable, so only there can the redirect below actually take effect -
    // asserting it elsewhere would fail a run for something it cannot fix.
    console.warn(
      `warning: ${process.platform} has no XDG_CONFIG_HOME equivalent; ` +
        `spawned apps will keep their debug log and window state in ${realAppConfigDir}`
    )
  }
}

// Where electron/main.js' `stableUserData` lands when XDG_CONFIG_HOME (or the
// platform equivalent) is left alone - i.e. the developer's real ZBTerm data
// directory, which a test run must never read or write.
function defaultAppConfigDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ZBTerm')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ZBTerm')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ZBTerm')
}

function snapshotDir(dir) {
  const entries = new Map()
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return entries
  }
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(dir, name))
      entries.set(name, `${stat.mtimeMs}:${stat.size}`)
    } catch {}
  }
  return entries
}

// The load-bearing safety check. electron/main.js writes `=== main.js loaded
// ===` into `<stableUserData>/debug_main.log` during module evaluation, so an
// instance that resolved to the developer's real data directory changes that
// file's mtime within milliseconds of starting - well before it could reach a
// profile picker. Comparing the directory against the snapshot taken before any
// app was spawned therefore detects the leak positively, not by inference.
function assertRealUserDataUntouched(label) {
  if (!realAppConfigSnapshot) return
  const current = snapshotDir(realAppConfigDir)
  const changed = []
  for (const [name, stamp] of current) {
    if (realAppConfigSnapshot.get(name) !== stamp) changed.push(name)
  }
  for (const name of realAppConfigSnapshot.keys()) {
    if (!current.has(name)) changed.push(name)
  }
  assert(
    changed.length === 0,
    `${label}: the developer's real ${realAppConfigDir} is untouched` +
      (changed.length ? ` (changed: ${changed.join(', ')})` : '')
  )
}

// Positive proof, through the REST API, that the instance answering on `port`
// really opened the temp profile directory it was pointed at: the engine's
// device key is generated into `<profile>/local-device-key.json`, so a matching
// key can only mean the profile the app is running on is this one.
async function assertProfileIsolated(port, name, profileDir) {
  assert(
    profileDir.startsWith(root + path.sep),
    `${name} profile directory is inside the e2e temp root (${profileDir})`
  )
  const identity = await api(port, 'GET', '/identity')
  const keyFile = path.join(profileDir, 'local-device-key.json')
  const stored = JSON.parse(fs.readFileSync(keyFile, 'utf8'))
  assert(
    identity.deviceKey === stored.publicKey,
    `${name} is running on ${profileDir}, not on any other profile`
  )
  const popups = await api(port, 'GET', '/popups')
  assert(
    !popups.some((popup) => popup.type === 'profile-picker'),
    `${name} started straight into its profile without a profile picker`
  )
  assertRealUserDataUntouched(name)
}

async function stopAfter(label) {
  console.log(`\nE2E stopped after ${label}.`)
  console.log('host debug server:', `http://127.0.0.1:${HOST_PORT}`)
  console.log('client debug server:', `http://127.0.0.1:${CLIENT_PORT}`)
  console.log('client2 debug server:', `http://127.0.0.1:${CLIENT2_PORT}`)

  if (REVIEW || KEEP) {
    await holdForReview(`E2E stopped after ${label}`)
    return
  }

  await cleanup()
}

async function openProfilesOnly(windowSlots) {
  step('launch client3')
  CLIENT3_PORT = CLIENT3_PORT || (await freePort())
  startApp('client3', storage, CLIENT3_PORT, launchOpts('client3'))
  if (RESET_PROFILES) await createProfileFromStartupPopup(CLIENT3_PORT, 'client3')
  await waitForHealth(CLIENT3_PORT, 'client3')
  await waitForRendererReady(CLIENT3_PORT, 'client3')
  await dismissStartupIdentityWizard(CLIENT3_PORT, 'client3')
  if (PLACE_WINDOWS) await setWindowSlot(CLIENT3_PORT, 'client3', windowSlots.client3)
  else if (VERIFY_WINDOW_RESTORE) {
    await verifyWindowSlot(CLIENT3_PORT, 'client3', windowSlots.client3)
  }

  console.log('\nOpen profiles only mode is ready.')
  console.log('host debug server:', `http://127.0.0.1:${HOST_PORT}`)
  console.log('client debug server:', `http://127.0.0.1:${CLIENT_PORT}`)
  console.log('client2 debug server:', `http://127.0.0.1:${CLIENT2_PORT}`)
  console.log('client3 debug server:', `http://127.0.0.1:${CLIENT3_PORT}`)
  if (REVIEW || KEEP) {
    await holdForReview('open profiles only mode')
    return
  }
  await cleanup()
}

async function runWindowBoundsSmokeTest() {
  HOST_PORT = HOST_PORT || (await freePort())
  step('launch window bounds smoke app')
  startApp('bounds-smoke', storage, HOST_PORT, {})
  await waitForDebugServer(HOST_PORT, 'bounds-smoke', { allowPopupTypes: ['profile-picker'] })

  const initial = await getWindowBoundsForSmoke()
  assert(initial.bounds, 'window bounds debug command returned initial bounds')
  assert(initial.display && initial.display.workArea, 'window bounds include display work area')

  const slots = quarterSlots(initial.display.workArea)
  const names = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
  for (let i = 0; i < slots.length; i++) {
    const label = names[i]
    const expected = normalizeExpectedDebugBounds(slots[i])
    step(`move smoke window to ${label}`)
    await setWindowBoundsForSmoke(slots[i], expected, label)
    const moved = await waitFor(async () => {
      const current = await getWindowBoundsForSmoke()
      return boundsClose(current.bounds, expected) ? current : null
    }, `smoke window moved to ${label}`)
    assert(boundsClose(moved.bounds, expected), `smoke window moved to ${label}`)
    await sleep(2000)
  }

  console.log('\nWindow bounds smoke test passed.')
  console.log('bounds smoke debug server:', `http://127.0.0.1:${HOST_PORT}`)

  if (REVIEW || KEEP) {
    await holdForReview('window bounds smoke test passed')
    return
  }
  await cleanup()
}

// Phase 2 step 4 (docs/PHASE2-WORK-PLAN.md): SIGKILLs the host's engine
// worker mid-session and asserts the supervision policy in
// electron/engine-lifecycle.js actually does what docs/DESIGN-SWARM-AND-
// WORKER.md's "Worker crash / restart semantics" describes - not just that
// it's written that way. Placed last in the host's lifecycle: the final
// assertion (backoff limit trips) deliberately tears the host's engine
// down for good, so nothing in this scenario can run afterward.
async function runWorkerCrashScenario() {
  step('crash test: create a fresh session with continuous output')
  const crashSession = await api(HOST_PORT, 'POST', '/sessions', { name: 'crash-test-session' })
  await api(HOST_PORT, 'POST', `/sessions/${crashSession.sessionId}/switch`)
  await api(HOST_PORT, 'POST', '/sessions/current/input', { text: TOP_COMMAND, enter: true })

  const preKillStats = await waitFor(async () => {
    const stats = await api(HOST_PORT, 'GET', `/sessions/${crashSession.sessionId}/stats`)
    return frameText(stats).toLowerCase().includes('top') ? stats : null
  }, 'crash-test session producing live output before kill')
  assert(preKillStats.history.length > 0, 'crash-test session has history before worker crash')

  const before = await api(HOST_PORT, 'GET', '/debug/worker-pid')
  assert(Number.isInteger(before.pid), 'host exposes a worker pid before crash')
  const firstWorkerPid = before.pid

  step('crash test: SIGKILL the worker mid-session')
  process.kill(firstWorkerPid, 'SIGKILL')

  step('crash test: renderer is told the engine is restarting')
  await waitFor(async () => {
    const events = await api(HOST_PORT, 'GET', '/events')
    return events.some((e) => e.name === 'engine:restarting') ? true : null
  }, 'host emitted engine:restarting after worker crash')

  step('crash test: still-connected viewer sees a clean failure, not a silent hang')
  await waitFor(async () => {
    const events = await api(CLIENT_PORT, 'GET', '/events')
    return events.some(
      (e) =>
        e.name === 'share:debug' &&
        e.data &&
        typeof e.data.event === 'string' &&
        /viewer:socket:(close|error)/.test(e.data.event)
    )
      ? true
      : null
  }, 'still-connected viewer observed a clean socket close/error, not a hang')

  step('crash test: worker respawns with a fresh pid, session reattached')
  const respawnedPid = await waitFor(async () => {
    const health = await api(HOST_PORT, 'GET', '/health')
    if (!health.engineReady) return null
    const { pid } = await api(HOST_PORT, 'GET', '/debug/worker-pid')
    return Number.isInteger(pid) && pid !== firstWorkerPid ? pid : null
  }, 'host worker respawned with a different pid')
  assert(respawnedPid !== firstWorkerPid, 'respawned worker has a fresh pid')

  step('crash test: buffered PTY output is replayed as ordinary output post-recovery')
  await waitFor(async () => {
    const stats = await api(HOST_PORT, 'GET', `/sessions/${crashSession.sessionId}/stats`)
    return stats.history.length > preKillStats.history.length ? stats : null
  }, 'crash-test session kept appending output through the crash and after respawn')

  await api(HOST_PORT, 'POST', `/sessions/${crashSession.sessionId}/input`, { data: 'q' }).catch(
    () => {}
  )

  step('crash test: repeated crashes trip the backoff limit (4th kill within 60s)')
  for (let i = 0; i < 3; i++) {
    const { pid } = await api(HOST_PORT, 'GET', '/debug/worker-pid')
    if (!Number.isInteger(pid)) break
    process.kill(pid, 'SIGKILL')
    await waitFor(
      async () => {
        const health = await api(HOST_PORT, 'GET', '/health')
        const current = await api(HOST_PORT, 'GET', '/debug/worker-pid')
        return !health.engineReady || current.pid !== pid ? true : null
      },
      `worker exit ${i + 1} of the backoff sequence observed`
    )
  }

  step('crash test: backoff limit tripped - fatal engine:error, no crash loop')
  await waitFor(async () => {
    const events = await api(HOST_PORT, 'GET', '/events')
    return events.some((e) => e.name === 'engine:error') ? true : null
  }, 'host emitted a fatal engine:error after repeated crashes')
  const finalHealth = await waitFor(async () => {
    const health = await api(HOST_PORT, 'GET', '/health')
    return health.engineReady === false ? health : null
  }, 'host settled into a non-ready state after giving up (profile-required, not crash-looping)')
  assert(!finalHealth.engineReady, 'host did not keep crash-looping past the backoff limit')

  await sleep(1500)
  const afterGraceStats = await api(HOST_PORT, 'GET', '/debug/worker-pid').catch(() => null)
  assert(
    !afterGraceStats || !Number.isInteger(afterGraceStats.pid),
    'no further respawn happened after the backoff limit tripped'
  )
}

// ---------------------------------------------------------------------------
// Identity end-to-end scenario (docs/identity-providers_plan.md, Phase 7)
//
// Three real app instances, each with its own profile, its own HOME (so one
// instance's fixture ~/.ssh can never show up in another's candidate list) and
// a stubbed `https://github.com/<user>.keys` endpoint:
//
//   identity-host     proves `zbterm-e2e@github` with a generated ed25519 key
//   identity-viewer   has no identity at all, joins both hosts
//   identity-badhost  claims `zbterm-e2e-bad@github` with a key that username
//                     does not publish, so the viewer must refuse the join
//
// Everything is asserted through the REST debug API (`/identity`, `/events`,
// `/renderer/command`), never by reading logs, and the host's identity is
// installed through the popup API - that is what proves the Phase 4 wizard
// works headlessly.
// ---------------------------------------------------------------------------
async function runIdentityScenario() {
  step('identity: generate ssh fixtures and stub the github keys endpoint')
  const fixture = createIdentityFixture()
  const keysPort = await startIdentityKeysServer({
    [IDENTITY_USER]: fixture.hostKey.publicKeyLine,
    // The bad host signs with its own key; this username publishes a key
    // nobody in this run holds, so the claim cannot verify.
    [IDENTITY_BAD_USER]: fixture.unrelatedKey.publicKeyLine
  })
  assert(keysPort > 0, 'github keys fixture server is listening on loopback')

  const ports = {
    host: await freePort(),
    viewer: await freePort(),
    badhost: await freePort()
  }

  step('identity: launch host, viewer and bad host')
  const apps = []
  try {
    for (const name of IDENTITY_APPS) {
      apps.push(
        startApp(name, fixture.storages[name], ports[identityRole(name)], {
          profilePath: fixture.profiles[name],
          env: {
            HOME: fixture.homes[name],
            ZBTERM_GITHUB_KEYS_BASE: `http://127.0.0.1:${keysPort}`,
            // Hide the developer's own ssh-agent: candidate discovery must see
            // exactly the fixture key and nothing else.
            SSH_AUTH_SOCK: null
          }
        })
      )
    }
    step('identity: verify every instance runs entirely on temp directories')
    for (const name of IDENTITY_APPS) {
      await waitForHealth(ports[identityRole(name)], name)
      await waitForRendererReady(ports[identityRole(name)], name)
      await assertProfileIsolated(ports[identityRole(name)], name, fixture.profiles[name])
    }

    await runIdentityChecks(ports, fixture)
    assertRealUserDataUntouched('identity scenario')
  } finally {
    if (!REVIEW && !KEEP) {
      step('identity: stop identity apps')
      for (const app of apps) app.kill()
      await sleep(2000)
      await stopIdentityKeysServer()
    }
  }
}

async function runIdentityChecks(ports, fixture) {
  step('identity: host completes the wizard headlessly through the popup API')
  const hostIdentity = await configureIdentityViaPopup(ports.host, 'identity-host', {
    username: IDENTITY_USER,
    fingerprint: fixture.hostKey.fingerprint,
    onProvider: true
  })
  assert(
    hostIdentity.displayId === `${IDENTITY_USER}@github`,
    `host identity is ${IDENTITY_USER}@github`
  )
  const hostIdentityRecord = await api(ports.host, 'GET', '/identity')
  assert(
    hostIdentityRecord.provider === 'github' &&
      hostIdentityRecord.displayId === `${IDENTITY_USER}@github`,
    'GET /identity reports the proved github identity'
  )

  step('identity: viewer stays unverified')
  await dismissIdentityWizard(ports.viewer, 'identity-viewer')
  const viewerIdentity = await api(ports.viewer, 'GET', '/identity')
  assert(
    viewerIdentity.provider === 'unknown' && /@UNKNOWN$/.test(viewerIdentity.displayId),
    `viewer identity is ${viewerIdentity.displayId}`
  )

  step('identity: host shares a session and the viewer joins it')
  const session = await api(ports.host, 'POST', '/sessions', {
    name: `${RUN_TAG} identity host`,
    cols: 80,
    rows: 24
  })
  assert(session.sessionId, 'identity host session was created')
  const share = await api(ports.host, 'POST', `/sessions/${session.sessionId}/share`, {
    type: 'group',
    maxViewers: 4,
    autoJoin: true
  })
  assert(share.uri && share.uri.startsWith('zbterm://join/'), 'identity host share uri was created')
  await api(ports.viewer, 'POST', '/join', { uri: share.uri })
  const joined = await waitForJoined(ports.viewer, session.sessionId, 'identity viewer joined')
  assert(joined.active, 'identity viewer joined session is active')

  step('identity: viewer verified the host, host recorded the viewer as unknown')
  const verifiedEvent = await waitForPeerIdentityEvent(
    ports.viewer,
    (data) => data.direction === 'host' && data.status === 'verified',
    'viewer verified the host identity'
  )
  assert(
    verifiedEvent.displayId === `${IDENTITY_USER}@github`,
    `share:peer-identity reported ${verifiedEvent.displayId} verified`
  )
  const viewerBadges = await waitForIdentityBadge(
    ports.viewer,
    (badge) => badge.status === 'verified' && badge.displayId === `${IDENTITY_USER}@github`,
    'viewer renders a verified host badge'
  )
  assert(
    viewerBadges.some((badge) => badge.direction === 'host' && badge.sessionId),
    'the verified host badge is attached to the joined session row'
  )

  const unknownEvent = await waitForPeerIdentityEvent(
    ports.host,
    (data) => data.direction === 'viewer' && data.status === 'unknown',
    'host recorded the viewer as unknown'
  )
  assert(
    /@UNKNOWN$/.test(unknownEvent.displayId),
    `host sees the viewer as ${unknownEvent.displayId}`
  )
  await waitForIdentityBadge(
    ports.host,
    (badge) => badge.status === 'unknown' && /@UNKNOWN$/.test(badge.displayId),
    'host renders an @UNKNOWN viewer badge'
  )

  step('identity: viewer attaches a local name to the verified host')
  const annotated = await rendererCommand(ports.viewer, {
    command: 'identity-annotate',
    identityKey: verifiedEvent.identityKey,
    name: 'Fixture host',
    comment: 'generated by the identity e2e'
  })
  const named = annotated.find((badge) => badge.identityKey === verifiedEvent.identityKey)
  assert(
    named && named.localName === 'Fixture host',
    'annotated peer keeps its local name in the badge state'
  )
  assert(
    named && named.text === `${IDENTITY_USER}@github (Fixture host)`,
    `annotated badge renders as ${named && named.text}`
  )

  step('identity: bad host claims a username whose published key it does not hold')
  const badIdentity = await configureIdentityViaPopup(ports.badhost, 'identity-badhost', {
    username: IDENTITY_BAD_USER,
    fingerprint: fixture.badKey.fingerprint,
    // The stub publishes a different key for this username, so the wizard must
    // report the selected key as not published by the provider - and still let
    // the user claim it. Catching that is the *verifier's* job.
    onProvider: false
  })
  assert(
    badIdentity.displayId === `${IDENTITY_BAD_USER}@github`,
    `bad host identity is ${IDENTITY_BAD_USER}@github`
  )

  const badSession = await api(ports.badhost, 'POST', '/sessions', {
    name: `${RUN_TAG} identity bad host`,
    cols: 80,
    rows: 24
  })
  const badShare = await api(ports.badhost, 'POST', `/sessions/${badSession.sessionId}/share`, {
    type: 'group',
    maxViewers: 4,
    autoJoin: true
  })
  assert(badShare.uri && badShare.uri.startsWith('zbterm://join/'), 'bad host share uri exists')

  // The Join dialog runs exactly this before it connects, so the bad host's
  // link has to be refusable from the link alone - the viewer should never have
  // to dial a host it can already tell is unverifiable.
  step('identity: the viewer can refuse the bad invite before connecting')
  const badInspection = await api(ports.viewer, 'POST', '/invoke', {
    method: 'identity.inspectInvite',
    args: { uri: badShare.uri }
  })
  assert(
    badInspection.status === 'failed',
    `inspecting the bad invite reports failed (got ${badInspection.status})`
  )
  assert(
    badInspection.subject === IDENTITY_BAD_USER && badInspection.provider === 'github',
    'the inspection names the claimed identity so the dialog can say what failed'
  )
  assert(
    /is not published by/.test(String(badInspection.reason || '')),
    `the inspection explains why: ${badInspection.reason}`
  )
  const goodInspection = await api(ports.viewer, 'POST', '/invoke', {
    method: 'identity.inspectInvite',
    args: { uri: share.uri }
  })
  assert(
    goodInspection.status === 'verified' && goodInspection.displayId === `${IDENTITY_USER}@github`,
    `inspecting the good invite reports ${goodInspection.displayId} verified`
  )
  const unclaimedInspection = await api(ports.viewer, 'POST', '/invoke', {
    method: 'identity.inspectInvite',
    args: { claim: null }
  })
  assert(
    unclaimedInspection.status === 'unknown' && unclaimedInspection.claimed === false,
    'an invite with no claim is unknown-and-unclaimed, which the dialog shows as unauthorized'
  )

  step('identity: viewer refuses the join it cannot verify')
  const refusalStartedAt = Date.now()
  await api(ports.viewer, 'POST', '/join', { uri: badShare.uri })
  const failedEvent = await waitForPeerIdentityEvent(
    ports.viewer,
    (data) => data.direction === 'host' && data.status === 'failed',
    'viewer reported the host identity as failed'
  )
  const refusalMs = Date.now() - refusalStartedAt
  assert(
    refusalMs < IDENTITY_REFUSAL_BUDGET_MS,
    `identity refusal settled in ${refusalMs}ms (budget ${IDENTITY_REFUSAL_BUDGET_MS}ms)`
  )
  assert(
    /is not published by/.test(String(failedEvent.reason || '')),
    `refusal reason names the unpublished key: ${failedEvent.reason}`
  )
  assert(
    /@UNKNOWN$/.test(failedEvent.displayId),
    'a refused peer never renders as its claimed provider id'
  )
  const joinFailure = await waitFor(async () => {
    const events = await api(ports.viewer, 'GET', '/events')
    return (
      events.find(
        (event) =>
          event.name === 'share:join-changed' && event.data && event.data.status === 'failed'
      ) || null
    )
  }, 'viewer join settled as failed')
  assert(
    /identity verification failed/i.test(String(joinFailure.data.message || '')),
    `join failed with: ${joinFailure.data.message}`
  )

  await sleep(1500)
  const viewerSessions = await api(ports.viewer, 'GET', '/sessions')
  assert(
    !viewerSessions.some((item) => item.sessionId === badSession.sessionId),
    'no session row appeared on the viewer for the refused join'
  )
  assert(
    viewerSessions.some((item) => item.sessionId === session.sessionId),
    'the previously verified session survived the refused join'
  )

  step('identity: both apps stay healthy after the refusal')
  for (const role of ['viewer', 'badhost']) {
    await assertHealthyAfterRefusal(ports[role], `identity-${role}`)
  }
}

// A refused join must leave the app usable, not wedged. Retried briefly because
// `/health` also reflects a renderer that happens to be mid-render, and reports
// the renderer's own reason when it never recovers.
async function assertHealthyAfterRefusal(port, name) {
  let health = null
  for (let attempt = 0; attempt < 15; attempt++) {
    health = await api(port, 'GET', '/health')
    if (health.ok) break
    await sleep(1000)
  }
  const renderer = (health && health.renderer) || {}
  assert(
    health && health.ok,
    `${name} is still healthy after the refused join` +
      (health && health.ok
        ? ''
        : `: ${JSON.stringify({
            engineReady: health && health.engineReady,
            reason: renderer.reason || null,
            phase: renderer.phase || null,
            startupError: (renderer.app && renderer.app.startupError) || null,
            startupPhase: (renderer.app && renderer.app.startupPhase) || null,
            terminalReady: (renderer.app && renderer.app.terminalReady) || null,
            title: (renderer.app && renderer.app.title) || null,
            selectedId: (renderer.app && renderer.app.selectedId) || null
          })}`)
  )
}

const IDENTITY_APPS = ['identity-host', 'identity-viewer', 'identity-badhost']

function identityRole(name) {
  return name.slice('identity-'.length)
}

// Fresh every run: a stale profile would already be configured, and then the
// wizard popup this scenario drives would never appear.
function createIdentityFixture() {
  const dir = path.join(root, 'identity')
  fs.rmSync(dir, { recursive: true, force: true })
  const homes = {}
  const profiles = {}
  const storages = {}
  for (const name of IDENTITY_APPS) {
    homes[name] = path.join(dir, `${name}-home`)
    profiles[name] = path.join(dir, `${name}-profile`)
    // One `--storage` root per instance, not the shared one the sharing
    // scenario uses. `pearDataRoot()` is what the shell hands to
    // `ensureProfileManager()`, i.e. what a profile picker would enumerate;
    // giving each identity instance a private one means the only profile any of
    // them could ever see is its own, so a picker cannot appear listing a
    // sibling instance's (or anybody else's) locked profile.
    storages[name] = path.join(dir, `${name}-storage`)
    fs.mkdirSync(path.join(homes[name], '.ssh'), { recursive: true, mode: 0o700 })
    // --profile-path is an *explicit* data directory; the engine creates it if
    // it is missing, but creating it here keeps the fixture's contract obvious
    // and matches how the fake HOMEs are set up.
    fs.mkdirSync(profiles[name], { recursive: true, mode: 0o700 })
    fs.mkdirSync(storages[name], { recursive: true })
  }
  const hostKey = generateEd25519Key(
    path.join(homes['identity-host'], '.ssh', 'id_ed25519'),
    `${IDENTITY_USER}@zbterm-e2e`
  )
  const badKey = generateEd25519Key(
    path.join(homes['identity-badhost'], '.ssh', 'id_ed25519'),
    `${IDENTITY_BAD_USER}@zbterm-e2e`
  )
  const unrelatedKey = generateEd25519Key(
    path.join(dir, 'unrelated', 'id_ed25519'),
    'unrelated@zbterm-e2e'
  )
  return { dir, homes, profiles, storages, hostKey, badKey, unrelatedKey }
}

// Generated at test time and never committed - see test/fixtures/identity/README.md.
function generateEd25519Key(keyPath, comment) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  const generated = spawnSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', keyPath],
    { encoding: 'utf8' }
  )
  if (generated.status !== 0) {
    throw new Error(`ssh-keygen failed: ${generated.stderr || generated.stdout}`)
  }
  const listed = spawnSync('ssh-keygen', ['-lf', `${keyPath}.pub`], { encoding: 'utf8' })
  if (listed.status !== 0) {
    throw new Error(`ssh-keygen -lf failed: ${listed.stderr || listed.stdout}`)
  }
  return {
    path: keyPath,
    publicKeyLine: fs.readFileSync(`${keyPath}.pub`, 'utf8').trim(),
    fingerprint: listed.stdout.trim().split(/\s+/)[1]
  }
}

// The `https://github.com/<user>.keys` stand-in. Both app instances point at it
// through ZBTERM_GITHUB_KEYS_BASE, so nothing in this scenario touches the
// network.
async function startIdentityKeysServer(users) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    const match = /^\/([^/]+)\.keys$/.exec(pathname)
    const user = match ? decodeURIComponent(match[1]) : null
    const line = user && Object.prototype.hasOwnProperty.call(users, user) ? users[user] : null
    if (!line) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(`${line}\n`)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  server.unref()
  identityKeysServer = server
  return server.address().port
}

function stopIdentityKeysServer() {
  const server = identityKeysServer
  if (!server) return Promise.resolve()
  identityKeysServer = null
  return new Promise((resolve) => server.close(() => resolve()))
}

// Drives the whole wizard over `POST /popups/identity-setup/actions/...`, which
// is the headless twin of the renderer modal. The modal is waited for first so
// the popup's resolution is what closes it - otherwise the renderer, which
// opens its copy un-awaited after startup, could raise it again afterwards with
// no popup left to dismiss it.
async function configureIdentityViaPopup(port, name, opts) {
  await waitForIdentityModal(port, name)
  const popup = await waitForIdentityPopup(port, name)
  assert(
    opts.username &&
      popup.actions.includes('fill-username') &&
      popup.actions.includes('select-key') &&
      popup.actions.includes('submit'),
    `${name} identity popup exposes the wizard actions`
  )

  const filled = await popupAction(port, popup.id, 'fill-username', { name: opts.username })
  assert(filled.username === opts.username.toLowerCase(), `${name} wizard accepted the username`)
  const candidate = (filled.candidates || []).find(
    (item) => item.fingerprint === opts.fingerprint && item.signable
  )
  assert(candidate, `${name} wizard discovered its own signable ed25519 key (${opts.fingerprint})`)
  assert(
    candidate.onProvider === opts.onProvider,
    `${name} key is ${opts.onProvider ? '' : 'not '}published by ${opts.username}`
  )

  await popupAction(port, popup.id, 'select-key', { fingerprint: candidate.fingerprint })
  const submitted = await popupAction(port, popup.id, 'submit', {})
  assert(submitted.identity, `${name} minted and stored an identity claim`)
  await waitForNoModal(port, `${name} identity wizard closed after submit`)
  return submitted.identity
}

async function dismissIdentityWizard(port, name) {
  await waitForIdentityModal(port, name)
  const popup = await waitForIdentityPopup(port, name)
  await popupAction(port, popup.id, 'dismiss', {})
  // The shell popup is gone now, so if the renderer's own copy is still up
  // there is nothing left to dismiss it with: choosing unknown and submitting
  // closes it from the renderer side (and re-clears the popup via
  // identity:changed). Choosing alone only moves the highlight - the wizard
  // commits nothing until submit.
  await waitFor(async () => {
    const layout = await api(port, 'GET', '/renderer/layout')
    const modal = layout && layout.renderer && layout.renderer.modal
    if (!modal || modal.title !== 'Choose your identity') return true
    await chooseUnverifiedIdentity(port)
    return null
  }, `${name} identity wizard dismissed`)
}

// Every profile in this e2e starts without an identity, so the Phase 4 wizard
// opens on all of them. Scenarios that drive a share/join modal must close it
// first: `debugModalState()` returns the FIRST `.modal-overlay`, which would
// otherwise be the wizard's. Waiting for the modal before touching the popup is
// deliberate - the renderer opens its copy un-awaited after startup, so
// dismissing the shell popup too early leaves a modal nothing can close.
async function dismissStartupIdentityWizard(port, name) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const layout = await api(port, 'GET', '/renderer/layout')
    const modal = layout && layout.renderer && layout.renderer.modal
    if (modal && modal.title === 'Choose your identity') {
      await chooseUnverifiedIdentity(port)
      await waitForNoModal(port, `${name} identity wizard closed`)
      return true
    }
    if (modal) break
    const popups = await api(port, 'GET', '/popups')
    if (!popups.some((popup) => popup.type === 'identity-setup')) break
    await sleep(500)
  }
  const popups = await api(port, 'GET', '/popups')
  const popup = popups.find((item) => item.type === 'identity-setup')
  if (popup) await popupAction(port, popup.id, 'dismiss', {})
  return false
}

// "Stay unverified" is a selection, not an action: the wizard only clears the
// stored claim when its submit button (relabelled "Stay Unidentified") fires.
async function chooseUnverifiedIdentity(port) {
  await rendererCommand(port, { command: 'identity-choose', provider: 'unknown' })
  return await rendererCommand(port, { command: 'identity-submit' })
}

function waitForIdentityPopup(port, name) {
  return waitFor(async () => {
    const popups = await api(port, 'GET', '/popups')
    return popups.find((popup) => popup.type === 'identity-setup') || null
  }, `${name} identity setup popup`)
}

function waitForIdentityModal(port, name) {
  return waitForModal(
    port,
    (state) => state && state.title === 'Choose your identity',
    `${name} identity wizard modal`
  )
}

function popupAction(port, popupId, action, body) {
  return api(port, 'POST', `/popups/${encodeURIComponent(popupId)}/actions/${action}`, body)
}

async function waitForPeerIdentityEvent(port, predicate, label) {
  const event = await waitFor(async () => {
    const events = await api(port, 'GET', '/events')
    return (
      events.find(
        (item) => item.name === 'share:peer-identity' && item.data && predicate(item.data)
      ) || null
    )
  }, label)
  assert(true, label)
  return event.data
}

async function waitForIdentityBadge(port, predicate, label) {
  const badges = await waitFor(async () => {
    const state = await rendererCommand(port, { command: 'identity-peers' })
    return Array.isArray(state) && state.some(predicate) ? state : null
  }, label)
  assert(true, label)
  return badges
}

function startApp(name, storage, port, opts = {}) {
  const forceX11 = opts.forceX11 !== false && process.platform === 'linux'
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const appArgs = [
    '--storage',
    storage,
    '--electron-user-data',
    path.join(root, `${name}-electron`),
    '--debug-server',
    '--debug-server-port',
    String(port)
  ]
  if (opts.profile) appArgs.push('--profile', opts.profile)
  if (opts.profilePath) appArgs.push('--profile-path', opts.profilePath)
  const args = ['start', '--', ...appArgs]
  const env = { ...process.env }
  // See the appConfigRoot comment at the top of this file: this is what keeps
  // electron/main.js' `stableUserData` (debug log, window state, preferences)
  // inside the e2e root instead of the developer's real ~/.config/ZBTerm.
  // Applied to every instance, including the ones that also override HOME, so
  // there is exactly one rule to reason about.
  env.XDG_CONFIG_HOME = appConfigRoot
  if (forceX11) {
    env.XDG_SESSION_TYPE = 'x11'
    env.GDK_BACKEND = 'x11'
    env.ELECTRON_OZONE_PLATFORM_HINT = 'x11'
    delete env.WAYLAND_DISPLAY
  }
  // Per-instance environment (HOME, ZBTERM_GITHUB_KEYS_BASE, ...). A null value
  // removes the variable rather than setting it to the string "null".
  for (const [key, value] of Object.entries(opts.env || {})) {
    if (value === null) delete env[key]
    else env[key] = String(value)
  }
  const child = spawn(command, args, {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    env
  })
  children.push(child)
  child.stdout.on('data', (data) => process.stdout.write(prefix(name, data)))
  child.stderr.on('data', (data) => process.stderr.write(prefix(name, data)))
  child.once('exit', (code, signal) => {
    if (!child._zbtermClosing && !child.killed) {
      console.error(`${name} exited early:`, { code, signal })
    }
  })
  return {
    kill() {
      killChild(child)
    }
  }
}

function launchOpts(name) {
  if (RESET_PROFILES) return {}
  return { profile: profileNameForApp(name) }
}

function profileNameForApp(name) {
  return name === 'host' ? 'default' : `${name} profile`
}

async function createSession(port, label, opts) {
  const created = await api(port, 'POST', '/sessions', opts)
  assert(created.sessionId, `${label} session was created`)
  const sessions = await api(port, 'GET', '/sessions')
  const matches = sessions
    .filter((session) => session.name === opts.name)
    .sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)))
  const selected =
    sessions.find((session) => session.sessionId === created.sessionId) ||
    matches[matches.length - 1] ||
    created
  assert(selected.sessionId === created.sessionId, `${label} is using the newly created session`)
  return created
}

async function computeWindowSlots(port) {
  const info = await api(port, 'GET', '/window/bounds')
  const area = (info.display && info.display.workArea) || { x: 0, y: 0, width: 1280, height: 840 }
  const [host, client, client2, client3] = quarterSlots(area)
  return { host, client, client2, client3 }
}

function quarterSlots(area) {
  const halfWidth = Math.floor(area.width / 2)
  const halfHeight = Math.floor(area.height / 2)
  return [
    { x: area.x, y: area.y, width: halfWidth, height: halfHeight },
    { x: area.x + halfWidth, y: area.y, width: area.width - halfWidth, height: halfHeight },
    {
      x: area.x,
      y: area.y + halfHeight,
      width: halfWidth,
      height: area.height - halfHeight
    },
    {
      x: area.x + halfWidth,
      y: area.y + halfHeight,
      width: area.width - halfWidth,
      height: area.height - halfHeight
    }
  ]
}

async function setWindowSlot(port, name, bounds) {
  const result = await api(port, 'POST', '/window/bounds', { ...bounds, animate: false })
  assert(
    boundsSimilar(result.bounds, bounds),
    `${name} window moved to its allocated screen quarter`
  )
  return result
}

async function getWindowBoundsForSmoke() {
  return await api(HOST_PORT, 'GET', '/window/bounds', undefined, {
    allowPopupTypes: ['profile-picker']
  })
}

async function setWindowBoundsForSmoke(bounds, expected, label) {
  const result = await api(
    HOST_PORT,
    'POST',
    '/window/bounds',
    { ...bounds, animate: false },
    { allowPopupTypes: ['profile-picker'] }
  )
  assert(
    boundsClose(result.bounds, expected),
    `debug command accepted ${label} window bounds: expected ${JSON.stringify(expected)}, got ${JSON.stringify(result.bounds)}`
  )
  return result
}

async function verifyWindowSlot(port, name, bounds) {
  step(`verify ${name} restored window slot`)
  let reportedMismatch = false
  const result = await waitFor(async () => {
    const current = await api(port, 'GET', '/window/bounds')
    if (boundsSimilar(current.bounds, bounds)) return current
    if (!reportedMismatch) {
      reportedMismatch = true
      console.warn(
        `${name} window restore pending: expected ${JSON.stringify(bounds)}, got ${JSON.stringify(current.bounds)}`
      )
    }
    throw new Error(`expected ${JSON.stringify(bounds)}, got ${JSON.stringify(current.bounds)}`)
  }, `${name} restored window quarter`)
  assert(
    boundsSimilar(result.bounds, bounds),
    `${name} window restored to its allocated screen quarter`
  )
  return result
}

function boundsSimilar(actual, expected) {
  if (!actual || !expected) return false
  const positionTolerance = process.platform === 'linux' ? 36 : 4
  return (
    Math.abs(actual.x - expected.x) <= positionTolerance &&
    Math.abs(actual.y - expected.y) <= positionTolerance &&
    actual.width >= Math.min(640, expected.width) &&
    actual.height >= Math.min(420, expected.height)
  )
}

function boundsClose(actual, expected) {
  if (!actual || !expected) return false
  const positionTolerance = process.platform === 'linux' ? 36 : 4
  return (
    Math.abs(actual.x - expected.x) <= positionTolerance &&
    Math.abs(actual.y - expected.y) <= positionTolerance &&
    Math.abs(actual.width - expected.width) <= 8 &&
    Math.abs(actual.height - expected.height) <= 8
  )
}

function normalizeExpectedDebugBounds(bounds) {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(640, Math.round(bounds.width)),
    height: Math.max(420, Math.round(bounds.height))
  }
}

async function persistWindowSlots(windowSlots, opts = {}) {
  step('persist window slots for profile restore')
  await setWindowSlot(HOST_PORT, 'host', windowSlots.host)
  await setWindowSlot(CLIENT_PORT, 'client', windowSlots.client)
  await setWindowSlot(CLIENT2_PORT, 'client2', windowSlots.client2)
  if (opts.includeClient3 && CLIENT3_PORT) {
    await setWindowSlot(CLIENT3_PORT, 'client3', windowSlots.client3)
  }
}

async function waitForHealth(port, name) {
  // An app that comes up but never reports healthy used to time out with no
  // clue why; `/health` already carries the renderer's own reason, so surface
  // it once instead of making the next person add a print statement.
  let reported = false
  return await waitFor(async () => {
    try {
      const health = await api(port, 'GET', '/health')
      if (health.ok) return health
      if (!reported) {
        reported = true
        const renderer = health.renderer || {}
        console.warn(
          `${name} not healthy yet:`,
          JSON.stringify({
            engineReady: health.engineReady,
            reason: renderer.reason || null,
            phase: renderer.phase || null,
            startupPhase: (renderer.app && renderer.app.startupPhase) || null,
            startupError: (renderer.app && renderer.app.startupError) || null,
            terminalReady: (renderer.app && renderer.app.terminalReady) || null
          })
        )
      }
      return null
    } catch {
      return null
    }
  }, `${name} debug server`)
}

async function waitForDebugServer(port, name, opts) {
  return await waitFor(async () => {
    try {
      return await api(port, 'GET', '/health', undefined, opts)
    } catch {
      return null
    }
  }, `${name} debug server`)
}

async function createProfileFromStartupPopup(port, name) {
  const popup = await waitForVisibleProfilePopup(port, name)
  assert(true, `${name} showed profile popup`)
  assert(
    popup.data.profiles.some((profile) => profile.id === 'default' && profile.locked),
    `${name} sees locked default profile`
  )
  const profileName = `${name} profile`
  await api(
    port,
    'POST',
    `/popups/${encodeURIComponent(popup.id)}/actions/fill-name`,
    { name: profileName },
    { allowPopupTypes: ['profile-picker'] }
  )
  await waitForFilledProfilePopup(port, name, profileName)
  assert(true, `${name} typed profile name`)
  await sleep(2000)
  await api(
    port,
    'POST',
    `/popups/${encodeURIComponent(popup.id)}/actions/create-and-select`,
    { name: profileName },
    { allowPopupTypes: ['profile-picker'] }
  )
}

async function waitForFilledProfilePopup(port, name, profileName) {
  return await waitFor(async () => {
    const health = await waitForDebugServer(port, name, { allowPopupTypes: ['profile-picker'] })
    return health.popups.find(
      (popup) =>
        popup.type === 'profile-picker' &&
        popup.renderer &&
        popup.renderer.filledName === profileName &&
        popup.renderer.filledAt
    )
  }, `${name} filled profile name`)
}

async function waitForVisibleProfilePopup(port, name) {
  return await waitFor(async () => {
    const health = await waitForDebugServer(port, name, { allowPopupTypes: ['profile-picker'] })
    return health.popups.find(
      (popup) =>
        popup.type === 'profile-picker' &&
        popup.renderer &&
        popup.renderer.visible &&
        popup.renderer.visibleAt
    )
  }, `${name} visible profile popup`)
}

async function waitForApprovalPopup(port, sessionId, afterRequestId) {
  return await waitFor(async () => {
    const popups = await api(port, 'GET', '/popups', undefined, {
      allowPopupTypes: ['share-approval']
    })
    return popups.find(
      (popup) =>
        popup.type === 'share-approval' &&
        popup.data &&
        popup.data.sessionId === sessionId &&
        popup.data.requestId !== afterRequestId
    )
  }, 'manual approval request')
}

async function waitForJoined(port, sessionId, label) {
  return await waitFor(async () => {
    const sessions = await api(port, 'GET', '/sessions')
    return sessions.find((item) => item.sessionId === sessionId && item.owner === 'joined')
  }, label)
}

async function waitForRendererReady(port, label) {
  return await waitFor(async () => {
    const layout = await api(port, 'GET', '/renderer/layout')
    const renderer = layout && layout.renderer
    const app = renderer && renderer.app
    const ui = renderer && renderer.layout
    if (!app) return null
    if (app.startupError) throw new Error(`${label} renderer startup error: ${app.startupError}`)
    if (app.startupPhase && app.startupPhase !== 'ready') return null
    const xtermReady = !!(
      ui &&
      ui.xtermScreen &&
      ui.xtermScreen.width > 0 &&
      ui.xtermScreen.height > 0
    )
    if (!app.terminalReady || !xtermReady) return null
    if (app.newDisabled !== false || app.joinDisabled !== false) return null
    if (app.selectedId === null) {
      return app.title === 'No session selected' && app.playbackHidden === true ? layout : null
    }
    return layout
  }, `${label} renderer ready`)
}

async function waitForRendererJoined(port, sessionId, label) {
  return await waitFor(async () => {
    const layout = await api(port, 'GET', '/renderer/layout')
    const renderer = layout && layout.renderer
    const app = renderer && renderer.app
    if (!app || !app.terminalReady) return null
    const selected = app.sessions.find((session) => session.sessionId === sessionId)
    return app.selectedId === sessionId && selected && selected.owner === 'joined' ? layout : null
  }, label)
}

async function assertTerminalDisplayVisible(port, sessionId, label) {
  const result = await waitFor(async () => {
    const display = await api(port, 'GET', '/renderer/terminal-display')
    const terminal = display && display.terminal
    if (!terminal || terminal.selectedId !== sessionId || terminal.mode !== 'live') return null
    if (!terminal.rows || !terminal.cols) return null
    if (!Array.isArray(terminal.visibleRows) || terminal.visibleRows.length !== terminal.rows) {
      return null
    }
    return { terminal }
  }, `${label} terminal display info`)

  const hiddenRows = result.terminal.hiddenRows || []
  const missingRects = result.terminal.visibleRows
    .filter((row) => !row.rect)
    .map((row) => row.index)
  assert(
    missingRects.length === 0,
    `${label} terminal display reports geometry for every original row`
  )
  assert(
    hiddenRows.length === 0 && result.terminal.rowsVisible === true,
    `${label} terminal displays all ${result.terminal.rows} original rows` +
      (hiddenRows.length ? `; hidden rows: ${hiddenRows.join(',')}` : '')
  )
}

async function shareSessionViaUi(port, sessionId) {
  step('host UI: click Share')
  await rendererCommand(port, { command: 'share-open', autoJoin: false })
  let modal = await waitForModal(
    port,
    (state) => state && state.title === 'Share session',
    'host UI opened share dialog'
  )
  assert(modal && modal.title === 'Share session', 'host UI opened the share dialog')
  if (DEMO_MODE) await demoPause('choosing share options')

  modal = await rendererCommand(port, { command: 'share-select', type: 'group' })
  assert(
    modal.shareOptions.some((option) => option.selected && option.text.includes('Group')),
    'host UI selected group sharing'
  )
  if (DEMO_MODE) await demoPause('creating the share link')

  await rendererCommand(port, { command: 'share-submit' })
  modal = await waitForModal(
    port,
    (state) => state && state.title === 'Share key' && state.shareKey,
    'host UI share key dialog'
  )
  const uri = modal.shareKey
  assert(uri && uri.startsWith('zbterm://join/'), 'host UI displayed a share uri')

  if (DEMO_MODE) await demoPause('copying the share link')
  await rendererCommand(port, { command: 'share-copy' })
  modal = await waitForModal(
    port,
    (state) => state && state.actions.some((action) => action.text === 'Copied'),
    'host UI copied share link'
  )
  assert(
    modal.actions.some((action) => action.text === 'Copied'),
    'host UI copied share link'
  )

  if (DEMO_MODE) await demoPause('closing the share dialog')
  await rendererCommand(port, { command: 'share-done' })
  await waitForNoModal(port, 'host UI closed share dialog')

  const links = await api(port, 'GET', `/sessions/${sessionId}/shares`)
  assert(
    links.some((link) => link.uri === uri && link.autoJoin === false),
    'host UI created a manual-approval share link'
  )
  return { uri }
}

async function joinSessionViaUi(port) {
  step('client UI: click Join')
  await rendererCommand(port, { command: 'join-open' })
  let modal = await waitForModal(
    port,
    (state) => state && state.title === 'Join session',
    'client UI opened join dialog'
  )
  assert(modal && modal.title === 'Join session', 'client UI opened the join dialog')
  if (DEMO_MODE) await demoPause('pasting the share link')

  await rendererCommand(port, { command: 'join-paste' })
  modal = await waitForModal(
    port,
    (state) => state && String(state.inputValue || '').startsWith('zbterm://join/'),
    'client UI pasted share link'
  )
  assert(
    modal.inputValue && modal.inputValue.startsWith('zbterm://join/'),
    'client UI pasted copied share link'
  )

  if (DEMO_MODE) await demoPause('submitting the join dialog')
  await rendererCommand(port, { command: 'join-submit' })
  await waitForNoModal(port, 'client UI closed join dialog')
}

async function rendererCommand(port, command) {
  return await api(port, 'POST', '/renderer/command', command)
}

async function waitForModal(port, predicate, label) {
  return await waitFor(async () => {
    const layout = await api(port, 'GET', '/renderer/layout')
    const modal = layout && layout.renderer && layout.renderer.modal
    return predicate(modal) ? modal : null
  }, label)
}

async function waitForNoModal(port, label) {
  return await waitFor(async () => {
    const layout = await api(port, 'GET', '/renderer/layout')
    const modal = layout && layout.renderer && layout.renderer.modal
    return modal ? null : true
  }, label)
}

async function assertRemoteJoin(port, uri, sessionId, expectedName) {
  const health = await api(port, 'GET', '/health')
  assert(health.ok, 'remote debug server is reachable')
  await api(port, 'POST', '/join', { uri })
  const joined = await waitForJoined(port, sessionId, 'remote client joined session')
  assert(joined.active, 'remote client joined session is active')
  assert(joined.name === expectedName, 'remote client sees renamed shared session')
  const stats = await waitFor(async () => {
    const current = await api(port, 'GET', `/sessions/${sessionId}/stats`)
    const text = frameText(current).toLowerCase()
    const hasHistory = current.history.length > 0 || current.playback.length > 0
    return hasHistory && text.includes('top') ? current : null
  }, 'remote client replicated live top output')
  assert(stats.location.owner === 'joined', 'remote client stats identify joined session')
}

async function api(port, method, pathname, body, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  const popups = parsePopups(res.headers.get('x-zbterm-popups'))
  const unexpected = unexpectedPopups(popups, opts.allowPopupTypes || [])
  if (unexpected.length) {
    throw new Error(
      `${method} ${pathname} surfaced unexpected popup(s): ${unexpected
        .map((popup) => `${popup.type}:${popup.id}`)
        .join(', ')}`
    )
  }
  if (!res.ok) {
    const message = json && json.error ? json.error.message : text
    throw new Error(`${method} ${pathname} failed with ${res.status}: ${message}`)
  }
  return json
}

function parsePopups(value) {
  if (!value) return []
  try {
    const popups = JSON.parse(value)
    return Array.isArray(popups) ? popups : []
  } catch {
    return []
  }
}

// The Phase 4 identity wizard is registered at startup on any profile that has
// not chosen an identity yet, so it is pending during most of a run and is
// never a surprise. Scenarios that drive a share/join modal still have to close
// it first: `debugModalState()` returns the FIRST `.modal-overlay`, and the
// wizard would otherwise shadow them.
const ALWAYS_ALLOWED_POPUP_TYPES = ['identity-setup']

function unexpectedPopups(popups, allowedTypes) {
  if (!popups.length) return []
  return popups.filter(
    (popup) =>
      !allowedTypes.includes(popup.type) && !ALWAYS_ALLOWED_POPUP_TYPES.includes(popup.type)
  )
}

async function waitFor(fn, label) {
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < TIMEOUT_MS) {
    try {
      const result = await fn()
      if (result) return result
    } catch (err) {
      lastError = err
    }
    await sleep(500)
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
}

function frameText(stats) {
  return (
    (stats &&
      stats.terminal &&
      stats.terminal.frame &&
      typeof stats.terminal.frame.data === 'string' &&
      stats.terminal.frame.data) ||
    ''
  )
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
  console.log('ok:', message)
}

function step(message) {
  console.log(`\nstep: ${message}`)
}

async function demoPause(action) {
  step(`demo wait before ${action}`)
  await sleep(DEMO_APPROVAL_DELAY_MS)
}

async function slowTypeLine(port, sessionId, line) {
  for (const char of line) {
    await api(port, 'POST', `/sessions/${sessionId}/input`, { data: char })
    await sleep(DEMO_TYPING_DELAY_MS)
  }
  await api(port, 'POST', `/sessions/${sessionId}/input`, { data: '\r' })
}

function prefix(name, data) {
  return String(data)
    .split(/(?<=\n)/)
    .map((line) => (line ? `[${name}] ${line}` : line))
    .join('')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findExistingE2eProcesses() {
  if (process.platform === 'win32') return []
  const result = spawnSync('ps', ['-eo', 'pid=,pgid=,command='], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  })
  if (result.status !== 0 || !result.stdout) return []
  return result.stdout
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (!match) return null
      return {
        pid: Number(match[1]),
        pgid: Number(match[2]),
        command: match[3]
      }
    })
    .filter(
      (proc) =>
        proc &&
        proc.pid !== process.pid &&
        proc.command.includes(root) &&
        /(?:electron|electron-forge|bare|npm start)/.test(proc.command)
    )
}

async function killExistingE2eProcesses(processes) {
  const groups = [...new Set(processes.map((proc) => proc.pgid).filter(Number.isInteger))]
  for (const pgid of groups) {
    try {
      process.kill(-pgid, 'SIGTERM')
    } catch {}
  }
  await sleep(2000)
  const remaining = findExistingE2eProcesses()
  const remainingGroups = [...new Set(remaining.map((proc) => proc.pgid).filter(Number.isInteger))]
  for (const pgid of remainingGroups) {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {}
  }
  await sleep(1000)
  const stillRunning = findExistingE2eProcesses()
  if (stillRunning.length) {
    throw new Error(
      `Could not terminate existing e2e process(es): ${stillRunning
        .map((proc) => `${proc.pid}`)
        .join(', ')}`
    )
  }
}

function readArgValue(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

function hasArgPrefix(args, name) {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`))
}

async function holdForReview(reason) {
  console.log('\nReview mode:', reason)
  console.log('temp storage:', root)
  console.log('host debug server:', HOST_PORT ? `http://127.0.0.1:${HOST_PORT}` : 'not started')
  console.log(
    'client debug server:',
    CLIENT_PORT ? `http://127.0.0.1:${CLIENT_PORT}` : 'not started'
  )
  console.log(
    'client2 debug server:',
    CLIENT2_PORT ? `http://127.0.0.1:${CLIENT2_PORT}` : 'not started'
  )
  if (CLEANUP_ON_EXIT) {
    console.log('Review cleanup is enabled. Press Ctrl+C here to close apps and remove storage.')
  } else {
    console.log('Review mode will not close apps or remove temp storage automatically.')
  }

  console.log('Review mode is holding this process open until you press Ctrl+C.')
  if (children.length) {
    for (const child of children) {
      child.once('exit', (code, signal) => {
        console.log('review child exited:', { pid: child.pid, code, signal })
      })
    }
  }
  await waitForever()
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

async function cleanup(opts = {}) {
  if (cleaningUp) return
  cleaningUp = true
  if (KEEP && !opts.force) {
    console.log('keeping apps open and temp storage at:', root)
    cleaningUp = false
    return
  }
  await stopIdentityKeysServer()
  for (const child of children) killChild(child)
  await Promise.all(children.map((child) => waitForExit(child, 5000)))
  await sleep(4000)
  if (REMOVE_ROOT_ON_CLEANUP) await removeTempRoot()
  else console.log('preserving e2e storage at:', root)
  cleaningUp = false
}

function killChild(child) {
  if (!child || child.killed) return
  child._zbtermClosing = true
  try {
    if (process.platform === 'win32') child.kill()
    else process.kill(-child.pid, 'SIGTERM')
  } catch {}
  setTimeout(() => {
    try {
      if (process.platform === 'win32') child.kill()
      else process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }, 3000).unref()
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function waitForever() {
  return new Promise(() => {})
}

async function removeTempRoot() {
  let lastError = null
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      if (!fs.existsSync(root)) return
    } catch (err) {
      lastError = err
    }
    await sleep(750)
  }
  console.warn(
    'warning: temp storage cleanup did not fully complete:',
    root,
    lastError ? lastError.message : ''
  )
}
