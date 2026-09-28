const http = require('http')
const { URL } = require('url')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 17077
const MAX_BODY_BYTES = 1024 * 1024

function createDebugServer(opts) {
  const getEngine = opts.getEngine
  const getPopups = opts.getPopups || (() => [])
  const getRendererLayout =
    opts.getRendererLayout ||
    (() => Promise.reject(httpError(404, 'Renderer layout is not available')))
  const getRendererTerminalDisplay =
    opts.getRendererTerminalDisplay ||
    (() => Promise.reject(httpError(404, 'Renderer terminal display is not available')))
  const getWindowBounds =
    opts.getWindowBounds ||
    (() => Promise.reject(httpError(404, 'Window bounds are not available')))
  const setWindowBounds =
    opts.setWindowBounds ||
    (() => Promise.reject(httpError(404, 'Window bounds are not available')))
  const executeRendererCommand =
    opts.executeRendererCommand ||
    (() => Promise.reject(httpError(404, 'Renderer commands are not available')))
  const onSelectSession = opts.onSelectSession || (() => {})
  const handlePopup =
    opts.handlePopup || (() => Promise.reject(httpError(404, 'Popup handler is not available')))
  const host = opts.host || DEFAULT_HOST
  const port = opts.port || DEFAULT_PORT
  let selectedSessionId = null
  let selectedMode = 'live'
  const recentEvents = []

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return send(res, 204)
      const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`)
      const route = match(req.method, url.pathname)
      if (!route) return send(res, 404, { error: { message: 'Not found' } })

      const body = await readJson(req)
      const engine = getEngine()
      if (!engine && route.requiresEngine !== false) {
        return send(res, 503, { error: { message: 'ZBTerm engine is not ready' } }, getPopups())
      }
      const ctx = { engine, body, query: url.searchParams, params: route.params }
      const result = await route.handler(ctx)
      const previousSelection = { sessionId: selectedSessionId, mode: selectedMode }
      if (result && result.selectedSessionId !== undefined) {
        selectedSessionId = result.selectedSessionId
      }
      if (result && result.selectedMode !== undefined) selectedMode = result.selectedMode
      if (
        selectedSessionId &&
        (selectedSessionId !== previousSelection.sessionId ||
          selectedMode !== previousSelection.mode)
      ) {
        onSelectSession({ sessionId: selectedSessionId, mode: selectedMode })
      }
      send(
        res,
        result && result.statusCode ? result.statusCode : 200,
        result && result.body ? result.body : result,
        getPopups()
      )
    } catch (err) {
      const statusCode = err.statusCode || 500
      send(res, statusCode, { error: errorJson(err) }, getPopups())
    }
  })

  function recordEvent(name, data) {
    recentEvents.push({ name, data, ts: Date.now() })
    if (recentEvents.length > 100) recentEvents.shift()
  }

  function selectSession(selection = {}) {
    const previousSelection = { sessionId: selectedSessionId, mode: selectedMode }
    if (selection.sessionId !== undefined) selectedSessionId = selection.sessionId
    if (selection.mode !== undefined) selectedMode = selection.mode
    if (
      selectedSessionId &&
      (selectedSessionId !== previousSelection.sessionId || selectedMode !== previousSelection.mode)
    ) {
      onSelectSession({ sessionId: selectedSessionId, mode: selectedMode })
    }
  }

  const routes = [
    route(
      'GET',
      '/health',
      async ({ engine }) => {
        const popups = getPopups()
        const renderer = await rendererHealth(popups).catch((err) => ({
          ok: false,
          reason: err && err.message ? err.message : String(err)
        }))
        return {
          ok: !!engine && renderer.ok,
          engineReady: !!engine,
          renderer,
          selectedSessionId,
          selectedMode,
          identity: engine ? await engine.invoke('identity.get') : null,
          popups
        }
      },
      { requiresEngine: false }
    ),
    route('GET', '/events', () => recentEvents, { requiresEngine: false }),
    route('GET', '/share/diagnostics', ({ engine }) => engine.invoke('share.diagnostics')),
    route('GET', '/sessions/:sessionId/input/diagnostics', async ({ engine, params }) =>
      inputDiagnostics(engine, params.sessionId, selectedSessionId, selectedMode, recentEvents)
    ),
    route('GET', '/popups', () => getPopups(), { requiresEngine: false }),
    route('GET', '/renderer/layout', () => getRendererLayout(), { requiresEngine: false }),
    route('GET', '/renderer/terminal-display', () => getRendererTerminalDisplay(), {
      requiresEngine: false
    }),
    route('POST', '/renderer/command', ({ body }) => executeRendererCommand(body || {}), {
      requiresEngine: false
    }),
    route('GET', '/window/bounds', () => getWindowBounds(), { requiresEngine: false }),
    route('POST', '/window/bounds', ({ body }) => setWindowBounds(body || {}), {
      requiresEngine: false
    }),
    route(
      'POST',
      '/popups/:popupId/actions/:action',
      ({ params, body }) => handlePopup(params.popupId, params.action, body || {}),
      { requiresEngine: false }
    ),
    route('GET', '/identity', async ({ engine }) => engine.invoke('identity.get')),
    route(
      'GET',
      '/debug/worker-pid',
      ({ engine }) => ({ pid: engine && typeof engine.pid === 'number' ? engine.pid : null }),
      { requiresEngine: false }
    ),
    route('GET', '/account/profile', ({ engine }) => engine.invoke('account.profile')),
    route('GET', '/account/devices', ({ engine }) => engine.invoke('account.devices')),
    route('GET', '/account/local-device', ({ engine }) => engine.invoke('account.localDevice')),
    route('GET', '/sessions', ({ engine, query }) =>
      engine.invoke('session.list', {
        query: query.get('query') || undefined,
        activeOnly: query.get('activeOnly') === 'true'
      })
    ),
    route('POST', '/sessions', async ({ engine, body }) => {
      const session = await engine.invoke('session.create', {
        name: body.name,
        cols: body.cols,
        rows: body.rows,
        cwd: body.cwd,
        command: body.command
      })
      return {
        selectedSessionId: body.select === false ? selectedSessionId : session.sessionId,
        selectedMode: body.select === false ? selectedMode : 'live',
        body: session
      }
    }),
    route('GET', '/sessions/current', async ({ engine }) => {
      if (!selectedSessionId) return { selectedSessionId: null, session: null }
      return {
        selectedSessionId,
        selectedMode,
        session: await sessionSummary(engine, selectedSessionId)
      }
    }),
    route('POST', '/sessions/current/input', ({ engine, body }) => {
      if (!selectedSessionId) throw httpError(409, 'No debug session is selected')
      return engine.invoke('session.input', { sessionId: selectedSessionId, data: inputData(body) })
    }),
    route('GET', '/sessions/:sessionId', ({ engine, params }) =>
      sessionSummary(engine, params.sessionId)
    ),
    route('POST', '/sessions/:sessionId/switch', async ({ engine, params }) => {
      await sessionSummary(engine, params.sessionId)
      return {
        selectedSessionId: params.sessionId,
        selectedMode: 'live',
        body: { selectedSessionId: params.sessionId }
      }
    }),
    route('POST', '/sessions/:sessionId/live', async ({ engine, params }) => {
      await engine.invoke('player.pause', { sessionId: params.sessionId }).catch(() => {})
      const session = await engine.invoke('session.open', { sessionId: params.sessionId })
      return {
        selectedSessionId: params.sessionId,
        selectedMode: 'live',
        body: session
      }
    }),
    // The engine revives the session at its last recorded grid; no geometry.
    route('POST', '/sessions/:sessionId/extend', async ({ engine, params }) => {
      const session = await engine.invoke('session.extend', { sessionId: params.sessionId })
      return {
        selectedSessionId: params.sessionId,
        selectedMode: 'live',
        body: session
      }
    }),
    route('POST', '/sessions/:sessionId/input', ({ engine, params, body }) =>
      engine.invoke('session.input', { sessionId: params.sessionId, data: inputData(body) })
    ),
    route('POST', '/sessions/:sessionId/resize', ({ engine, params, body }) =>
      engine.invoke('session.resize', {
        sessionId: params.sessionId,
        cols: body.cols,
        rows: body.rows,
        fontSize: body.fontSize
      })
    ),
    route('POST', '/sessions/:sessionId/share', async ({ engine, params, body }) => {
      if (body.inputMode) {
        await engine.invoke('share.setInputMode', {
          sessionId: params.sessionId,
          mode: body.inputMode
        })
      }
      const link = await engine.invoke('share.createLink', {
        sessionId: params.sessionId,
        type: body.type,
        maxViewers: body.maxViewers,
        caps: body.caps,
        autoJoin: body.autoJoin
      })
      return { ...link, key: link.uri }
    }),
    route('GET', '/sessions/:sessionId/shares', ({ engine, params }) =>
      engine.invoke('share.listLinks', { sessionId: params.sessionId })
    ),
    route('POST', '/sessions/:sessionId/approvals/:requestId/approve', ({ params }) =>
      handlePopup(approvalPopupId(params.sessionId, params.requestId), 'approve', {})
    ),
    route('POST', '/sessions/:sessionId/approvals/:requestId/deny', ({ params }) =>
      handlePopup(approvalPopupId(params.sessionId, params.requestId), 'deny', {})
    ),
    route('DELETE', '/sessions/:sessionId/shares/:linkId', ({ engine, params }) =>
      engine.invoke('share.revokeLink', {
        sessionId: params.sessionId,
        linkId: params.linkId
      })
    ),
    route('GET', '/sessions/:sessionId/stats', ({ engine, params }) =>
      sessionStats(engine, params.sessionId, selectedSessionId, selectedMode)
    ),
    route('POST', '/sessions/:sessionId/playback/open', async ({ engine, params }) => ({
      selectedSessionId: params.sessionId,
      selectedMode: 'playback',
      body: await engine.invoke('player.open', { sessionId: params.sessionId })
    })),
    route('POST', '/sessions/:sessionId/playback/seek', async ({ engine, params, body }) => ({
      selectedSessionId: params.sessionId,
      selectedMode: 'playback',
      body: await engine.invoke('player.seek', { sessionId: params.sessionId, tsMs: body.tsMs })
    })),
    route('POST', '/sessions/:sessionId/playback/play', async ({ engine, params, body }) => ({
      selectedSessionId: params.sessionId,
      selectedMode: 'playback',
      body: await engine.invoke('player.play', { sessionId: params.sessionId, speed: body.speed })
    })),
    route('POST', '/sessions/:sessionId/playback/pause', ({ engine, params }) =>
      engine.invoke('player.pause', { sessionId: params.sessionId })
    ),
    route('POST', '/sessions/:sessionId/playback/step', async ({ engine, params, body }) => ({
      selectedSessionId: params.sessionId,
      selectedMode: 'playback',
      body: await engine.invoke('player.step', { sessionId: params.sessionId, delta: body.delta })
    })),
    route('POST', '/join', async ({ engine, body }) => {
      const status = await engine.invoke('share.join', { uri: body.uri })
      return {
        selectedSessionId: status && status.sessionId ? status.sessionId : selectedSessionId,
        selectedMode: status && status.sessionId ? 'live' : selectedMode,
        body: status
      }
    }),
    route('POST', '/invoke', ({ engine, body }) => {
      if (!body.method) throw httpError(400, 'Missing method')
      return engine.invoke(body.method, body.args || {})
    })
  ]

  function match(method, pathname) {
    const requestParts = splitPath(pathname)
    for (const item of routes) {
      if (item.method !== method) continue
      if (item.parts.length !== requestParts.length) continue
      const params = {}
      let ok = true
      for (let i = 0; i < item.parts.length; i++) {
        const expected = item.parts[i]
        const actual = requestParts[i]
        if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual)
        else if (expected !== actual) {
          ok = false
          break
        }
      }
      if (ok) return { ...item, params }
    }
    return null
  }

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        resolve({ host, port: server.address().port })
      })
    })
  }

  function stop() {
    return new Promise((resolve) => {
      server.close(() => resolve())
    })
  }

  return { start, stop, recordEvent, selectSession }

  async function rendererHealth(popups) {
    const layout = await getRendererLayout()
    const renderer = layout && layout.renderer
    const app = renderer && renderer.app
    const ui = renderer && renderer.layout
    const hasProfilePicker = popups.some((popup) => popup.type === 'profile-picker')
    if (!app) return { ok: false, reason: 'renderer debug layout is not available' }
    if (app.startupError) return { ok: false, reason: app.startupError, app }
    if (hasProfilePicker) return { ok: true, phase: 'profile-picker', app }
    if (app.startupPhase !== 'ready') {
      return {
        ok: false,
        reason: `renderer startup phase is ${app.startupPhase || 'unknown'}`,
        app
      }
    }
    const xtermReady = !!(
      ui &&
      ui.xtermScreen &&
      ui.xtermScreen.width > 0 &&
      ui.xtermScreen.height > 0
    )
    if (!app.terminalReady || !xtermReady) {
      return { ok: false, reason: 'renderer terminal is not ready', app }
    }
    if (app.selectedId === null) {
      if (app.title !== 'No session selected') {
        return { ok: false, reason: `unexpected no-session title: ${app.title}`, app }
      }
      if (app.newDisabled !== false || app.joinDisabled !== false) {
        return { ok: false, reason: 'new/join controls are disabled in no-session state', app }
      }
      if (app.playbackHidden !== true) {
        return { ok: false, reason: 'playback controls are visible without a session', app }
      }
    }
    return { ok: true, phase: app.startupPhase, app }
  }
}

async function sessionSummary(engine, sessionId) {
  const sessions = await engine.invoke('session.list', {})
  const entry = sessions.find((session) => session.sessionId === sessionId) || null
  const opened = await engine.invoke('session.open', { sessionId })
  return { entry, opened }
}

async function sessionStats(engine, sessionId, selectedSessionId, selectedMode) {
  const summary = await sessionSummary(engine, sessionId)
  const opened = summary.opened || {}
  let playback = null
  try {
    playback = await engine.invoke('player.open', { sessionId })
  } catch (err) {
    playback = { error: errorJson(err) }
  }
  return {
    sessionId,
    selected: sessionId === selectedSessionId,
    mode: sessionId === selectedSessionId ? selectedMode : null,
    location: {
      owner: summary.entry && summary.entry.owner,
      path: summary.entry && summary.entry.path,
      active: !!(summary.entry && summary.entry.active)
    },
    history: {
      length: opened.length || 0,
      timeline: opened.timeline || [],
      availability: opened.availability || null,
      snapshotCount: summary.entry && summary.entry.snapshotCount,
      sizeBytes: summary.entry && summary.entry.sizeBytes
    },
    terminal: {
      cols: opened.info && opened.info.cols,
      rows: opened.info && opened.info.rows,
      frame: opened.frame || (playback && playback.frame) || null
    },
    playback,
    share: {
      isSharing: !!(summary.entry && summary.entry.isSharing),
      viewerCount: (summary.entry && summary.entry.viewerCount) || 0,
      inputMode: summary.entry && summary.entry.inputMode
    }
  }
}

async function inputDiagnostics(engine, sessionId, selectedSessionId, selectedMode, recentEvents) {
  const [stats, share] = await Promise.all([
    sessionStats(engine, sessionId, selectedSessionId, selectedMode),
    engine.invoke('share.diagnostics')
  ])
  return {
    sessionId,
    selected: stats.selected,
    mode: stats.mode,
    location: stats.location,
    inputMode: stats.share.inputMode,
    share,
    inputEvents: recentEvents.filter(
      (item) =>
        item.name === 'share:debug' &&
        item.data &&
        typeof item.data.event === 'string' &&
        item.data.event.includes(':input:')
    )
  }
}

function route(method, pattern, handler, opts = {}) {
  return { method, parts: splitPath(pattern), handler, requiresEngine: opts.requiresEngine }
}

function splitPath(pathname) {
  return pathname.split('/').filter(Boolean)
}

function inputData(body) {
  if (typeof body.data === 'string') return body.data
  if (typeof body.text === 'string') return body.text + (body.enter ? '\r' : '')
  if (Array.isArray(body.keys)) return body.keys.join('')
  throw httpError(400, 'Missing input data')
}

function approvalPopupId(sessionId, requestId) {
  return `share-approval:${sessionId}:${requestId}`
}

function readJson(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return Promise.resolve({})
  }
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, 'Request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(httpError(400, 'Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function send(res, statusCode, body, popups = []) {
  res.statusCode = statusCode
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('X-ZBTerm-Popups', JSON.stringify(popups))
  if (statusCode === 204) return res.end()
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body === undefined ? null : body))
}

function httpError(statusCode, message) {
  const err = new Error(message)
  err.statusCode = statusCode
  return err
}

function errorJson(err) {
  if (err && err.toJSON) return err.toJSON()
  return {
    name: (err && err.name) || 'Error',
    code: (err && err.code) || 'E_INTERNAL',
    message: (err && err.message) || String(err),
    details: (err && err.details) || null
  }
}

module.exports = {
  createDebugServer,
  DEFAULT_HOST,
  DEFAULT_PORT
}
