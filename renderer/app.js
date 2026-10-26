;(() => {
  if (window.__zbtermRendererLoaded) {
    console.warn('ZBTerm renderer app.js was loaded more than once')
    return
  }
  window.__zbtermRendererLoaded = true

  const bridge = window.bridge
  const api = window.zbterm

  if (bridge && bridge.logToFile) {
    bridge.logToFile('=== ZBTerm renderer app.js loaded ===')
    const oldLog = console.log
    const oldError = console.error
    const serializeLogArg = (arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack || ''}`
      if (typeof arg === 'object') return JSON.stringify(arg)
      return String(arg)
    }
    console.log = (...args) => {
      oldLog(...args)
      bridge.logToFile('[INFO] ' + args.map(serializeLogArg).join(' '))
    }
    console.error = (...args) => {
      oldError(...args)
      bridge.logToFile('[ERROR] ' + args.map(serializeLogArg).join(' '))
    }
  }

  // Read from package metadata rather than hardcoded here so the about/boot
  // banners cannot drift from the real repository.
  function projectUrl() {
    const pkg = (bridge && bridge.pkg && bridge.pkg()) || {}
    return String(pkg.homepage || '').replace(/#readme$/, '') || pkg.name || ''
  }

  const SCRUBBER_STEPS = 1000
  const TOAST_MS = 6000
  // A join the share backend gave up on, in words (freenet-backend F9).
  const JOIN_ICE_FAILED_TOAST = 'Could not connect directly to the host (ICE failed)'
  const JOIN_IDENTITY_TOAST = "The host's identity did not match the invite"
  // What the viewer is told when a join fails, by the engine's `reason`
  // (engine/share-manager.js JOIN_REASONS). Refusals are the host's choice;
  // failures are nobody's.
  const JOIN_REFUSAL_TEXT = {
    denied: 'the host denied the join request',
    revoked: 'the invite is no longer valid (revoked, or the share ended)',
    consumed: 'the invite was already used; a single-use link joins once',
    full: 'the share is full; the host allows no more viewers',
    ended: 'the host is no longer sharing this session',
    'device-revoked': 'the host has revoked this device',
    'bad-identity-proof': 'the host rejected this device identity proof'
  }
  const JOIN_FAILURE_TEXT = {
    unreachable: 'no host answered; it may be offline, or the invite is no longer valid',
    'no-answer': 'the host did not answer the join request',
    closed: 'the connection closed before the join completed',
    'host-mismatch': "the host's key did not match the invite"
  }
  // A command that exits non-zero this soon after its start did not run: it
  // is missing, not executable, or failed at once. Shown as such, not retried.
  const FAILED_START_MS = 10 * 1000
  const SIGNAL_INITIAL_DT_MS = 1000 / 16
  const SIGNAL_MAX_SAMPLES = 512
  const SIGNAL_COMPACT_SAMPLES = 256
  const SEEK_IDLE_MS = 200
  const SEEK_MAX_RENDER_MS = 500
  const SEEK_MOVEMENT_THRESHOLD = 10
  const LIVE_WRITE_MAX_BATCH_BYTES = 512 * 1024
  const THEME_STORAGE_KEY = 'zbterm.theme'
  const DEVB_STORAGE_KEY = 'zbterm.devb'
  const COPY_ON_SELECT_STORAGE_KEY = 'zbterm.copyOnSelect'
  const CTRL_ZOOM_STORAGE_KEY = 'zbterm.ctrlZoom'
  const APP_ZOOM_STORAGE_KEY = 'zbterm.appZoom'
  const APP_ZOOM_LEVEL_STORAGE_KEY = 'zbterm.appZoomLevel'
  // Chromium zoom levels: each step is about 10%, from roughly 58% to 250%.
  const APP_ZOOM_STEP = 0.5
  const APP_ZOOM_MIN = -3
  const APP_ZOOM_MAX = 5
  const SHARE_AUTO_COPY_STORAGE_KEY = 'zbterm.share.autoCopy'
  const JOIN_AUTO_PASTE_STORAGE_KEY = 'zbterm.join.autoPaste'
  const TIME_COLLAPSE_STORAGE_KEY = 'zbterm.collapseGaps'
  const SIDEBAR_WIDTH_STORAGE_KEY = 'zbterm.sidebarWidth'
  // Install-wide: the STUN/TURN servers for direct connections (D-11), a
  // comma-separated list of ICE URLs; empty leaves the flag, the environment
  // or the built-in list in charge.
  const ICE_SERVERS_STORAGE_KEY = 'zbterm.iceServers'
  // Per profile: the session SHIFT+New copies. Empty means the default shell.
  const DEFAULT_SESSION_PREFERENCE = 'zbterm.defaultSessionId'
  // Per profile: pinned session ids, in the order they were pinned.
  const PINNED_SESSIONS_PREFERENCE = 'zbterm.pinnedSessions'
  const SIDEBAR_WIDTH_DEFAULT = 310
  const SIDEBAR_WIDTH_MIN = 220
  const SIDEBAR_WIDTH_MAX = 640
  const DEFAULT_GAP_COLLAPSE_MS = 2000
  const WHEEL_SCRUB_SENSITIVITY = 0.1
  const ZBTERM_JOIN_PREFIX = 'zbterm://join/'
  const IDENTITY_POPUP_ID = 'identity-setup'
  const IDENTITY_DISMISS_PREFERENCE = 'identity.setupDismissed'
  // More than this many confirmed viewers on one row collapse into a single
  // "N viewers" chip whose tooltip lists them.
  const IDENTITY_BADGE_LIMIT = 2
  // How long after a failed peer-identity event a join failure still counts
  // as that refusal, so the status line can name the real reason.
  const IDENTITY_REFUSAL_WINDOW_MS = 60000
  const IDENTITY_ICONS = {
    verified: 'fa-circle-check',
    unknown: 'fa-circle-question',
    failed: 'fa-circle-xmark'
  }
  // Worst-first: the collapsed chip takes the first status any viewer has.
  const IDENTITY_STATUS_ORDER = ['failed', 'pending', 'unknown', 'verified']
  // Kept byte-for-byte in sync with engine/identity/providers.js: the wizard
  // rejects a bad username before any engine call is made.
  const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
  // The wizard's submit button is the commit point for both providers, so its
  // label has to say which one is about to happen.
  const IDENTITY_SUBMIT_LABELS = {
    github: 'Use this identity',
    unknown: 'Stay Unidentified'
  }
  // How long the wizard waits after the last keystroke before asking the
  // provider which keys the typed username publishes.
  const USERNAME_CHECK_DEBOUNCE_MS = 400
  const INPUT_BLOCKED_FLASH_MS = 680
  const ZOOM_FLASH_MS = 420
  // A pointer that moved less than this many pixels was a click, not a drag,
  // so it never stands in for a selection.
  const SELECTION_DRAG_MIN_PX = 4
  // A program may set the clipboard (OSC 52) only this soon after the user
  // clicked or typed in the terminal, so replayed or unprompted output cannot.
  const OSC52_GESTURE_MS = 10000
  const MIN_LIVE_FONT_SIZE = 8
  const MAX_LIVE_FONT_SIZE = 24
  const VISIBLE_TERMINAL_RESET = '\x1b[?1049l\x1b[?47l\x1b[?1048l\x1b[?25h\x1b[0m'
  const TERMINAL_CLEAR = '\x1b[2J\x1b[H'
  const ANSI_RESET = '\x1b[0m'
  const STARTUP_LOGO_COLS = 90
  // Below this the terminal container is mid-layout, not a usable size.
  const MIN_FIT_COLS = 10
  const MIN_FIT_ROWS = 3
  const STARTUP_LOGO_ROWS = 30
  const STARTUP_LOGO_DELAY_MS = 0.75
  const STARTUP_LOGO_SHADE = 105
  const MAX_GROUP_VIEWERS = 99
  const STARTUP_LOGO_RAW_LINES = window.STARTUP_LOGO_RAW_LINES
  const STARTUP_LOGO_LINES = paddedLogoLines(STARTUP_LOGO_RAW_LINES)
  const STARTUP_LOGO_WIDTH = Math.max(...STARTUP_LOGO_LINES.map((line) => line.length))
  const STARTUP_LOGO_GREEN_BG = hexToAnsiBg(window.STARTUP_LOGO_COLORS.green)
  const STARTUP_LOGO_GREEN_FG = hexToAnsiFg(window.STARTUP_LOGO_COLORS.green)
  const STARTUP_LOGO_BLACK_BG = hexToAnsiBg(window.STARTUP_LOGO_COLORS.black)

  const state = {
    sessions: [],
    pendingJoins: [],
    // defaultSessionId is the stored preference; defaultSession is its catalog
    // entry, or null when unset or pointing at a session that no longer exists.
    defaultSessionId: '',
    defaultSession: null,
    // Sessions a session.delete is in flight for; their exit must not reopen
    // them for playback.
    deletingSessionIds: new Set(),
    selectedId: null,
    mode: 'live',
    activeOnly: false,
    query: '',
    term: null,
    fit: null,
    webgl: null,
    currentSession: null,
    timeline: [],
    availability: { availableLength: 0, logLength: 0, gaps: [] },
    timelineSignal: {
      timeline: null,
      startTs: 0,
      activity: null,
      history: null,
      historyAvailableLength: -1
    },
    timeCollapse: {
      enabled: initialPreferredTimeCollapse(),
      thresholdMs: DEFAULT_GAP_COLLAPSE_MS
    },
    timeCollapseMap: {
      timeline: null,
      startTs: 0,
      endTs: 0,
      thresholdMs: 0,
      breakpoints: null,
      compressedSpan: 0
    },
    liveActivityMaps: new Map(),
    liveFrame: null,
    playbackFrame: null,
    playbackGridLayout: null,
    playbackPositions: new Map(),
    playbackStartTs: 0,
    playbackEndTs: 0,
    playbackClockTs: 0,
    playbackPlaying: false,
    playerReady: false,
    startupPhase: 'booting',
    startupError: null,
    terminalStarting: null,
    startupLogoActive: false,
    startupLogoLayout: null,
    startupLogoVersion: 0,
    sessionClockTimer: null,
    clockFrame: 0,
    clockStartedAt: 0,
    clockStartedTs: 0,
    clockSpeed: 1,
    liveFontSize: 13,
    sidebarWidthPreferred: null,
    sidebarWidthFromProfile: false,
    theme: preferredTheme(),
    devb: initialPreferredDevb(),
    copyOnSelect: true,
    ctrlZoom: true,
    appZoom: false,
    appZoomLevel: 0,
    pinnedIds: [],
    // The last left-button drag over the terminal, kept so a drag the remote
    // program swallowed can still be turned into a selection on mouseup.
    selectionDrag: null,
    selectionForced: false,
    terminalGestureAt: 0,
    devLogActive: false,
    devLogPaused: false,
    devLogBuffer: [],
    devLogMode: null,
    liveReveal: null,
    pendingLiveRevealSession: null,
    hd: false,
    restoring: false,
    playbackWrites: {
      version: 0,
      active: false,
      queue: []
    },
    liveWrites: {
      version: 0,
      active: false,
      queue: []
    },
    seek: {
      timer: null,
      version: 0,
      inFlight: false,
      waitingForRender: false,
      pendingValue: SCRUBBER_STEPS,
      lastDrawAt: 0,
      lastDrawValue: SCRUBBER_STEPS,
      pauseRequested: false,
      resumeAfterScrub: false,
      dragging: false,
      hovering: false,
      wheelTimer: null
    },
    profile: {
      selectedId: null,
      selectedName: null,
      profiles: []
    },
    appInfo: {
      name: 'ZBTerm',
      debugServer: null,
      channel: 'dev',
      updateCheckEnabled: false
    },
    pendingDebugSelection: null,
    identity: null,
    // Every remote party we have ever heard about, keyed by identityKey, fed
    // by `share:peer-identity` events, `session.list` rows and (once, at
    // startup) `identity.peers`. renderSessions runs several times a second,
    // so it only ever reads this map - it never calls the engine.
    peerIdentity: new Map(),
    // sessionId -> identityKey of the host we joined, learned from the
    // `share:peer-identity` event with direction 'host'.
    sessionHostIdentity: new Map(),
    lastIdentityFailure: null,
    identityRefusal: null,
    // The last session whose command exited at once (see FAILED_START_MS),
    // until the note about it has been written into the terminal.
    failedStart: null,
    // `share.backends`, fetched once after the engine is ready (null until
    // then, and null when the core predates the method: nothing is gated).
    shareBackends: null,
    sharingNotice: null,
    popupResolvers: new Map(),
    joinedRefreshTimer: 0,
    blockedFlashTimers: new WeakMap()
  }

  const els = {
    profilePicker: document.getElementById('profilePicker'),
    profileList: document.getElementById('profileList'),
    profileName: document.getElementById('profileName'),
    createProfile: document.getElementById('createProfile'),
    sessions: document.getElementById('sessions'),
    sessionSelect: document.getElementById('sessionSelect'),
    search: document.getElementById('search'),
    activeOnly: document.getElementById('activeOnly'),
    newSession: document.getElementById('newSession'),
    joinLink: document.getElementById('joinLink'),
    rename: document.getElementById('rename'),
    delete: document.getElementById('delete'),
    clearCaches: document.getElementById('clearCaches'),
    removeHd: document.getElementById('removeHd'),
    extendSession: document.getElementById('extendSession'),
    extendSessionHidden: document.getElementById('extendSessionHidden'),
    sessionMenu: document.getElementById('sessionMenu'),
    terminalMenu: document.getElementById('terminalMenu'),
    goLive: document.getElementById('goLive'),
    fontSizeDecrease: document.getElementById('fontSizeDecrease'),
    fontSizeIncrease: document.getElementById('fontSizeIncrease'),
    shareSession: document.getElementById('shareSession'),
    inputMode: document.getElementById('inputMode'),
    hdToggle: document.getElementById('hdToggle'),
    collapseGaps: document.getElementById('collapseGaps'),
    identitySetup: document.getElementById('identitySetup'),
    themeToggle: document.getElementById('themeToggle'),
    settingsToggle: document.getElementById('settingsToggle'),
    settingsMenu: document.getElementById('settingsMenu'),
    main: document.querySelector('.main'),
    topbar: document.querySelector('.topbar'),
    app: document.querySelector('.app'),
    sidebar: document.querySelector('.sidebar'),
    sidebarResizer: document.getElementById('sidebarResizer'),
    terminalWrap: document.querySelector('.terminal-wrap'),
    terminal: document.getElementById('terminal'),
    terminalPending: document.getElementById('terminalPending'),
    terminalPendingText: document.getElementById('terminalPendingText'),
    status: document.getElementById('status'),
    title: document.getElementById('title'),
    meta: document.getElementById('meta'),
    bottom: document.querySelector('.bottom'),
    playback: document.getElementById('playback'),
    scrubber: document.getElementById('scrubber'),
    scrubberIndicators: document.getElementById('scrubberIndicators'),
    scrubberTip: document.getElementById('scrubberTip'),
    timeLabel: document.getElementById('timeLabel'),
    currentTime: document.getElementById('currentTime'),
    totalTime: document.getElementById('totalTime'),
    playPause: document.getElementById('playPause'),
    stepBack: document.getElementById('stepBack'),
    stepForward: document.getElementById('stepForward'),
    speed: document.getElementById('speed'),
    updateBtn: document.getElementById('update-btn'),
    version: document.getElementById('version')
  }

  applyTheme(state.theme)
  applyDevb(state.devb)
  applyTimeCollapse(state.timeCollapse.enabled)

  window.addEventListener('error', (event) => {
    if (isBenignBrowserError(event.error || event.message)) return
    showError(event.error || event.message)
  })

  window.addEventListener('unhandledrejection', (event) => {
    if (isBenignBrowserError(event.reason)) return
    showError(event.reason)
  })

  // Applied before init() so the sidebar never flashes at its default width.
  restoreSidebarWidth()
  init().catch(showError)

  async function init() {
    state.startupPhase = 'initializing'
    if (!bridge || !api) throw new Error('Electron preload bridge did not load')
    els.version.textContent = `v${bridge.pkg().version}`
    await loadAppInfo()
    applyTheme(await storedThemePreference(), false)
    applyDevb(await preferredDevb(), false)
    await restoreZoomPreferences()
    await restoreIceServers()
    applyTimeCollapse(await preferredTimeCollapse(), false)
    wireEvents()
    wireProfilePicker()
    wirePopupEvents()
    wirePearRuntimeEvents()
    setStatus('starting terminal')
    await startTerminal()
    if (state.devb) {
      startDevTerminalLog('startup')
      devLog('ZBTerm renderer boot')
      devLog(`version ${bridge.pkg().version}`)
    } else {
      drawStartupLogo({ clear: true }).catch(showError)
    }
    setStatus('checking profile state')
    await ensureProfileSelected()
    // After the profile is known, so the per-profile key resolves.
    applyCopyOnSelect(await preferredCopyOnSelect(), false)
    await restoreProfileSidebarWidth()
    await loadSessionListPreferences()
    setStatus('starting engine')
    await api.invoke('ping')
    await loadShareBackends()
    setStatus('loading sessions')
    // Load the stored peer records once: the render loop reads the memoized
    // map, never the engine.
    await refreshPeerIdentities()
    await refreshSessions()
    renderSessions()
    if (state.appInfo.channel === 'npm') setStatus('checking for updates')
    wireUpdater()
    if (state.devb) showDevStartupLogoInterlude().catch(showError)
    if (state.pendingDebugSelection) {
      const selection = state.pendingDebugSelection
      state.pendingDebugSelection = null
      await selectDebugSession(selection)
    } else {
      await syncDebugSelection()
    }
    startSessionClock()
    state.startupPhase = 'ready'
    setStatus(readyStatusText())
    // Not awaited on purpose: the identity wizard never gates startup.
    maybeShowIdentityWizard().catch(showError)
    // console.log('ZBTerm renderer initialized. Simulating click on + button in 2s...')
    // setTimeout(() => {
    //   console.log('Simulating click now...')
    //   els.newSession.click()
    // }, 2000)
  }

  async function loadAppInfo() {
    try {
      const info = await api.invoke('app.info')
      state.appInfo = {
        name: (info && info.name) || state.appInfo.name,
        debugServer: info && info.debugServer ? info.debugServer : null,
        channel: (info && info.channel) || state.appInfo.channel,
        updateCheckEnabled: !!(info && info.updateCheckEnabled)
      }
    } catch {}
    updateWindowTitle()
  }

  function wireProfilePicker() {
    if (!els.createProfile) return
    els.createProfile.addEventListener('click', guard(createProfile))
    els.profileName.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') createProfile().catch(showError)
    })
  }

  function wirePopupEvents() {
    api.on('popup:resolved', (resolution) => {
      resolveExternalPopup(resolution)
    })
    api.on('popup:fill', (message) => {
      handlePopupFill(message)
    })
    api.on('profile:selected', (selected) => {
      completeProfileSelection(selected)
    })
  }

  function wirePearRuntimeEvents() {
    if (!bridge) return
    if (bridge.onPearReady) {
      bridge.onPearReady(() => {
        if (state.startupPhase === 'ready') setStatus(readyStatusText())
      })
    }
    if (bridge.onPearError) {
      bridge.onPearError((message) => {
        showError(new Error(message))
      })
    }
    api.on('profile:required', () => {
      if (!state.profile.resolve) showProfilePicker().catch(showError)
    })
  }

  async function ensureProfileSelected() {
    setStatus('checking selected profile')
    const current = await api.invoke('profile.current')
    if (current.engineReady) {
      state.profile.selectedId = current.selectedProfileId
      state.profile.selectedName =
        current.selectedProfileName || profileNameForId(current.selectedProfileId)
      updateWindowTitle()
      hideProfilePicker()
      return
    }
    if (current.engineStarting || current.pearRuntimeInitializing) {
      setStatus('opening profile')
      const decision = await waitForPearDecision()
      if (decision === 'profile-required') return
      return
    }
    await showProfilePicker()
  }

  function waitForPearDecision() {
    if (!bridge || !bridge.onPearReady || !bridge.onPearError) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let offReady = null
      let offError = null
      let offProfileRequired = null
      const cleanup = () => {
        if (offReady) offReady()
        if (offError) offError()
        if (offProfileRequired) offProfileRequired()
      }
      offReady = bridge.onPearReady(() => {
        cleanup()
        resolve('ready')
      })
      offError = bridge.onPearError((message) => {
        cleanup()
        reject(new Error(message))
      })
      offProfileRequired = api.on('profile:required', () => {
        cleanup()
        showProfilePicker().then(() => resolve('profile-required'), reject)
      })
      api
        .invoke('profile.current')
        .then((current) => {
          if (current.engineReady) {
            cleanup()
            resolve('ready')
          } else if (!current.engineStarting && !current.pearRuntimeInitializing) {
            cleanup()
            showProfilePicker().then(() => resolve('profile-required'), reject)
          }
        })
        .catch((err) => {
          cleanup()
          reject(err)
        })
    })
  }

  async function showProfilePicker() {
    if (state.profile.promise) return state.profile.promise
    setStatus('checking running profiles')
    const registry = await api.invoke('profile.list')
    state.profile.profiles = registry.profiles || []
    if (state.profile.selectedId && !state.profile.selectedName) {
      state.profile.selectedName = profileNameForId(state.profile.selectedId)
      updateWindowTitle()
    }
    renderProfilePicker()
    els.profilePicker.hidden = false
    notifyPopupVisibleAfterPaint('profile-picker')
    setStatus('select a profile')
    state.profile.promise = new Promise((resolve, reject) => {
      state.profile.resolve = resolve
      state.profile.reject = reject
    })
    return state.profile.promise
  }

  function completeProfileSelection(selected) {
    state.profile.selectedId =
      (selected && (selected.selectedProfileId || selected.profileId)) || state.profile.selectedId
    state.profile.selectedName =
      (selected && (selected.selectedProfileName || selected.profileName)) ||
      profileNameForId(state.profile.selectedId) ||
      state.profile.selectedName
    updateWindowTitle()
    devLog(`profile selected ${state.profile.selectedId || ''}`)
    // The profile's engine is ready by the time it is selected.
    restoreProfileSidebarWidth().catch(() => {})
    // At startup boot() loads it once the engine answers; only a later
    // selection needs the list redrawn with the new profile's default.
    if (state.sessions.length) {
      loadSessionListPreferences()
        .then(() => refreshSessions())
        .catch(() => {})
    }
    const resolve = state.profile.resolve
    hideProfilePicker()
    if (resolve) resolve(selected)
    state.profile.resolve = null
    state.profile.reject = null
    state.profile.promise = null
  }

  function renderProfilePicker() {
    els.profileList.replaceChildren()
    if (!state.profile.profiles.length) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = 'No profiles yet'
      els.profileList.append(empty)
      return
    }
    for (const profile of state.profile.profiles) {
      const row = document.createElement('button')
      row.className = 'profile-row text-btn'
      row.disabled = !!profile.locked
      row.innerHTML = `
        <span>
          <span class="profile-name"></span>
          <span class="profile-meta"></span>
        </span>
        <span>${profile.locked ? 'Running' : 'Open'}</span>
      `
      row.querySelector('.profile-name').textContent = profile.name || profile.id
      row.querySelector('.profile-meta').textContent = profile.locked
        ? 'Already open in another process'
        : profile.lastUsedAt
          ? `Last used ${formatTime(profile.lastUsedAt)}`
          : profile.id
      row.addEventListener('click', () => selectProfile(profile.id).catch(showError))
      els.profileList.append(row)
    }
  }

  async function createProfile() {
    const name = els.profileName.value.trim() || 'New profile'
    setStatus('creating profile')
    const profile = await api.invoke('profile.create', { name })
    els.profileName.value = ''
    await selectProfile(profile.id)
  }

  async function selectProfile(profileId) {
    setStatus('opening profile')
    const selected = await api.invoke('profile.select', { profileId })
    completeProfileSelection(selected)
  }

  function hideProfilePicker() {
    if (els.profilePicker) els.profilePicker.hidden = true
    notifyPopupHidden('profile-picker')
    state.profile.promise = null
  }

  function notifyPopupVisible(popupId) {
    api.invoke('debug.popupVisible', { popupId }).catch(() => {})
  }

  function notifyPopupVisibleAfterPaint(popupId) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => notifyPopupVisible(popupId))
    })
  }

  function notifyPopupHidden(popupId) {
    api.invoke('debug.popupHidden', { popupId }).catch(() => {})
  }

  async function ensureTerminalLibraries() {
    await loadScriptOnce('vendor/xterm/xterm.js', () => resolveGlobal('Terminal', 'Terminal'))
    await loadScriptOnce('vendor/xterm/addon-fit.js', () => resolveGlobal('FitAddon', 'FitAddon'))
    await loadScriptOnce('vendor/xterm/addon-webgl.js', () =>
      resolveGlobal('WebglAddon', 'WebglAddon')
    ).catch((err) => {
      console.warn('webgl terminal addon unavailable, using DOM renderer', err)
    })
  }

  async function startTerminal() {
    if (state.term) return
    if (state.terminalStarting) return state.terminalStarting
    state.startupPhase = 'starting-terminal'
    state.startupError = null
    setStatus('starting terminal')
    state.terminalStarting = Promise.resolve()
      .then(async () => {
        await ensureTerminalLibraries()
        createTerminal()
      })
      .catch((err) => {
        state.startupPhase = 'terminal-error'
        state.startupError = err && err.message ? err.message : String(err)
        throw err
      })
      .finally(() => {
        state.terminalStarting = null
      })
    return state.terminalStarting
  }

  async function ensureTerminalReady() {
    if (state.term) return true
    await startTerminal()
    return !!state.term
  }

  function loadScriptOnce(src, ready) {
    if (ready()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error(`Timed out loading ${src}`))
      }, 5000)
      const done = (fn, value) => {
        window.clearTimeout(timeout)
        fn(value)
      }
      const existing = document.querySelector(`script[data-src="${src}"]`)
      if (existing) {
        existing.addEventListener('load', () => done(resolve), { once: true })
        existing.addEventListener('error', (event) => done(reject, event), { once: true })
        return
      }
      const script = document.createElement('script')
      script.src = src
      script.dataset.src = src
      script.onload = () => done(resolve)
      script.onerror = () => done(reject, new Error(`Failed to load ${src}`))
      document.body.append(script)
    })
  }

  function createTerminal() {
    const Terminal = resolveGlobal('Terminal', 'Terminal')
    const FitAddon = resolveGlobal('FitAddon', 'FitAddon')
    const WebglAddon = resolveGlobal('WebglAddon', 'WebglAddon')

    if (!Terminal || !FitAddon) {
      els.terminal.textContent =
        'Terminal renderer failed to load. Check DevTools for the first script error.'
      throw new Error('Terminal libraries did not load')
    }

    state.term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.08,
      scrollback: 5000,
      scrollOnUserInput: true,
      theme: terminalTheme()
    })
    state.startupError = null
    state.liveFontSize = state.term.options.fontSize
    state.fit = new FitAddon()
    state.term.loadAddon(state.fit)
    if (WebglAddon) {
      try {
        state.webgl = new WebglAddon()
        state.term.loadAddon(state.webgl)
      } catch (err) {
        console.warn('webgl renderer unavailable, using DOM renderer', err)
      }
    }
    state.term.open(els.terminal)
    enablePausedTerminalSelection()
    state.term.parser.registerOscHandler(52, copyFromOsc52)
    els.terminal.addEventListener('keydown', noteTerminalGesture, true)
    els.terminal.addEventListener('click', () => {
      if (state.pendingLiveRevealSession) showRevealedLiveStream().catch(showError)
    })
    // Listen on the window: a drag that leaves the terminal still ends here.
    els.terminal.addEventListener('mousedown', (event) => {
      noteTerminalGesture()
      if (event.button !== 0) return
      // A selection this app forced is not cleared by xterm while the program
      // owns the mouse, so it is dropped when the next drag begins.
      if (state.selectionForced) {
        state.selectionForced = false
        state.term.clearSelection()
      }
      state.selectionDrag = {
        anchor: terminalSelectionCell(event),
        x: event.clientX,
        y: event.clientY
      }
      window.addEventListener('mouseup', copySelectionOnPointerUp, { once: true })
    })
    syncTerminalLayout()
    fitTerminalToContainer()
    state.term.onData((data) => {
      if (state.pendingLiveRevealSession) {
        if (data === '\r' || data === '\n' || data === '\r\n') {
          showRevealedLiveStream().catch(showError)
        }
        return
      }
      if (!state.selectedId) return
      if (state.mode !== 'live') {
        return
      }
      if (!canInputToTerminal()) {
        return
      }
      api.invoke('session.input', { sessionId: state.selectedId, data }).catch(showError)
    })
    // onData also receives terminal mouse-reporting escape sequences.  Those
    // can be produced by trackpad gestures after playback has rendered an
    // application that enabled mouse tracking, so only keyboard events should
    // trigger the "input blocked" affordance.
    state.term.onKey(({ domEvent }) => {
      if (!domEvent || !isTerminalInputKey(domEvent.key)) return
      if (state.mode === 'playback') {
        flashPlaybackInputBlocked()
      } else if (state.mode === 'live' && !canInputToTerminal()) {
        flashInputBlockedButtons([els.inputMode])
      }
    })
    let dragDepth = 0
    els.terminalWrap.addEventListener('dragenter', (event) => {
      if (!hasDraggedFiles(event) || !canInputToTerminal()) return
      event.preventDefault()
      dragDepth += 1
      els.terminalWrap.classList.add('drop-target')
    })
    els.terminalWrap.addEventListener('dragover', (event) => {
      if (!hasDraggedFiles(event) || !canInputToTerminal()) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    })
    els.terminalWrap.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) els.terminalWrap.classList.remove('drop-target')
    })
    els.terminalWrap.addEventListener('drop', (event) => {
      dragDepth = 0
      els.terminalWrap.classList.remove('drop-target')
      if (!hasDraggedFiles(event)) return
      event.preventDefault()
      dropFilePathsToTerminal(event.dataTransfer.files).catch(showError)
    })
    let resizeFrame = 0
    const resizeObserver = new window.ResizeObserver(() => {
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame)
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0
        fitAndResize()
      })
    })
    for (const el of [els.main, els.topbar, els.terminalWrap, els.bottom]) {
      if (el) resizeObserver.observe(el)
    }
    window.addEventListener('resize', fitAndResize)
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitAndResize)
  }

  async function drawStartupLogo(options = {}) {
    if (!state.term) return
    const clear = options.clear !== false
    state.startupLogoActive = true
    const version = ++state.startupLogoVersion
    fitStartupLogoTerminal()

    const slate = `\x1b[48;2;${STARTUP_LOGO_SHADE};${STARTUP_LOGO_SHADE};${STARTUP_LOGO_SHADE}m`
    const black = STARTUP_LOGO_BLACK_BG
    const green = STARTUP_LOGO_GREEN_BG
    const greenText = STARTUP_LOGO_GREEN_FG
    const blockHeight = STARTUP_LOGO_LINES.length + 3
    const startRow = Math.max(1, Math.floor((STARTUP_LOGO_ROWS - blockHeight) / 2) + 1 - 2)
    const startCol = Math.max(1, Math.floor((STARTUP_LOGO_COLS - STARTUP_LOGO_WIDTH) / 2) + 1)
    const cellsToDraw = []

    for (let rowIndex = 0; rowIndex < STARTUP_LOGO_LINES.length; rowIndex++) {
      const cells = STARTUP_LOGO_LINES[rowIndex].padEnd(STARTUP_LOGO_WIDTH, '.')
      for (let colIndex = 0; colIndex < cells.length; colIndex++) {
        const char = cells[colIndex]
        const color = char === '-' ? slate : char === 'G' ? green : black
        cellsToDraw.push(`\x1b[${startRow + rowIndex};${startCol + colIndex}H${color} \x1b[0m`)
      }
    }
    if (clear) await writeTerminal(`${TERMINAL_CLEAR}\x1b[?25l`)
    await writeTimedLogoCells(cellsToDraw, STARTUP_LOGO_DELAY_MS, version)
    await writeCenteredTerminalText(
      startRow + STARTUP_LOGO_LINES.length + 1,
      `ZBTerm v${bridge.pkg().version}`,
      greenText
    )
    await writeCenteredTerminalText(
      startRow + STARTUP_LOGO_LINES.length + 2,
      '© MMXXVI by PassCall Advanced Technologies Ltd.'
    )
    // No newline after the last line: the block already reaches the bottom row
    // of the fixed grid, and a line feed there scrolls it, leaving scrollback
    // and with it a scrollbar floating at the edge of the centred grid.
    await writeTerminal(
      '\r\n\r\n' +
        'Based on modules and examples by pears.com/holepunch.to\r\n' +
        `See ${projectUrl()} for more information\r\n` +
        '\r\n' +
        'ZBTerm is not affiliated with Holepunch.to or pears.com'
    )

    await writeTerminal(`${ANSI_RESET}\x1b[${startRow + blockHeight + 2};1H\x1b[?25h`)
  }

  function writeCenteredTerminalText(row, text, color = '') {
    const col = Math.max(1, Math.floor((STARTUP_LOGO_COLS - text.length) / 2) + 1)
    return writeTerminal(`\x1b[${row};${col}H${color}${text}\x1b[0m`)
  }

  function paddedLogoLines(lines) {
    const width = Math.max(...lines.map((line) => line.length))
    const blackLine = '.'.repeat(width + 4)
    return [blackLine, ...lines.map((line) => `..${line.padEnd(width, '.')}..`), blackLine]
  }

  function hexToAnsiBg(hex) {
    const n = parseInt(hex.slice(1), 16)
    return `\x1b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
  }

  function hexToAnsiFg(hex) {
    const n = parseInt(hex.slice(1), 16)
    return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
  }

  function writeTerminal(data) {
    return new Promise((resolve) => state.term.write(data, resolve))
  }

  async function writeTimedLogoCells(cells, delayMs, version) {
    const startedAt = performance.now()
    let index = 0
    while (index < cells.length) {
      if (version !== state.startupLogoVersion || !state.startupLogoActive) return
      const elapsed = performance.now() - startedAt
      const targetCount = Math.min(
        cells.length,
        Math.max(index + 1, Math.floor(elapsed / delayMs) + 1)
      )
      await writeTerminal(cells.slice(index, targetCount).join(''))
      index = targetCount
      if (index < cells.length) await nextFrame()
    }
  }

  function nextFrame() {
    return new Promise((resolve) => window.requestAnimationFrame(resolve))
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
  }

  function startDevTerminalLog(mode) {
    if (!state.devb || !state.term) return
    state.devLogActive = true
    state.devLogPaused = false
    state.devLogMode = mode
    state.devLogBuffer = []
    state.startupLogoActive = false
    state.startupLogoVersion++
    fitLiveTerminal()
    writeTerminal(`${TERMINAL_CLEAR}\x1b[?25h${ANSI_RESET}`).catch(showError)
    devLog(`diagnostics: ${mode}`)
    updateTransportControls()
  }

  function stopDevTerminalLog() {
    state.devLogActive = false
    state.devLogPaused = false
    state.devLogBuffer = []
    state.devLogMode = null
    updateTransportControls()
  }

  function isDevLogTerminalVisible() {
    return !!(
      state.devb &&
      state.devLogActive &&
      !state.selectedId &&
      !state.pendingLiveRevealSession
    )
  }

  function devLog(message) {
    if (!state.devb || !state.devLogActive || !state.term) return
    const line = `[${new Date().toLocaleTimeString()}] ${String(message).replace(/\s+/g, ' ')}`
    if (state.devLogPaused) {
      state.devLogBuffer.push(line)
      if (state.devLogBuffer.length > 200) state.devLogBuffer.shift()
      return
    }
    // Newline after the text, not before it: the cursor then rests on an
    // empty row, so every status line is an ordinary row that xterm reflows
    // on resize (the cursor row is never reflowed).
    writeTerminal(`${line}\r\n`).catch(() => {})
  }

  async function pauseDevLogFor(ms) {
    state.devLogPaused = true
    await sleep(ms)
    state.devLogPaused = false
    const buffered = state.devLogBuffer.splice(0)
    for (const line of buffered) await writeTerminal(`${line}\r\n`)
  }

  async function showDevStartupLogoInterlude() {
    if (!state.devb || !state.term || state.selectedId) return
    fitLiveTerminal()
    state.devLogPaused = true
    await writeTerminal('\r\n\r\n')
    await writeTerminal(devLogoText(state.term.cols))
    await writeTerminal('\r\n\r\n')
    await pauseDevLogFor(5000)
    devLog('diagnostics resumed')
  }

  async function beginLiveReveal(session) {
    if (!state.term || !session) return
    state.pendingLiveRevealSession = session
    state.liveReveal = { sessionId: session.sessionId }
    els.title.textContent = session.name
    els.meta.textContent = 'Joined - paused before live'
    updateTransportControls()
    renderSessions()
    stopDevTerminalLog()
    await sleep(2500)
    // await writeTerminal(
    //   '\r\n\r\nReady! Click here, press Enter, or press Play to show live stream...\r\n'
    // )
  }

  async function showRevealedLiveStream() {
    const session = state.pendingLiveRevealSession
    if (!session) return
    state.pendingLiveRevealSession = null
    state.liveReveal = null
    await selectSession(session)
  }

  function devLogoText(cols = STARTUP_LOGO_COLS) {
    const slate = `\x1b[48;2;${STARTUP_LOGO_SHADE};${STARTUP_LOGO_SHADE};${STARTUP_LOGO_SHADE}m`
    const black = STARTUP_LOGO_BLACK_BG
    const green = STARTUP_LOGO_GREEN_BG
    const terminalCols = Number.isFinite(cols) ? Math.floor(cols) : STARTUP_LOGO_COLS
    const lineWidth = Math.max(1, Math.min(STARTUP_LOGO_WIDTH, terminalCols - 1))
    const cropStart = Math.max(0, Math.floor((STARTUP_LOGO_WIDTH - lineWidth) / 2))
    const leftPad = ' '.repeat(Math.max(0, Math.floor((terminalCols - lineWidth) / 2)))
    const centered = (text) =>
      `${' '.repeat(
        Math.max(0, Math.floor((terminalCols - Math.min(text.length, lineWidth)) / 2))
      )}${text.slice(0, lineWidth)}`
    const logo = STARTUP_LOGO_LINES.map((line) => {
      const visibleLine = line
        .padEnd(STARTUP_LOGO_WIDTH, '.')
        .slice(cropStart, cropStart + lineWidth)
      let out = leftPad
      for (const char of visibleLine) {
        if (char === '-') out += `${slate} ${ANSI_RESET}`
        else if (char === 'G') out += `${green} ${ANSI_RESET}`
        else out += `${black} ${ANSI_RESET}`
      }
      return out
    })
    return [
      ...logo,
      '',
      centered(`ZBTerm v${bridge.pkg().version}`),
      centered('(c) MMXXVI by PassCall Advanced Technologies Ltd.'),
      '\r\n\r\n', // '(c) MMXXVI by PassCall Advanced Technologies Ltd.\r\n',
      'Based on modules and examples by pears.com/holepunch.to',
      `See ${projectUrl()} for more information`,
      '',
      'ZBTerm is not affiliated with Holepunch.to or pears.com',
      ''
    ].join('\r\n')
  }

  function wireEvents() {
    els.search.addEventListener('input', async () => {
      state.query = els.search.value
      await refreshSessions()
    })
    els.activeOnly.addEventListener('click', async () => {
      state.activeOnly = !state.activeOnly
      updateActiveToggle()
      await refreshSessions()
    })
    els.newSession.addEventListener(
      'click',
      guard((event) => newSessionProfile(els.newSession, event))
    )
    els.joinLink.addEventListener('click', guard(joinSharedSession))
    els.rename.addEventListener('click', guard(renameSession))
    els.delete.addEventListener('click', guard(deleteSession))
    els.clearCaches.addEventListener('click', guard(clearCaches))
    els.removeHd.addEventListener('click', guard(removeHd))
    els.extendSession.addEventListener('click', guard(extendSession))
    els.extendSessionHidden.addEventListener('click', guard(extendSession))
    els.goLive.addEventListener('click', guard(goLive))
    els.fontSizeDecrease.addEventListener(
      'click',
      guard(() => adjustLiveFontSize(-1))
    )
    els.fontSizeIncrease.addEventListener(
      'click',
      guard(() => adjustLiveFontSize(1))
    )
    els.shareSession.addEventListener('click', guard(shareSession))
    els.inputMode.addEventListener('click', guard(toggleInputMode))
    els.hdToggle.addEventListener('click', guard(toggleHd))
    els.themeToggle.addEventListener('click', toggleTheme)
    if (els.status) {
      els.status.addEventListener('click', () => {
        if (!state.identityRefusal) return
        clearIdentityRefusal()
        setStatus(readyStatusText())
      })
    }
    if (els.identitySetup) {
      els.identitySetup.addEventListener('click', () => {
        openIdentityWizard(els.identitySetup).catch(showError)
      })
    }
    wireSidebarResizer()
    if (els.settingsToggle) {
      els.settingsToggle.addEventListener('click', toggleSettingsMenu)
      els.settingsToggle.addEventListener('contextmenu', guard(showIdleSurfaceFromDevToggle))
    }
    els.sessionSelect.addEventListener('change', guard(selectSessionFromDropdown))
    els.playPause.addEventListener('click', guard(togglePlay))
    els.speed.addEventListener('change', guard(changePlaybackSpeed))
    els.terminal.addEventListener('contextmenu', openTerminalMenu)
    els.terminal.addEventListener('auxclick', guard(handleTerminalAuxClick))
    document.addEventListener('pointerdown', (event) => {
      if (els.settingsMenu && !els.settingsMenu.hidden) {
        const onToggle =
          event.target && event.target.closest && event.target.closest('#settingsToggle')
        if (!els.settingsMenu.contains(event.target) && !onToggle) closeSettingsMenu()
      }
      if (els.sessionMenu && !els.sessionMenu.hidden) {
        if (els.sessionMenu.contains(event.target)) return
        if (event.target && event.target.closest && event.target.closest('.session-menu-trigger')) {
          return
        }
        closeSessionMenu()
      }
      if (!els.terminalMenu || els.terminalMenu.hidden) return
      if (els.terminalMenu.contains(event.target)) return
      if (event.target && event.target.closest && event.target.closest('.session-menu-trigger')) {
        return
      }
      closeTerminalMenu()
    })
    document.addEventListener(
      'mousedown',
      (event) => {
        const button = event.target && event.target.closest && event.target.closest('button')
        if (button) event.preventDefault()
      },
      true
    )
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.ctrlKey && !event.metaKey && !event.altKey) {
          const appZoom = appZoomKey(event)
          if (appZoom !== null) {
            event.preventDefault()
            event.stopPropagation()
            stepAppZoom(appZoom)
            return
          }
          const zoomDelta = ctrlZoomDelta(event)
          if (zoomDelta) {
            event.preventDefault()
            event.stopPropagation()
            zoomLiveFontSize(zoomDelta).catch(showError)
            return
          }
          if (event.key === 'PageUp' || event.key === 'PageDown') {
            event.preventDefault()
            event.stopPropagation()
            switchSessionRelative(event.key === 'PageUp' ? -1 : 1).catch(showError)
            return
          }
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          return
        }
        flashPlaybackInputBlockedFromKey(event)
        if (event.key !== 'Escape') return
        closeSessionMenu()
        closeTerminalMenu()
        closeSettingsMenu()
      },
      true
    )
    els.stepBack.addEventListener(
      'click',
      guard(() => step(-1))
    )
    els.stepForward.addEventListener(
      'click',
      guard(() => step(1))
    )
    if (els.collapseGaps) {
      els.collapseGaps.addEventListener('click', guard(toggleTimeCollapse))
    }
    els.scrubber.addEventListener('pointerdown', beginScrub)
    els.scrubber.addEventListener('keydown', (event) => event.preventDefault())
    els.scrubber.addEventListener('input', scheduleScrubberSeek)
    els.scrubber.addEventListener('change', commitScrub)
    window.addEventListener('pointerup', commitScrub)
    els.scrubber.addEventListener('mousemove', handleScrubberHover)
    els.scrubber.addEventListener('mouseenter', handleScrubberHover)
    els.scrubber.addEventListener('mouseleave', hideScrubberHover)
    els.scrubber.addEventListener('wheel', handleScrubberWheel, { passive: false })
    // xterm may stop bubbling wheel events while its mouse-reporting mode is
    // active. Capture them before xterm so horizontal two-finger seeking works
    // over the terminal as well as elsewhere in the UI.
    document.addEventListener('wheel', handleGlobalScrubberWheel, {
      capture: true,
      passive: false
    })
    // Electron navigates to a dropped file's path by default; block that
    // everywhere so an unhandled or blocked drop never blows away the app.
    document.addEventListener('dragover', (event) => {
      if (hasDraggedFiles(event)) event.preventDefault()
    })
    document.addEventListener('drop', (event) => {
      if (hasDraggedFiles(event)) event.preventDefault()
    })

    api.on('session:list-changed', (list) => {
      const realIds = new Set(list.map((session) => session.sessionId))
      state.pendingJoins = state.pendingJoins.filter((join) => !realIds.has(join.sessionId))
      state.sessions = withPinnedFirst([...state.pendingJoins, ...list])
      syncSelectedSessionFromList()
      renderSessions()
    })
    api.on('session:data', ({ sessionId, source, hd, data }) => {
      const bytes = new Uint8Array(data)
      recordLiveActivity(sessionId, source, bytes.byteLength)
      scheduleJoinedAvailabilityRefresh(sessionId)
      if (state.mode !== 'live' || sessionId !== state.selectedId) {
        ackSessionData(sessionId, bytes.byteLength)
        return
      }
      state.hd = !!hd
      hideTerminalPending()
      enqueueLiveWrite({ sessionId, hd, data: bytes })
      updateLiveClock()
    })
    api.on('session:availability-changed', ({ sessionId }) => {
      scheduleJoinedAvailabilityRefresh(sessionId)
    })
    api.on('session:exit', ({ sessionId, exit, uptimeMs, command }) => {
      if (sessionId !== state.selectedId) return
      state.restoring = false
      if (state.currentSession) state.currentSession.active = false
      refreshSessions().catch(showError)
      if (state.deletingSessionIds.has(sessionId)) return
      const failed = isFailedStart(exit, uptimeMs)
      if (failed) state.failedStart = { sessionId, exit, uptimeMs, command: command || null }
      setStatus(failed ? failedStartStatus(exit) : 'exited')
      // The recording ends with whatever the command printed; the note about
      // the failure goes under it once the playback view has drawn that. An
      // exit that lands mid-extend (mode is still 'playback') is picked up by
      // extendSession() when it selects the session again.
      if (state.mode === 'live') {
        openPlayback(sessionId)
          .then(() => showFailedStartNote(sessionId))
          .catch(showError)
      }
    })
    api.on('player:frame', ({ sessionId, frame }) => {
      if (state.seek.inFlight || state.seek.timer) return
      if (sessionId !== state.selectedId) return
      if (state.mode === 'playback') renderFrame(frame)
    })
    api.on('player:data', ({ sessionId, tsMs, kind, cols, rows, hd, data }) => {
      if (sessionId !== state.selectedId || state.mode !== 'playback') return
      enqueuePlaybackWrite({ tsMs, kind, cols, rows, hd, data })
    })
    // An extended session goes live before its history is rebuilt; the
    // terminal has only shown output since the spawn. Repaint with the full
    // screen once the engine has it.
    api.on('session:restored', ({ sessionId }) => {
      if (sessionId !== state.selectedId || state.mode !== 'live') return
      api
        .invoke('session.open', { sessionId })
        .then((opened) => {
          if (sessionId !== state.selectedId || state.mode !== 'live') return
          state.restoring = !!opened.restoring
          if (opened.frame && opened.frame.data) renderLiveFrame(opened.frame)
          setStatus('live')
          updateTransportControls()
        })
        .catch(showError)
    })
    api.on('session:hd-changed', ({ sessionId, hd }) => {
      if (sessionId !== state.selectedId) return
      state.hd = !!hd
      updateTransportControls()
    })
    api.on('share:changed', ({ sessionId, viewerCount, inputMode }) => {
      if (sessionId !== state.selectedId) return
      const current = state.sessions.find((session) => session.sessionId === sessionId)
      if (current && inputMode) {
        current.inputMode = inputMode
        if (state.currentSession && state.currentSession.sessionId === sessionId) {
          state.currentSession.inputMode = inputMode
        }
        updateTransportControls()
      }
      setStatus(`shared with ${viewerCount || 0} viewer${viewerCount === 1 ? '' : 's'}`)
      refreshSessions().catch(showError)
    })
    api.on('share:join-changed', (status) => {
      handleJoinStatus(status).catch(showError)
    })
    api.on('share:debug', ({ event }) => {
      if (!event) return
      setStatus(`share: ${event}`)
    })
    api.on('share:approval-pending', (request) => {
      handleApprovalRequest(request).catch(showError)
    })
    // The requester gave up (or timed out) while the prompt was open: close
    // it, there is nothing left to approve.
    api.on('share:approval-cancelled', ({ sessionId, requestId }) => {
      const close = state.popupResolvers.get(approvalPopupId(sessionId, requestId))
      if (close) close({ external: true, action: 'cancelled' })
    })
    api.on('share:peer-identity', (event) => {
      applyPeerIdentity(event)
    })
    api.on('player:end', ({ sessionId }) => {
      if (sessionId !== state.selectedId) return
      stopPlaybackClock()
      updateTransportControls()
    })
    api.on('identity:changed', (self) => {
      applyIdentity(self)
      if (self && self.displayId) setStatus(`identity ${self.displayId}`)
    })
    api.on('engine:error', showError)
    api.on('app:toast', (notice) => showToast(notice && notice.message))
    api.on('debug:select-session', (selection) => {
      selectDebugSession(selection).catch(showError)
    })
  }

  async function selectDebugSession(selection) {
    if (!selection || !selection.sessionId) return
    if (!state.term) {
      state.pendingDebugSelection = selection
      return
    }
    await refreshSessions()
    const session = state.sessions.find((item) => item.sessionId === selection.sessionId)
    if (!session) return
    await selectSession(session, { extend: selection.mode !== 'playback' })
    if (selection.mode === 'playback') await openPlayback(selection.sessionId)
  }

  async function syncDebugSelection() {
    let selection = null
    try {
      selection = await api.invoke('debug.currentSelection')
    } catch (err) {
      if (!isUnknownDebugMethodError(err)) throw err
    }
    if (selection) await selectDebugSession(selection)
  }

  async function refreshSessions() {
    const sessions = await api.invoke('session.list', {
      query: state.query,
      activeOnly: state.activeOnly
    })
    updateActiveToggle()
    const realIds = new Set(sessions.map((session) => session.sessionId))
    state.pendingJoins = state.pendingJoins.filter((join) => !realIds.has(join.sessionId))
    await prunePinnedSessions(realIds)
    state.sessions = withPinnedFirst([...state.pendingJoins, ...sessions])
    await resolveDefaultSession(sessions)
    ingestSessionIdentities(state.sessions)
    syncSelectedSessionFromList()
    renderSessions()
  }

  async function loadSessionListPreferences() {
    await Promise.all([loadDefaultSessionPreference(), loadPinnedSessionsPreference()])
  }

  async function loadPinnedSessionsPreference() {
    let saved = null
    try {
      saved = api ? await api.invoke('preference.get', { key: PINNED_SESSIONS_PREFERENCE }) : null
    } catch {}
    let ids = []
    try {
      ids = JSON.parse(saved || '[]')
    } catch {}
    state.pinnedIds = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : []
  }

  async function setPinnedIds(ids) {
    state.pinnedIds = ids
    await api.invoke('preference.set', {
      key: PINNED_SESSIONS_PREFERENCE,
      value: JSON.stringify(ids)
    })
  }

  // Pinned sessions lead the list in the order they were pinned, live or not,
  // so they never move; everything else keeps the engine's order below them.
  function withPinnedFirst(sessions) {
    if (!state.pinnedIds.length) return sessions
    const byId = new Map(sessions.map((session) => [session.sessionId, session]))
    const pinned = state.pinnedIds
      .map((id) => byId.get(id))
      .filter((session) => session && !session.pending)
    const pinnedSet = new Set(pinned)
    return [...pinned, ...sessions.filter((session) => !pinnedSet.has(session))]
  }

  // A pin for a session that no longer exists is dropped, but only when the
  // list is unfiltered - a search hiding a session must not unpin it.
  async function prunePinnedSessions(realIds) {
    if (state.query || state.activeOnly) return
    const kept = state.pinnedIds.filter((id) => realIds.has(id))
    if (kept.length !== state.pinnedIds.length) await setPinnedIds(kept).catch(() => {})
  }

  function isPinnedSession(session) {
    return !!session && state.pinnedIds.includes(session.sessionId)
  }

  async function togglePinSession(session) {
    const next = isPinnedSession(session)
      ? state.pinnedIds.filter((id) => id !== session.sessionId)
      : [...state.pinnedIds, session.sessionId]
    await setPinnedIds(next)
    await refreshSessions()
  }

  async function loadDefaultSessionPreference() {
    let saved = null
    try {
      saved = api ? await api.invoke('preference.get', { key: DEFAULT_SESSION_PREFERENCE }) : null
    } catch {}
    state.defaultSessionId = typeof saved === 'string' && saved !== 'null' ? saved : ''
    state.defaultSession = null
    updateNewSessionTitle()
  }

  // `sessions` may be filtered by the search box or the live-only toggle; the
  // default still counts then, so look it up in the full list.
  async function resolveDefaultSession(sessions) {
    const id = state.defaultSessionId
    let entry = id ? sessions.find((session) => session.sessionId === id) : null
    if (id && !entry && (state.query || state.activeOnly)) {
      const all = await api.invoke('session.list', {}).catch(() => [])
      entry = all.find((session) => session.sessionId === id)
    }
    state.defaultSession = entry && entry.owner !== 'joined' && !entry.isJoined ? entry : null
    updateNewSessionTitle()
  }

  async function setDefaultSession(sessionId) {
    state.defaultSessionId = sessionId || ''
    if (!sessionId) state.defaultSession = null
    updateNewSessionTitle()
    await api.invoke('preference.set', {
      key: DEFAULT_SESSION_PREFERENCE,
      value: state.defaultSessionId
    })
  }

  function updateNewSessionTitle() {
    if (!els.newSession) return
    const source = state.defaultSession ? state.defaultSession.name : 'default shell'
    els.newSession.title = `New session (hold SHIFT to skip dialog and copy from ${source})`
  }

  function syncSelectedSessionFromList() {
    if (!state.selectedId) return
    const current = state.sessions.find((session) => session.sessionId === state.selectedId)
    if (!current || current.pending) return
    state.currentSession = current
    els.title.textContent = current.name
    els.meta.textContent = sessionMeta(current)
    updateTransportControls()
  }

  // --- identity badges -----------------------------------------------------

  function peerIdentityEntry(identityKey) {
    if (!identityKey) return null
    return state.peerIdentity.get(String(identityKey)) || null
  }

  // Merge-in-place so every badge for one peer shares a single record and a
  // later update (an event, an annotation) is picked up by the next render.
  function mergePeerIdentity(identityKey, patch) {
    const key = String(identityKey || '')
    if (!key) return null
    const peer = state.peerIdentity.get(key) || { identityKey: key }
    for (const name of Object.keys(patch || {})) {
      const value = patch[name]
      if (value === undefined || value === null) continue
      peer[name] = value
    }
    peer.identityKey = key
    state.peerIdentity.set(key, peer)
    return peer
  }

  // Phase 5 pushes one of these per peer per verification step.
  function applyPeerIdentity(event) {
    if (!event) return
    // A peer that presents no claim at all carries no identity key (the host
    // half of the event is built from the claim), so fall back to its device
    // key: the badge still has to say "nobody knows who this is".
    const identityKey = event.identityKey || event.deviceKey
    if (!identityKey) return
    const peer = mergePeerIdentity(identityKey, {
      deviceKey: event.deviceKey,
      // `@UNKNOWN` with an empty hex prefix is worse than deriving the id from
      // the key we do have, so only trust the event's display id when it was
      // built from a real identity key.
      displayId: event.identityKey ? event.displayId : undefined,
      provider: event.provider
    })
    if (!peer) return
    peer.status = event.status || 'unknown'
    peer.failureReason = event.reason || null
    if (event.direction === 'host' && event.sessionId) {
      state.sessionHostIdentity.set(event.sessionId, String(identityKey))
    }
    if (peer.status === 'failed') {
      state.lastIdentityFailure = {
        at: Date.now(),
        direction: event.direction || null,
        reason: event.reason || '',
        displayId: peer.displayId || ''
      }
    }
    // A cold provider cache makes the host block our join on a
    // github.com/<user>.keys fetch for up to the resolver timeout, so say what
    // is happening rather than looking hung.
    if (event.direction === 'host' && peer.status === 'pending') {
      setStatus('checking host identity')
      if (state.currentSession && state.currentSession.pending) {
        showTerminalPending('Checking host identity')
      }
    }
    renderSessions()
  }

  // The stored record is the only source of localName/localComment; a live
  // event always wins for status/displayId.
  function applyStoredPeer(record) {
    if (!record || !record.identityKey) return null
    const existing = peerIdentityEntry(record.identityKey)
    const live = !!(existing && existing.status)
    return mergePeerIdentity(record.identityKey, {
      provider: record.provider,
      sshFingerprint: record.sshFingerprint,
      localName: record.localName,
      localComment: record.localComment,
      displayId: live ? existing.displayId : record.displayId,
      status: live ? existing.status : record.status,
      failureReason: live ? existing.failureReason : record.failureReason
    })
  }

  // Called once at startup: the render loop must never reach the engine.
  async function refreshPeerIdentities() {
    let peers = []
    try {
      peers = await api.invoke('identity.peers')
    } catch {
      return
    }
    for (const record of peers || []) applyStoredPeer(record)
  }

  function ingestSessionIdentities(sessions) {
    for (const session of sessions || []) {
      const viewers = Array.isArray(session.viewers) ? session.viewers : []
      for (const viewer of viewers) {
        if (!viewer || !viewer.identityKey) continue
        const peer = mergePeerIdentity(viewer.identityKey, {
          deviceKey: viewer.deviceKey,
          displayId: viewer.displayId
        })
        if (peer) peer.status = viewer.status || 'unknown'
      }
    }
  }

  function identityStatusOf(peer) {
    const status = peer && peer.status ? String(peer.status) : 'unknown'
    if (status === 'verified' || status === 'pending' || status === 'failed') return status
    return 'unknown'
  }

  function identityDisplayId(peer) {
    if (peer && peer.displayId) return String(peer.displayId)
    if (peer && peer.identityKey) return `${String(peer.identityKey).slice(0, 12)}@UNKNOWN`
    return 'unknown'
  }

  function identityDisplayText(peer) {
    const displayId = identityDisplayId(peer)
    const localName = peer && peer.localName ? String(peer.localName).trim() : ''
    return localName ? `${displayId} (${localName})` : displayId
  }

  function identityBadgeTitle(peer, status) {
    let base = ''
    if (status === 'failed') {
      base = (peer && peer.failureReason) || 'identity verification failed'
    } else if (status === 'verified') {
      base = (peer && peer.sshFingerprint) || identityDisplayId(peer)
    } else if (status === 'pending') {
      base = 'checking identity'
    } else {
      base = 'this peer has not proved who they are'
    }
    const comment = peer && peer.localComment ? String(peer.localComment).trim() : ''
    return comment ? `${base}\n${comment}` : base
  }

  function identityStatusMark(status) {
    if (status === 'pending') {
      const spinner = document.createElement('div')
      spinner.className = 'spinner'
      return spinner
    }
    const icon = document.createElement('i')
    icon.className = `fa-solid ${IDENTITY_ICONS[status] || IDENTITY_ICONS.unknown}`
    icon.setAttribute('aria-hidden', 'true')
    return icon
  }

  function renderIdentityBadge(peer, options = {}) {
    const status = identityStatusOf(peer)
    const badge = document.createElement('span')
    badge.className = `identity-badge identity-${status}`
    badge.title = identityBadgeTitle(peer, status)
    badge.dataset.status = status
    badge.dataset.displayId = identityDisplayId(peer)
    if (peer && peer.identityKey) badge.dataset.identityKey = String(peer.identityKey)
    if (peer && peer.localName) badge.dataset.localName = String(peer.localName)
    if (options.direction) badge.dataset.direction = options.direction
    badge.append(identityStatusMark(status))
    const text = document.createElement('span')
    text.className = 'identity-badge-text'
    text.textContent = identityDisplayText(peer)
    badge.append(text)
    if (options.annotate !== false && peer && peer.identityKey) {
      badge.append(identityAnnotateButton(peer))
    }
    return badge
  }

  function worstIdentityStatus(peers) {
    for (const status of IDENTITY_STATUS_ORDER) {
      if (peers.some((peer) => identityStatusOf(peer) === status)) return status
    }
    return 'unknown'
  }

  function renderCollapsedIdentityBadge(peers) {
    const status = worstIdentityStatus(peers)
    const badge = document.createElement('span')
    badge.className = `identity-badge identity-collapsed identity-${status}`
    badge.title = peers.map((peer) => identityDisplayText(peer)).join('\n')
    badge.dataset.status = status
    badge.dataset.displayId = ''
    badge.dataset.direction = 'viewer'
    badge.append(identityStatusMark(status))
    const text = document.createElement('span')
    text.className = 'identity-badge-text'
    text.textContent = `${peers.length} viewers`
    badge.append(text)
    return badge
  }

  // The pencil lives inside the badge; the session row underneath it opens the
  // session on click, so the click must not bubble.
  // --- "who is on the other end" line --------------------------------------
  //
  // One presentation shared by the Join dialog (which inspects the identity an
  // invite carries, before connecting) and the host's approval dialog (which
  // reports the identity the handshake already settled). Same icon, same
  // colours, same explainer sentence, so the two dialogs never describe the
  // same identity state in two different ways.

  // Normalises both sources into what the line renders. `checking` is the
  // Join dialog's own state - no engine answer exists yet.
  function identityLineState(inspection) {
    const state = inspection || {}
    if (state.checking) {
      const name = state.displayId || 'this user'
      return {
        mark: 'checking',
        name,
        explain: `Verifying user "${name}" identity`,
        blocked: true
      }
    }
    const status = state.status === undefined ? 'unknown' : String(state.status)
    const reason = state.reason || state.failureReason || ''
    // A failed claim always renders as @UNKNOWN, so the explainer has to name
    // what was *claimed* - that is the whole point of the message.
    const claimedId =
      state.subject && state.provider && state.provider !== 'unknown'
        ? `${state.subject}@${state.provider}`
        : state.displayId || 'this user'
    if (status === 'failed') {
      return {
        mark: 'failed',
        name: state.displayId || claimedId,
        explain: `Error: Failed to verify ${claimedId}${reason ? ` - ${reason}` : ''}`,
        blocked: true
      }
    }
    if (status === 'verified') {
      const name = state.displayId || claimedId
      return {
        mark: 'verified',
        name,
        explain: state.sshFingerprint
          ? `Verified ${name} via ${state.sshFingerprint}`
          : `Verified ${name}`,
        blocked: false
      }
    }
    if (status === 'pending') {
      const name = state.displayId || claimedId
      return {
        mark: 'checking',
        name,
        explain: `Verifying user "${name}" identity`,
        blocked: true
      }
    }
    // `unknown` covers two very different things, and the engine tells them
    // apart with `claimed`: no claim presented at all, versus a claim we could
    // not check because the provider was unreachable. The second one never
    // blocks - engine/identity/verify.js downgrades an unreachable resolver
    // rather than refusing, and blocking here would strand an offline user.
    if (state.claimed) {
      return {
        mark: 'unknown',
        name: state.displayId || claimedId,
        explain:
          'Could not reach GitHub to check this identity - you can still join, but who you ' +
          'are talking to is unconfirmed',
        blocked: false
      }
    }
    return {
      mark: 'unknown',
      name: state.displayId || 'unknown user',
      explain: 'The user is not github authorized',
      blocked: false
    }
  }

  const IDENTITY_LINE_ICONS = {
    checking: 'fa-circle-question',
    verified: 'fa-circle-check',
    failed: 'fa-circle-xmark',
    unknown: 'fa-circle-question'
  }

  // Returns `{ root, set }`. `set` re-renders in place and answers whether the
  // state it was given blocks the dialog's action.
  function peerIdentityLine() {
    const root = document.createElement('div')
    root.className = 'peer-identity'

    const head = document.createElement('div')
    head.className = 'peer-identity-head'
    const icon = document.createElement('i')
    icon.setAttribute('aria-hidden', 'true')
    const name = document.createElement('span')
    name.className = 'peer-identity-name'
    head.append(icon, name)

    const explain = document.createElement('div')
    explain.className = 'peer-identity-explain'
    root.append(head, explain)

    return {
      root,
      set(inspection) {
        const line = identityLineState(inspection)
        root.className = `peer-identity peer-identity-${line.mark}`
        icon.className = `fa-solid ${IDENTITY_LINE_ICONS[line.mark]}`
        name.textContent = line.name
        explain.textContent = line.explain
        return line.blocked
      }
    }
  }

  function identityAnnotateButton(peer) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'identity-annotate'
    button.title = 'Name this peer'
    button.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i>'
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      showPeerAnnotation(peer.identityKey).catch(showError)
    })
    return button
  }

  async function showPeerAnnotation(identityKey) {
    const peer = peerIdentityEntry(identityKey) || { identityKey }
    const values = await showModal({
      title: `Name ${identityDisplayText(peer)}`,
      okText: 'Save',
      cancelText: 'Cancel',
      fields: [
        { placeholder: 'Local name', value: peer.localName || '' },
        { placeholder: 'Comment (only you see this)', value: peer.localComment || '' }
      ]
    })
    if (!values) return
    await annotatePeer({ identityKey, name: values[0], comment: values[1] })
  }

  // Local only: annotations never travel on the wire.
  async function annotatePeer({ identityKey, name, comment }) {
    const record = await api.invoke('identity.annotatePeer', {
      identityKey,
      name: name === undefined ? undefined : String(name),
      comment: comment === undefined ? undefined : String(comment)
    })
    if (record) applyStoredPeer(record)
    renderSessions()
    return record
  }

  function viewerPeerRecord(viewer) {
    return (
      peerIdentityEntry(viewer && viewer.identityKey) || {
        identityKey: (viewer && viewer.identityKey) || '',
        displayId: (viewer && viewer.displayId) || '',
        status: (viewer && viewer.status) || 'unknown'
      }
    )
  }

  function sessionIdentityBadges(session) {
    if (!session) return []
    if (session.pending || session.isJoined || session.owner === 'joined') {
      const peer = peerIdentityEntry(state.sessionHostIdentity.get(session.sessionId))
      return peer ? [renderIdentityBadge(peer, { direction: 'host' })] : []
    }
    const viewers = Array.isArray(session.viewers) ? session.viewers : []
    if (!viewers.length) return []
    const peers = viewers.map(viewerPeerRecord)
    if (peers.length > IDENTITY_BADGE_LIMIT) return [renderCollapsedIdentityBadge(peers)]
    return peers.map((peer) => renderIdentityBadge(peer, { direction: 'viewer' }))
  }

  function identityBadgeState() {
    const badges = []
    const seen = new Set()
    for (const row of document.querySelectorAll('.session-row')) {
      for (const badge of row.querySelectorAll('.identity-badge')) {
        const identityKey = badge.dataset.identityKey || null
        if (identityKey) seen.add(identityKey)
        badges.push({
          sessionId: row.dataset.sessionId || null,
          identityKey,
          direction: badge.dataset.direction || null,
          displayId: badge.dataset.displayId || '',
          status: badge.dataset.status || '',
          localName: badge.dataset.localName || null,
          text: badge.textContent
        })
      }
    }
    // Peers this profile knows about but that are not on screen right now are
    // reported with a null sessionId, so a headless check can still read their
    // badge state without a live session.
    for (const peer of state.peerIdentity.values()) {
      if (!peer.identityKey || seen.has(peer.identityKey)) continue
      badges.push({
        sessionId: null,
        identityKey: peer.identityKey,
        direction: null,
        displayId: identityDisplayId(peer),
        status: identityStatusOf(peer),
        localName: peer.localName || null,
        text: identityDisplayText(peer)
      })
    }
    return badges
  }

  function setIdentityRefusal(reason) {
    setStickyStatus(`Refused: ${reason}`)
  }

  // A status that owns the line until the user clicks it away: the reason a
  // join was refused or failed must not be buried by the next routine update.
  function setStickyStatus(text) {
    state.identityRefusal = text
    if (els.status) {
      els.status.textContent = text
      els.status.classList.add('status-refused')
      els.status.title = 'Click to dismiss'
    }
    devLog(text)
  }

  function clearIdentityRefusal() {
    if (!state.identityRefusal) return
    state.identityRefusal = null
    if (els.status) {
      els.status.classList.remove('status-refused')
      els.status.title = ''
    }
  }

  // A join that died on the identity gate: prefer the reason the failed
  // peer-identity event carried, fall back to the engine's message.
  function identityRefusalReason(status) {
    const message = (status && status.message) || ''
    if (!/identity verification failed/i.test(message)) return null
    const failure = state.lastIdentityFailure
    if (failure && failure.reason && Date.now() - failure.at < IDENTITY_REFUSAL_WINDOW_MS) {
      return failure.reason
    }
    return message
  }

  function renderSessions() {
    els.sessions.replaceChildren()
    renderSessionSelect()
    if (!state.sessions.length) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent =
        state.query || state.activeOnly ? 'No matching sessions' : 'No sessions yet'
      els.sessions.append(empty)
      return
    }
    for (const session of state.sessions) {
      const row = document.createElement('div')
      row.className = 'session-row'
      row.dataset.sessionId = session.sessionId
      if (session.pending) row.classList.add('pending')
      if (session.sessionId === state.selectedId) row.classList.add('selected')
      row.addEventListener('click', () => selectSession(session).catch(showError))
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        openSessionMenu(session, event)
      })
      const status = session.pending ? 'pending' : session.active ? 'live' : 'recorded'
      const liveIcon = sessionLiveIcon(session, { keyboardShared: true })
      const shared = session.isSharing ? ` · ${session.viewerCount || 0} watching` : ''
      const joined = session.isJoined || session.owner === 'joined' ? ' · joined' : ''
      const meta = session.pending
        ? 'joining shared session'
        : `${status}${joined}${shared} · ${formatTime(session.startedAt)} · ${formatBytes(session.sizeBytes || 0)}`
      row.innerHTML = `
      <i class="fa-solid ${liveIcon.icon} session-icon ${liveIcon.state}" aria-hidden="true"></i>
      <span class="session-main">
        <span class="session-title"><span class="session-name"></span></span>
        <span class="session-sub">${meta}</span>
      </span>
      <span class="session-actions"></span>
    `
      row.querySelector('.session-name').textContent = session.name
      // Status marks sit at the row's right end, where the hover actions
      // appear; they hide while the actions show.
      const marks = document.createElement('span')
      marks.className = 'session-marks'
      if (isPinnedSession(session)) {
        marks.append(sessionMark('fa-thumbtack session-pin-mark', 'Pinned'))
      }
      if (state.defaultSession && state.defaultSession.sessionId === session.sessionId) {
        marks.append(sessionMark('fa-check session-default-mark', 'Default for new sessions'))
      }
      if (marks.childElementCount) {
        row.classList.add('has-marks')
        row.append(marks)
      }
      const badges = sessionIdentityBadges(session)
      if (badges.length) {
        const identity = document.createElement('span')
        identity.className = 'session-identity'
        for (const badge of badges) identity.append(badge)
        row.querySelector('.session-main').append(identity)
      }
      renderSessionActions(session, row.querySelector('.session-actions'))
      els.sessions.append(row)
    }
  }

  function sessionMark(classes, label) {
    const mark = document.createElement('i')
    mark.className = `fa-solid ${classes}`
    mark.title = label
    mark.setAttribute('aria-label', label)
    return mark
  }

  // Hover actions on a session row, right to left: Edit, Copy, Delete, Pin. A
  // pending join can only be dropped, and a joined session's launch settings
  // belong to its host, so it cannot be copied. Each action gets the click
  // event, for its SHIFT shortcut.
  function renderSessionActions(session, container) {
    const joined = session.isJoined || session.owner === 'joined'
    const pinned = isPinnedSession(session)
    const actions = [
      {
        key: 'pin',
        icon: 'fa-thumbtack',
        label: pinned ? 'Unpin' : 'Pin',
        title: pinned ? 'Unpin' : 'Pin to the top of the list',
        run: togglePinSession,
        hidden: session.pending,
        active: pinned
      },
      {
        key: 'delete',
        icon: 'fa-trash',
        label: 'Delete',
        title: 'Delete (hold SHIFT to delete session)',
        run: openSessionDeleteMenu
      },
      {
        key: 'copy',
        icon: 'fa-copy',
        label: 'Copy',
        title: 'Copy (hold SHIFT to skip dialog)',
        run: copySessionProfile,
        hidden: session.pending || joined
      },
      {
        key: 'edit',
        icon: 'fa-pen',
        label: 'Edit',
        title: 'Edit',
        run: editSessionProfile,
        hidden: session.pending
      }
    ]
    for (const action of actions) {
      if (action.hidden) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'session-menu-trigger session-action'
      button.dataset.action = action.key
      if (action.active) button.classList.add('active')
      button.title = action.title
      button.setAttribute('aria-label', action.label)
      button.innerHTML = `<i class="fa-solid ${action.icon}" aria-hidden="true"></i>`
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        Promise.resolve(action.run(session, event.currentTarget, event)).catch(showError)
      })
      container.append(button)
    }
  }

  function openSessionDeleteMenu(session, anchor, event) {
    const joined = session.isJoined || session.owner === 'joined'
    const deleteItem = {
      icon: 'fa-trash',
      label: 'Delete session',
      title: 'Hold SHIFT to skip confirmation',
      action: (click) =>
        deleteSession({
          anchor: sessionDeleteButton(session.sessionId),
          confirm: !(click && click.shiftKey)
        }),
      disabled: false
    }
    // SHIFT on the row's Delete goes straight to the confirmation.
    if (event && event.shiftKey) {
      closeSessionMenu()
      return runSessionMenuAction(session, deleteItem, null)
    }
    openSessionMenu(session, anchor, {
      align: 'left',
      items: [
        {
          icon: 'fa-clock-rotate-left',
          label: 'Delete History',
          action: () => clearCaches({ confirm: false }),
          disabled: session.pending || joined
        },
        deleteItem
      ]
    })
  }

  // Looked up when the confirmation opens, not when the menu did: selecting
  // the session first re-renders the list, which replaces the row's buttons.
  function sessionDeleteButton(sessionId) {
    for (const row of els.sessions.querySelectorAll('.session-row')) {
      if (row.dataset.sessionId === sessionId) {
        return row.querySelector('.session-action[data-action="delete"]')
      }
    }
    return null
  }

  async function editSessionProfile(session, anchor) {
    const joined = session.isJoined || session.owner === 'joined'
    // Only a session New could copy may be the default.
    const canBeDefault = !joined && !session.pending
    const wasDefault = !!state.defaultSessionId && state.defaultSessionId === session.sessionId
    const values = await showSessionEditor(anchor, session, {
      mode: 'edit',
      launch: !joined,
      defaultChoice: canBeDefault,
      isDefault: wasDefault
    })
    if (!values) return
    const patch = { sessionId: session.sessionId, name: values.name }
    if (values.launch) {
      patch.cwd = values.cwd
      patch.command = values.command
    }
    await api.invoke('session.update', patch)
    if (canBeDefault && values.isDefault !== wasDefault) {
      await setDefaultSession(values.isDefault ? session.sessionId : '')
    }
    await refreshSessions()
    if (state.selectedId === session.sessionId && values.name) {
      els.title.textContent = values.name
      if (state.currentSession) state.currentSession.name = values.name
    }
  }

  // New opens the same editor as Copy, prefilled with the name the engine
  // would pick on its own. SHIFT skips the editor: it copies the default
  // session, or starts the default shell when there is none.
  async function newSessionProfile(anchor, event) {
    if (event && event.shiftKey) {
      const source = state.defaultSession
      if (!source) {
        await createSession({})
        return
      }
      await createSession({
        name: await uniqueSessionName(source.name),
        cwd: source.cwd,
        command: source.command
      })
      return
    }
    const { name } = await api.invoke('session.defaultName')
    const values = await showSessionEditor(
      anchor,
      { name },
      { mode: 'new', launch: true, shareAutoCopy: await shareAutoCopyPreference() }
    )
    if (!values) return
    await createSessionFromEditor(values)
  }

  async function copySessionProfile(session, anchor, event) {
    const name = await uniqueSessionName(session.name)
    if (event && event.shiftKey) {
      await createSession({ name, cwd: session.cwd, command: session.command })
      return
    }
    const values = await showSessionEditor(
      anchor,
      { ...session, name },
      { mode: 'copy', launch: true, shareAutoCopy: await shareAutoCopyPreference() }
    )
    if (!values) return
    await createSessionFromEditor(values, values.copyHistory ? session.sessionId : '')
  }

  async function createSessionFromEditor(values, copyHistoryFrom) {
    const session = await createSession({ ...values, copyHistoryFrom })
    if (values.share) await shareCreatedSession(session.sessionId, values.share)
  }

  // The prefill for a copy: the source name without its " #N", numbered one
  // past the highest "base #N" already in use (a bare "base" counts as 1).
  // Checked against every session, not just the ones a search is showing.
  async function uniqueSessionName(sourceName) {
    const base =
      String(sourceName || '')
        .replace(/ #\d+$/, '')
        .trim() || 'session'
    let sessions = state.sessions
    try {
      sessions = [...state.pendingJoins, ...(await api.invoke('session.list', {}))]
    } catch {}
    const pattern = new RegExp(`^${escapeRegExp(base)} #(\\d+)$`)
    let max = 0
    for (const session of sessions) {
      const name = session.name || ''
      if (name === base) max = Math.max(max, 1)
      const match = pattern.exec(name)
      if (!match) continue
      const n = Number(match[1])
      if (Number.isSafeInteger(n) && n > max) max = n
    }
    return `${base} #${max + 1}`
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  // Places a fixed panel just under the button that opened it, left or right
  // edges aligned, flipping above it (or pinning to the viewport) when there
  // is no room below. The panel is re-placed whenever its size or the
  // window's changes, since wizards grow and shrink between steps.
  function anchorPanel(panel, anchor, align = 'left') {
    if (!anchor || !anchor.getBoundingClientRect) return false
    const place = () => {
      if (!panel.isConnected) {
        window.removeEventListener('resize', place)
        observer.disconnect()
        return
      }
      // A list refresh can replace the anchor while the panel is open; keep
      // the last position rather than jumping to a detached button's 0,0.
      if (!anchor.isConnected) return
      const rect = anchor.getBoundingClientRect()
      const box = panel.getBoundingClientRect()
      const edge = align === 'right' ? rect.right - box.width : rect.left
      const x = Math.max(8, Math.min(window.innerWidth - box.width - 8, edge))
      const below = rect.bottom + 4
      const above = rect.top - box.height - 4
      let y = below
      if (below + box.height > window.innerHeight - 8) {
        y = above >= 8 ? above : Math.max(8, window.innerHeight - box.height - 8)
      }
      panel.style.left = `${x}px`
      panel.style.top = `${y}px`
    }
    const observer = new window.ResizeObserver(place)
    observer.observe(panel)
    window.addEventListener('resize', place)
    place()
    return true
  }

  // The modal flavour: a button that is not on screen (the dialog was opened
  // from elsewhere, eg. at startup) keeps the centred layout.
  function anchorModal(overlay, panel, anchor, align) {
    if (!anchor || !anchor.getClientRects || !anchor.getClientRects().length) return
    overlay.classList.add('modal-overlay-anchored')
    anchorPanel(panel, anchor, align)
  }

  // A small popover editor anchored under a row action, left edges aligned.
  // `options.mode` is 'edit', 'new' or 'copy'. Resolves with
  // { name, cwd, command, launch, isDefault, copyHistory, share } or null when
  // cancelled; `share` is the Share form's settings when "Share session now"
  // was ticked, else null.
  function showSessionEditor(anchor, session, options = {}) {
    closeSessionMenu()
    const existing = document.querySelector('.session-editor-overlay')
    if (existing) existing.remove()
    return new Promise((resolve) => {
      const overlay = document.createElement('div')
      overlay.className = 'session-editor-overlay'
      const panel = document.createElement('form')
      panel.className = 'session-editor'
      panel.innerHTML = `
        <label class="session-editor-label" for="sessionEditorName">Name:</label>
        <input id="sessionEditorName" class="modal-input" name="name" autocomplete="off" />
        <label class="session-editor-label session-editor-launch" for="sessionEditorCwd">Home Directory:</label>
        <span class="session-editor-field session-editor-launch">
          <input id="sessionEditorCwd" class="modal-input" name="cwd" placeholder="~/" autocomplete="off" />
          <button type="button" class="text-btn session-editor-browse" title="Browse" aria-label="Browse">
            <i class="fa-solid fa-folder-open" aria-hidden="true"></i>
          </button>
        </span>
        <label class="session-editor-label session-editor-launch" for="sessionEditorCommand">Command:</label>
        <input id="sessionEditorCommand" class="modal-input session-editor-launch" name="command" placeholder="default shell" autocomplete="off" />
        <span class="modal-actions session-editor-actions">
          <button type="submit" class="text-btn mode-pause">OK</button>
          <button type="button" class="text-btn session-editor-cancel">Cancel</button>
        </span>
      `
      const name = panel.querySelector('#sessionEditorName')
      const cwd = panel.querySelector('#sessionEditorCwd')
      const command = panel.querySelector('#sessionEditorCommand')
      name.value = session.name || ''
      cwd.value = session.cwd || '~/'
      command.value = session.command || ''
      if (!options.launch) {
        panel.querySelectorAll('.session-editor-launch').forEach((element) => element.remove())
      }
      const actionsRow = panel.querySelector('.session-editor-actions')
      const addCheck = (text, checked, className) => {
        const toggle = preferenceCheckbox(text, checked)
        toggle.label.classList.add('session-editor-check', className)
        panel.insertBefore(toggle.label, actionsRow)
        return toggle.input
      }
      const defaultInput =
        options.mode === 'edit' && options.defaultChoice
          ? addCheck(
              'Default for new sessions (hold SHIFT on New)',
              !!options.isDefault,
              'session-editor-default'
            )
          : null
      // Off every time: copying history is never the implied choice.
      const copyHistoryInput =
        options.mode === 'copy' ? addCheck('Copy history', false, 'session-editor-history') : null
      let shareForm = null
      // No share box (checkbox or options) in a build with no usable backend.
      const shareInput =
        sharingAvailable() && (options.mode === 'new' || options.mode === 'copy')
          ? addCheck('Share session now', false, 'session-editor-share')
          : null
      if (shareInput) {
        // Expands the editor with the Share wizard's options; the panel is
        // anchored, so it re-places itself as it grows.
        const shareBox = document.createElement('div')
        shareBox.className = 'session-editor-share-options'
        shareBox.hidden = true
        panel.insertBefore(shareBox, actionsRow)
        shareInput.addEventListener('change', () => {
          if (shareInput.checked && !shareForm) {
            shareForm = shareOptionsForm({ autoCopy: !!options.shareAutoCopy })
            shareBox.append(shareForm.root)
          }
          shareBox.hidden = !shareInput.checked
        })
      }
      overlay.append(panel)
      document.body.append(overlay)

      const row = anchor && anchor.closest ? anchor.closest('.session-row') : null
      if (row) row.classList.add('menu-open')
      let closed = false
      const close = (value) => {
        if (closed) return
        closed = true
        overlay.remove()
        if (row) row.classList.remove('menu-open')
        resolve(value)
      }

      panel.querySelector('.session-editor-browse')?.addEventListener('click', () => {
        api
          .invoke('app.chooseDirectory', { defaultPath: cwd.value })
          .then((chosen) => {
            if (chosen) cwd.value = chosen
            cwd.focus()
          })
          .catch(showError)
      })
      panel.querySelector('.session-editor-cancel').addEventListener('click', () => close(null))
      overlay.addEventListener('pointerdown', (event) => {
        if (event.target === overlay) close(null)
      })
      panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close(null)
      })
      panel.addEventListener('submit', (event) => {
        event.preventDefault()
        const value = name.value.trim()
        if (!value) {
          name.focus()
          return
        }
        close({
          name: value,
          cwd: options.launch ? cwd.value.trim() : undefined,
          command: options.launch ? command.value.trim() : undefined,
          launch: !!options.launch,
          isDefault: defaultInput ? defaultInput.checked : false,
          copyHistory: copyHistoryInput ? copyHistoryInput.checked : false,
          share: shareInput && shareInput.checked && shareForm ? { ...shareForm.settings } : null
        })
      })

      anchorPanel(panel, anchor, 'left')
      window.requestAnimationFrame(() => {
        name.focus()
        name.select()
      })
    })
  }

  function renderSessionSelect() {
    els.sessionSelect.replaceChildren()
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent =
      state.query || state.activeOnly ? 'No matching sessions' : 'Select a session'
    placeholder.disabled = !!state.sessions.length
    els.sessionSelect.append(placeholder)
    els.sessionSelect.disabled = !state.sessions.length

    for (const session of state.sessions) {
      const option = document.createElement('option')
      option.value = session.sessionId
      option.textContent = `${session.pending ? 'joining' : session.active ? 'live' : 'recorded'} · ${session.name}`
      els.sessionSelect.append(option)
    }

    els.sessionSelect.value =
      state.selectedId && state.sessions.some((session) => session.sessionId === state.selectedId)
        ? state.selectedId
        : ''
  }

  function openSessionMenu(session, anchor, options = {}) {
    if (!els.sessionMenu || !session) return
    closeTerminalMenu()
    closeSettingsMenu()
    els.sessionMenu.replaceChildren()
    const items = options.items || [
      { icon: 'fa-pen', label: 'Rename', action: renameSession, disabled: false },
      {
        icon: 'fa-clock-rotate-left',
        label: 'Delete History',
        action: () => clearCaches({ anchor: sessionDeleteButton(session.sessionId) }),
        disabled: session.pending || session.isJoined || session.owner === 'joined'
      },
      {
        icon: 'fa-rocket',
        label: 'Remove HD',
        action: removeHd,
        disabled: session.pending || session.active || !session.hd
      },
      {
        icon: 'fa-trash',
        label: 'Delete',
        action: () => deleteSession({ anchor: sessionDeleteButton(session.sessionId) }),
        disabled: false
      }
    ]
    for (const item of items) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'context-menu-item label-btn'
      button.disabled = item.disabled
      button.innerHTML = `<i class="fa-solid ${item.icon} btn-icon" aria-hidden="true"></i><span></span>`
      button.querySelector('span:last-child').textContent = item.label
      if (item.title) button.title = item.title
      button.addEventListener('click', (event) => {
        closeSessionMenu()
        if (item.disabled) return
        runSessionMenuAction(session, item, event)
      })
      els.sessionMenu.append(button)
    }

    document.querySelectorAll('.session-row.menu-open').forEach((row) => {
      row.classList.remove('menu-open')
    })
    const row = anchor && anchor.closest ? anchor.closest('.session-row') : null
    if (row) row.classList.add('menu-open')

    els.sessionMenu.hidden = false
    const rect =
      anchor && anchor.getBoundingClientRect
        ? anchor.getBoundingClientRect()
        : {
            left: anchor.clientX,
            right: anchor.clientX,
            top: anchor.clientY,
            bottom: anchor.clientY
          }
    const menuRect = els.sessionMenu.getBoundingClientRect()
    const x = Math.min(
      window.innerWidth - menuRect.width - 8,
      Math.max(8, options.align === 'left' ? rect.left : rect.right - menuRect.width)
    )
    const y = Math.min(window.innerHeight - menuRect.height - 8, Math.max(8, rect.bottom + 4))
    els.sessionMenu.style.left = `${x}px`
    els.sessionMenu.style.top = `${y}px`
  }

  // Menu actions work on the selected session, so select it (without
  // reviving it) first. The click event is passed on for SHIFT shortcuts.
  function runSessionMenuAction(session, item, event) {
    return Promise.resolve()
      .then(async () => {
        if (state.selectedId !== session.sessionId) {
          await selectSession(session, { extend: false })
        }
        await item.action(event)
      })
      .catch(showError)
  }

  function closeSessionMenu() {
    if (!els.sessionMenu) return
    els.sessionMenu.hidden = true
    els.sessionMenu.replaceChildren()
    document.querySelectorAll('.session-row.menu-open').forEach((row) => {
      row.classList.remove('menu-open')
    })
  }

  function openTerminalMenu(event) {
    if (!els.terminalMenu || !state.term) return
    event.preventDefault()
    closeSessionMenu()
    closeSettingsMenu()
    els.terminalMenu.replaceChildren()
    const canPaste = canPasteToTerminal()

    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'context-menu-item label-btn'
    copy.disabled = !state.term.hasSelection()
    copy.innerHTML = '<i class="fa-solid fa-copy btn-icon" aria-hidden="true"></i><span>Copy</span>'
    copy.addEventListener('click', () => {
      closeTerminalMenu()
      copyTerminalSelection().catch(showError)
    })
    els.terminalMenu.append(copy)

    const copyAll = document.createElement('button')
    copyAll.type = 'button'
    copyAll.className = 'context-menu-item label-btn'
    copyAll.innerHTML =
      '<i class="fa-solid fa-copy btn-icon" aria-hidden="true"></i><span>Copy All</span>'
    copyAll.addEventListener('click', () => {
      closeTerminalMenu()
      copyTerminalAll().catch(showError)
    })
    els.terminalMenu.append(copyAll)

    if (canPaste) {
      const paste = document.createElement('button')
      paste.type = 'button'
      paste.className = 'context-menu-item label-btn'
      paste.innerHTML =
        '<i class="fa-solid fa-paste btn-icon" aria-hidden="true"></i><span>Paste</span>'
      paste.addEventListener('click', () => {
        closeTerminalMenu()
        pasteToTerminal().catch(showError)
      })
      els.terminalMenu.append(paste)
    }

    els.terminalMenu.hidden = false
    const menuRect = els.terminalMenu.getBoundingClientRect()
    const x = Math.min(window.innerWidth - menuRect.width - 8, Math.max(8, event.clientX))
    const y = Math.min(window.innerHeight - menuRect.height - 8, Math.max(8, event.clientY))
    els.terminalMenu.style.left = `${x}px`
    els.terminalMenu.style.top = `${y}px`
  }

  function closeTerminalMenu() {
    if (!els.terminalMenu) return
    els.terminalMenu.hidden = true
    els.terminalMenu.replaceChildren()
  }

  // The brand-bar cogwheel used to toggle developer mode directly.  It now
  // opens this menu, so every app-wide preference has one place to live and
  // the gear itself no longer carries hidden state.
  function settingsMenuItems() {
    return [
      {
        label: 'Developer Mode',
        checked: state.devb,
        toggle: toggleDevb
      },
      {
        label: 'Copy on select',
        checked: state.copyOnSelect,
        toggle: toggleCopyOnSelect
      },
      {
        label: 'Change font size with CTRL -/+',
        checked: state.ctrlZoom,
        toggle: toggleCtrlZoom
      },
      {
        label: 'Zoom whole app with CTRL -/+',
        checked: state.appZoom,
        toggle: toggleAppZoom
      },
      {
        label: 'STUN/TURN servers…',
        field: true,
        toggle: editIceServers
      }
    ]
  }

  // The "STUN/TURN servers" field (D-11): stored install-wide with the other
  // app preferences and pushed to the main process, which applies it to new
  // connections; non-empty, it wins over --ice-servers and
  // ZBTERM_ICE_SERVERS.
  async function editIceServers() {
    closeSettingsMenu()
    const current = (await storedAppPreference(ICE_SERVERS_STORAGE_KEY)) || ''
    // The fields form, so Cancel (null) is told apart from an emptied field.
    const values = await showModal({
      title: 'STUN/TURN servers (comma-separated; empty = default)',
      okText: 'Save',
      cancelText: 'Cancel',
      fields: [
        {
          placeholder: 'stun:stun.example.org:3478, turn:user:secret@turn.example.org:3478',
          value: current
        }
      ]
    })
    if (!values) return
    const text = String(values[0] || '').trim()
    persistAppPreference(ICE_SERVERS_STORAGE_KEY, text)
    await pushIceServers(text)
    setStatus(text ? 'STUN/TURN servers saved' : 'STUN/TURN servers: default')
  }

  async function pushIceServers(text) {
    const app = window.app
    if (!app || typeof app.setIceServers !== 'function') return
    try {
      await app.setIceServers(text)
    } catch (err) {
      console.warn('setIceServers failed:', err && err.message ? err.message : err)
    }
  }

  async function restoreIceServers() {
    const saved = (await storedAppPreference(ICE_SERVERS_STORAGE_KEY)) || ''
    if (saved) await pushIceServers(saved)
  }

  function renderSettingsMenu() {
    if (!els.settingsMenu) return
    els.settingsMenu.replaceChildren()
    for (const item of settingsMenuItems()) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `context-menu-item context-menu-check label-btn${item.field ? ' context-menu-field' : ''}`
      if (item.field) {
        button.setAttribute('role', 'menuitem')
      } else {
        button.setAttribute('role', 'menuitemcheckbox')
        button.setAttribute('aria-checked', item.checked ? 'true' : 'false')
      }
      button.innerHTML =
        '<i class="fa-solid fa-check btn-icon check-mark" aria-hidden="true"></i><span></span>'
      button.querySelector('span:last-child').textContent = item.label
      button.addEventListener('click', () => {
        Promise.resolve().then(item.toggle).then(renderSettingsMenu).catch(showError)
      })
      els.settingsMenu.append(button)
    }
  }

  function openSettingsMenu() {
    if (!els.settingsMenu || !els.settingsToggle) return
    closeSessionMenu()
    closeTerminalMenu()
    renderSettingsMenu()
    els.settingsMenu.hidden = false
    els.settingsToggle.setAttribute('aria-expanded', 'true')
    const rect = els.settingsToggle.getBoundingClientRect()
    const menuRect = els.settingsMenu.getBoundingClientRect()
    const x = Math.min(window.innerWidth - menuRect.width - 8, Math.max(8, rect.left))
    const y = Math.min(window.innerHeight - menuRect.height - 8, Math.max(8, rect.bottom + 4))
    els.settingsMenu.style.left = `${x}px`
    els.settingsMenu.style.top = `${y}px`
  }

  function closeSettingsMenu() {
    if (!els.settingsMenu) return
    els.settingsMenu.hidden = true
    els.settingsMenu.replaceChildren()
    if (els.settingsToggle) {
      els.settingsToggle.setAttribute('aria-expanded', 'false')
    }
  }

  function toggleSettingsMenu() {
    if (els.settingsMenu && els.settingsMenu.hidden) openSettingsMenu()
    else closeSettingsMenu()
  }

  async function copyTerminalSelection() {
    if (!state.term || !state.term.hasSelection()) return
    await navigator.clipboard.writeText(state.term.getSelection())
    setStatus('copied selection')
  }

  async function copyTerminalAll() {
    if (!state.term) return
    const buffer = state.term.buffer && state.term.buffer.active
    if (!buffer) return
    const lines = []
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      lines.push(line ? line.translateToString(true) : '')
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop()
    await navigator.clipboard.writeText(lines.join('\n'))
    setStatus('copied terminal')
  }

  async function pasteToTerminal() {
    if (!canPasteToTerminal()) return
    const text = await navigator.clipboard.readText()
    if (!text) return
    await api.invoke('session.input', { sessionId: state.selectedId, data: text })
  }

  function hasDraggedFiles(event) {
    return !!event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')
  }

  async function dropFilePathsToTerminal(fileList) {
    if (!canPasteToTerminal()) {
      flashPlaybackInputBlocked()
      flashInputBlockedButtons([els.inputMode])
      return
    }
    const paths = Array.from(fileList || [])
      .map((file) => bridge.getPathForFile(file))
      .filter(Boolean)
    if (!paths.length) return
    const text = paths.map(shellQuotePath).join(' ')
    await api.invoke('session.input', { sessionId: state.selectedId, data: text })
  }

  function shellQuotePath(path) {
    if (/^[a-zA-Z0-9_/.~-]+$/.test(path)) return path
    return `'${path.replace(/'/g, `'\\''`)}'`
  }

  async function handleTerminalAuxClick(event) {
    if (event.button !== 1) return
    event.preventDefault()
    await pasteToTerminal()
  }

  function enablePausedTerminalSelection() {
    const selection = state.term?._core?._selectionService
    if (!selection || typeof selection.shouldForceSelection !== 'function') return
    const originalShouldForceSelection = selection.shouldForceSelection.bind(selection)
    selection.shouldForceSelection = (event) =>
      isPausedTerminalSelectionMode() || originalShouldForceSelection(event)
  }

  function isPausedTerminalSelectionMode() {
    return !!state.pendingLiveRevealSession || (state.mode === 'playback' && !state.playbackPlaying)
  }

  function updateActiveToggle() {
    if (!els.activeOnly) return
    els.activeOnly.classList.toggle('active', state.activeOnly)
    els.activeOnly.textContent = state.activeOnly ? 'Active' : 'All'
    els.activeOnly.setAttribute('aria-pressed', state.activeOnly ? 'true' : 'false')
  }

  async function selectSessionFromDropdown() {
    const session = state.sessions.find((item) => item.sessionId === els.sessionSelect.value)
    if (!session) return
    await selectSession(session)
  }

  async function switchSessionRelative(delta) {
    if (!state.sessions.length) return
    const selectable = state.sessions.filter((session) => !session.pending)
    if (!selectable.length) return
    const currentIndex = selectable.findIndex((session) => session.sessionId === state.selectedId)
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + delta + selectable.length) % selectable.length
    await selectSession(selectable[nextIndex])
  }

  async function createSession(profile = {}) {
    await ensureTerminalReady()
    const dims = dimensions()
    setStatus('starting session')
    const session = await api.invoke('session.create', {
      name: profile.name || undefined,
      cwd: profile.cwd || undefined,
      command: profile.command || undefined,
      copyHistoryFrom: profile.copyHistoryFrom || undefined,
      cols: dims.cols,
      rows: dims.rows
    })
    await refreshSessions()
    // The listed entry, not the create result: a command that failed at once
    // is already inactive there, and selecting it must not extend it again.
    const created = state.sessions.find((item) => item.sessionId === session.sessionId) || session
    await selectSession(created, { extend: false })
    showFailedStartNote(session.sessionId)
    return session
  }

  // Entering a closed session of our own resumes it: the shell comes back and
  // the history keeps growing. Pass `{ extend: false }` to only look at it.
  async function selectSession(session, options = {}) {
    await ensureTerminalReady()
    if (session.pending) {
      selectPendingJoin(session)
      return
    }
    if (options.extend !== false && canExtendSession(session)) {
      savePlaybackPosition()
      stopPlaybackClock()
      clearLiveWrites({ ack: true })
      state.selectedId = session.sessionId
      state.currentSession = session
      els.title.textContent = session.name
      els.meta.textContent = sessionMeta(session)
      renderSessions()
      await extendSession()
      return
    }
    stopDevTerminalLog()
    state.startupLogoActive = false
    state.startupLogoVersion++
    savePlaybackPosition()
    stopPlaybackClock()
    clearLiveWrites({ ack: true })
    state.selectedId = session.sessionId
    state.currentSession = session
    state.playbackPlaying = false
    state.playerReady = false
    state.hd = !!session.hd
    state.liveFrame = null
    els.title.textContent = session.name
    els.meta.textContent = sessionMeta(session)
    renderSessions()
    if (state.term) {
      resetVisibleTerminal()
      state.term.focus()
    }
    hideTerminalPending()
    if (session.active) {
      cancelPendingSeek()
      state.mode = 'live'
      state.playbackFrame = null
      if (!isJoinedSession()) adoptSessionFontSize(session)
      setTerminalFontSize(state.liveFontSize)
      setStatus('live')
      updateTransportControls()
      const opened = await api.invoke('session.open', { sessionId: session.sessionId })
      state.restoring = !!opened.restoring
      state.hd = !!opened.hd
      setTimeline(opened.timeline || [])
      state.availability = opened.availability || availabilityFromTimeline()
      configureScrubber({ value: SCRUBBER_STEPS, startTs: session.startedAt, endTs: Date.now() })
      if (opened.frame && opened.frame.data) {
        renderLiveFrame(opened.frame, { preserveGrid: isJoinedSession() })
      } else if (isJoinedSession()) {
        fitPlaybackFrame(opened.info || session)
      } else fitLiveTerminal()
      updateLiveClock()
      if (canResizeSelectedLiveSession()) {
        const dims = dimensions()
        await api
          .invoke('session.resize', {
            sessionId: session.sessionId,
            ...dims,
            fontSize: state.liveFontSize
          })
          .catch(() => {})
      }
    } else {
      state.restoring = false
      await openPlayback(session.sessionId)
    }
  }

  async function openPlayback(sessionId) {
    cancelPendingSeek()
    stopPlaybackClock()
    clearLiveWrites({ ack: true })
    state.mode = 'playback'
    state.playbackGridLayout = null
    state.playerReady = false
    setStatus('playback')
    updateTransportControls()
    let player
    try {
      player = await api.invoke('player.open', { sessionId })
    } catch (err) {
      state.playerReady = false
      updateTransportControls()
      throw err
    }
    state.playerReady = true
    setTimeline(player.timeline)
    state.availability = player.availability || availabilityFromTimeline()
    state.hd = !!player.hd
    const active = !!(state.currentSession && state.currentSession.active)
    const activeStartTs = active ? state.currentSession.startedAt : undefined
    configureScrubber({
      value: savedScrubberValue(sessionId, {
        startTs: activeStartTs,
        endTs: active ? Date.now() : undefined
      }),
      startTs: activeStartTs,
      endTs: active ? Date.now() : undefined
    })
    const failedStart = state.failedStart && state.failedStart.sessionId === sessionId
    const savedTs = failedStart ? undefined : state.playbackPositions.get(sessionId)
    if (savedTs !== undefined && savedTs !== player.frame.tsMs) {
      const frame = await api.invoke('player.seek', { sessionId, tsMs: savedTs })
      renderFrame(frame)
    } else {
      renderFrame(player.frame)
    }
  }

  function renderFrame(frame) {
    if (!state.term) return
    hideTerminalPending()
    clearLiveWrites({ ack: true })
    clearPlaybackWrites()
    state.hd = !!frame.hd
    resetVisibleTerminal()
    if (state.mode === 'playback') {
      state.playbackFrame = frame
      state.liveFrame = null
      fitPlaybackFrame(frame)
    } else {
      state.playbackFrame = null
      state.playbackGridLayout = null
      state.liveFrame = null
      setTerminalFontSize(state.liveFontSize)
      state.term.resize(frame.cols || 100, frame.rows || 30)
    }
    state.term.write(frame.data || '', refreshTerminal)
    updatePlaybackClock(frame.tsMs)
  }

  function renderLiveFrame(frame, options = {}) {
    if (!state.term) return
    hideTerminalPending()
    clearLiveWrites({ ack: true })
    clearPlaybackWrites()
    state.hd = !!frame.hd
    state.playbackFrame = null
    // Only drop the cached grid layout when actually entering live mode (from
    // playback, or the very first frame): fitPlaybackFrame's own cache below
    // is what keeps repeated frames - a bootstrap resync while already live,
    // for instance - from picking a font size. Clearing it on every call here
    // defeated that cache for every live frame of a joined session, so each
    // one recomputed fontSizeForGrid from scratch; that computation folds in
    // the terminal's own just-rendered cell metrics (currentRenderCellMetrics
    // via terminalCellMetrics), so successive recomputes fed on each other's
    // rounding and drifted between two nearby sizes forever instead of
    // settling (ZBTerm: joined-session font size flicker).
    if (state.mode !== 'live') state.playbackGridLayout = null
    state.liveFrame = frame
    state.mode = 'live'
    if (options.preserveGrid || isJoinedSession()) fitPlaybackFrame(frame)
    else fitLiveTerminal()
    resetVisibleTerminal()
    state.term.write(frame.data || '', refreshTerminal)
    updatePlaybackClock(frame.tsMs || Date.now())
  }

  async function renameSession() {
    if (!state.selectedId) return
    const current = state.sessions.find((s) => s.sessionId === state.selectedId)
    const name = await askText('Rename session', {
      value: current ? current.name : '',
      okText: 'Rename'
    })
    if (!name) return
    await api.invoke('session.rename', { sessionId: state.selectedId, name })
    await refreshSessions()
  }

  // `anchor` places the confirmation under that button (centred without one);
  // `confirm: false` deletes without asking.
  async function deleteSession(options = {}) {
    if (!state.selectedId) return
    const current = state.sessions.find((s) => s.sessionId === state.selectedId)
    if (current && current.pending) {
      state.pendingJoins = state.pendingJoins.filter((join) => join.sessionId !== current.sessionId)
      state.sessions = state.sessions.filter((session) => session.sessionId !== current.sessionId)
      await showNoSessionSelected()
      renderSessions()
      return
    }
    if (options.confirm !== false) {
      const confirmed = await askConfirm(`Delete "${current ? current.name : 'this session'}"?`, {
        okText: 'Delete',
        danger: true,
        anchor: options.anchor
      })
      if (!confirmed) return
    }
    const sessionId = state.selectedId
    state.deletingSessionIds.add(sessionId)
    try {
      await api.invoke('session.delete', { sessionId })
    } finally {
      state.deletingSessionIds.delete(sessionId)
    }
    if (sessionId === state.defaultSessionId) await setDefaultSession('').catch(() => {})
    if (state.pinnedIds.includes(sessionId)) {
      await setPinnedIds(state.pinnedIds.filter((id) => id !== sessionId)).catch(() => {})
    }
    await refreshSessions()
    await showNoSessionSelected()
  }

  async function clearCaches(options = {}) {
    if (!state.selectedId) return
    const current = state.sessions.find((s) => s.sessionId === state.selectedId)
    if (options.confirm !== false) {
      const confirmed = await askConfirm(
        `Delete history for "${current ? current.name : 'this session'}"?`,
        {
          okText: 'Delete',
          anchor: options.anchor
        }
      )
      if (!confirmed) return
    }
    const sessionId = state.selectedId
    cancelPendingSeek()
    stopPlaybackClock()
    clearLiveWrites({ ack: true })
    clearPlaybackWrites()
    const result = await api.invoke('session.clearCaches', { sessionId })
    if (sessionId !== state.selectedId) return
    setTimeline(result.timeline || [])
    state.availability = { availableLength: 0, logLength: 0, gaps: [] }
    state.playerReady = false
    state.playbackPlaying = false
    configureScrubber({ value: SCRUBBER_STEPS, startTs: Date.now(), endTs: Date.now() })
    const opened = await api.invoke('session.open', { sessionId })
    if (sessionId !== state.selectedId) return
    if (opened.active && opened.frame) {
      renderLiveFrame(opened.frame, { preserveGrid: isJoinedSession() })
    } else {
      state.mode = 'playback'
      state.playbackFrame = null
      resetVisibleTerminal()
      updateTransportControls()
    }
    await refreshSessions()
    setStatus('history deleted')
  }

  async function extendSession() {
    if (!state.selectedId) return
    const current = state.sessions.find((s) => s.sessionId === state.selectedId)
    if (!canExtendSession(current)) return
    const sessionId = state.selectedId
    state.restoring = true
    updateTransportControls()
    try {
      await ensureTerminalReady()
      cancelPendingSeek()
      freezePlaybackClock()
      await api.invoke('player.pause', { sessionId }).catch(() => {})
      clearPlaybackWrites()
      setStatus('extending session')
      // No geometry: the engine revives the shell at the grid the session was
      // last recorded at (not the playback view's), and selectSession() below
      // restores the font size it was last shown with before fitting.
      const session = await api.invoke('session.extend', { sessionId })
      await refreshSessions()
      const revived = state.sessions.find((item) => item.sessionId === session.sessionId) || session
      // `extend: false`: a command that died before the list refreshed is
      // inactive again here, and selecting it with the default would extend
      // it again, and again - the retry loop the failure note replaces.
      await selectSession(revived, { extend: false })
      if (state.failedStart && state.failedStart.sessionId === sessionId) {
        showFailedStartNote(sessionId)
      } else {
        setStatus(state.restoring ? 'live, restoring history' : 'live')
      }
    } catch (err) {
      state.restoring = false
      throw err
    } finally {
      updateTransportControls()
    }
  }

  async function removeHd() {
    if (!state.selectedId) return
    const current = state.sessions.find((s) => s.sessionId === state.selectedId)
    const confirmed = await askConfirm(
      `Remove HD timing from "${current ? current.name : 'this session'}"?`,
      { okText: 'Remove' }
    )
    if (!confirmed) return
    freezePlaybackClock()
    await api.invoke('player.pause', { sessionId: state.selectedId }).catch(() => {})
    clearPlaybackWrites()
    const result = await api.invoke('session.removeHd', { sessionId: state.selectedId })
    state.hd = false
    cancelPendingSeek()
    await refreshSessions()
    if (state.mode === 'playback') await openPlayback(state.selectedId)
    updateTransportControls()
    setStatus(`HD removed ${result.before || 0}->${result.after || 0}`)
  }

  async function goLive() {
    if (!state.currentSession || !state.currentSession.active) return
    savePlaybackPosition()
    stopPlaybackClock()
    await selectSession(state.currentSession)
  }

  // The share backends this build can use right now (backend-abstraction
  // R-9). A broken backend is listed by the core but is not usable.
  function usableShareBackends() {
    const info = state.shareBackends
    if (!info || !Array.isArray(info.backends)) return null
    return info.backends.filter((backend) => backend && backend.state === 'available')
  }

  // False only when the core answered and named no usable backend.
  function sharingAvailable() {
    const usable = usableShareBackends()
    return !usable || usable.length > 0
  }

  async function loadShareBackends() {
    try {
      state.shareBackends = await api.invoke('share.backends')
    } catch (err) {
      state.shareBackends = null
      console.warn('share.backends unavailable:', err && err.message ? err.message : err)
    }
    state.sharingNotice = sharingUnavailableNotice()
    applyShareGating()
  }

  // The build says (package.json#zbtermBackends) it carries a backend, the
  // core lists it as broken and nothing else is usable: say why rather than
  // silently hiding sharing.
  function sharingUnavailableNotice() {
    if (sharingAvailable()) return null
    const pkg = (bridge && bridge.pkg && bridge.pkg()) || {}
    const expected = Array.isArray(pkg.zbtermBackends) ? pkg.zbtermBackends : []
    const broken = state.shareBackends.backends.find(
      (backend) => backend.state === 'broken' && expected.includes(backend.id)
    )
    return broken ? `Sharing unavailable: ${broken.detail || 'unknown reason'}` : null
  }

  function readyStatusText() {
    return state.sharingNotice || 'ready'
  }

  function applyShareGating() {
    const available = sharingAvailable()
    document.body.classList.toggle('sharing-unavailable', !available)
    els.joinLink.hidden = !available
    if (!available) {
      els.shareSession.hidden = true
      els.inputMode.hidden = true
    }
  }

  async function shareSession() {
    if (!sharingAvailable()) return
    if (!state.selectedId || !state.currentSession || !state.currentSession.active) return
    const result = await showShareWizard(els.shareSession)
    await finishShare(result)
  }

  // "Share session now" from the New/Copy editor: the wizard opens straight
  // on its sharing step with the options picked there.
  async function shareCreatedSession(sessionId, settings) {
    const result = await showShareWizard(els.shareSession, { sessionId, settings })
    await finishShare(result)
  }

  async function finishShare(result) {
    if (!result) return
    await refreshSessions()
    setStatus(result.copied ? 'Copied' : result.copyAttempted ? 'Copy failed' : 'share link ready')
  }

  async function joinSharedSession() {
    if (!sharingAvailable()) return
    await ensureTerminalReady()
    const result = await showJoinWizard(els.joinLink)
    if (!result) return
    if (state.devb) {
      startDevTerminalLog('join')
      devLog('join link submitted')
    }
    const pending = addPendingJoin(result)
    selectPendingJoin(pending)
    setStatus('joining shared session')
    api
      .invoke('share.join', { uri: result.uri })
      .then((status) => {
        if (status && status.linkId) pending.linkId = status.linkId
      })
      .catch((err) => {
        state.pendingJoins = state.pendingJoins.filter(
          (join) => join.sessionId !== pending.sessionId
        )
        if (state.selectedId === pending.sessionId) {
          showNoSessionSelected().catch(showError)
        }
        renderSessions()
        showError(err)
      })
  }

  async function toggleInputMode() {
    if (!state.selectedId || !state.currentSession || !state.currentSession.active) return
    const current = state.sessions.find((session) => session.sessionId === state.selectedId)
    const mode = current && current.inputMode === 'all' ? 'host' : 'all'
    if (mode === 'all') {
      const confirmed = await askConfirm('⚠️ Allow all viewers to control the session keyboard?', {
        okText: 'Share Keyboard',
        danger: true,
        anchor: els.inputMode,
        align: 'right'
      })
      if (!confirmed) return
    }
    await api.invoke('share.setInputMode', { sessionId: state.selectedId, mode })
    await refreshSessions()
    updateTransportControls()
    setStatus(mode === 'all' ? 'viewer input enabled' : 'host input only')
  }

  // Each of our own sessions keeps the font size it was last shown with (the
  // engine stores what session.resize reports), so selecting or extending it
  // fits the same grid again instead of whatever size another session left.
  function adoptSessionFontSize(session) {
    const size = Number(session && session.fontSize)
    if (!Number.isFinite(size) || size <= 0) return
    state.liveFontSize = clamp(Math.round(size), MIN_LIVE_FONT_SIZE, MAX_LIVE_FONT_SIZE)
  }

  // The engine emits no list change for a font size, so keep the cached rows
  // current; otherwise switching away and back would restore the old size.
  function rememberSessionFontSize(sessionId, fontSize) {
    for (const session of [state.currentSession, ...state.sessions]) {
      if (session && session.sessionId === sessionId) session.fontSize = fontSize
    }
  }

  function canZoomLiveFontSize() {
    return (canResizeSelectedLiveSession() && state.mode === 'live') || isDevLogTerminalVisible()
  }

  // Returns whether the size actually moved, so a keyboard zoom only flashes
  // the button when something happened.
  async function adjustLiveFontSize(delta) {
    const canResizeSession = canResizeSelectedLiveSession() && state.mode === 'live'
    const canResizeDevTerminal = isDevLogTerminalVisible()
    if (!canResizeSession && !canResizeDevTerminal) return false
    const next = clamp(
      Math.round(state.liveFontSize + delta),
      MIN_LIVE_FONT_SIZE,
      MAX_LIVE_FONT_SIZE
    )
    if (next === state.liveFontSize) return false
    state.liveFontSize = next
    fitLiveTerminal()
    if (canResizeSession) {
      rememberSessionFontSize(state.selectedId, next)
      await api.invoke('session.resize', {
        sessionId: state.selectedId,
        ...dimensions(),
        fontSize: next
      })
    }
    updateTransportControls()
    setStatus(`font size ${next}px`)
    return true
  }

  // Ctrl and the zoom keys: '=' is the unshifted key that carries '+', and a
  // numeric keypad reports 'Add'/'Subtract' on some platforms.
  function ctrlZoomDelta(event) {
    if (!state.ctrlZoom || !event) return 0
    // xterm's own input is a hidden textarea, so only other fields count as
    // typing somewhere else.
    const target = event.target
    const inTerminal = !!(target && target.closest && target.closest('#terminal'))
    if (!inTerminal && isEditableTarget(target)) return 0
    // Nothing to zoom, so the chord stays the terminal's to send.
    if (!canZoomLiveFontSize()) return 0
    if (event.key === '+' || event.key === '=' || event.key === 'Add') return 1
    if (event.key === '-' || event.key === '_' || event.key === 'Subtract') return -1
    return 0
  }

  // Mirrors the "+ Font" / "- Font" buttons, and flashes the one it stood in
  // for so the keyboard shortcut is visibly the same action.
  async function zoomLiveFontSize(delta) {
    const changed = await adjustLiveFontSize(delta)
    if (!changed) return
    flashButton(
      delta > 0 ? els.fontSizeIncrease : els.fontSizeDecrease,
      'zoom-flash',
      ZOOM_FLASH_MS
    )
  }

  async function handleApprovalRequest(request) {
    if (!request || !request.sessionId || !request.requestId) return
    const deviceName = request.deviceName || 'viewer'
    // Phase 5 runs the identity gate before approval:pending, so the requester
    // always has a settled status here - never 'pending'.
    const peer = peerIdentityEntry(request.identityKey) || {
      identityKey: request.identityKey || '',
      status: 'unknown'
    }
    const status = identityStatusOf(peer)
    setStatus(`approval pending from ${identityDisplayText(peer)}`)
    const approved = await askConfirm(`Approve ${deviceName}?`, {
      okText: 'Approve',
      cancelText: 'Deny',
      // The same line the Join dialog shows, fed from the settled handshake
      // outcome instead of an invite. A requester whose claim failed cannot be
      // approved at all - `identity` disables the OK button on its own.
      identity: {
        status,
        displayId: identityDisplayText(peer),
        provider: peer.provider,
        subject: peer.subject,
        sshFingerprint: peer.sshFingerprint,
        reason: peer.failureReason,
        claimed: !!(peer.provider && peer.provider !== 'unknown')
      },
      warning:
        status === 'unknown' && request.linkType === 'group'
          ? 'WARNING: until we add user authentication, YOU CANT TELL WHO IS REALLY JOINING VIA A GROUP LINK'
          : '',
      popupId: approvalPopupId(request.sessionId, request.requestId),
      ...approvalAnchor(request.sessionId)
    })
    if (approved && approved.external) {
      if (approved.action === 'cancelled') {
        setStatus(`${deviceName} left before a decision`)
      } else {
        setStatus(approved.action === 'approve' ? `${deviceName} approved` : `${deviceName} denied`)
      }
      return
    }
    await api.invoke(approved ? 'share.approveJoin' : 'share.denyJoin', {
      sessionId: request.sessionId,
      requestId: request.requestId
    })
    setStatus(approved ? `${deviceName} approved` : `${deviceName} denied`)
  }

  // The Share button acts on the selected session, so a request for it opens
  // there; a request for any other session opens under that session's row.
  function approvalAnchor(sessionId) {
    if (sessionId === state.selectedId) return { anchor: els.shareSession, align: 'right' }
    const row = Array.from(els.sessions.querySelectorAll('.session-row')).find(
      (item) => item.dataset.sessionId === sessionId
    )
    return row ? { anchor: row, align: 'left' } : {}
  }

  function approvalPopupId(sessionId, requestId) {
    return `share-approval:${sessionId}:${requestId}`
  }

  function resolveExternalPopup(resolution) {
    if (!resolution || !resolution.popupId) return
    if (resolution.type === 'profile-picker') {
      completeProfileSelection(resolution.selected)
      return
    }
    const resolve = state.popupResolvers.get(resolution.popupId)
    if (!resolve) return
    resolve({ external: true, action: resolution.action, resolution })
  }

  function handlePopupFill(message) {
    if (!message || message.popupId !== 'profile-picker') return
    if (typeof message.name !== 'string') return
    els.profileName.value = message.name
    els.profileName.dispatchEvent(new Event('input', { bubbles: true }))
    api
      .invoke('debug.popupFilled', { popupId: message.popupId, name: message.name })
      .catch(() => {})
  }

  async function toggleHd() {
    if (!state.selectedId || state.mode !== 'live') return
    const result = await api.invoke('session.setHd', {
      sessionId: state.selectedId,
      enabled: !state.hd
    })
    state.hd = !!result.hd
    updateTransportControls()
    setStatus(state.hd ? 'live HD' : 'live')
  }

  async function togglePlay() {
    if (isSeekWaiting()) return
    if (state.pendingLiveRevealSession) {
      await showRevealedLiveStream()
      return
    }
    if (!state.selectedId || state.mode !== 'playback' || !state.playerReady) return
    if (state.playbackPlaying) {
      freezePlaybackClock()
      await api.invoke('player.pause', { sessionId: state.selectedId })
      clearPlaybackWrites()
      updateTransportControls()
    } else {
      cancelPendingSeek()
      state.mode = 'playback'
      if (
        !(state.currentSession && state.currentSession.active) &&
        state.playbackClockTs >= currentPlaybackEndTs() - 250
      ) {
        const frame = await api.invoke('player.seek', {
          sessionId: state.selectedId,
          tsMs: state.playbackStartTs
        })
        renderFrame(frame)
      }
      await api.invoke('player.play', {
        sessionId: state.selectedId,
        speed: Number(els.speed.value),
        collapse: playbackCollapseOptions()
      })
      startPlaybackClock(Number(els.speed.value))
      updateTransportControls()
    }
  }

  function playbackCollapseOptions() {
    return {
      enabled: !!state.timeCollapse.enabled,
      thresholdMs: state.timeCollapse.thresholdMs
    }
  }

  async function changePlaybackSpeed() {
    if (!state.selectedId || state.mode !== 'playback' || !state.playerReady) return
    if (!state.playbackPlaying) return
    updatePlaybackClock(currentRunningPlaybackTs())
    await api.invoke('player.play', {
      sessionId: state.selectedId,
      speed: Number(els.speed.value),
      collapse: playbackCollapseOptions()
    })
    startPlaybackClock(Number(els.speed.value))
  }

  async function step(delta) {
    if (!state.selectedId) return
    if (state.mode === 'live') {
      if (delta >= 0 || !state.currentSession || !state.currentSession.active) return
      cancelPendingSeek()
      stopPlaybackClock()
      clearPlaybackWrites()
      await enterPlaybackMode(state.selectedId)
    }
    if (state.mode !== 'playback' || !state.playerReady) return
    cancelPendingSeek()
    stopPlaybackClock()
    clearPlaybackWrites()
    const frame = await api.invoke('player.step', { sessionId: state.selectedId, delta })
    renderFrame(frame)
  }

  function beginScrub() {
    if (state.mode !== 'playback' && state.mode !== 'live') return
    state.seek.dragging = true
    state.seek.hovering = false
    state.seek.resumeAfterScrub =
      state.mode === 'live' || (state.mode === 'playback' && state.playbackPlaying)
    els.scrubberTip.hidden = false
    updateDragTime()
  }

  function commitScrub() {
    if (!state.seek.dragging) return
    state.seek.dragging = false
    els.scrubberTip.hidden = true
    els.scrubber.blur()
    focusPrimaryTarget()
    if (
      state.currentSession &&
      state.currentSession.active &&
      Number(els.scrubber.value) >= SCRUBBER_STEPS
    ) {
      goLive().catch(showError)
      return
    }
    scheduleScrubberSeek({ force: true })
  }

  function canWheelSeek() {
    return !!(
      state.selectedId &&
      state.timeline.length &&
      (state.mode === 'playback' || state.mode === 'live') &&
      els.playback &&
      !els.playback.hidden
    )
  }

  // A two-finger horizontal drag is easy to produce by accident while
  // scrolling vertically at an angle.  Only let it seek once the user is
  // already in playback; in live mode refuse it and flash the affordance
  // that explains why nothing moved.
  function wheelSeekRefusedInLive() {
    if (state.mode !== 'live') return false
    flashInputBlockedButtons([els.stepBack, els.goLive])
    return true
  }

  function normalizedWheelDelta(value, mode) {
    if (mode === 1) return value * 16
    if (mode === 2) return value * 800
    return value
  }

  function scrubberWheelSteps(event) {
    const rect = els.scrubber.getBoundingClientRect()
    const width = rect.width || 300
    const dx = normalizedWheelDelta(event.deltaX, event.deltaMode)
    const dy = normalizedWheelDelta(event.deltaY, event.deltaMode)
    const raw = Math.abs(dx) >= Math.abs(dy) ? dx : dy
    return (raw / width) * SCRUBBER_STEPS * WHEEL_SCRUB_SENSITIVITY
  }

  function applyScrubberWheelSteps(steps) {
    if (!steps) return
    if (!state.seek.dragging) beginScrub()
    const current = Number(els.scrubber.value)
    const next = clamp(Math.round(current + steps), 0, SCRUBBER_STEPS)
    els.scrubber.value = next
    scheduleScrubberSeek()
    if (state.seek.wheelTimer) window.clearTimeout(state.seek.wheelTimer)
    state.seek.wheelTimer = window.setTimeout(() => {
      state.seek.wheelTimer = null
      commitScrub()
    }, 220)
  }

  function handleScrubberWheel(event) {
    if (!canWheelSeek()) return
    event.preventDefault()
    if (wheelSeekRefusedInLive()) return
    applyScrubberWheelSteps(scrubberWheelSteps(event))
  }

  function handleGlobalScrubberWheel(event) {
    if (event.defaultPrevented) return
    if (!canWheelSeek()) return
    if (els.scrubber.contains(event.target)) return
    const dx = normalizedWheelDelta(event.deltaX, event.deltaMode)
    const dy = normalizedWheelDelta(event.deltaY, event.deltaMode)
    const horizontal = Math.abs(dx) > Math.abs(dy)
    if (!horizontal && !(event.shiftKey && dy)) return
    event.preventDefault()
    event.stopPropagation()
    if (wheelSeekRefusedInLive()) return
    applyScrubberWheelSteps(scrubberWheelSteps(event))
  }

  function scheduleScrubberSeek(options = {}) {
    if (!state.selectedId || !state.timeline.length) return
    if (state.mode === 'playback' && !state.playerReady) return
    const force = options && options.force === true
    state.seek.pendingValue = Number(els.scrubber.value)
    state.seek.version++
    if (state.seek.dragging) updateDragTime()

    if (!state.seek.pauseRequested) {
      state.seek.resumeAfterScrub =
        state.seek.resumeAfterScrub ||
        (state.seek.dragging && state.mode === 'live') ||
        (state.seek.dragging && state.mode === 'playback' && state.playbackPlaying)
      state.seek.pauseRequested = true
      state.seek.waitingForRender = true
      if (state.mode === 'playback') {
        api.invoke('player.pause', { sessionId: state.selectedId }).catch(showError)
      }
      stopPlaybackClock()
      clearPlaybackWrites()
      updateTransportControls()
    }

    if (state.seek.timer) window.clearTimeout(state.seek.timer)
    const now = Date.now()
    const movedEnough =
      Math.abs(state.seek.pendingValue - state.seek.lastDrawValue) >= SEEK_MOVEMENT_THRESHOLD
    const overdue = movedEnough && now - state.seek.lastDrawAt >= SEEK_MAX_RENDER_MS
    const delay = force || overdue ? 0 : SEEK_IDLE_MS

    state.seek.timer = window.setTimeout(() => {
      state.seek.timer = null
      seekFromScrubber(state.seek.version).catch(showError)
    }, delay)
  }

  async function seekFromScrubber(version) {
    if (!state.selectedId || !state.timeline.length) return
    if (state.seek.inFlight) {
      queueSeekRetry()
      return
    }
    state.seek.inFlight = true
    const sessionId = state.selectedId
    const scrubberValue = state.seek.pendingValue
    const tsMs = tsForScrubberValue(scrubberValue)
    let refreshControlsAfterSeek = false
    try {
      if (state.mode === 'live') await enterPlaybackMode(sessionId)
      if (version !== state.seek.version || sessionId !== state.selectedId) return
      if (!state.playerReady) return
      const frame = await api.invoke('player.seek', { sessionId, tsMs })
      if (version !== state.seek.version || sessionId !== state.selectedId) return
      state.seek.lastDrawAt = Date.now()
      state.seek.lastDrawValue = scrubberValue
      renderFrame(frame)
      if (!state.seek.dragging && state.seek.resumeAfterScrub) {
        state.seek.resumeAfterScrub = false
        state.seek.pauseRequested = false
        await resumePlayback()
      } else if (!state.seek.dragging) {
        state.seek.pauseRequested = false
        state.seek.waitingForRender = false
        refreshControlsAfterSeek = true
      }
    } catch (err) {
      if (!state.seek.dragging) {
        state.seek.pauseRequested = false
        state.seek.resumeAfterScrub = false
        state.seek.waitingForRender = false
        refreshControlsAfterSeek = true
      }
      throw err
    } finally {
      state.seek.inFlight = false
      if (version !== state.seek.version) queueSeekRetry(0)
      else if (!state.seek.dragging && !state.seek.timer) {
        state.seek.pauseRequested = false
        state.seek.waitingForRender = false
        if (refreshControlsAfterSeek) updateTransportControls()
        else updateTransportControls()
      } else if (refreshControlsAfterSeek) updateTransportControls()
    }
  }

  function queueSeekRetry(delay = SEEK_IDLE_MS) {
    if (state.seek.timer) window.clearTimeout(state.seek.timer)
    state.seek.timer = window.setTimeout(() => {
      state.seek.timer = null
      seekFromScrubber(state.seek.version).catch(showError)
    }, delay)
  }

  function cancelPendingSeek() {
    state.seek.version++
    state.seek.pauseRequested = false
    state.seek.resumeAfterScrub = false
    state.seek.waitingForRender = false
    state.seek.dragging = false
    if (state.seek.timer) window.clearTimeout(state.seek.timer)
    state.seek.timer = null
  }

  function configureScrubber(options = {}) {
    const startTs =
      options.startTs !== undefined
        ? options.startTs
        : state.timeline.length
          ? state.timeline[0].tsMs
          : 0
    const endTs =
      options.endTs !== undefined
        ? options.endTs
        : state.timeline.length
          ? state.timeline[state.timeline.length - 1].tsMs
          : startTs
    const value = options.value !== undefined ? options.value : SCRUBBER_STEPS
    els.scrubber.min = 0
    els.scrubber.max = SCRUBBER_STEPS
    els.scrubber.value = value
    state.playbackStartTs = startTs
    state.playbackEndTs = endTs
    state.playbackClockTs = tsForScrubberValue(value)
    state.seek.pendingValue = value
    state.seek.lastDrawValue = value
    state.seek.lastDrawAt = Date.now()
    if (!options.preserveDragging) {
      state.seek.dragging = false
      els.scrubberTip.hidden = true
    }
    updateTimeLabels()
  }

  function savedScrubberValue(sessionId, bounds = {}) {
    const tsMs = state.playbackPositions.get(sessionId)
    if (tsMs === undefined) return SCRUBBER_STEPS
    const first =
      bounds.startTs !== undefined
        ? bounds.startTs
        : state.timeline.length
          ? state.timeline[0].tsMs
          : 0
    const last =
      bounds.endTs !== undefined
        ? bounds.endTs
        : state.timeline.length
          ? state.timeline[state.timeline.length - 1].tsMs
          : first
    const collapseMap = getTimeCollapseMap(first, last)
    if (collapseMap) {
      if (collapseMap.compressedSpan <= 0) return SCRUBBER_STEPS
      const compTs = realToCompressed(collapseMap, tsMs)
      return clamp(
        Math.round((compTs / collapseMap.compressedSpan) * SCRUBBER_STEPS),
        0,
        SCRUBBER_STEPS
      )
    }
    const span = last - first
    if (span <= 0) return SCRUBBER_STEPS
    return clamp(Math.round(((tsMs - first) / span) * SCRUBBER_STEPS), 0, SCRUBBER_STEPS)
  }

  function savePlaybackPosition() {
    if (!state.selectedId || !state.timeline.length) return
    state.playbackPositions.set(state.selectedId, state.playbackClockTs)
  }

  async function enterPlaybackMode(sessionId) {
    if (state.mode === 'playback') return
    const startTs = state.playbackStartTs
    const endTs = state.playbackEndTs
    stopPlaybackClock()
    state.mode = 'playback'
    state.playerReady = false
    setStatus('playback')
    updateTransportControls()
    const player = await api.invoke('player.open', { sessionId })
    state.playerReady = true
    setTimeline(player.timeline)
    state.availability = player.availability || availabilityFromTimeline()
    const value = Number(els.scrubber.value)
    configureScrubber({
      value,
      startTs,
      endTs: state.currentSession && state.currentSession.active ? Date.now() : endTs,
      preserveDragging: state.seek.dragging
    })
  }

  function startSessionClock() {
    if (state.sessionClockTimer) window.clearInterval(state.sessionClockTimer)
    state.sessionClockTimer = window.setInterval(() => {
      if (!state.currentSession || !state.currentSession.active) return
      if (state.mode === 'live') updateLiveClock()
      else updateActivePlaybackBounds()
    }, 1000)
  }

  async function resumePlayback() {
    if (!state.selectedId || state.mode !== 'playback') return
    await api.invoke('player.play', {
      sessionId: state.selectedId,
      speed: Number(els.speed.value),
      collapse: playbackCollapseOptions()
    })
    state.seek.waitingForRender = false
    startPlaybackClock(Number(els.speed.value))
    updateTransportControls()
  }

  function startPlaybackClock(speed) {
    stopPlaybackClock()
    state.playbackPlaying = true
    state.clockSpeed = speed || 1
    state.clockStartedAt = performance.now()
    state.clockStartedTs = state.playbackClockTs
    tickPlaybackClock()
  }

  function currentRunningPlaybackTs() {
    if (!state.playbackPlaying) return state.playbackClockTs
    const elapsed = (performance.now() - state.clockStartedAt) * state.clockSpeed
    return clamp(state.clockStartedTs + elapsed, state.playbackStartTs, currentPlaybackEndTs())
  }

  function stopPlaybackClock() {
    state.playbackPlaying = false
    if (state.clockFrame) window.cancelAnimationFrame(state.clockFrame)
    state.clockFrame = 0
    updateTransportControls()
  }

  function freezePlaybackClock() {
    if (!state.playbackPlaying) {
      stopPlaybackClock()
      return
    }
    const elapsed = (performance.now() - state.clockStartedAt) * state.clockSpeed
    updatePlaybackClock(
      clamp(state.clockStartedTs + elapsed, state.playbackStartTs, currentPlaybackEndTs())
    )
    stopPlaybackClock()
  }

  function tickPlaybackClock() {
    if (!state.playbackPlaying) return
    const elapsed = (performance.now() - state.clockStartedAt) * state.clockSpeed
    const tsMs = clamp(
      state.clockStartedTs + elapsed,
      state.playbackStartTs,
      currentPlaybackEndTs()
    )
    updatePlaybackClock(tsMs)
    if (tsMs >= currentPlaybackEndTs()) {
      stopPlaybackClock()
      updateTransportControls()
      return
    }
    state.clockFrame = window.requestAnimationFrame(tickPlaybackClock)
  }

  function updatePlaybackClockFromPacket(tsMs) {
    if (!tsMs) return
    state.clockStartedTs = tsMs
    state.clockStartedAt = performance.now()
    updatePlaybackClock(tsMs)
  }

  function enqueuePlaybackWrite(packet) {
    state.playbackWrites.queue.push(packet)
    drainPlaybackWrites()
  }

  function drainPlaybackWrites() {
    if (state.playbackWrites.active || !state.playbackWrites.queue.length) return
    if (!state.term || state.mode !== 'playback' || state.seek.inFlight) {
      clearPlaybackWrites()
      return
    }
    const version = state.playbackWrites.version
    const packet = state.playbackWrites.queue.shift()
    state.hd = !!packet.hd
    updateTransportControls()
    if (packet.kind === 1 && packet.cols && packet.rows) {
      state.playbackFrame = {
        ...(state.playbackFrame || {}),
        cols: packet.cols,
        rows: packet.rows,
        hd: !!packet.hd,
        tsMs: packet.tsMs || state.playbackClockTs
      }
      fitPlaybackFrame(packet)
    }

    const finish = () => {
      if (version !== state.playbackWrites.version) return
      state.playbackWrites.active = false
      updatePlaybackClockFromPacket(packet.tsMs)
      drainPlaybackWrites()
    }

    if (!packet.data) {
      finish()
      return
    }
    state.playbackWrites.active = true
    state.term.write(new Uint8Array(packet.data), finish)
  }

  function clearPlaybackWrites() {
    state.playbackWrites.version++
    state.playbackWrites.active = false
    state.playbackWrites.queue = []
  }

  function enqueueLiveWrite(packet) {
    state.liveWrites.queue.push(packet)
    drainLiveWrites()
  }

  function drainLiveWrites() {
    if (state.liveWrites.active || !state.liveWrites.queue.length) return
    if (!state.term || state.mode !== 'live') {
      clearLiveWrites({ ack: true })
      return
    }

    const sessionId = state.selectedId
    const chunks = []
    let bytes = 0
    let hd = state.hd
    while (state.liveWrites.queue.length) {
      const packet = state.liveWrites.queue[0]
      if (packet.sessionId !== sessionId) break
      if (chunks.length && bytes + packet.data.byteLength > LIVE_WRITE_MAX_BATCH_BYTES) break
      state.liveWrites.queue.shift()
      chunks.push(packet.data)
      bytes += packet.data.byteLength
      hd = !!packet.hd
    }
    if (!chunks.length) {
      clearLiveWrites({ ack: true })
      return
    }

    const version = state.liveWrites.version
    state.liveWrites.active = true
    state.hd = hd
    state.term.write(concatUint8Arrays(chunks, bytes), () => {
      ackSessionData(sessionId, bytes)
      if (version !== state.liveWrites.version) return
      state.liveWrites.active = false
      drainLiveWrites()
    })
  }

  function clearLiveWrites(options = {}) {
    const ack = options.ack === true
    const queued = state.liveWrites.queue.splice(0)
    state.liveWrites.version++
    state.liveWrites.active = false
    if (!ack) return
    for (const packet of queued) {
      if (packet && packet.sessionId) ackSessionData(packet.sessionId, packet.data.byteLength)
    }
  }

  function concatUint8Arrays(chunks, totalBytes) {
    if (chunks.length === 1) return chunks[0]
    const out = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  }

  function ackSessionData(sessionId, bytes) {
    api.invoke('session.ack', { sessionId, bytes }).catch(showError)
  }

  // Joined sessions download their history in the background, and a local
  // session created with copied history (copyHistoryFrom) copies it in the
  // same way; both report progress through `availability`.
  function tracksAvailability() {
    if (isJoinedSession()) return true
    const availability = state.availability
    return !!availability && availability.logLength > availability.availableLength
  }

  function scheduleJoinedAvailabilityRefresh(sessionId) {
    if (sessionId !== state.selectedId || !tracksAvailability()) return
    if (state.joinedRefreshTimer) return
    state.joinedRefreshTimer = window.setTimeout(() => {
      state.joinedRefreshTimer = 0
      refreshJoinedAvailability(sessionId).catch(showError)
    }, 350)
  }

  async function refreshJoinedAvailability(sessionId) {
    if (sessionId !== state.selectedId || !tracksAvailability()) return
    // Timeline and availability only: the screen (a serialised 5000-line
    // mirror) is not used here, and building it every 350 ms during a flood
    // is what timed the worker out.
    const opened = await api.invoke('session.open', { sessionId, frame: false })
    if (sessionId !== state.selectedId || !tracksAvailability()) return
    if (opened.timeline) setTimeline(opened.timeline)
    state.availability = opened.availability || state.availability
    if (state.currentSession && opened.active !== undefined) {
      state.currentSession.active = !!opened.active
    }
    if (state.mode === 'live') updateLiveClock()
    else {
      state.playbackEndTs = currentPlaybackEndTs()
      renderScrubberIndicators()
      updateTimeLabels()
    }
  }

  function updateLiveClock() {
    if (state.mode !== 'live' || !state.currentSession) return
    const now = Date.now()
    state.playbackEndTs = now
    state.playbackClockTs = now
    if (!state.timeline.length) {
      setTimeline([{ seq: 0, tsMs: state.currentSession.startedAt || now }])
    }
    if (!tracksAvailability()) state.availability = availabilityFromTimeline()
    updateTimeLabels()
    if (!state.seek.dragging) els.scrubber.value = SCRUBBER_STEPS
    updateTransportControls()
  }

  function updateActivePlaybackBounds() {
    if (!state.currentSession || !state.currentSession.active) return
    const now = Date.now()
    const startedAt = state.currentSession.startedAt || state.playbackStartTs || now
    state.playbackStartTs = state.playbackStartTs || startedAt
    state.playbackEndTs = Math.max(state.playbackEndTs, now)
    if (!state.timeline.length) setTimeline([{ seq: 0, tsMs: startedAt }])
    if (!tracksAvailability()) state.availability = availabilityFromTimeline()
    state.playbackClockTs = clamp(
      state.playbackClockTs || startedAt,
      state.playbackStartTs,
      state.playbackEndTs
    )
    updateTimeLabels()
    if (!state.seek.dragging) els.scrubber.value = scrubberValueForTs(state.playbackClockTs)
    updateTransportControls()
  }

  function updatePlaybackClock(tsMs) {
    if (!state.timeline.length) return
    state.playbackClockTs = clamp(tsMs, state.playbackStartTs, currentPlaybackEndTs())
    if (state.selectedId) state.playbackPositions.set(state.selectedId, state.playbackClockTs)
    updateTimeLabels()
    if (state.seek.dragging) return
    els.scrubber.value = scrubberValueForTs(state.playbackClockTs)
    updateTransportControls()
  }

  function updateTransportControls() {
    const current = state.sessions.find((session) => session.sessionId === state.selectedId)
    const isPending = !!(current && current.pending)
    const hasSession = !!state.selectedId && !isPending
    const hasPendingLiveReveal = !!state.pendingLiveRevealSession
    const isActiveSession = !!(state.currentSession && state.currentSession.active)
    const isLive = state.mode === 'live'
    const isPlayback = state.mode === 'playback'
    const isRunningPlayback = isPlayback && state.playbackPlaying
    const canUsePlaybackControls = hasSession && isPlayback
    const canUseOpenPlayer = canUsePlaybackControls && state.playerReady
    const canStepBack = canUseOpenPlayer || (hasSession && isLive && isActiveSession)
    const canGoLive = hasSession && isActiveSession && !isLive
    const joined = isJoinedSession()
    const canToggleHd = hasSession && isLive && isActiveSession && !joined
    const canShare = hasSession && isActiveSession && !joined
    const devLogTerminalVisible = isDevLogTerminalVisible()
    const canShowInputMode = hasSession && !devLogTerminalVisible
    const canAdjustSessionFont = isLive && canResizeSelectedLiveSession()
    const canAdjustFont = canAdjustSessionFont || devLogTerminalVisible
    const hideSessionActions = devLogTerminalVisible || !hasSession
    const canExtend = hasSession && canExtendSession(current)
    const canRemoveHd = hasSession && !isActiveSession && sessionHasHd()
    const isPausedPlayback = canUsePlaybackControls && !isRunningPlayback
    const isInputShared = !!(current && current.inputMode === 'all')
    const seekWaiting = isSeekWaiting()
    const liveRole = sessionLiveRoleClass(current)

    if (!isPlayback) state.playbackPlaying = false

    els.rename.disabled = !hasSession
    els.clearCaches.disabled = !hasSession
    els.delete.disabled = !hasSession && !isPending
    els.removeHd.disabled = !canRemoveHd
    // Enabled only once the shell has exited while this session is open (a
    // closed session is extended on entry); flashes while an extend is running.
    const extending = hasSession && !!state.restoring
    els.extendSession.disabled = !canExtend || extending
    els.extendSession.classList.toggle('extending', extending)
    els.playback.hidden = !hasSession && !hasPendingLiveReveal
    els.stepBack.disabled = !canStepBack
    els.stepForward.disabled = !canUseOpenPlayer
    els.playPause.disabled = !canUseOpenPlayer && !hasPendingLiveReveal
    els.speed.disabled = !canUseOpenPlayer
    els.goLive.disabled = !canGoLive
    els.fontSizeDecrease.disabled = !canAdjustFont || state.liveFontSize <= MIN_LIVE_FONT_SIZE
    els.fontSizeIncrease.disabled = !canAdjustFont || state.liveFontSize >= MAX_LIVE_FONT_SIZE
    els.shareSession.disabled = !canShare
    els.inputMode.disabled = !canShare
    els.goLive.hidden = hideSessionActions
    els.hdToggle.hidden = hideSessionActions
    const canOfferSharing = sharingAvailable()
    els.shareSession.hidden = hideSessionActions || !isActiveSession || !isLive || !canOfferSharing
    els.fontSizeDecrease.hidden = !canAdjustFont
    els.fontSizeIncrease.hidden = !canAdjustFont
    els.inputMode.hidden = !canShowInputMode || !canOfferSharing
    els.extendSession.hidden = hideSessionActions || !(canExtend || extending)
    els.hdToggle.disabled = !canToggleHd
    els.scrubber.disabled = !hasSession

    setIconOnly(
      els.playPause,
      seekWaiting ? 'fa-hourglass-half' : isRunningPlayback ? 'fa-pause' : 'fa-play'
    )
    els.playPause.title = hasPendingLiveReveal
      ? 'Show live stream'
      : seekWaiting
        ? 'Preparing playback'
        : isRunningPlayback
          ? 'Pause'
          : 'Play'
    els.playPause.classList.toggle('mode-live', isPausedPlayback && !seekWaiting)
    els.playPause.classList.toggle('mode-pause', isRunningPlayback && !seekWaiting)
    els.playPause.classList.toggle('transport-waiting', seekWaiting)
    els.hdToggle.classList.toggle('mode-hd', !!state.hd)
    setButtonLabel(els.hdToggle, 'fa-rocket', state.hd ? 'HD on' : 'HD')
    els.hdToggle.title = isPlayback
      ? 'HD state follows recorded packets during playback'
      : isJoinedSession()
        ? state.hd
          ? 'Live shared feed is HD'
          : 'Live shared feed is not HD'
        : state.hd
          ? 'Disable HD recording'
          : 'Enable HD recording'
    els.goLive.classList.toggle('live-on', isLive && hasSession)
    els.goLive.classList.toggle('live-joined', liveRole === 'live-joined')
    els.goLive.classList.toggle('live-host', liveRole === 'live-host')
    els.goLive.classList.toggle('live-beacon', canGoLive)
    els.totalTime.classList.toggle('live-total', isLive && isActiveSession)
    const isLiveInputShared = isInputShared && isLive && isActiveSession
    els.inputMode.classList.toggle('input-shared', isLiveInputShared && !joined)
    els.inputMode.classList.toggle('input-shared-viewer', isLiveInputShared && joined)
    setButtonLabel(els.fontSizeDecrease, 'fa-minus', 'Font')
    setButtonLabel(els.fontSizeIncrease, 'fa-plus', 'Font')
    els.fontSizeDecrease.title = 'Decrease terminal font size'
    els.fontSizeIncrease.title = 'Increase terminal font size'
    setButtonLabel(
      els.inputMode,
      'fa-keyboard',
      !isActiveSession ? 'Offline' : isInputShared ? 'Shared' : joined ? 'Host' : 'Local'
    )
    els.inputMode.title = !isActiveSession
      ? 'Offline session'
      : isInputShared
        ? isLive
          ? 'Shared keyboard'
          : 'Shared keyboard is available only while live'
        : 'Host keyboard only'
    setButtonLabel(els.goLive, sessionLiveIcon(current, { keyboardShared: true }).icon, 'Live')
    els.goLive.title = canGoLive ? 'Show live session' : 'Live session'
    setButtonLabel(els.shareSession, 'fa-share-nodes', 'Share')
    els.shareSession.title = 'Share session'
    renderScrubberIndicators()
  }

  function setButtonLabel(button, icon, label) {
    if (!button) return
    const iconEl = button.querySelector('.btn-icon')
    const labelEl = button.querySelector('.btn-icon + span')
    if (iconEl && labelEl) {
      iconEl.className = `fa-solid ${icon} btn-icon`
      labelEl.textContent = label
      return
    }
    button.textContent = `${icon} ${label}`
  }

  function setIconOnly(button, icon) {
    if (!button) return
    let iconEl = button.querySelector('i')
    if (!iconEl) {
      button.replaceChildren()
      iconEl = document.createElement('i')
      iconEl.setAttribute('aria-hidden', 'true')
      button.append(iconEl)
    }
    iconEl.className = `fa-solid ${icon}`
  }

  function isSeekWaiting() {
    return (
      !!state.seek.waitingForRender ||
      !!state.seek.inFlight ||
      !!state.seek.timer ||
      !!state.seek.pauseRequested
    )
  }

  function sessionHasHd() {
    return state.timeline.some((item) => item && item.hd)
  }

  function isJoinedSession() {
    const current = state.sessions.find((session) => session.sessionId === state.selectedId)
    return !!(current && (current.isJoined || current.owner === 'joined'))
  }

  function canPasteToTerminal() {
    return canInputToTerminal()
  }

  function canInputToTerminal() {
    const current = state.sessions.find((session) => session.sessionId === state.selectedId)
    if (!current || current.pending || !current.active || state.mode !== 'live') return false
    return !(current.isJoined || current.owner === 'joined') || current.inputMode === 'all'
  }

  function flashPlaybackInputBlockedFromKey(event) {
    if (!shouldFlashPlaybackInputBlocked(event)) return
    flashPlaybackInputBlocked()
  }

  function shouldFlashPlaybackInputBlocked(event) {
    if (!event || event.defaultPrevented || event.isComposing) return false
    if (!state.selectedId || state.mode !== 'playback') return false
    if (event.ctrlKey || event.metaKey || event.altKey) return false
    if (isEditableTarget(event.target)) return false
    return isTerminalInputKey(event.key)
  }

  function isTerminalInputKey(key) {
    if (!key) return false
    if (key.length === 1) return true
    return (
      key === 'Enter' ||
      key === 'Backspace' ||
      key === 'Delete' ||
      key === 'Insert' ||
      key === 'Home' ||
      key === 'End' ||
      key === 'PageUp' ||
      key === 'PageDown' ||
      key.startsWith('Arrow')
    )
  }

  function isEditableTarget(target) {
    if (!target || !target.closest) return false
    return !!target.closest('input, textarea, select, [contenteditable="true"]')
  }

  function flashPlaybackInputBlocked() {
    flashInputBlockedButtons([els.inputMode, els.goLive])
  }

  function flashInputBlockedButtons(buttons) {
    for (const button of buttons) flashInputBlockedButton(button)
  }

  function flashInputBlockedButton(button) {
    flashButton(button, 'input-blocked-flash', INPUT_BLOCKED_FLASH_MS)
  }

  function flashButton(button, className, duration) {
    if (!button || button.hidden) return
    const running = state.blockedFlashTimers.get(button)
    if (running) {
      window.clearTimeout(running.timer)
      button.classList.remove(running.className)
    }
    // Force style recalculation so repeated keystrokes restart the animation.
    void button.offsetWidth
    button.classList.add(className)
    state.blockedFlashTimers.set(button, {
      className,
      timer: window.setTimeout(() => {
        button.classList.remove(className)
        state.blockedFlashTimers.delete(button)
      }, duration)
    })
  }

  function sessionLiveRoleClass(session) {
    if (!session || session.pending) return session && session.pending ? 'pending' : ''
    if (!session.active) return ''
    return session.isJoined || session.owner === 'joined' ? 'live-joined' : 'live-host'
  }

  function sessionLiveIcon(session, opts = {}) {
    if (!session) return { icon: 'fa-desktop', state: '' }
    if (session.pending) return { icon: 'fa-hourglass-half', state: 'pending' }
    const role = sessionLiveRoleClass(session)
    if (session.isJoined || session.owner === 'joined') return { icon: 'fa-eye', state: role }
    if (opts.keyboardShared && session.inputMode === 'all') {
      return { icon: 'fa-keyboard', state: 'input-shared' }
    }
    if (session.isSharing) return { icon: 'fa-circle-nodes', state: role || 'live-host' }
    return { icon: 'fa-desktop', state: role }
  }

  function isFailedStart(exit, uptimeMs) {
    if (!exit || !Number.isFinite(uptimeMs) || uptimeMs >= FAILED_START_MS) return false
    if (exit.signal === 'detached') return false
    return (Number.isFinite(exit.code) && exit.code !== 0) || !!exit.signal
  }

  function exitText(exit) {
    if (!exit) return 'exited'
    if (exit.signal) return `was killed by ${exit.signal}`
    return `exited with code ${exit.code}`
  }

  function failedStartStatus(exit) {
    return `${exitText(exit)} at start - edit the session command to fix it`
  }

  // Written into the terminal under the command's own output. Selecting the
  // session again is the retry; nothing retries on its own.
  function failedStartNote({ exit, uptimeMs, command }) {
    const seconds = (Math.max(0, uptimeMs) / 1000).toFixed(1)
    const lines = [
      `\x1b[1;31mZBTerm: the session command ${exitText(exit)} after ${seconds} s.\x1b[0m`,
      `\x1b[33mCommand: ${command || 'the default shell'}\x1b[0m`,
      '\x1b[33mIt will not be retried. Edit the session (row menu > Edit) to change its ' +
        'command or directory, then select it again.\x1b[0m'
    ]
    return `\r\n${lines.join('\r\n')}\r\n`
  }

  function showFailedStartNote(sessionId) {
    const failed = state.failedStart
    if (!failed || failed.sessionId !== sessionId) return
    if (sessionId !== state.selectedId || !state.term) return
    state.failedStart = null
    state.term.write(failedStartNote(failed))
    setStatus(failedStartStatus(failed.exit))
  }

  function canExtendSession(session) {
    return !!(
      session &&
      !session.pending &&
      !session.active &&
      session.owner !== 'joined' &&
      !session.isJoined
    )
  }

  function addPendingJoin(result = {}) {
    const id = `pending:${result.linkId || Date.now()}`
    const existing = state.pendingJoins.find((join) => join.sessionId === id)
    if (existing) return existing
    const pending = {
      sessionId: id,
      linkId: result.linkId || '',
      name: 'Joining shared session',
      startedAt: Date.now(),
      active: true,
      owner: 'joined',
      isJoined: true,
      pending: true,
      pendingStatus: result.status || 'connecting',
      sizeBytes: 0
    }
    state.pendingJoins.unshift(pending)
    state.sessions = [pending, ...state.sessions]
    renderSessions()
    return pending
  }

  function selectPendingJoin(session) {
    savePlaybackPosition()
    stopPlaybackClock()
    cancelPendingSeek()
    state.selectedId = session.sessionId
    state.currentSession = session
    state.mode = 'live'
    state.playerReady = false
    state.playbackPlaying = false
    setTimeline([])
    state.availability = { availableLength: 0, logLength: 0, gaps: [] }
    state.playbackFrame = null
    els.title.textContent = session.name
    els.meta.textContent = 'Joining'
    if (state.devb && state.devLogActive) {
      devLog('waiting for share approval and live stream')
      hideTerminalPending()
    } else {
      resetVisibleTerminal()
      showTerminalPending('Joining')
    }
    configureScrubber({ value: 0, startTs: session.startedAt, endTs: Date.now() })
    updateTransportControls()
    renderSessions()
  }

  // A join the share backend itself gave up on carries its `backend` and
  // `detail` (docs/CORE-CONTRACT.md, freenet-backend F9); two of them have a
  // plain sentence. The join timeout, which also says E_AUTH, names no
  // backend and keeps its own message.
  function joinFailureToast(status) {
    if (!status || !status.backend) return null
    if (status.detail === 'ice-failed') return JOIN_ICE_FAILED_TOAST
    if (status.code === 'E_AUTH') return JOIN_IDENTITY_TOAST
    return null
  }

  // One sentence for a failed join, from the engine's reason when it has one.
  function joinFailureMessage(status) {
    const reason = status && status.reason
    if (reason && JOIN_REFUSAL_TEXT[reason]) return `Join refused: ${JOIN_REFUSAL_TEXT[reason]}`
    if (reason && JOIN_FAILURE_TEXT[reason]) return `Join failed: ${JOIN_FAILURE_TEXT[reason]}`
    const message = (status && status.message) || 'could not join the shared session'
    return `Join failed: ${message}`
  }

  async function handleJoinStatus(status) {
    if (status && status.status === 'joined') {
      setStatus('joined shared session')
      state.pendingJoins = []
      await refreshSessions()
      const session = state.sessions.find((item) => item.sessionId === status.sessionId)
      if (session) {
        if (state.devb && state.devLogActive) await beginLiveReveal(session)
        else await selectSession(session)
      }
      return
    }
    if (status && status.status === 'failed') {
      const refusal = identityRefusalReason(status)
      const backendToast = joinFailureToast(status)
      const message = joinFailureMessage(status)
      // Written first, before the placeholder goes: the message is the only
      // trace of the join that is left, and it stays until clicked away.
      if (refusal) setIdentityRefusal(refusal)
      else setStickyStatus(message)
      const failed = status.linkId
        ? state.pendingJoins.filter((join) => join.linkId === status.linkId)
        : state.pendingJoins.slice()
      if (status.linkId && !failed.length && state.currentSession && state.currentSession.pending) {
        failed.push(state.currentSession)
      }
      const failedIds = new Set(failed.map((join) => join.sessionId))
      state.pendingJoins = state.pendingJoins.filter((join) => !failedIds.has(join.sessionId))
      if (
        state.currentSession &&
        state.currentSession.pending &&
        failedIds.has(state.currentSession.sessionId)
      ) {
        await showNoSessionSelected()
      }
      state.sessions = state.sessions.filter((session) => !failedIds.has(session.sessionId))
      renderSessions()
      if (refusal) return
      if (backendToast) showToast(backendToast)
      else showToast(message)
      return
    }
    if (status && status.status === 'connecting') {
      clearIdentityRefusal()
      setStatus('joining shared session')
      if (state.currentSession && state.currentSession.pending) showTerminalPending('Joining')
      return
    }
    if (status && status.status === 'approval-pending') {
      setStatus('Waiting for host approval...')
      if (state.currentSession && state.currentSession.pending) {
        state.currentSession.pendingStatus = 'approval-pending'
        showTerminalPending('Waiting for host approval...')
        renderSessions()
      }
      return
    }
    if (status && status.status === 'syncing') {
      setStatus('syncing shared session')
      if (state.currentSession && state.currentSession.pending) {
        showTerminalPending('Syncing initial frame')
      }
      return
    }
    setStatus('joining shared session')
  }

  function showTerminalPending(text) {
    if (!els.terminalPending) return
    if (els.terminalPendingText) els.terminalPendingText.textContent = text
    els.terminalPending.hidden = false
  }

  function hideTerminalPending() {
    if (els.terminalPending) els.terminalPending.hidden = true
  }

  function availabilityFromTimeline() {
    const length = state.timeline.length ? state.timeline[state.timeline.length - 1].seq : 0
    return { availableLength: length, logLength: length, gaps: [] }
  }

  function setTimeline(timeline) {
    state.timeline = Array.isArray(timeline) ? timeline : []
    state.timelineSignal.timeline = null
    state.timelineSignal.activity = null
    state.timelineSignal.history = null
    state.timelineSignal.historyAvailableLength = -1
    invalidateTimeCollapseMap()
  }

  function recordLiveActivity(sessionId, source, bytes) {
    if (source !== 'pty' && source !== 'socket') return
    const now = Date.now()
    addSignalMeasurement(liveActivityMap(sessionId, source), now, Math.max(1, bytes || 1))
  }

  async function shareAutoCopyPreference() {
    return await storedBooleanPreference(SHARE_AUTO_COPY_STORAGE_KEY, false)
  }

  // The Share wizard's option form (link type, max users, approval, Auto
  // Copy, warning) without its buttons, so the New/Copy editor can embed it.
  // `settings` is updated in place; `onChange` runs after a type is picked.
  function shareOptionsForm(initial = {}, onChange = () => {}) {
    const settings = {
      type: 'single',
      maxViewers: 2,
      requireApproval: false,
      autoCopy: false,
      ...initial
    }
    const root = document.createElement('div')
    root.className = 'share-options-form'

    const shareTypeButton = (type, label, help) => {
      const button = document.createElement('div')
      button.className = 'text-btn share-option'
      button.classList.toggle('selected', settings.type === type)
      button.setAttribute('role', 'button')
      button.tabIndex = 0
      const header = document.createElement('div')
      header.className = 'share-option-header'
      const strong = document.createElement('strong')
      strong.textContent = label
      const span = document.createElement('span')
      span.className = 'share-option-help'
      span.textContent = help
      header.append(strong)
      button.append(header, span)
      const select = () => {
        settings.type = type
        settings.requireApproval = type === 'group'
        render()
        onChange(settings)
      }
      button.addEventListener('click', select)
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          select()
        }
      })
      return button
    }

    const render = () => {
      root.replaceChildren()
      const options = document.createElement('div')
      options.className = 'share-options'
      const single = shareTypeButton('single', 'Single-use', 'One viewer can join with this link.')
      const group = shareTypeButton(
        'group',
        'Group',
        `Up to ${settings.maxViewers} viewers can join with this link.`
      )
      const maxUsersLabel = document.createElement('label')
      maxUsersLabel.className = 'share-max-users'
      maxUsersLabel.textContent = 'Max Users:'
      const maxUsersInput = document.createElement('input')
      maxUsersInput.type = 'number'
      maxUsersInput.min = '2'
      maxUsersInput.max = String(MAX_GROUP_VIEWERS)
      maxUsersInput.step = '1'
      maxUsersInput.value = String(settings.maxViewers)
      maxUsersInput.setAttribute('aria-label', 'Maximum users')
      maxUsersLabel.addEventListener('click', (event) => event.stopPropagation())
      maxUsersInput.addEventListener('input', () => {
        const value = Number(maxUsersInput.value)
        if (Number.isFinite(value)) {
          settings.maxViewers = Math.min(MAX_GROUP_VIEWERS, Math.max(2, Math.trunc(value)))
          group.querySelector('.share-option-help').textContent =
            `Up to ${settings.maxViewers} viewers can join with this link.`
        }
      })
      maxUsersInput.addEventListener('change', () => {
        maxUsersInput.value = String(settings.maxViewers)
      })
      maxUsersLabel.append(maxUsersInput)
      group.querySelector('.share-option-header').append(maxUsersLabel)
      options.append(single, group)
      root.append(options)

      const approvalToggle = preferenceCheckbox(
        'Require approval to join',
        settings.requireApproval
      )
      approvalToggle.input.addEventListener('change', () => {
        settings.requireApproval = approvalToggle.input.checked
      })
      root.append(approvalToggle.label)

      const autoCopyToggle = preferenceCheckbox('Auto Copy', settings.autoCopy)
      autoCopyToggle.input.addEventListener('change', () => {
        settings.autoCopy = autoCopyToggle.input.checked
        storeBooleanPreference(SHARE_AUTO_COPY_STORAGE_KEY, settings.autoCopy)
      })
      root.append(autoCopyToggle.label)

      const warning = document.createElement('div')
      warning.className = `share-warning${settings.type === 'group' ? ' share-warning-danger' : ''}`
      warning.textContent =
        'WARNING: until we add user authentication, YOU CANT TELL WHO IS REALLY JOINING VIA A GROUP LINK'
      root.append(warning)
    }

    render()
    return { root, settings }
  }

  // A radio group over every backend the core reports, or null when it
  // reports at most one or none is usable (the core then shares over its
  // default). A broken backend is a disabled radio with the core's reason as
  // its text (D-14). Once a backend is active the core serves every share
  // over it, so the group shows it and is disabled.
  function shareBackendPicker(settings) {
    const usable = usableShareBackends()
    const listed = (state.shareBackends && state.shareBackends.backends) || []
    if (!usable || !usable.length || listed.length < 2) return null
    const info = state.shareBackends
    const active = info.active || null
    settings.backend = active || settings.backend || info.default || usable[0].id

    const group = document.createElement('fieldset')
    group.className = 'share-backend-picker'
    group.disabled = !!active
    const legend = document.createElement('legend')
    legend.textContent = active ? 'Network (in use)' : 'Network'
    group.append(legend)
    for (const backend of listed) {
      const broken = backend.state !== 'available'
      const label = document.createElement('label')
      label.className = `share-backend-choice${broken ? ' share-backend-broken' : ''}`
      const input = document.createElement('input')
      input.type = 'radio'
      input.name = 'share-backend'
      input.value = backend.id
      input.disabled = broken
      input.checked = !broken && backend.id === settings.backend
      input.addEventListener('change', () => {
        if (input.checked) settings.backend = backend.id
      })
      const text = document.createElement('span')
      text.textContent = backend.label || backend.id
      label.append(input, text)
      if (broken) {
        const reason = document.createElement('span')
        reason.className = 'share-backend-detail'
        reason.textContent = backend.detail || 'unavailable'
        label.append(reason)
      }
      group.append(label)
    }
    return group
  }

  // `options.sessionId` + `options.settings` (from shareOptionsForm) skip the
  // choose step and share that session straight away; otherwise the wizard
  // asks first and shares the selected session.
  async function showShareWizard(anchor, options = {}) {
    const initialAutoCopy = await shareAutoCopyPreference()
    const debugAutoJoin = window.__zbtermDebugShareAutoJoin
    window.__zbtermDebugShareAutoJoin = undefined
    return new Promise((resolve) => {
      let link = null
      let closed = false
      const form = shareOptionsForm(options.settings || { autoCopy: initialAutoCopy }, () => {
        const next = actions.querySelector('button[type="submit"]')
        if (next) next.focus()
      })
      const settings = form.settings

      const overlay = document.createElement('div')
      overlay.className = 'modal-overlay'

      const panel = document.createElement('form')
      panel.className = 'modal-panel'

      const title = document.createElement('div')
      title.className = 'modal-title'
      panel.append(title)

      const body = document.createElement('div')
      panel.append(body)

      const actions = document.createElement('div')
      actions.className = 'modal-actions'
      panel.append(actions)

      overlay.append(panel)
      document.body.append(overlay)
      anchorModal(overlay, panel, anchor, 'right')

      const close = (value) => {
        if (closed) return
        closed = true
        overlay.remove()
        resolve(value)
      }

      const picker = shareBackendPicker(settings)

      const renderChoose = () => {
        title.textContent = 'Share session'
        body.replaceChildren(...(picker ? [picker, form.root] : [form.root]))
        actions.replaceChildren()
        const cancel = wizardButton('Cancel')
        cancel.type = 'button'
        cancel.addEventListener('click', () => close(null))
        const next = wizardButton('Share', 'mode-pause')
        next.type = 'submit'
        actions.append(cancel, next)
        next.focus()
      }

      const renderSharing = () => {
        title.textContent = 'Share session'
        body.replaceChildren()
        actions.replaceChildren()
        const status = document.createElement('div')
        status.className = 'wizard-status'
        const spinner = document.createElement('div')
        spinner.className = 'spinner'
        const label = document.createElement('div')
        label.textContent = 'Sharing'
        status.append(spinner, label)
        body.append(status)
      }

      const renderReady = (copyResult = { copied: false, attempted: false }) => {
        let copied = !!copyResult.copied
        let copyAttempted = !!copyResult.attempted
        title.textContent = 'Share key'
        body.replaceChildren()
        actions.replaceChildren()

        const output = document.createElement('textarea')
        output.className = 'share-key'
        output.value = link.uri
        output.readOnly = true
        body.append(output)

        const autoCopyToggle = preferenceCheckbox('Auto Copy', settings.autoCopy)
        autoCopyToggle.input.addEventListener('change', () => {
          settings.autoCopy = autoCopyToggle.input.checked
          storeBooleanPreference(SHARE_AUTO_COPY_STORAGE_KEY, settings.autoCopy)
        })
        body.append(autoCopyToggle.label)

        const done = wizardButton('Done')
        done.type = 'button'
        done.addEventListener('click', () => close({ copied, copyAttempted }))

        const copy = wizardButton(
          copied ? 'Copied' : copyAttempted ? 'Copy failed' : 'Copy',
          'mode-pause'
        )
        copy.type = 'button'
        copy.addEventListener('click', async () => {
          const ok = await copyShareLink(link.uri)
          copy.textContent = ok ? 'Copied' : 'Copy failed'
          copied = ok
          copyAttempted = true
        })
        actions.append(done, copy)
        copy.focus()
        output.select()
      }

      // The one sharing path, whether the options came from this wizard's
      // choose step or from the New/Copy editor.
      const share = (sessionId) => {
        renderSharing()
        api
          .invoke('share.createLink', {
            sessionId,
            type: settings.type,
            maxViewers: settings.type === 'group' ? settings.maxViewers : 1,
            autoJoin: debugAutoJoin === false ? false : !settings.requireApproval,
            ...(settings.backend ? { backend: settings.backend } : {})
          })
          .then(async (created) => {
            // The first share activates its backend for the life of the core.
            const info = state.shareBackends
            if (info && !info.active) info.active = settings.backend || info.default || null
            if (closed) return
            link = created
            const copied = settings.autoCopy ? await copyShareLink(link.uri) : false
            if (closed) return
            renderReady({ copied, attempted: settings.autoCopy })
          })
          .catch((err) => {
            close(null)
            showError(err)
          })
      }

      panel.addEventListener('submit', (event) => {
        event.preventDefault()
        // Only the choose step has a submit button.
        if (link || !actions.querySelector('button[type="submit"]')) return
        share(state.selectedId)
      })
      panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close(null)
      })
      overlay.addEventListener('pointerdown', (event) => {
        if (event.target === overlay) close(null)
      })

      if (options.sessionId) share(options.sessionId)
      else renderChoose()
    })
  }

  async function showJoinWizard(anchor) {
    const initialAutoPaste = await storedBooleanPreference(JOIN_AUTO_PASTE_STORAGE_KEY, false)
    return new Promise((resolve) => {
      let closed = false
      let autoPaste = initialAutoPaste
      // Set by the identity line: a link whose claim does not check out is
      // never joinable.
      let blocked = false
      const overlay = document.createElement('div')
      overlay.className = 'modal-overlay'

      const panel = document.createElement('form')
      panel.className = 'modal-panel'

      const title = document.createElement('div')
      title.className = 'modal-title'
      title.textContent = 'Join session'
      panel.append(title)

      const body = document.createElement('div')
      panel.append(body)

      const inputRow = document.createElement('div')
      inputRow.className = 'modal-input-row'

      const paste = wizardButton('Paste')
      paste.type = 'button'

      const input = document.createElement('input')
      input.className = 'modal-input'
      input.placeholder = 'zbterm://join/...'
      inputRow.append(paste, input)
      body.append(inputRow)

      // Who is inviting you, checked before anything connects. Hidden until
      // there is a link to say something about.
      const identity = peerIdentityLine()
      identity.root.hidden = true
      body.append(identity.root)

      const autoPasteToggle = preferenceCheckbox('Auto Paste', autoPaste)
      autoPasteToggle.input.addEventListener('change', () => {
        autoPaste = autoPasteToggle.input.checked
        storeBooleanPreference(JOIN_AUTO_PASTE_STORAGE_KEY, autoPaste)
        syncJoinInputWithClipboard()
      })
      body.append(autoPasteToggle.label)

      const actions = document.createElement('div')
      actions.className = 'modal-actions'
      const cancel = wizardButton('Cancel')
      cancel.type = 'button'
      const join = wizardButton('Join', 'mode-pause')
      join.type = 'submit'
      actions.append(cancel, join)
      panel.append(actions)

      overlay.append(panel)
      document.body.append(overlay)
      anchorModal(overlay, panel, anchor, 'left')

      const close = (value) => {
        if (closed) return
        closed = true
        overlay.remove()
        resolve(value)
      }
      cancel.addEventListener('click', () => close(false))
      paste.addEventListener('click', async () => {
        const uri = await readZBTermJoinClipboard()
        if (!uri) return
        input.value = uri
        input.focus()
        input.select()
        inspectInvite()
      })
      overlay.addEventListener('pointerdown', (event) => {
        if (event.target === overlay) close(false)
      })
      panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close(false)
      })
      input.addEventListener('input', () => {
        inspectInvite()
      })
      panel.addEventListener('submit', (event) => {
        event.preventDefault()
        const uri = zbtermJoinUri(input.value)
        if (!uri || blocked) return
        close({ status: 'connecting', uri })
      })

      // Each inspection carries a token: the answer to a link the user has
      // already typed past is dropped rather than painted over the current one.
      let inspectToken = 0
      function inspectInvite() {
        const uri = zbtermJoinUri(input.value)
        const token = ++inspectToken
        if (!uri) {
          identity.root.hidden = true
          setBlocked(false)
          return
        }
        identity.root.hidden = false
        setBlocked(identity.set({ checking: true }))
        api
          .invoke('identity.inspectInvite', { uri })
          .then((answer) => {
            if (closed || token !== inspectToken) return
            setBlocked(identity.set(answer))
          })
          .catch((err) => {
            if (closed || token !== inspectToken) return
            // A link that will not even decode: say so on the same line rather
            // than letting Join fail later with the same message.
            setBlocked(
              identity.set({
                status: 'failed',
                displayId: 'this invite',
                reason: (err && err.message) || String(err)
              })
            )
          })
      }

      function setBlocked(next) {
        blocked = !!next
        join.disabled = blocked
      }

      async function syncJoinInputWithClipboard() {
        const uri = await readZBTermJoinClipboard()
        if (closed || !uri) return
        if (autoPaste) {
          input.value = uri
          input.select()
        } else if (input.value.trim() === uri) {
          input.value = ''
        }
        inspectInvite()
      }

      window.requestAnimationFrame(() => input.focus())
      syncJoinInputWithClipboard()
    })
  }

  // ---------------------------------------------------------------------
  // Identity setup wizard
  // ---------------------------------------------------------------------

  // Only one wizard may exist: `debugModalState` finds a modal with
  // `querySelector('.modal-overlay')`, so a second overlay would shadow it.
  let activeIdentityWizard = null

  // Startup gate. Deliberately never awaited by init(): the wizard must not
  // delay the terminal, session restore or the `ready` startup phase.
  async function maybeShowIdentityWizard() {
    if (!api || activeIdentityWizard) return
    if (els.profilePicker && !els.profilePicker.hidden) return
    let self = null
    try {
      self = await api.invoke('identity.self')
    } catch {
      return
    }
    applyIdentity(self)
    if (!self || self.configured) return
    let dismissed = null
    try {
      dismissed = await api.invoke('preference.get', { key: IDENTITY_DISMISS_PREFERENCE })
    } catch {}
    if (String(dismissed === null || dismissed === undefined ? '' : dismissed) === '1') return
    await showIdentityWizard(self)
  }

  // The settings entry point: always opens, even with "Don't suggest github
  // identity" set (that only preselects Stay unverified).
  // Resolves once the modal is on screen, NOT when it closes - awaiting the
  // wizard's own promise would hang the caller for as long as it is open.
  async function openIdentityWizard(anchor) {
    if (!api || activeIdentityWizard) return activeIdentityWizard
    if (els.profilePicker && !els.profilePicker.hidden) return null
    const self = await api.invoke('identity.self')
    applyIdentity(self)
    showIdentityWizard(self, anchor)
    return activeIdentityWizard
  }

  function applyIdentity(self) {
    state.identity = self || null
    updateWindowTitle()
  }

  function showIdentityWizard(self, anchor) {
    return new Promise((resolve) => {
      const current = self || {}
      const wizard = {
        provider: null,
        candidates: [],
        fingerprints: [],
        selectedFingerprint: null,
        // The lowercased subject `fingerprints` was fetched for, plus the
        // status the provider answered with. Both are dropped the moment the
        // username field changes, so a stale "published by GitHub" mark can
        // never satisfy the publish gate below.
        checkedSubject: null,
        lookupStatus: null,
        checking: false,
        // Set by a failed invoke; outranks the gate's own explanation until
        // the next action clears it.
        hardError: ''
      }
      let closed = false
      let checkTimer = null

      const overlay = document.createElement('div')
      overlay.className = 'modal-overlay'

      const panel = document.createElement('form')
      panel.className = 'modal-panel identity-panel'

      const title = document.createElement('div')
      title.className = 'modal-title'
      title.textContent = 'Choose your identity'
      panel.append(title)

      const hint = document.createElement('div')
      hint.className = 'identity-current'
      panel.append(hint)

      const options = document.createElement('div')
      options.className = 'identity-options'
      const unknownOption = identityOptionButton(
        'Stay unverified',
        'Keep the generated @UNKNOWN name. Nothing is published anywhere.'
      )
      const githubOption = identityOptionButton(
        'GitHub',
        'Prove a GitHub username by signing a claim with one of your SSH keys.'
      )
      options.append(unknownOption, githubOption)
      panel.append(options)

      const github = document.createElement('div')
      github.className = 'identity-github'
      github.hidden = true
      panel.append(github)

      const usernameRow = document.createElement('div')
      usernameRow.className = 'identity-username-row'
      const usernameInput = document.createElement('input')
      usernameInput.className = 'modal-input'
      usernameInput.placeholder = 'GitHub username'
      // Provider answers are cached for hours, so a key added on GitHub a
      // moment ago would otherwise stay locked out by the gate below.
      const recheck = wizardButton('Recheck')
      recheck.type = 'button'
      recheck.title = 'Ask GitHub again, ignoring the cached answer'
      usernameRow.append(usernameInput, recheck)
      github.append(usernameRow)

      const error = document.createElement('div')
      error.className = 'identity-error'
      error.hidden = true
      github.append(error)

      const keys = document.createElement('div')
      keys.className = 'identity-keys'
      github.append(keys)

      const manualHint = document.createElement('div')
      manualHint.className = 'identity-hint'
      manualHint.textContent = 'Or enter the path to a private key file'
      github.append(manualHint)

      const manualRow = document.createElement('div')
      manualRow.className = 'modal-input-row'
      const manualInput = document.createElement('input')
      manualInput.className = 'modal-input'
      manualInput.placeholder = '~/.ssh/id_ed25519 or ~/.ssh/id_rsa'
      const manualButton = wizardButton('Add key')
      manualButton.type = 'button'
      manualRow.append(manualInput, manualButton)
      github.append(manualRow)

      const dontAsk = preferenceCheckbox("Don't suggest github identity", false)
      dontAsk.input.addEventListener('change', () => {
        storeBooleanPreference(IDENTITY_DISMISS_PREFERENCE, dontAsk.input.checked)
        // Only steers an unverified profile; a configured one keeps its provider.
        if (current.configured) return
        const provider = dontAsk.input.checked ? 'unknown' : 'github'
        chooseProvider(provider).catch((err) => showWizardError(err.message || String(err)))
      })
      panel.append(dontAsk.label)

      const actions = document.createElement('div')
      actions.className = 'modal-actions'
      const cancel = wizardButton('Not now')
      cancel.type = 'button'
      const submit = wizardButton(IDENTITY_SUBMIT_LABELS.github, 'mode-pause')
      submit.type = 'submit'
      submit.disabled = true
      actions.append(cancel, submit)
      panel.append(actions)

      overlay.append(panel)
      document.body.append(overlay)
      anchorModal(overlay, panel, anchor, 'left')

      const close = (value) => {
        if (closed) return
        closed = true
        if (checkTimer) clearTimeout(checkTimer)
        checkTimer = null
        state.popupResolvers.delete(IDENTITY_POPUP_ID)
        if (activeIdentityWizard === controller) activeIdentityWizard = null
        overlay.remove()
        notifyPopupHidden(IDENTITY_POPUP_ID)
        resolve(value)
      }

      // The headline the user reads first, so it carries the same red/green
      // mark the peer badges use rather than being one more line of grey hint.
      function renderCurrentIdentity(identity) {
        const configured = !!(identity && identity.configured)
        const status = configured ? 'verified' : 'unknown'
        hint.className = `identity-current identity-current-${status}`
        hint.replaceChildren()
        const icon = document.createElement('i')
        icon.className = `fa-solid ${IDENTITY_ICONS[status]}`
        icon.setAttribute('aria-hidden', 'true')
        const text = document.createElement('span')
        text.textContent =
          identity && identity.displayId
            ? `Peers currently see you as ${identity.displayId}`
            : 'Peers currently cannot tell who you are'
        hint.append(icon, text)
      }

      function showWizardError(message) {
        wizard.hardError = message || ''
        refreshError()
      }

      // One line under the username carries the whole gate verdict: red while
      // something still blocks the claim, green once GitHub has confirmed it.
      function refreshError() {
        const gate = publishGate()
        const message = wizard.hardError || gate.message
        const passed = !wizard.hardError && gate.ok
        error.className = passed ? 'identity-error identity-error-ok' : 'identity-error'
        error.textContent = message
        error.hidden = !message
      }

      // A github identity is only worth anything because *peers* re-check it
      // against the username's published key list (engine/identity/verify.js
      // refuses a claim whose signing key GitHub does not publish). Minting a
      // claim that every peer will reject is the "half-baked" case, so the
      // submit button stays locked until this profile's own lookup confirms
      // the selected key is published by the username in the field.
      function publishGate() {
        const value = usernameInput.value.trim()
        if (!value) return { ok: false, message: '' }
        if (!GITHUB_USERNAME.test(value)) {
          return { ok: false, message: `Not a valid GitHub username: ${value}` }
        }
        if (wizard.checking) return { ok: false, message: `Checking ${value} on GitHub...` }
        if (wizard.checkedSubject !== value.toLowerCase()) return { ok: false, message: '' }
        if (wizard.lookupStatus === 'not-found') {
          return { ok: false, message: `GitHub has no user named ${value}` }
        }
        if (wizard.lookupStatus !== 'ok') {
          return {
            ok: false,
            message: `Could not ask GitHub which keys ${value} publishes - check your connection and try again`
          }
        }
        if (!wizard.fingerprints.length) {
          return {
            ok: false,
            message: `${value} publishes no SSH keys on GitHub, so no claim can be proved`
          }
        }
        const candidate = selectedCandidate()
        if (!candidate) return { ok: false, message: 'Select one of the keys above' }
        if (!candidate.signable) {
          return {
            ok: false,
            message: candidate.reason || 'That SSH key cannot be used to sign a claim'
          }
        }
        if (!candidate.onProvider) {
          return {
            ok: false,
            message: `${value} does not publish ${candidate.fingerprint} on GitHub - add it under Settings > SSH and GPG keys, or pick a key that is published`
          }
        }
        return { ok: true, message: `GitHub confirms ${value} publishes ${candidate.fingerprint}` }
      }

      function updateSubmitState() {
        submit.textContent =
          IDENTITY_SUBMIT_LABELS[wizard.provider] || IDENTITY_SUBMIT_LABELS.github
        submit.disabled = wizard.provider === 'unknown' ? false : !publishGate().ok
        refreshError()
      }

      function selectedCandidate() {
        return (
          wizard.candidates.find((item) => item.fingerprint === wizard.selectedFingerprint) || null
        )
      }

      function markCandidates() {
        const known = new Set(wizard.fingerprints)
        for (const candidate of wizard.candidates) {
          candidate.onProvider = !!candidate.fingerprint && known.has(candidate.fingerprint)
        }
      }

      // Only meaningful once a lookup has answered for the username in the
      // field: before that we know nothing about what GitHub publishes.
      function candidatesAreMarked() {
        return wizard.checkedSubject === usernameInput.value.trim().toLowerCase()
      }

      function renderCandidates() {
        keys.replaceChildren()
        if (!wizard.candidates.length) {
          const empty = document.createElement('div')
          empty.className = 'identity-hint'
          empty.textContent = 'No SSH keys found - enter a key file path below.'
          keys.append(empty)
          return
        }
        const marked = candidatesAreMarked() && wizard.lookupStatus === 'ok'
        for (const candidate of wizard.candidates) {
          const row = document.createElement('button')
          row.type = 'button'
          row.className = 'identity-key-row text-btn'
          if (candidate.fingerprint === wizard.selectedFingerprint) row.classList.add('selected')
          if (marked && !candidate.onProvider) row.classList.add('unpublished')
          row.disabled = !candidate.signable
          const name = document.createElement('strong')
          name.textContent = candidate.path || candidate.comment || 'ssh-agent key'
          const meta = document.createElement('span')
          const marks = [candidate.keyType || 'unknown key type', candidate.fingerprint || '']
          if (marked) {
            marks.push(candidate.onProvider ? 'published on GitHub' : 'not published on GitHub')
          }
          if (!candidate.signable && candidate.reason) marks.push(candidate.reason)
          meta.textContent = marks.filter(Boolean).join(' - ')
          row.append(name, meta)
          row.addEventListener('click', () => {
            selectKey(candidate.fingerprint)
          })
          keys.append(row)
        }
      }

      function selectKey(fingerprint) {
        const candidate = wizard.candidates.find((item) => item.fingerprint === fingerprint)
        if (!candidate || !candidate.signable) return false
        wizard.selectedFingerprint = fingerprint
        wizard.hardError = ''
        renderCandidates()
        updateSubmitState()
        return true
      }

      // Prefer the key this profile already claims, then any signable key the
      // username actually publishes. A selection that no lookup has faulted is
      // left alone, so a deliberate pick is never silently overridden.
      function preselectKey() {
        const usable = (candidate) => !!candidate && candidate.signable && candidate.onProvider
        if (usable(selectedCandidate())) return
        const claimed = wizard.candidates.find(
          (item) => item.fingerprint === current.sshFingerprint && usable(item)
        )
        const next = claimed || wizard.candidates.find(usable)
        if (next) wizard.selectedFingerprint = next.fingerprint
      }

      // Selecting a provider no longer commits to it: both branches only move
      // the highlight and reshape the form, and nothing is written until the
      // submit button is pressed.
      async function chooseProvider(provider) {
        if (provider === 'unknown') {
          wizard.provider = 'unknown'
          unknownOption.classList.add('selected')
          githubOption.classList.remove('selected')
          github.hidden = true
          wizard.hardError = ''
          updateSubmitState()
          submit.focus()
          return
        }
        wizard.provider = 'github'
        githubOption.classList.add('selected')
        unknownOption.classList.remove('selected')
        github.hidden = false
        wizard.hardError = ''
        // Re-confirming an existing identity should not mean retyping it.
        if (!usernameInput.value.trim() && current.provider === 'github' && current.subject) {
          usernameInput.value = current.subject
        }
        updateSubmitState()
        usernameInput.focus()
        usernameInput.select()
        await loadCandidates()
        if (usernameInput.value.trim()) await checkUsername()
      }

      async function loadCandidates() {
        try {
          const candidates = await api.invoke('identity.sshCandidates')
          wizard.candidates = Array.isArray(candidates) ? candidates.slice() : []
        } catch (err) {
          wizard.candidates = []
          showWizardError(err.message || String(err))
        }
        markCandidates()
        renderCandidates()
        updateSubmitState()
      }

      function invalidateLookup() {
        wizard.checkedSubject = null
        wizard.lookupStatus = null
        wizard.fingerprints = []
        markCandidates()
      }

      function scheduleUsernameCheck() {
        if (checkTimer) clearTimeout(checkTimer)
        checkTimer = setTimeout(() => {
          checkTimer = null
          checkUsername().catch((err) => showWizardError(err.message || String(err)))
        }, USERNAME_CHECK_DEBOUNCE_MS)
      }

      function setChecking(checking) {
        wizard.checking = checking
        recheck.disabled = checking
      }

      // Asks GitHub which keys the username publishes. Runs on a debounce while
      // typing, on blur, and once more from submit - the gate reads only what
      // this leaves behind, so an unchecked username can never be claimed.
      async function checkUsername(opts = {}) {
        if (checkTimer) clearTimeout(checkTimer)
        checkTimer = null
        const value = usernameInput.value.trim()
        invalidateLookup()
        if (!value || !GITHUB_USERNAME.test(value)) {
          renderCandidates()
          updateSubmitState()
          return false
        }
        const subject = value.toLowerCase()
        wizard.hardError = ''
        setChecking(true)
        updateSubmitState()
        let answer = null
        try {
          answer = await api.invoke('identity.lookup', {
            provider: 'github',
            subject: value,
            refresh: !!opts.refresh
          })
        } catch (err) {
          setChecking(false)
          showWizardError(err.message || String(err))
          renderCandidates()
          updateSubmitState()
          return false
        }
        setChecking(false)
        // A racing edit already moved on: drop this answer rather than mark
        // candidates against a username the user is no longer claiming.
        if (usernameInput.value.trim().toLowerCase() !== subject) return false
        wizard.lookupStatus = answer && answer.status ? String(answer.status) : 'error'
        wizard.fingerprints = (answer && answer.keys ? answer.keys : []).map(
          (key) => key.fingerprint
        )
        wizard.checkedSubject = subject
        markCandidates()
        preselectKey()
        renderCandidates()
        updateSubmitState()
        return wizard.lookupStatus === 'ok'
      }

      async function addKeyPath(keyPath) {
        const value = String(keyPath === null || keyPath === undefined ? '' : keyPath).trim()
        if (!value) return false
        let candidate = null
        try {
          candidate = await api.invoke('identity.sshInspect', { keyPath: value })
        } catch (err) {
          showWizardError(err.message || String(err))
          return false
        }
        showWizardError('')
        wizard.candidates = wizard.candidates
          .filter((item) => item.fingerprint !== candidate.fingerprint)
          .concat([candidate])
        markCandidates()
        preselectKey()
        renderCandidates()
        updateSubmitState()
        return true
      }

      // The exact submit sequence: beginClaim -> sshSign -> setSelf. Choosing
      // to stay unverified is a submit too - it clears the stored claim and
      // drops the profile back to its generated @UNKNOWN name.
      async function submitClaim() {
        if (wizard.provider === 'unknown') {
          submit.disabled = true
          try {
            const identity = await api.invoke('identity.clear')
            applyIdentity(identity)
            renderCurrentIdentity(identity)
            setStatus(`identity ${identity.displayId}`)
            close({ provider: 'unknown', identity })
            return true
          } catch (err) {
            submit.disabled = false
            showWizardError(err.message || String(err))
            return false
          }
        }
        // Last line of defence: a username edited after the last lookup is
        // re-checked here rather than trusted.
        if (!candidatesAreMarked()) await checkUsername()
        if (!publishGate().ok) {
          updateSubmitState()
          return false
        }
        const value = usernameInput.value.trim()
        const candidate = selectedCandidate()
        submit.disabled = true
        try {
          const begun = await api.invoke('identity.beginClaim', {
            provider: 'github',
            subject: value,
            sshPublicKey: candidate.publicKeyBlobBase64,
            sshKeyType: candidate.keyType
          })
          const signed = await api.invoke('identity.sshSign', {
            messageBase64: begun.bytes,
            keyPath: candidate.path || null,
            publicKeyBlobBase64: candidate.publicKeyBlobBase64 || null
          })
          const identity = await api.invoke('identity.setSelf', {
            claim: begun.claim,
            signature: signed.signature
          })
          applyIdentity(identity)
          renderCurrentIdentity(identity)
          setStatus(`identity ${identity.displayId}`)
          close({ provider: 'github', identity })
          return true
        } catch (err) {
          showWizardError(err.message || String(err))
          updateSubmitState()
          return false
        }
      }

      unknownOption.addEventListener('click', () => {
        chooseProvider('unknown').catch((err) => showWizardError(err.message || String(err)))
      })
      githubOption.addEventListener('click', () => {
        chooseProvider('github').catch((err) => showWizardError(err.message || String(err)))
      })
      usernameInput.addEventListener('input', () => {
        wizard.hardError = ''
        invalidateLookup()
        renderCandidates()
        updateSubmitState()
        scheduleUsernameCheck()
      })
      usernameInput.addEventListener('blur', () => {
        checkUsername().catch((err) => showWizardError(err.message || String(err)))
      })
      recheck.addEventListener('click', () => {
        checkUsername({ refresh: true }).catch((err) => showWizardError(err.message || String(err)))
      })
      manualButton.addEventListener('click', () => {
        addKeyPath(manualInput.value).catch((err) => showWizardError(err.message || String(err)))
      })
      cancel.addEventListener('click', () => close(null))
      overlay.addEventListener('pointerdown', (event) => {
        if (event.target === overlay) close(null)
      })
      panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close(null)
      })
      panel.addEventListener('submit', (event) => {
        event.preventDefault()
        submitClaim().catch((err) => showWizardError(err.message || String(err)))
      })

      const controller = {
        choose: chooseProvider,
        setUsername: async (value) => {
          usernameInput.value = String(value === null || value === undefined ? '' : value)
          return await checkUsername()
        },
        recheck: () => checkUsername({ refresh: true }),
        selectKey,
        addKey: addKeyPath,
        submit: submitClaim,
        close: () => close(null),
        debugState: () => ({
          provider: wizard.provider,
          username: usernameInput.value.trim(),
          selectedFingerprint: wizard.selectedFingerprint,
          submitLabel: submit.textContent,
          submitEnabled: !submit.disabled,
          candidates: wizard.candidates.map((candidate) => ({
            fingerprint: candidate.fingerprint,
            keyType: candidate.keyType,
            signable: !!candidate.signable,
            onProvider: !!candidate.onProvider
          }))
        })
      }
      activeIdentityWizard = controller

      renderCurrentIdentity(current)
      updateSubmitState()

      // A headless `POST /popups/identity-setup/actions/...` resolves through
      // the same map `showModal` uses, so it closes this modal too.
      state.popupResolvers.set(IDENTITY_POPUP_ID, close)
      notifyPopupVisibleAfterPaint(IDENTITY_POPUP_ID)
      // An already-configured profile opens on its own provider, prefilled and
      // with its current key preselected, so re-confirming is one click.
      if (current.provider === 'github' && current.subject) {
        chooseProvider('github').catch((err) => showWizardError(err.message || String(err)))
      } else {
        // An unverified profile opens on GitHub, expanded, unless the user
        // asked not to be offered it - then staying unverified is preselected.
        storedBooleanPreference(IDENTITY_DISMISS_PREFERENCE, false)
          .then((dismissed) => {
            if (closed) return
            dontAsk.input.checked = dismissed
            return chooseProvider(dismissed ? 'unknown' : 'github')
          })
          .catch((err) => showWizardError(err.message || String(err)))
      }
    })
  }

  function identityOptionButton(label, description) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'identity-option text-btn'
    const strong = document.createElement('strong')
    strong.textContent = label
    const span = document.createElement('span')
    span.textContent = description
    button.append(strong, span)
    return button
  }

  function wizardButton(text, extraClass) {
    const button = document.createElement('button')
    button.className = extraClass ? `text-btn ${extraClass}` : 'text-btn'
    button.textContent = text
    return button
  }

  async function copyShareLink(uri) {
    try {
      if (bridge && bridge.writeClipboardText) {
        await bridge.writeClipboardText(uri)
        return true
      }
      await navigator.clipboard.writeText(uri)
      return true
    } catch (err) {
      console.warn('share link copy failed', err)
      return false
    }
  }

  async function readZBTermJoinClipboard() {
    try {
      if (bridge && bridge.readClipboardText) {
        return zbtermJoinUri(await bridge.readClipboardText())
      }
      return zbtermJoinUri(await navigator.clipboard.readText())
    } catch {
      return ''
    }
  }

  function zbtermJoinUri(value) {
    const uri = String(value || '').trim()
    return uri.startsWith(ZBTERM_JOIN_PREFIX) ? uri : ''
  }

  function preferenceCheckbox(text, checked) {
    const label = document.createElement('label')
    label.className = 'modal-check'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = !!checked
    const span = document.createElement('span')
    span.textContent = text
    label.append(input, span)
    return { label, input }
  }

  async function storedBooleanPreference(key, fallback = false) {
    const local = window.localStorage.getItem(key)
    try {
      if (api) {
        const saved = await api.invoke('preference.get', { key })
        if (saved === '0' || saved === 'false') return false
        if (saved === '1' || saved === 'true') return true
      }
    } catch {}
    if (local === '0' || local === 'false') return false
    if (local === '1' || local === 'true') return true
    return !!fallback
  }

  function storeBooleanPreference(key, enabled) {
    const value = enabled ? '1' : '0'
    window.localStorage.setItem(key, value)
    if (api) api.invoke('preference.set', { key, value }).catch(() => {})
  }

  function askText(title, options = {}) {
    return showModal({
      title,
      value: options.value || '',
      placeholder: options.placeholder || '',
      okText: options.okText || 'OK',
      cancelText: options.cancelText || 'Cancel',
      readonly: !!options.readonly,
      input: true
    })
  }

  function askConfirm(title, options = {}) {
    return showModal({
      title,
      okText: options.okText || 'OK',
      cancelText: options.cancelText || 'Cancel',
      danger: !!options.danger,
      warning: options.warning || '',
      note: options.note || '',
      badge: options.badge || null,
      identity: options.identity || null,
      input: false,
      popupId: options.popupId || null,
      anchor: options.anchor || null,
      align: options.align || 'left'
    })
  }

  function showModal(options) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div')
      overlay.className = 'modal-overlay'

      const panel = document.createElement('form')
      panel.className = 'modal-panel'

      const title = document.createElement('div')
      title.className = 'modal-title'
      title.textContent = options.title
      panel.append(title)

      let input = null
      if (options.input) {
        input = document.createElement('input')
        input.className = 'modal-input'
        input.value = options.value || ''
        input.placeholder = options.placeholder || ''
        input.readOnly = !!options.readonly
        panel.append(input)
      }

      // A multi-field modal (peer annotation) resolves with an array of the
      // trimmed values, or null when it was cancelled.
      const fields = Array.isArray(options.fields) ? options.fields : []
      const fieldInputs = fields.map((field) => {
        const element = document.createElement('input')
        element.className = 'modal-input'
        element.value = (field && field.value) || ''
        element.placeholder = (field && field.placeholder) || ''
        panel.append(element)
        return element
      })

      if (options.badge) {
        const badge = document.createElement('div')
        badge.className = 'modal-identity'
        badge.append(options.badge)
        panel.append(badge)
      }

      // Rendered before the actions so `ok` can be disabled by it below.
      let identityBlocked = false
      if (options.identity) {
        const identity = peerIdentityLine()
        identityBlocked = identity.set(options.identity)
        panel.append(identity.root)
      }

      if (options.note) {
        const note = document.createElement('div')
        note.className = 'share-warning modal-warning identity-note'
        note.textContent = options.note
        panel.append(note)
      }

      if (options.warning) {
        const warning = document.createElement('div')
        warning.className = 'share-warning share-warning-danger modal-warning'
        warning.textContent = options.warning
        panel.append(warning)
      }

      const actions = document.createElement('div')
      actions.className = 'modal-actions'

      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'text-btn'
      cancel.textContent = options.cancelText || 'Cancel'

      const ok = document.createElement('button')
      ok.type = 'submit'
      ok.className = options.danger ? 'text-btn modal-danger' : 'text-btn mode-pause'
      ok.textContent = options.okText || 'OK'
      ok.disabled = identityBlocked

      actions.append(cancel, ok)
      panel.append(actions)
      overlay.append(panel)
      document.body.append(overlay)
      // Anchored under the button that asked (a session row's action keeps
      // its row lit, as its menu did); centred when there is none on screen.
      const anchor = options.anchor && options.anchor.isConnected ? options.anchor : null
      const anchorRow = anchor && anchor.closest ? anchor.closest('.session-row') : null
      anchorModal(overlay, panel, anchor, options.align || 'left')
      if (anchorRow) anchorRow.classList.add('menu-open')

      let closed = false
      const close = (value) => {
        if (closed) return
        closed = true
        if (options.popupId) state.popupResolvers.delete(options.popupId)
        overlay.remove()
        if (anchorRow) anchorRow.classList.remove('menu-open')
        resolve(value)
      }

      if (options.popupId) state.popupResolvers.set(options.popupId, close)

      const cancelValue = () => {
        if (fieldInputs.length) return null
        return options.input ? '' : false
      }
      const okValue = () => {
        if (fieldInputs.length) return fieldInputs.map((element) => element.value.trim())
        return options.input ? input.value.trim() : true
      }

      cancel.addEventListener('click', () => close(cancelValue()))
      overlay.addEventListener('pointerdown', (event) => {
        if (event.target === overlay) close(cancelValue())
      })
      panel.addEventListener('submit', (event) => {
        event.preventDefault()
        // Implicit submission (Enter in a field) bypasses a disabled button,
        // so the gate is re-checked here rather than trusted to the DOM.
        if (ok.disabled) return
        close(okValue())
      })
      panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close(cancelValue())
      })

      window.requestAnimationFrame(() => {
        const focusTarget = input || fieldInputs[0]
        if (focusTarget) {
          focusTarget.focus()
          focusTarget.select()
        } else if (ok.disabled) {
          // Focusing a disabled button silently focuses nothing, which would
          // leave Escape as the only key that does anything.
          cancel.focus()
        } else {
          ok.focus()
        }
      })
    })
  }

  function sessionMeta(session) {
    const parts = [session.active ? 'Live' : 'Recorded']
    if (session.owner === 'joined' || session.isJoined) parts.push('Joined')
    if (session.isSharing) {
      parts.push(`${session.viewerCount || 0} viewer${session.viewerCount === 1 ? '' : 's'}`)
    }
    parts.push(formatTime(session.startedAt))
    return parts.join(' · ')
  }

  function updateDragTime() {
    const tsMs = tsForScrubberValue(Number(els.scrubber.value))
    state.playbackClockTs = tsMs
    updateTimeLabels()
    positionScrubberTip()
  }

  function updateTimeLabels() {
    const start = state.playbackStartTs
    const end = currentPlaybackEndTs()
    const realElapsed = state.playbackClockTs - start
    const realTotal = end - start
    let currentElapsed = realElapsed
    let totalElapsed = realTotal
    let uncompressedTitle = ''
    if (state.timeCollapse.enabled) {
      const collapseMap = getTimeCollapseMap(start, end)
      if (collapseMap && collapseMap.compressedSpan > 0) {
        currentElapsed = realToCompressed(collapseMap, state.playbackClockTs)
        totalElapsed = collapseMap.compressedSpan
        uncompressedTitle = `Ucompresses: ${formatDuration(realElapsed)} / ${formatDuration(realTotal)}`
      }
    }
    els.currentTime.textContent = formatDuration(currentElapsed)
    els.totalTime.textContent = formatDuration(totalElapsed)
    if (els.timeLabel) els.timeLabel.title = uncompressedTitle
    if (!state.seek.hovering) {
      els.scrubberTip.textContent = scrubberTipTextForTs(state.playbackClockTs)
    }
    updateTransportControls()
  }

  function positionScrubberTip() {
    const value = Number(els.scrubber.value)
    const min = Number(els.scrubber.min)
    const max = Number(els.scrubber.max)
    const pct = max === min ? 0 : (value - min) / (max - min)
    els.scrubberTip.style.left = `${pct * 100}%`
  }

  function scrubberTipTextForTs(tsMs) {
    const start = state.playbackStartTs
    const realElapsed = tsMs - start
    if (state.timeCollapse.enabled) {
      const end = currentPlaybackEndTs()
      const collapseMap = getTimeCollapseMap(start, end)
      if (collapseMap && collapseMap.compressedSpan > 0) {
        const compElapsed = realToCompressed(collapseMap, tsMs)
        return `${formatDuration(compElapsed)} (${formatDuration(realElapsed)})`
      }
    }
    return formatDuration(realElapsed)
  }

  function scrubberHoverTsFromEvent(event) {
    const rect = els.scrubber.getBoundingClientRect()
    const fraction = rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0
    const value = fraction * SCRUBBER_STEPS
    return { value, tsMs: tsForScrubberValue(value) }
  }

  function handleScrubberHover(event) {
    if (state.seek.dragging) return
    if (!state.selectedId || !state.timeline.length) return
    const { value, tsMs } = scrubberHoverTsFromEvent(event)
    state.seek.hovering = true
    els.scrubberTip.hidden = false
    els.scrubberTip.style.left = `${clamp((value / SCRUBBER_STEPS) * 100, 0, 100)}%`
    els.scrubberTip.textContent = scrubberTipTextForTs(tsMs)
  }

  function hideScrubberHover() {
    state.seek.hovering = false
    if (state.seek.dragging) return
    els.scrubberTip.hidden = true
  }

  function renderScrubberIndicators() {
    if (!els.scrubberIndicators) return
    els.scrubberIndicators.replaceChildren()
    if (!state.selectedId || !state.timeline.length) return
    const start = state.playbackStartTs
    const end = currentPlaybackEndTs()
    const span = end - start
    if (span <= 0) return
    const collapseMap = getTimeCollapseMap(start, end)

    for (const segment of activitySegments(start, end, collapseMap)) {
      appendSampledSegment(segment, 'activity')
    }
    for (const segment of historySegments(start, end, collapseMap)) {
      appendSampledSegment(segment, 'history')
    }
    for (const segment of socketSegments(start, end, collapseMap)) {
      appendSampledSegment(segment, 'socket')
    }
    for (const segment of downloadSegments(start, end)) {
      els.scrubberIndicators.append(indicatorSegment(segment, 'download', start, span, collapseMap))
    }
    for (const segment of idleSegments(start, end)) {
      els.scrubberIndicators.append(indicatorSegment(segment, 'idle', start, span, collapseMap))
    }
  }

  function activitySegments(start, end, collapseMap) {
    if (isJoinedSession()) return []
    const timelineMap = timelineActivityMap(start, end)
    const liveMap = state.selectedId ? liveActivityMap(state.selectedId, 'pty', end) : null
    return sampledSignalSegments(mergeSignalMaps(timelineMap, liveMap), start, end, collapseMap)
  }

  function historySegments(start, end, collapseMap) {
    if (!isJoinedSession()) return []
    const availableLength =
      state.availability && Number.isFinite(state.availability.availableLength)
        ? state.availability.availableLength
        : state.timeline.length
    return sampledSignalSegments(
      timelineHistoryMap(start, end, availableLength),
      start,
      end,
      collapseMap
    )
  }

  function timelineActivityMap(start, end) {
    if (
      state.timelineSignal.timeline !== state.timeline ||
      state.timelineSignal.startTs !== start ||
      !state.timelineSignal.activity
    ) {
      state.timelineSignal.timeline = state.timeline
      state.timelineSignal.startTs = start
      state.timelineSignal.activity = signalMapFromPoints(
        state.timeline.map((item) => ({ tsMs: item.tsMs || start, weight: 1 })),
        start,
        end
      )
      state.timelineSignal.history = null
      state.timelineSignal.historyAvailableLength = -1
    } else fillSignalTo(state.timelineSignal.activity, end)
    return state.timelineSignal.activity
  }

  function timelineHistoryMap(start, end, availableLength) {
    if (
      state.timelineSignal.timeline !== state.timeline ||
      state.timelineSignal.startTs !== start ||
      state.timelineSignal.historyAvailableLength !== availableLength ||
      !state.timelineSignal.history
    ) {
      state.timelineSignal.timeline = state.timeline
      state.timelineSignal.startTs = start
      state.timelineSignal.historyAvailableLength = availableLength
      state.timelineSignal.history = signalMapFromPoints(
        state.timeline
          .filter((item) => item.seq <= availableLength)
          .map((item) => ({ tsMs: item.tsMs || start, weight: 1 })),
        start,
        end
      )
      if (!state.timelineSignal.activity) {
        state.timelineSignal.activity = signalMapFromPoints(
          state.timeline.map((item) => ({ tsMs: item.tsMs || start, weight: 1 })),
          start,
          end
        )
      }
    } else fillSignalTo(state.timelineSignal.history, end)
    return state.timelineSignal.history
  }

  function socketSegments(start, end, collapseMap) {
    if (!state.selectedId) return []
    return sampledSignalSegments(
      liveActivityMap(state.selectedId, 'socket', end),
      start,
      end,
      collapseMap
    )
  }

  function liveActivityMap(sessionId, source, endTs) {
    let maps = state.liveActivityMaps.get(sessionId)
    if (!maps) {
      maps = {
        pty: createSignalMap(sessionStartTs(sessionId)),
        socket: createSignalMap(sessionStartTs(sessionId))
      }
      state.liveActivityMaps.set(sessionId, maps)
    }
    if (!maps[source]) maps[source] = createSignalMap(sessionStartTs(sessionId))
    if (endTs !== undefined) fillSignalTo(maps[source], endTs)
    return maps[source]
  }

  function sessionStartTs(sessionId) {
    if (state.selectedId === sessionId && state.playbackStartTs) return state.playbackStartTs
    const session = state.sessions.find((item) => item.sessionId === sessionId)
    return (session && session.startedAt) || Date.now()
  }

  function createSignalMap(startTs) {
    return {
      startTs,
      dtMs: SIGNAL_INITIAL_DT_MS,
      values: [],
      nextTs: startTs
    }
  }

  function signalMapFromPoints(points, start, end) {
    const map = createSignalMap(start)
    for (const point of points) {
      if (!point || point.tsMs < start || point.tsMs > end) continue
      addSignalMeasurement(map, point.tsMs, point.weight || 1)
    }
    fillSignalTo(map, end)
    return map
  }

  function addSignalMeasurement(map, tsMs, value) {
    if (tsMs < map.startTs) return
    fillSignalTo(map, tsMs)
    if (!map.values.length) return
    const index = clamp(Math.floor((tsMs - map.startTs) / map.dtMs), 0, map.values.length - 1)
    map.values[index] += value || 1
  }

  function fillSignalTo(map, tsMs) {
    if (!map.values.length && tsMs >= map.startTs) {
      map.values.push(0)
      map.nextTs = map.startTs + map.dtMs
    }
    while (map.nextTs <= tsMs) {
      map.values.push(0)
      map.nextTs += map.dtMs
      if (map.values.length >= SIGNAL_MAX_SAMPLES) {
        compactSignalMap(map, map.startTs + map.values.length * map.dtMs)
      }
    }
  }

  function compactSignalMap(map, nowTs) {
    const compacted = []
    for (let i = 0; i < SIGNAL_COMPACT_SAMPLES; i++) {
      const left = map.values[i * 2] || 0
      const right = map.values[i * 2 + 1] || 0
      compacted.push((left + right) / 2)
    }
    map.values = compacted
    const elapsed = Math.max(map.dtMs * SIGNAL_MAX_SAMPLES, nowTs - map.startTs)
    map.dtMs = elapsed / SIGNAL_COMPACT_SAMPLES
    map.nextTs = map.startTs + map.values.length * map.dtMs
  }

  function mergeSignalMaps(left, right) {
    if (!left || !left.values.length) return right
    if (!right || !right.values.length) return left
    const start = Math.min(left.startTs, right.startTs)
    const end = Math.max(signalEndTs(left), signalEndTs(right))
    const merged = createSignalMap(start)
    fillSignalTo(merged, end)
    mergeSignalInto(merged, left)
    mergeSignalInto(merged, right)
    return merged
  }

  function mergeSignalInto(target, source) {
    for (let i = 0; i < source.values.length; i++) {
      const value = source.values[i]
      if (!value) continue
      addSignalMeasurement(target, source.startTs + i * source.dtMs, value)
    }
  }

  function signalEndTs(map) {
    return map.startTs + Math.max(0, map.values.length - 1) * map.dtMs
  }

  function sampledSignalSegments(map, start, end, collapseMap) {
    if (!map || !map.values.length || !els.scrubberIndicators) return []
    const pixelCount = Math.max(1, Math.round(els.scrubberIndicators.clientWidth || 1))
    const values = interpolatedSignalPixels(map, pixelCount, start, end, collapseMap)
    const max = Math.max(...values)
    if (max <= 0) return []
    const out = []
    let current = null
    for (let p = 0; p < values.length; p++) {
      const value = values[p]
      if (value <= 0) {
        if (current) {
          out.push(current)
          current = null
        }
        continue
      }
      const level = activityLevel(value, max)
      const segment = {
        leftPct: (p / pixelCount) * 100,
        widthPct: (1 / pixelCount) * 100,
        level
      }
      if (current && current.level === level) current.widthPct += segment.widthPct
      else {
        if (current) out.push(current)
        current = segment
      }
    }
    if (current) out.push(current)
    return out
  }

  function interpolatedSignalPixels(map, pixelCount, start, end, collapseMap) {
    if (!map.values.length) return []
    const pixels = []
    if (collapseMap && collapseMap.compressedSpan > 0) {
      const compSpan = collapseMap.compressedSpan
      for (let p = 0; p < pixelCount; p++) {
        const compTs = (compSpan * p) / pixelCount
        const tsMs = compressedToReal(collapseMap, compTs)
        pixels.push(signalValueAt(map, tsMs))
      }
      return pixels
    }
    const span = end - start
    for (let p = 0; p < pixelCount; p++) {
      const tsMs = start + (span * p) / pixelCount
      pixels.push(signalValueAt(map, tsMs))
    }
    return pixels
  }

  function signalValueAt(map, tsMs) {
    const r = (tsMs - map.startTs) / map.dtMs
    if (r < 0) return 0
    const i = Math.floor(r)
    if (i >= map.values.length) return 0
    const next = Math.min(map.values.length - 1, i + 1)
    const mix = r - i
    return map.values[i] * (1 - mix) + map.values[next] * mix
  }

  function appendSampledSegment(segment, className) {
    const item = document.createElement('span')
    item.className = `${className} ${segment.level || 'low'}`
    const left = clamp(segment.leftPct || 0, 0, 99.6)
    item.style.left = `${left}%`
    item.style.width = `${clamp(segment.widthPct || 0.4, 0.4, 100 - left)}%`
    els.scrubberIndicators.append(item)
  }

  function idleSegments(start, end) {
    const points = state.timeline
      .map((item) => clamp(item.tsMs || start, start, end))
      .filter((tsMs, index, list) => index === 0 || tsMs !== list[index - 1])
    if (!points.length) return []
    const idleThreshold = Math.max(5000, (end - start) * 0.025)
    const out = []
    let previous = start
    for (const point of points) {
      if (point - previous >= idleThreshold) out.push({ startTs: previous, endTs: point })
      previous = point
    }
    if (end - previous >= idleThreshold) out.push({ startTs: previous, endTs: end })
    return out
  }

  function activityLevel(value, max) {
    if (max <= 1) return 'low'
    const ratio = value / max
    if (ratio >= 0.66) return 'high'
    if (ratio >= 0.28) return 'medium'
    return 'low'
  }

  function downloadSegments(start, end) {
    const availability = state.availability || {}
    const gaps = Array.isArray(availability.gaps) ? availability.gaps : []
    const out = []
    for (const gap of gaps) {
      const startTs = tsForSeqApprox(gap.startSeq, start, end)
      const endTs = tsForSeqApprox((gap.endSeq || gap.startSeq) + 1, start, end)
      out.push({ startTs, endTs: Math.max(endTs, startTs + 400) })
    }
    if (availability.logLength > availability.availableLength && !gaps.length) {
      const startTs = tsForSeqApprox(availability.availableLength + 1, start, end)
      out.push({ startTs, endTs: end })
    }
    return out.map((segment) => ({
      startTs: clamp(segment.startTs, start, end),
      endTs: clamp(segment.endTs, start, end)
    }))
  }

  function tsForSeqApprox(seq, start, end) {
    if (!state.timeline.length) return start
    const exact = state.timeline.find((item) => item.seq === seq)
    if (exact) return exact.tsMs
    const before = [...state.timeline].reverse().find((item) => item.seq < seq)
    const after = state.timeline.find((item) => item.seq > seq)
    if (before && after && after.seq !== before.seq) {
      const pct = (seq - before.seq) / (after.seq - before.seq)
      return before.tsMs + (after.tsMs - before.tsMs) * pct
    }
    if (before) return before.tsMs
    if (after) return after.tsMs
    return end
  }

  function indicatorSegment(segment, className, start, span, collapseMap) {
    const item = document.createElement('span')
    item.className = className
    let left
    let width
    if (collapseMap && collapseMap.compressedSpan > 0) {
      const compSpan = collapseMap.compressedSpan
      const leftComp = realToCompressed(collapseMap, segment.startTs)
      const rightComp = realToCompressed(collapseMap, segment.endTs)
      left = (leftComp / compSpan) * 100
      width = Math.max(0.4, ((rightComp - leftComp) / compSpan) * 100)
    } else {
      left = ((segment.startTs - start) / span) * 100
      width = Math.max(0.4, ((segment.endTs - segment.startTs) / span) * 100)
    }
    const boundedLeft = clamp(left, 0, 99.6)
    item.style.left = `${boundedLeft}%`
    item.style.width = `${clamp(width, 0.4, 100 - boundedLeft)}%`
    return item
  }

  function tsForScrubberValue(value) {
    const start = state.playbackStartTs
    const end = currentPlaybackEndTs()
    const collapseMap = getTimeCollapseMap(start, end)
    if (collapseMap) {
      if (collapseMap.compressedSpan <= 0) return start
      const compTs = (collapseMap.compressedSpan * value) / SCRUBBER_STEPS
      return compressedToReal(collapseMap, compTs)
    }
    const span = end - start
    return start + (span * value) / SCRUBBER_STEPS
  }

  function scrubberValueForTs(tsMs) {
    const start = state.playbackStartTs
    const end = currentPlaybackEndTs()
    const collapseMap = getTimeCollapseMap(start, end)
    if (collapseMap) {
      if (collapseMap.compressedSpan <= 0) return SCRUBBER_STEPS
      const compTs = realToCompressed(collapseMap, tsMs)
      return Math.round((compTs / collapseMap.compressedSpan) * SCRUBBER_STEPS)
    }
    const span = end - start
    if (span <= 0) return SCRUBBER_STEPS
    return Math.round(((tsMs - start) / span) * SCRUBBER_STEPS)
  }

  function currentPlaybackEndTs() {
    if (state.currentSession && state.currentSession.active) return Date.now()
    return state.playbackEndTs
  }

  function fitAndResize() {
    if (!state.fit) return
    syncTerminalLayout()
    if (state.startupLogoActive && !state.selectedId) {
      fitStartupLogoTerminal()
      return
    }
    if (state.mode === 'playback') {
      if (state.playbackFrame) {
        fitPlaybackFrame(state.playbackFrame)
        refreshTerminal()
      }
      return
    }
    if (state.mode === 'live' && isJoinedSession()) {
      if (state.liveFrame) fitPlaybackFrame(state.liveFrame)
      return
    }
    fitLiveTerminal()
    if (state.mode === 'live' && state.selectedId) {
      if (canResizeSelectedLiveSession()) {
        api
          .invoke('session.resize', {
            sessionId: state.selectedId,
            ...dimensions(),
            fontSize: state.liveFontSize
          })
          .catch(showError)
      }
    }
  }

  function canResizeSelectedLiveSession() {
    const current = state.sessions.find((session) => session.sessionId === state.selectedId)
    return !!(
      current &&
      !current.pending &&
      current.active &&
      current.owner !== 'joined' &&
      !current.isJoined
    )
  }

  function fitLiveTerminal() {
    syncTerminalLayout()
    setLetterboxed(false)
    els.terminal.style.width = '100%'
    els.terminal.style.height = '100%'
    setTerminalFontSize(state.liveFontSize)
    if (!fitTerminalToContainer()) return
    // The grid is whole cells, so the container keeps the leftover fraction of a
    // row and column. While the element is 100% that slack all sits below and
    // right of the screen; snapping the element to the grid lets the wrap centre
    // it, so the slack reads as even bars like a letterboxed remote view. The
    // next fit resets the element to 100% first, so this never feeds back into
    // proposeDimensions().
    sizeTerminalToGrid(state.term.cols, state.term.rows, terminalCellMetrics(state.liveFontSize))
    setLetterboxed(true)
  }

  // FitAddon clamps a container that has no real size yet (hidden window,
  // a transient configure while the window is being shown, maximized or
  // restored to a profile's bounds) to a 2-column grid instead of refusing.
  // xterm never reflows the cursor row, so whatever status line was being
  // written stayed broken into 2-character rows. Keep the previous grid until
  // the container is big enough to be a real layout.
  function fitTerminalToContainer() {
    const proposed = state.fit.proposeDimensions()
    if (!proposed || proposed.cols < MIN_FIT_COLS || proposed.rows < MIN_FIT_ROWS) return false
    state.fit.fit()
    return true
  }

  function fitStartupLogoTerminal() {
    syncTerminalLayout()
    setLetterboxed(false)
    const bounds = terminalContentBounds()
    const layoutKey = `${Math.round(bounds.width)}x${Math.round(bounds.height)}@${window.devicePixelRatio}`
    let layout = state.startupLogoLayout
    // fontSizeForGrid folds in the terminal's own last-rendered cell metrics, so
    // recomputing it for an unchanged container feeds on its own rounding and
    // steps the logo between neighbouring sizes (the startup logo resizing a
    // few times). Keep the size until the container actually changes.
    if (!layout || layout.key !== layoutKey) {
      const fontSize = Math.max(8, fontSizeForGrid(STARTUP_LOGO_COLS, STARTUP_LOGO_ROWS) - 2)
      layout = { key: layoutKey, fontSize, metrics: terminalCellMetrics(fontSize) }
      state.startupLogoLayout = layout
    }
    setTerminalFontSize(layout.fontSize)
    state.term.resize(STARTUP_LOGO_COLS, STARTUP_LOGO_ROWS)
    sizeTerminalToGrid(STARTUP_LOGO_COLS, STARTUP_LOGO_ROWS, layout.metrics)
  }

  function fitPlaybackFrame(frame) {
    syncTerminalLayout()
    setLetterboxed(true)
    const cols = frame.cols || 100
    const rows = frame.rows || 30
    const bounds = terminalContentBounds()
    const layoutKey = `${cols}x${rows}:${Math.round(bounds.width)}x${Math.round(bounds.height)}`
    let layout = state.playbackGridLayout

    // A frame normally carries a full terminal snapshot but not a new layout.
    // Keeping that layout avoids deriving the next font size from xterm's
    // just-resized metrics, which made stepping frames visibly oscillate.
    if (!layout || layout.key !== layoutKey) {
      const fontSize = fontSizeForGrid(cols, rows)
      layout = {
        key: layoutKey,
        fontSize,
        metrics: terminalCellMetrics(fontSize)
      }
      state.playbackGridLayout = layout
    }
    setTerminalFontSize(layout.fontSize)
    if (state.term.cols !== cols || state.term.rows !== rows) state.term.resize(cols, rows)
    sizeTerminalToGrid(cols, rows, layout.metrics)
  }

  function setLetterboxed(letterboxed) {
    if (els.terminalWrap) els.terminalWrap.classList.toggle('terminal-letterboxed', letterboxed)
  }

  function sizeTerminalToGrid(cols, rows, fallbackMetrics) {
    const metrics = currentRenderCellMetrics() || fallbackMetrics
    els.terminal.style.width = `${Math.ceil(cols * metrics.width)}px`
    els.terminal.style.height = `${Math.ceil(rows * metrics.height)}px`
  }

  function syncTerminalLayout() {
    if (!els.terminalWrap || !els.terminal) return
    const viewportHeight = Math.floor(
      window.visualViewport && window.visualViewport.height
        ? window.visualViewport.height
        : window.innerHeight
    )
    const wrapTop = els.terminalWrap.getBoundingClientRect().top
    const bottomHeight = els.bottom ? els.bottom.getBoundingClientRect().height : 0
    const availableHeight = Math.max(80, Math.floor(viewportHeight - wrapTop - bottomHeight))
    const currentHeight = Math.round(els.terminalWrap.getBoundingClientRect().height)
    if (Math.abs(currentHeight - availableHeight) > 1) {
      els.terminalWrap.style.height = `${availableHeight}px`
    }
  }

  function fontSizeForGrid(cols, rows) {
    const bounds = terminalContentBounds()
    if (!bounds.width || !bounds.height || !cols || !rows) return state.liveFontSize
    const baseMetrics = terminalCellMetrics(state.liveFontSize)
    const widthRatio = baseMetrics.width / state.liveFontSize
    const heightRatio = baseMetrics.height / state.liveFontSize
    const horizontal = Math.max(0, bounds.width - 4) / (cols * widthRatio)
    const verticalSlack = Math.max(12, baseMetrics.height)
    const vertical = Math.max(0, bounds.height - verticalSlack) / (rows * heightRatio)
    return clamp(Math.floor(Math.min(horizontal, vertical) * 10) / 10, 5, maxGridFontSize())
  }

  function maxGridFontSize() {
    return Math.max(state.liveFontSize, 28)
  }

  function terminalCellMetrics(fontSize) {
    const renderMetrics = currentRenderCellMetrics()
    if (renderMetrics) {
      const currentFontSize =
        Number(state.term && state.term.options.fontSize) || state.liveFontSize
      const scale = fontSize / currentFontSize
      return {
        width: Math.max(1, renderMetrics.width * scale),
        height: Math.max(1, renderMetrics.height * scale)
      }
    }
    const lineHeight = Math.max(Number(state.term && state.term.options.lineHeight) || 1.08, 1.18)
    return {
      width: Math.max(1, measureTerminalGlyphWidth(fontSize)),
      height: Math.max(1, fontSize * lineHeight)
    }
  }

  function currentRenderCellMetrics() {
    const cell = state.term?._core?._renderService?.dimensions?.css?.cell
    if (!cell || !cell.width || !cell.height) return null
    return { width: cell.width, height: cell.height }
  }

  function measureTerminalGlyphWidth(fontSize) {
    if (!measureTerminalGlyphWidth.canvas) {
      measureTerminalGlyphWidth.canvas = document.createElement('canvas')
    }
    const context = measureTerminalGlyphWidth.canvas.getContext('2d')
    if (!context) return fontSize * 0.62
    const family =
      (state.term && state.term.options.fontFamily) ||
      'Menlo, Monaco, Consolas, "Liberation Mono", monospace'
    context.font = `${fontSize}px ${family}`
    return context.measureText('W').width || fontSize * 0.62
  }

  function terminalContentBounds() {
    const bounds = els.terminalWrap.getBoundingClientRect()
    const styles = window.getComputedStyle(els.terminalWrap)
    const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight)
    const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom)
    return {
      width: Math.max(0, bounds.width - horizontalPadding),
      height: Math.max(0, bounds.height - verticalPadding)
    }
  }

  function setTerminalFontSize(size) {
    if (!state.term || state.term.options.fontSize === size) return
    state.term.options.fontSize = size
  }

  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark', true)
  }

  function toggleDevb() {
    applyDevb(!state.devb, true)
    if (state.devb && !state.selectedId) {
      startDevTerminalLog('manual')
      devLog('developer diagnostics enabled')
    } else if (!state.devb && !state.selectedId) {
      stopDevTerminalLog()
      drawStartupLogo({ clear: true }).catch(showError)
    }
  }

  async function showIdleSurfaceFromDevToggle(event) {
    event.preventDefault()
    await showNoSessionSelected()
  }

  // Synchronous, localStorage-only default so the very first paint (before
  // the preload bridge/main process round-trip is available) doesn't flash
  // the wrong theme. localStorage lives inside Chromium's own userData dir,
  // which is now a fresh scratch directory per launch (see electron/main.js
  // - Chromium profile-locking used to serialize concurrent launches, so
  // each process got its own private profile to remove that contention) -
  // so this alone would silently reset the theme every launch. The durable
  // choice lives in main-process preferences.json via
  // storedThemePreference()/applyTheme(..., true) below, mirroring how
  // devb/dev-mode already persists.
  function preferredTheme() {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light'
    }
    return 'dark'
  }

  async function storedThemePreference() {
    const local = window.localStorage.getItem(THEME_STORAGE_KEY)
    try {
      const saved = await api.invoke('app.preference.get', { key: THEME_STORAGE_KEY })
      if (saved === 'light' || saved === 'dark') return saved
    } catch {}
    return local === 'light' || local === 'dark' ? local : preferredTheme()
  }

  async function preferredDevb() {
    const saved = await storedDevbPreference()
    if (saved === '0' || saved === 'false') return false
    if (saved === '1' || saved === 'true') return true
    return true
  }

  function initialPreferredDevb() {
    const saved = window.localStorage.getItem(DEVB_STORAGE_KEY)
    if (saved === '0' || saved === 'false') return false
    if (saved === '1' || saved === 'true') return true
    return true
  }

  async function storedDevbPreference() {
    const local = window.localStorage.getItem(DEVB_STORAGE_KEY)
    try {
      const saved = await api.invoke('app.preference.get', { key: DEVB_STORAGE_KEY })
      if (saved === '0' || saved === 'false' || saved === '1' || saved === 'true') return saved
    } catch {}
    return local
  }

  function applyTheme(theme, persist = false) {
    state.theme = theme
    document.documentElement.dataset.theme = theme
    if (persist) {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
      if (api) {
        api.invoke('app.preference.set', { key: THEME_STORAGE_KEY, value: theme }).catch(() => {})
      }
    }
    if (els.themeToggle) {
      const icon = els.themeToggle.querySelector('i')
      if (icon) {
        icon.className = `fa-solid ${theme === 'dark' ? 'fa-sun' : 'fa-moon'}`
      }
      els.themeToggle.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
    }
    if (state.term) {
      state.term.options.theme = terminalTheme()
      refreshTerminal()
    }
  }

  function applyDevb(enabled, persist = false) {
    state.devb = !!enabled
    if (persist) {
      const value = state.devb ? '1' : '0'
      window.localStorage.setItem(DEVB_STORAGE_KEY, value)
      if (api) api.invoke('app.preference.set', { key: DEVB_STORAGE_KEY, value }).catch(() => {})
    }
  }

  // Copy on select is per profile: the preference key carries the selected
  // profile id, so two profiles in the same install keep their own answer.
  // Falls back to the bare key until a profile has been picked.
  function copyOnSelectKey() {
    const profileId = state.profile && state.profile.selectedId
    return profileId ? `${COPY_ON_SELECT_STORAGE_KEY}.${profileId}` : COPY_ON_SELECT_STORAGE_KEY
  }

  async function preferredCopyOnSelect() {
    const key = copyOnSelectKey()
    const local = window.localStorage.getItem(key)
    let saved = local
    try {
      const stored = await api.invoke('app.preference.get', { key })
      if (stored === '0' || stored === 'false' || stored === '1' || stored === 'true') {
        saved = stored
      }
    } catch {}
    if (saved === '0' || saved === 'false') return false
    return true
  }

  function applyCopyOnSelect(enabled, persist = false) {
    state.copyOnSelect = !!enabled
    if (persist) {
      const key = copyOnSelectKey()
      const value = state.copyOnSelect ? '1' : '0'
      window.localStorage.setItem(key, value)
      if (api) api.invoke('app.preference.set', { key, value }).catch(() => {})
    }
  }

  function toggleCopyOnSelect() {
    applyCopyOnSelect(!state.copyOnSelect, true)
  }

  // Ctrl -/+ zoom is a keyboard habit rather than a per-profile choice, so it
  // is stored install-wide like the theme and developer mode.
  async function preferredCtrlZoom() {
    const local = window.localStorage.getItem(CTRL_ZOOM_STORAGE_KEY)
    let saved = local
    try {
      const stored = await api.invoke('app.preference.get', { key: CTRL_ZOOM_STORAGE_KEY })
      if (stored === '0' || stored === 'false' || stored === '1' || stored === 'true') {
        saved = stored
      }
    } catch {}
    if (saved === '0' || saved === 'false') return false
    return true
  }

  function applyCtrlZoom(enabled, persist = false) {
    state.ctrlZoom = !!enabled
    if (persist) {
      const value = state.ctrlZoom ? '1' : '0'
      window.localStorage.setItem(CTRL_ZOOM_STORAGE_KEY, value)
      if (api) {
        api.invoke('app.preference.set', { key: CTRL_ZOOM_STORAGE_KEY, value }).catch(() => {})
      }
    }
  }

  // The two Ctrl -/+ modes share the keys, so turning one on turns the other
  // off; both may be off, leaving the chord to the terminal.
  function toggleCtrlZoom() {
    const next = !state.ctrlZoom
    applyCtrlZoom(next, true)
    if (next && state.appZoom) applyAppZoom(false, true)
  }

  function toggleAppZoom() {
    const next = !state.appZoom
    applyAppZoom(next, true)
    if (next && state.ctrlZoom) applyCtrlZoom(false, true)
  }

  async function restoreZoomPreferences() {
    const appZoom = (await storedAppPreference(APP_ZOOM_STORAGE_KEY)) === '1'
    applyAppZoom(appZoom, false)
    applyCtrlZoom(appZoom ? false : await preferredCtrlZoom(), false)
    const level = Number.parseFloat((await storedAppPreference(APP_ZOOM_LEVEL_STORAGE_KEY)) || '')
    setAppZoomLevel(appZoom && Number.isFinite(level) ? level : 0, false)
  }

  // Install-wide like the Ctrl font zoom; the engine copy wins over the
  // localStorage one, which only covers a missing engine answer.
  async function storedAppPreference(key) {
    let saved = window.localStorage.getItem(key)
    try {
      const stored = await api.invoke('app.preference.get', { key })
      if (typeof stored === 'string') saved = stored
    } catch {}
    return saved
  }

  function persistAppPreference(key, value) {
    window.localStorage.setItem(key, value)
    if (api) api.invoke('app.preference.set', { key, value }).catch(() => {})
  }

  // Turning whole-app zoom off also puts the app back at 100%, since the
  // keys that could undo it now belong to something else.
  function applyAppZoom(enabled, persist = false) {
    state.appZoom = !!enabled
    if (persist) persistAppPreference(APP_ZOOM_STORAGE_KEY, state.appZoom ? '1' : '0')
    if (!state.appZoom && state.appZoomLevel !== 0) setAppZoomLevel(0, persist)
  }

  function setAppZoomLevel(level, persist = false) {
    const next = clamp(
      Math.round(level / APP_ZOOM_STEP) * APP_ZOOM_STEP,
      APP_ZOOM_MIN,
      APP_ZOOM_MAX
    )
    state.appZoomLevel = next
    if (bridge && typeof bridge.setZoomLevel === 'function') bridge.setZoomLevel(next)
    if (persist) persistAppPreference(APP_ZOOM_LEVEL_STORAGE_KEY, String(next))
  }

  // Ctrl -/+ step the zoom and Ctrl 0 resets it, wherever focus is.
  function appZoomKey(event) {
    if (!state.appZoom || !event) return null
    if (event.key === '+' || event.key === '=' || event.key === 'Add') return 1
    if (event.key === '-' || event.key === '_' || event.key === 'Subtract') return -1
    if (event.key === '0') return 0
    return null
  }

  function stepAppZoom(direction) {
    const level = direction === 0 ? 0 : state.appZoomLevel + direction * APP_ZOOM_STEP
    setAppZoomLevel(level, true)
    setStatus(`app zoom ${Math.round(Math.pow(1.2, state.appZoomLevel) * 100)}%`)
  }

  function noteTerminalGesture() {
    state.terminalGestureAt = Date.now()
  }

  // OSC 52 is how a program copies to the clipboard of the terminal it is
  // drawn in.  Claude Code in fullscreen owns the mouse, makes the selection
  // itself and, over ssh, can only hand it over this way.  Only writes are
  // honoured (a '?' read query is ignored), only from live output of a
  // session this app may type into, and only shortly after the user clicked
  // or typed in the terminal.
  function copyFromOsc52(data) {
    const split = data.indexOf(';')
    if (split < 0) return true
    const payload = data.slice(split + 1)
    if (!payload || payload === '?') return true
    if (!state.liveWrites.active || !canInputToTerminal()) return true
    if (Date.now() - state.terminalGestureAt > OSC52_GESTURE_MS) return true
    let text = ''
    try {
      const binary = atob(payload)
      text = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
    } catch {
      return true
    }
    if (!text) return true
    navigator.clipboard.writeText(text).then(() => setStatus('copied selection'), showError)
    return true
  }

  // xterm fires onSelectionChange for every cell the drag crosses, so the
  // clipboard write waits for the pointer to come back up and the selection
  // to be final.
  function copySelectionOnPointerUp(event) {
    const drag = state.selectionDrag
    state.selectionDrag = null
    if (!state.copyOnSelect || !state.term) return
    const selected = state.term.hasSelection() ? state.term.getSelection() : ''
    const text = selected || selectDraggedCells(drag, event)
    if (!text) return
    navigator.clipboard.writeText(text).then(() => setStatus('copied selection'), showError)
  }

  // A program with mouse reporting on (Claude Code, vim, less) receives the
  // drag itself, so xterm never builds a selection and copy on select had
  // nothing to copy.  The drag is replayed through the terminal control here:
  // the same cells are selected, then read back the usual way.
  function selectDraggedCells(drag, event) {
    if (!drag || !drag.anchor || !event || !state.term) return ''
    const moved = Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y)
    if (moved < SELECTION_DRAG_MIN_PX) return ''
    const end = terminalSelectionCell(event)
    if (!end) return ''
    const [from, to] = orderTerminalCells(drag.anchor, end)
    const length = (to.row - from.row) * state.term.cols + (to.col - from.col)
    if (length <= 0) return ''
    state.term.select(from.col, from.row, length)
    state.selectionForced = state.term.hasSelection()
    return state.selectionForced ? state.term.getSelection() : ''
  }

  function orderTerminalCells(a, b) {
    if (b.row < a.row || (b.row === a.row && b.col < a.col)) return [b, a]
    return [a, b]
  }

  // Buffer coordinates for a mouse event, in the same half-cell rounding
  // xterm uses for its own drags, so a replayed selection covers the cells the
  // pointer crossed.  Falls back to the measured cell size when xterm's
  // internal mouse service is unavailable.
  function terminalSelectionCell(event) {
    const term = state.term
    if (!term || !event) return null
    const screen = term._core && term._core.screenElement
    if (!screen) return null
    const viewportY = (term.buffer && term.buffer.active && term.buffer.active.viewportY) || 0
    const mouse = term._core._mouseService
    if (mouse && typeof mouse.getCoords === 'function') {
      const coords = mouse.getCoords(event, screen, term.cols, term.rows, true)
      if (coords) return { col: coords[0] - 1, row: coords[1] - 1 + viewportY }
    }
    const metrics = currentRenderCellMetrics()
    if (!metrics) return null
    const rect = screen.getBoundingClientRect()
    const col = clamp(
      Math.ceil((event.clientX - rect.left + metrics.width / 2) / metrics.width) - 1,
      0,
      term.cols
    )
    const row = clamp(Math.ceil((event.clientY - rect.top) / metrics.height) - 1, 0, term.rows - 1)
    return { col, row: row + viewportY }
  }

  function clampSidebarWidth(width) {
    if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT
    // Never let the sidebar squeeze the terminal below a usable width.
    const room = window.innerWidth - 360
    const max = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, room))
    return Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, width)))
  }

  // `preferred` is the width asked for, before clamping to the window. It is
  // what a window resize re-applies, so a window that is briefly small (say,
  // while a profile's saved bounds are restored) does not shrink it for good.
  function applySidebarWidth(width, { preferred = true } = {}) {
    const next = clampSidebarWidth(width)
    if (preferred && Number.isFinite(width)) state.sidebarWidthPreferred = Math.round(width)
    document.documentElement.style.setProperty('--sidebar-width', `${next}px`)
    return next
  }

  // The width belongs to the profile (engine preference.* - the profile's
  // preferences.json). localStorage and the app-wide preference only hold the
  // last width used anywhere, as the first-paint guess before a profile's
  // engine is up.
  function persistSidebarWidth(width) {
    state.sidebarWidthPreferred = width
    const value = String(width)
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, value)
    if (api) {
      api.invoke('app.preference.set', { key: SIDEBAR_WIDTH_STORAGE_KEY, value }).catch(() => {})
      if (state.profile.selectedId) {
        api.invoke('preference.set', { key: SIDEBAR_WIDTH_STORAGE_KEY, value }).catch(() => {})
      }
    }
  }

  function restoreSidebarWidth() {
    const stored = Number.parseInt(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) || '', 10)
    if (Number.isFinite(stored)) applySidebarWidth(stored)
  }

  // Once the profile's engine is ready (startup and every profile selection).
  // A profile that never saved a width keeps the fallback already applied.
  async function restoreProfileSidebarWidth() {
    if (!api) return
    let saved = null
    try {
      saved = await api.invoke('preference.get', { key: SIDEBAR_WIDTH_STORAGE_KEY })
    } catch {
      return
    }
    const parsed = Number.parseInt(saved || '', 10)
    if (!Number.isFinite(parsed)) return
    state.sidebarWidthFromProfile = true
    applySidebarWidth(parsed)
  }

  function wireSidebarResizer() {
    const handle = els.sidebarResizer
    if (!handle || !els.app || !els.sidebar) return
    if (api) {
      api
        .invoke('app.preference.get', { key: SIDEBAR_WIDTH_STORAGE_KEY })
        .then((saved) => {
          const parsed = Number.parseInt(saved || '', 10)
          // Only a fallback: never override a width the profile already set.
          if (Number.isFinite(parsed) && !state.sidebarWidthFromProfile) applySidebarWidth(parsed)
        })
        .catch(() => {})
    }

    let dragPointer = null
    let dragWidth = 0
    // Distance between the grab point and the divider, so the divider tracks
    // the cursor instead of snapping to it on pointerdown.
    let dragOffset = 0

    const stopDrag = () => {
      if (dragPointer === null) return
      try {
        if (handle.hasPointerCapture(dragPointer)) handle.releasePointerCapture(dragPointer)
      } catch {}
      dragPointer = null
      handle.classList.remove('dragging')
      document.body.classList.remove('sidebar-resizing')
      persistSidebarWidth(dragWidth)
    }

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      dragPointer = event.pointerId
      const appLeft = els.app.getBoundingClientRect().left
      dragWidth = clampSidebarWidth(els.sidebar.getBoundingClientRect().width)
      dragOffset = event.clientX - appLeft - dragWidth
      try {
        handle.setPointerCapture(dragPointer)
      } catch {}
      handle.classList.add('dragging')
      document.body.classList.add('sidebar-resizing')
    })

    handle.addEventListener('pointermove', (event) => {
      if (dragPointer !== event.pointerId) return
      event.preventDefault()
      dragWidth = applySidebarWidth(
        event.clientX - els.app.getBoundingClientRect().left - dragOffset
      )
    })

    handle.addEventListener('pointerup', stopDrag)
    handle.addEventListener('pointercancel', stopDrag)

    handle.addEventListener('dblclick', () => {
      dragWidth = applySidebarWidth(SIDEBAR_WIDTH_DEFAULT)
      persistSidebarWidth(dragWidth)
    })

    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 32 : 8
      let delta = 0
      if (event.key === 'ArrowLeft') delta = -step
      else if (event.key === 'ArrowRight') delta = step
      else return
      event.preventDefault()
      const next = applySidebarWidth(els.sidebar.getBoundingClientRect().width + delta)
      persistSidebarWidth(next)
    })

    window.addEventListener('resize', () => {
      // Below 780px the sidebar spans the full width, so its measured size is
      // not the drag width and must not be fed back into the CSS variable.
      if (window.innerWidth <= 780) return
      if (Number.isFinite(state.sidebarWidthPreferred)) {
        applySidebarWidth(state.sidebarWidthPreferred)
      } else {
        applySidebarWidth(els.sidebar.getBoundingClientRect().width, { preferred: false })
      }
    })
  }

  function initialPreferredTimeCollapse() {
    const saved = window.localStorage.getItem(TIME_COLLAPSE_STORAGE_KEY)
    return saved === '1' || saved === 'true'
  }

  async function preferredTimeCollapse() {
    const local = window.localStorage.getItem(TIME_COLLAPSE_STORAGE_KEY)
    try {
      const saved = await api.invoke('app.preference.get', { key: TIME_COLLAPSE_STORAGE_KEY })
      if (saved === '0' || saved === 'false' || saved === '1' || saved === 'true') {
        return saved === '1' || saved === 'true'
      }
    } catch {}
    return local === '1' || local === 'true'
  }

  function applyTimeCollapse(enabled, persist = false) {
    state.timeCollapse.enabled = !!enabled
    invalidateTimeCollapseMap()
    if (persist) {
      const value = state.timeCollapse.enabled ? '1' : '0'
      window.localStorage.setItem(TIME_COLLAPSE_STORAGE_KEY, value)
      if (api) {
        api.invoke('app.preference.set', { key: TIME_COLLAPSE_STORAGE_KEY, value }).catch(() => {})
      }
    }
    if (els.collapseGaps) {
      els.collapseGaps.setAttribute('aria-pressed', state.timeCollapse.enabled ? 'true' : 'false')
      const icon = els.collapseGaps.querySelector('i')
      if (icon) {
        icon.className = state.timeCollapse.enabled ? 'fa-solid fa-expand' : 'fa-solid fa-compress'
      }
      els.collapseGaps.title = state.timeCollapse.enabled
        ? 'Show real time (currently collapsing empty time)'
        : 'Collapse empty time'
    }
  }

  async function toggleTimeCollapse() {
    const wasPlaying = state.playbackPlaying
    const tsMs = wasPlaying
      ? currentRunningPlaybackTs()
      : els.scrubber
        ? tsForScrubberValue(Number(els.scrubber.value))
        : state.playbackClockTs
    if (wasPlaying) updatePlaybackClock(tsMs)
    applyTimeCollapse(!state.timeCollapse.enabled, true)
    if (els.scrubber) {
      const value = clamp(scrubberValueForTs(tsMs), 0, SCRUBBER_STEPS)
      els.scrubber.value = value
      state.seek.pendingValue = value
      state.seek.lastDrawValue = value
      state.seek.lastDrawAt = Date.now()
      updateDragTime()
      renderScrubberIndicators()
    }
    if (wasPlaying && state.selectedId && state.mode === 'playback') {
      await api.invoke('player.play', {
        sessionId: state.selectedId,
        speed: Number(els.speed.value),
        collapse: playbackCollapseOptions()
      })
      startPlaybackClock(Number(els.speed.value))
    }
  }

  function invalidateTimeCollapseMap() {
    state.timeCollapseMap.timeline = null
    state.timeCollapseMap.breakpoints = null
    state.timeCollapseMap.compressedSpan = 0
  }

  function getTimeCollapseMap(startTs, endTs) {
    if (!state.timeCollapse.enabled) return null
    const thresholdMs = state.timeCollapse.thresholdMs
    const cache = state.timeCollapseMap
    if (
      cache.timeline === state.timeline &&
      cache.startTs === startTs &&
      cache.endTs === endTs &&
      cache.thresholdMs === thresholdMs &&
      cache.breakpoints
    ) {
      return cache
    }
    const breakpoints = buildTimeCollapseBreakpoints(state.timeline, startTs, endTs, thresholdMs)
    cache.timeline = state.timeline
    cache.startTs = startTs
    cache.endTs = endTs
    cache.thresholdMs = thresholdMs
    cache.breakpoints = breakpoints
    cache.compressedSpan = breakpoints.length ? breakpoints[breakpoints.length - 1].compTs : 0
    return cache
  }

  function buildTimeCollapseBreakpoints(timeline, startTs, endTs, thresholdMs) {
    if (endTs <= startTs) {
      return [
        { realTs: startTs, compTs: 0 },
        { realTs: endTs, compTs: 0 }
      ]
    }
    const points = new Set([startTs, endTs])
    for (const item of timeline) {
      if (item.tsMs > startTs && item.tsMs < endTs) points.add(item.tsMs)
    }
    const sorted = Array.from(points).sort((a, b) => a - b)
    const breakpoints = [{ realTs: sorted[0], compTs: 0 }]
    let compTs = 0
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1]
      compTs += Math.min(gap, thresholdMs)
      breakpoints.push({ realTs: sorted[i], compTs })
    }
    return breakpoints
  }

  function realToCompressed(map, tsMs) {
    const bp = map.breakpoints
    if (!bp || !bp.length) return 0
    if (tsMs <= bp[0].realTs) return bp[0].compTs
    if (tsMs >= bp[bp.length - 1].realTs) return bp[bp.length - 1].compTs
    let lo = 0
    let hi = bp.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (bp[mid].realTs <= tsMs) lo = mid
      else hi = mid
    }
    const a = bp[lo]
    const b = bp[hi]
    const realSpan = b.realTs - a.realTs
    if (realSpan <= 0) return a.compTs
    const frac = (tsMs - a.realTs) / realSpan
    return a.compTs + (b.compTs - a.compTs) * frac
  }

  function compressedToReal(map, compTs) {
    const bp = map.breakpoints
    if (!bp || !bp.length) return 0
    if (compTs <= bp[0].compTs) return bp[0].realTs
    if (compTs >= bp[bp.length - 1].compTs) return bp[bp.length - 1].realTs
    let lo = 0
    let hi = bp.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (bp[mid].compTs <= compTs) lo = mid
      else hi = mid
    }
    const a = bp[lo]
    const b = bp[hi]
    const compSpan = b.compTs - a.compTs
    if (compSpan <= 0) return a.realTs
    const frac = (compTs - a.compTs) / compSpan
    return a.realTs + (b.realTs - a.realTs) * frac
  }

  function terminalTheme() {
    const styles = window.getComputedStyle(document.documentElement)
    return {
      background: styles.getPropertyValue('--terminal-bg').trim(),
      foreground: styles.getPropertyValue('--terminal-fg').trim(),
      cursor: styles.getPropertyValue('--terminal-cursor').trim(),
      selectionBackground: styles.getPropertyValue('--terminal-selection').trim()
    }
  }

  function refreshTerminal() {
    if (!state.term) return
    if (typeof state.term.refresh === 'function') {
      state.term.refresh(0, Math.max(0, state.term.rows - 1))
    }
  }

  function resetVisibleTerminal() {
    if (!state.term) return
    state.term.reset()
    state.term.options.cursorBlink = true
    state.term.write(VISIBLE_TERMINAL_RESET, refreshTerminal)
  }

  async function showNoSessionSelected() {
    state.selectedId = null
    state.currentSession = null
    state.hd = false
    state.liveFrame = null
    state.playbackFrame = null
    state.playerReady = false
    state.playbackPlaying = false
    hideTerminalPending()
    els.title.textContent = 'No session selected'
    els.meta.textContent = ''
    renderSessions()
    updateTransportControls()
    resetVisibleTerminal()
    if (state.devb) {
      startDevTerminalLog('idle')
      devLog('no session selected')
      return
    }
    await drawStartupLogo()
  }

  function profileNameForId(profileId) {
    if (!profileId) return null
    const profile = state.profile.profiles.find((item) => item.id === profileId)
    return profile && profile.name ? profile.name : profileId
  }

  function updateWindowTitle() {
    const parts = [state.appInfo.name || 'ZBTerm']
    if (state.profile.selectedName) parts.push(state.profile.selectedName)
    if (state.identity && state.identity.displayId) parts.push(state.identity.displayId)
    const debugPort = state.appInfo.debugServer && state.appInfo.debugServer.port
    if (debugPort) parts.push(`debug @ http://localhost:${debugPort}`)
    document.title = parts.join(' - ')
  }

  function dimensions() {
    if (!state.term) return { cols: 100, rows: 30 }
    return { cols: state.term.cols, rows: state.term.rows }
  }

  function setStatus(text) {
    // A refused join owns the status line until it is dismissed, so routine
    // chatter cannot bury the reason the connection was refused.
    if (state.identityRefusal) {
      devLog(text)
      return
    }
    els.status.textContent = text
    devLog(text)
  }

  // A short, self-dismissing notice for something the host refused to do.
  function showToast(message) {
    const text = String(message || '').trim()
    if (!text) return
    const toast = document.createElement('div')
    toast.className = 'toast'
    toast.setAttribute('role', 'status')
    toast.textContent = text
    document.body.append(toast)
    setTimeout(() => toast.remove(), TOAST_MS)
    setStatus(text)
  }

  function showError(err) {
    if (isBenignBrowserError(err)) return
    console.error(err)
    state.startupError = err && err.message ? err.message : String(err)
    const code = err && err.code ? `${err.code}: ` : ''
    setStatus(`${code}${err.message || err}`)
  }

  function isBenignBrowserError(err) {
    const message = err && err.message ? err.message : String(err || '')
    return message.includes('ResizeObserver loop completed with undelivered notifications')
  }

  function isUnknownDebugMethodError(err) {
    const message = err && err.message ? err.message : String(err || '')
    return message.includes('Unknown method: debug.currentSelection')
  }

  function guard(fn) {
    return (...args) => {
      Promise.resolve(fn(...args))
        .catch(showError)
        .finally(() => focusPrimaryTarget())
    }
  }

  // The terminal is a single persistent xterm.js instance reused across the
  // startup logo and every session (live or playback), so it can always take
  // focus - there is no need for a separate invisible focus sink. Buttons and
  // native form controls (range/select) are prevented from retaining focus
  // (see the delegated 'mousedown' listener and commitScrub) so keyboard
  // input always lands in the terminal instead of accidentally re-triggering
  // whatever control was last clicked.
  function focusPrimaryTarget() {
    if (state.term) state.term.focus()
  }

  function resolveGlobal(name, prop) {
    const value = window[name]
    if (!value) return null
    return value[prop] || value
  }

  // Today -> "13:45"; within the last week -> "Tue 02:11"; same year ->
  // "Dec 12, 18:43"; older -> "Dec 12 2003" (no time - it's stale enough
  // that time-of-day isn't useful at a glance).
  function formatTime(ts) {
    const date = new Date(ts)
    const now = new Date()
    const pad2 = (n) => String(n).padStart(2, '0')
    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000)
    if (dayDiff === 0) return time
    if (dayDiff > 0 && dayDiff < 7) {
      const weekday = date.toLocaleDateString(undefined, { weekday: 'short' })
      return `${weekday} ${time}`
    }
    const month = date.toLocaleDateString(undefined, { month: 'short' })
    const day = date.getDate()
    if (date.getFullYear() === now.getFullYear()) return `${month} ${day}, ${time}`
    return `${month} ${day} ${date.getFullYear()}`
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit++
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    if (hours) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
  }

  const NPM_UPDATE_COMMAND = 'npm i -g zbterm@latest'

  // An npm install is updated through npm: the registry is asked at most once
  // a day, and the update button hands the user the one command that actually
  // upgrades their install.
  function wireNpmUpdater() {
    els.updateBtn.onclick = async () => {
      if (bridge && bridge.writeClipboardText) {
        await bridge.writeClipboardText(NPM_UPDATE_COMMAND)
      }
      setStatus(NPM_UPDATE_COMMAND)
    }
    if (!state.appInfo.updateCheckEnabled) return
    // Deliberately not awaited - a slow or unreachable registry must not hold
    // up startup.
    api
      .invoke('app.updateCheck')
      .then((result) => {
        if (!result || !result.available || !result.latest) return
        els.updateBtn.textContent = `Update to v${result.latest}`
        els.updateBtn.title = `${NPM_UPDATE_COMMAND} (click to copy)`
        els.updateBtn.hidden = false
      })
      .catch(() => {})
  }

  // The npm registry check is the only updater (D-08). Every other channel
  // leaves #update-btn hidden.
  function wireUpdater() {
    if (state.appInfo.channel === 'npm') wireNpmUpdater()
  }

  const debugRect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      top: r.top,
      left: r.left,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height
    }
  }

  function debugIntersectRects(...rects) {
    const valid = rects.filter(Boolean)
    if (!valid.length) return null
    const top = Math.max(...valid.map((rect) => rect.top))
    const left = Math.max(...valid.map((rect) => rect.left))
    const right = Math.min(...valid.map((rect) => rect.right))
    const bottom = Math.min(...valid.map((rect) => rect.bottom))
    return {
      top,
      left,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    }
  }

  function debugTerminalDisplay() {
    if (!state.term) return null
    const term = state.term
    const buffer = term.buffer && term.buffer.active
    const screen = document.querySelector('.xterm-screen')
    const viewport = document.querySelector('.xterm-viewport')
    const rowsEl = document.querySelector('.xterm-rows')
    const screenRect = debugRect(screen)
    const viewportRect = debugRect(viewport)
    const terminalRect = debugRect(els.terminal)
    const wrapRect = debugRect(els.terminalWrap)
    const contentBounds = els.terminalWrap ? terminalContentBounds() : null
    const windowRect = {
      top: 0,
      left: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height: window.innerHeight
    }
    const clipRect = debugIntersectRects(
      wrapRect,
      terminalRect,
      viewportRect || screenRect,
      windowRect
    )
    const cell = currentRenderCellMetrics()
    const rowHeight =
      (cell && cell.height) || (screenRect && term.rows ? screenRect.height / term.rows : 0)
    const domRows = rowsEl ? Array.from(rowsEl.children) : []
    const viewportY = buffer && Number.isFinite(buffer.viewportY) ? buffer.viewportY : 0
    const visibleRows = []
    for (let y = 0; y < term.rows; y++) {
      const line = buffer && buffer.getLine ? buffer.getLine(viewportY + y) : null
      const domRow = domRows[y] || null
      const rect =
        debugRect(domRow) ||
        (screenRect && rowHeight
          ? {
              top: screenRect.top + y * rowHeight,
              bottom: screenRect.top + (y + 1) * rowHeight,
              left: screenRect.left,
              right: screenRect.right,
              width: screenRect.width,
              height: rowHeight
            }
          : null)
      const fullyVisible = !!(
        rect &&
        clipRect &&
        clipRect.width > 0 &&
        clipRect.height > 0 &&
        rect.top >= clipRect.top - 0.75 &&
        rect.bottom <= clipRect.bottom + 0.75 &&
        rect.left >= clipRect.left - 0.75 &&
        rect.right <= clipRect.right + 0.75
      )
      visibleRows.push({
        index: y,
        bufferLine: viewportY + y,
        text: line && line.translateToString ? line.translateToString(false) : '',
        trimmedText: line && line.translateToString ? line.translateToString(true) : '',
        domText: domRow ? domRow.textContent : null,
        rect,
        fullyVisible
      })
    }
    const hiddenRows = visibleRows.filter((row) => !row.fullyVisible).map((row) => row.index)
    return {
      selectedId: state.selectedId,
      mode: state.mode,
      cols: term.cols,
      rows: term.rows,
      viewportY,
      baseY: buffer && Number.isFinite(buffer.baseY) ? buffer.baseY : null,
      cursor: buffer ? { x: buffer.cursorX, y: buffer.cursorY } : null,
      fontSize: term.options.fontSize,
      lineHeight: term.options.lineHeight,
      renderCell: cell,
      rects: {
        wrap: wrapRect,
        terminal: terminalRect,
        viewport: viewportRect,
        screen: screenRect,
        rows: debugRect(rowsEl),
        clip: clipRect,
        bottom: debugRect(els.bottom),
        contentBounds
      },
      rowsVisible: hiddenRows.length === 0 && visibleRows.length === term.rows,
      hiddenRows,
      visibleRows
    }
  }

  function debugModalState() {
    const overlay = document.querySelector('.modal-overlay')
    if (!overlay) return null
    const panel = overlay.querySelector('.modal-panel')
    const title = overlay.querySelector('.modal-title')
    const input = overlay.querySelector('.modal-input')
    const shareKey = overlay.querySelector('.share-key')
    return {
      title: title ? title.textContent : '',
      text: panel ? panel.textContent : '',
      inputValue: input ? input.value : null,
      shareKey: shareKey ? shareKey.value : null,
      actions: Array.from(overlay.querySelectorAll('.modal-actions button')).map((button) => ({
        text: button.textContent,
        disabled: !!button.disabled
      })),
      shareOptions: Array.from(overlay.querySelectorAll('.share-option')).map((button) => ({
        text: button.textContent,
        selected: button.classList.contains('selected')
      })),
      // The backend picker (D-14): every row, a broken one disabled with its reason.
      shareBackends: Array.from(overlay.querySelectorAll('.share-backend-choice')).map((label) => {
        const radio = label.querySelector('input')
        return {
          id: radio ? radio.value : null,
          text: label.textContent,
          checked: !!(radio && radio.checked),
          disabled: !!(radio && radio.disabled)
        }
      }),
      identity: activeIdentityWizard ? activeIdentityWizard.debugState() : null
    }
  }

  function debugButtonByText(root, text) {
    const needle = String(text || '')
      .trim()
      .toLowerCase()
    return Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent.trim().toLowerCase() === needle
    )
  }

  async function debugClickButton(root, text) {
    const button = debugButtonByText(root, text)
    if (!button) throw new Error(`Debug button not found: ${text}`)
    button.click()
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
    return debugModalState()
  }

  window.__zbtermDebugCommand = async (request = {}) => {
    const command = request.command || request.action
    const modal = () => {
      const overlay = document.querySelector('.modal-overlay')
      if (!overlay) throw new Error('Debug modal is not open')
      return overlay
    }
    if (command === 'share-open') {
      window.__zbtermDebugShareAutoJoin = request.autoJoin === false ? false : undefined
      els.shareSession.click()
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      return debugModalState()
    }
    if (command === 'share-select') {
      const option = Array.from(modal().querySelectorAll('.share-option')).find((button) =>
        button.textContent.toLowerCase().includes(String(request.type || '').toLowerCase())
      )
      if (!option) throw new Error(`Debug share option not found: ${request.type}`)
      option.click()
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      return debugModalState()
    }
    if (command === 'share-backend') {
      const radio = Array.from(modal().querySelectorAll('.share-backend-choice input')).find(
        (input) => input.value === String(request.backend || '')
      )
      if (!radio) throw new Error(`Debug share backend not found: ${request.backend}`)
      if (radio.disabled) throw new Error(`Debug share backend is disabled: ${request.backend}`)
      radio.click()
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      return debugModalState()
    }
    if (command === 'share-submit') return await debugClickButton(modal(), 'Share')
    if (command === 'share-copy') {
      const buttons = Array.from(modal().querySelectorAll('.modal-actions button'))
      const button = buttons[buttons.length - 1]
      if (!button) throw new Error('Debug share copy button not found')
      button.click()
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      return debugModalState()
    }
    if (command === 'share-done') return await debugClickButton(modal(), 'Done')
    if (command === 'join-open') {
      els.joinLink.click()
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      return debugModalState()
    }
    if (command === 'join-paste') return await debugClickButton(modal(), 'Paste')
    if (command === 'join-submit') return await debugClickButton(modal(), 'Join')
    if (command === 'identity-open') {
      // The settings entry point, so it ignores identity.setupDismissed.
      await openIdentityWizard()
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      return debugModalState()
    }
    if (command === 'identity-peers') return identityBadgeState()
    if (command === 'identity-annotate') {
      await annotatePeer({
        identityKey: request.identityKey,
        name: request.name,
        comment: request.comment
      })
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      return identityBadgeState()
    }
    if (String(command || '').startsWith('identity-')) {
      const wizard = activeIdentityWizard
      if (!wizard) throw new Error('Identity wizard is not open')
      if (command === 'identity-choose') await wizard.choose(request.provider)
      else if (command === 'identity-username') await wizard.setUsername(request.value)
      else if (command === 'identity-select-key') wizard.selectKey(request.fingerprint)
      else if (command === 'identity-add-key') await wizard.addKey(request.keyPath)
      else if (command === 'identity-submit') await wizard.submit()
      else throw new Error(`Unknown debug renderer command: ${command}`)
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      return debugModalState()
    }
    if (command === 'modal-state') return debugModalState()
    throw new Error(`Unknown debug renderer command: ${command}`)
  }

  window.__zbtermDebugTerminalDisplay = () => debugTerminalDisplay()

  window.__zbtermDebugLayout = () => {
    const cell = currentRenderCellMetrics()
    return {
      mode: state.mode,
      app: {
        selectedId: state.selectedId,
        currentSession: state.currentSession
          ? {
              sessionId: state.currentSession.sessionId,
              name: state.currentSession.name,
              owner: state.currentSession.owner,
              active: !!state.currentSession.active,
              pending: !!state.currentSession.pending
            }
          : null,
        sessions: state.sessions.map((session) => ({
          sessionId: session.sessionId,
          name: session.name,
          owner: session.owner,
          active: !!session.active,
          pending: !!session.pending,
          selected: session.sessionId === state.selectedId
        })),
        status: els.status ? els.status.textContent : '',
        title: els.title ? els.title.textContent : '',
        newDisabled: els.newSession ? !!els.newSession.disabled : null,
        joinDisabled: els.joinLink ? !!els.joinLink.disabled : null,
        playbackHidden: els.playback ? !!els.playback.hidden : null,
        terminalReady: !!state.term,
        devb: state.devb,
        startupPhase: state.startupPhase,
        startupError: state.startupError
      },
      devicePixelRatio: window.devicePixelRatio,
      window: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
      visualViewport: window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            scale: window.visualViewport.scale
          }
        : null,
      screen: {
        width: window.screen.width,
        height: window.screen.height,
        availWidth: window.screen.availWidth,
        availHeight: window.screen.availHeight
      },
      terminal: state.term
        ? {
            cols: state.term.cols,
            rows: state.term.rows,
            fontSize: state.term.options.fontSize,
            lineHeight: state.term.options.lineHeight,
            liveFontSize: state.liveFontSize,
            renderCell: cell
          }
        : null,
      modal: debugModalState(),
      identityBadges: identityBadgeState(),
      layout: {
        terminalWrap: debugRect(els.terminalWrap),
        terminal: debugRect(els.terminal),
        terminalStyle: els.terminal
          ? { width: els.terminal.style.width, height: els.terminal.style.height }
          : null,
        terminalText: els.terminal ? els.terminal.textContent : '',
        xtermScreen: debugRect(document.querySelector('.xterm-screen')),
        bottom: debugRect(els.bottom),
        contentBounds: els.terminalWrap ? terminalContentBounds() : null
      }
    }
  }
})()
