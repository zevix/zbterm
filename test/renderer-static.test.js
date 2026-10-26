const fs = require('fs')
const path = require('path')
const test = require('brittle')

test('profile picker hidden attribute is not overridden by display grid', async (t) => {
  const html = await fs.promises.readFile(
    path.join(__dirname, '..', 'renderer', 'index.html'),
    'utf8'
  )
  t.ok(html.includes('.profile-picker[hidden]'))
  t.ok(html.includes('display: none'))
})

test('renderer loads its assets from renderer/vendor, never from node_modules', async (t) => {
  const rendererDir = path.join(__dirname, '..', 'renderer')
  const html = await fs.promises.readFile(path.join(rendererDir, 'index.html'), 'utf8')
  const js = await fs.promises.readFile(path.join(rendererDir, 'app.js'), 'utf8')
  t.absent(html.includes('../node_modules'), 'index.html has no ../node_modules reference')
  t.absent(js.includes('../node_modules'), 'app.js has no ../node_modules reference')
})

test('renderer lets engine assign default session names', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  t.absent(js.match(/name:\s*`shell @/), 'renderer does not override engine default naming')
})

test('identity wizard markup and styles exist', async (t) => {
  const rendererDir = path.join(__dirname, '..', 'renderer')
  const js = await fs.promises.readFile(path.join(rendererDir, 'app.js'), 'utf8')
  const html = await fs.promises.readFile(path.join(rendererDir, 'index.html'), 'utf8')
  t.ok(js.includes('function showIdentityWizard('), 'app.js builds the identity wizard')
  t.ok(js.includes("'modal-overlay'"), 'wizard reuses the modal overlay class')
  t.ok(js.includes("'modal-panel identity-panel'"), 'wizard reuses the modal panel class')
  t.ok(js.includes("'identity-option text-btn'"), 'wizard renders identity options')
  t.ok(js.includes("'identity-key-row text-btn'"), 'wizard renders key rows')
  t.ok(js.includes("'identity-hint'"), 'wizard renders hints')
  t.ok(js.includes("'identity-error'"), 'wizard renders inline errors')
  t.ok(
    js.includes('state.popupResolvers.set(IDENTITY_POPUP_ID, close)'),
    'wizard registers a popup resolver so headless actions close it'
  )
  t.ok(js.includes("'Or enter the path to a private key file'"), 'wizard offers manual key entry')
  t.ok(js.includes("api.invoke('identity.sshInspect'"), 'manual entry inspects the key path')
  t.ok(html.includes('.identity-option'), 'index.html styles .identity-option')
  t.ok(html.includes('.identity-key-row.selected'), 'index.html styles the selected key row')
  t.ok(html.includes('.identity-hint'), 'index.html styles .identity-hint')
  t.ok(html.includes('.identity-error'), 'index.html styles .identity-error')
})

test('identity wizard gates submit on a published key', async (t) => {
  const rendererDir = path.join(__dirname, '..', 'renderer')
  const js = await fs.promises.readFile(path.join(rendererDir, 'app.js'), 'utf8')
  const html = await fs.promises.readFile(path.join(rendererDir, 'index.html'), 'utf8')
  t.ok(js.includes('function publishGate('), 'wizard has a publish gate')
  t.ok(
    js.includes("submit.disabled = wizard.provider === 'unknown' ? false : !publishGate().ok"),
    'submit is enabled only by the publish gate'
  )
  t.ok(
    js.includes('if (!candidatesAreMarked()) await checkUsername()') &&
      js.includes('if (!publishGate().ok) {'),
    'submit re-checks the username and refuses an ungated claim'
  )
  t.ok(js.includes('candidate.onProvider'), 'the gate reads the published-key mark')
  t.ok(html.includes('.identity-key-row.unpublished'), 'index.html styles an unpublished key row')
  t.ok(
    js.includes('checkUsername({ refresh: true })') && js.includes('refresh: !!opts.refresh'),
    'a recheck forces a fresh provider lookup past the cache'
  )
  t.ok(
    html.includes('.identity-error.identity-error-ok'),
    'index.html styles the passing gate verdict'
  )
})

test('identity wizard treats staying unverified as a submit', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  t.ok(js.includes("unknown: 'Stay Unidentified'"), 'submit relabels for the unknown provider')
  t.ok(
    js.includes("api.invoke('identity.clear')") &&
      js.indexOf("api.invoke('identity.clear')") > js.indexOf('async function submitClaim('),
    'identity.clear runs from submitClaim, not from choosing the option'
  )
  const choose = js.indexOf('async function chooseProvider(')
  const submitClaim = js.indexOf('async function submitClaim(')
  const clear = js.indexOf("api.invoke('identity.clear')")
  t.ok(choose > 0 && choose < submitClaim && clear > submitClaim, 'choosing unknown only selects')
})

test('identity wizard prefills the identity the profile already claims', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  t.ok(
    js.includes('usernameInput.value = current.subject'),
    'choosing GitHub prefills the current subject'
  )
  t.ok(
    js.includes('item.fingerprint === current.sshFingerprint'),
    'the key the profile already claims is preselected'
  )
  t.ok(
    js.includes("if (current.provider === 'github' && current.subject) {"),
    'a configured profile opens on its own provider'
  )
})

test('identity wizard headlines the current identity with a status mark', async (t) => {
  const rendererDir = path.join(__dirname, '..', 'renderer')
  const js = await fs.promises.readFile(path.join(rendererDir, 'app.js'), 'utf8')
  const html = await fs.promises.readFile(path.join(rendererDir, 'index.html'), 'utf8')
  t.ok(js.includes('function renderCurrentIdentity('), 'wizard renders the current identity line')
  t.ok(js.includes('`identity-current identity-current-${status}`'), 'the line carries its status')
  t.ok(js.includes('IDENTITY_ICONS[status]'), 'the line reuses the peer badge icons')
  t.ok(html.includes('.identity-current-verified > i'), 'index.html colors the verified mark')
  t.ok(html.includes('.identity-current-unknown > i'), 'index.html colors the unknown mark')
})

test('identity wizard submits beginClaim then sshSign then setSelf', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  const begin = js.indexOf("api.invoke('identity.beginClaim'")
  const sign = js.indexOf("api.invoke('identity.sshSign'")
  const set = js.indexOf("api.invoke('identity.setSelf'")
  t.ok(
    begin > 0 && sign > begin && set > sign,
    'submit sequence is beginClaim -> sshSign -> setSelf'
  )
})

test('renderer exposes the identity debug commands', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  for (const command of [
    'identity-open',
    'identity-choose',
    'identity-username',
    'identity-select-key',
    'identity-add-key',
    'identity-submit',
    'identity-peers',
    'identity-annotate'
  ]) {
    t.ok(js.includes(`'${command}'`), `__zbtermDebugCommand handles ${command}`)
  }
  t.ok(js.includes('identityBadges: identityBadgeState()'), '__zbtermDebugLayout reports badges')
})

test('identity badges render one span per peer with a status modifier', async (t) => {
  const rendererDir = path.join(__dirname, '..', 'renderer')
  const js = await fs.promises.readFile(path.join(rendererDir, 'app.js'), 'utf8')
  const html = await fs.promises.readFile(path.join(rendererDir, 'index.html'), 'utf8')
  t.ok(js.includes('function renderIdentityBadge('), 'app.js builds identity badges')
  t.ok(js.includes('`identity-badge identity-${status}`'), 'badge carries a status modifier class')
  t.ok(js.includes("'identity-badge-text'"), 'badge carries its display id in a text span')
  for (const status of ['verified', 'pending', 'unknown', 'failed']) {
    t.ok(js.includes(`'${status}'`), `app.js knows the ${status} identity status`)
    t.ok(html.includes(`.identity-${status}`), `index.html styles .identity-${status}`)
  }
  t.ok(js.includes("verified: 'fa-circle-check'"), 'verified peers use the check icon')
  t.ok(js.includes("unknown: 'fa-circle-question'"), 'unknown peers use the question icon')
  t.ok(js.includes("failed: 'fa-circle-xmark'"), 'failed peers use the cross icon')
  t.ok(js.includes("spinner.className = 'spinner'"), 'pending peers reuse the existing spinner')
  t.ok(html.includes('.identity-badge .spinner'), 'index.html sizes the spinner inside a badge')
  t.ok(html.includes('.identity-badge'), 'index.html styles .identity-badge')
  t.ok(html.includes('.session-identity'), 'index.html styles the session row badge holder')
  t.absent(html.includes('.identity-badge {\n        color: #fff'), 'no hard-coded badge color')
})

test('identity badges come from a memoized map, never from the render loop', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  t.ok(js.includes('peerIdentity: new Map()'), 'state keeps a peer identity map')
  t.ok(js.includes("api.on('share:peer-identity'"), 'map is fed by share:peer-identity events')
  t.ok(js.includes('function ingestSessionIdentities('), 'map is fed by session.list rows')
  const render = js.indexOf('function renderSessions(')
  const renderEnd = js.indexOf('\n  function renderSessionSelect(')
  const body = js.slice(render, renderEnd)
  t.absent(
    body.includes("api.invoke('identity.peers'"),
    'renderSessions never calls identity.peers'
  )
})

test('approval dialog swaps the group-link warning for the identity state', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  const warning = 'YOU CANT TELL WHO IS REALLY JOINING VIA A GROUP LINK'
  t.ok(js.includes(warning), 'the unknown-requester warning still exists')
  t.ok(
    js.includes("status === 'unknown' && request.linkType === 'group'"),
    'the warning is no longer unconditional for group links'
  )
  t.ok(
    js.includes('identity: {') && js.includes('reason: peer.failureReason'),
    'the requester identity is announced on the shared identity line instead'
  )
  t.ok(
    js.includes('ok.disabled = identityBlocked') && js.includes('if (ok.disabled) return'),
    'a blocked identity disables OK and survives implicit submission'
  )
})

test('the join dialog inspects the inviter identity before connecting', async (t) => {
  const rendererDir = path.join(__dirname, '..', 'renderer')
  const js = await fs.promises.readFile(path.join(rendererDir, 'app.js'), 'utf8')
  const html = await fs.promises.readFile(path.join(rendererDir, 'index.html'), 'utf8')
  t.ok(js.includes(".invoke('identity.inspectInvite', { uri })"), 'the pasted uri is inspected')
  t.ok(js.includes('identity.set({ checking: true })'), 'the line starts in the checking state')
  t.ok(js.includes('token !== inspectToken'), 'a stale inspection answer is dropped')
  t.ok(js.includes('if (!uri || blocked) return'), 'a blocked invite cannot be submitted')
  t.ok(
    html.includes('@keyframes peer-identity-flash') &&
      html.includes('.peer-identity-checking > .peer-identity-head > i'),
    'the checking mark flashes'
  )
  t.ok(
    html.includes('.peer-identity-verified > .peer-identity-head > i'),
    'a verified inviter gets the green mark'
  )
})

test('the identity line explains every state in one sentence', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  t.ok(js.includes('function identityLineState('), 'one function maps state to presentation')
  t.ok(js.includes("'The user is not github authorized'"), 'an unclaimed identity is explained')
  t.ok(js.includes('`Verifying user "${name}" identity`'), 'a checking identity is explained')
  t.ok(
    js.includes("`Error: Failed to verify ${claimedId}${reason ? ` - ${reason}` : ''}`"),
    'a failed identity names what was claimed and why it failed'
  )
  t.ok(js.includes('blocked: true'), 'checking and failed states block the action')
  t.ok(
    js.includes('function peerIdentityLine('),
    'the join and approval dialogs share one component'
  )
})

test('peer annotations are local and a refused join stays on the status line', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  t.ok(js.includes("api.invoke('identity.annotatePeer'"), 'annotation calls identity.annotatePeer')
  t.ok(js.includes('function showPeerAnnotation('), 'a modal collects name and comment')
  t.ok(js.includes("placeholder: 'Local name'"), 'annotation modal has a name input')
  t.ok(js.includes('function identityAnnotateButton('), 'a pencil opens the annotation modal')
  t.ok(js.includes('event.stopPropagation()'), 'the pencil does not select the session row')
  t.ok(js.includes('`Refused: ${reason}`'), 'a refused join reports the reason')
  t.ok(js.includes('function clearIdentityRefusal('), 'the refusal stays until dismissed')
})

test('the cogwheel opens a settings menu instead of toggling dev mode', async (t) => {
  const rendererDir = path.join(__dirname, '..', 'renderer')
  const js = await fs.promises.readFile(path.join(rendererDir, 'app.js'), 'utf8')
  const html = await fs.promises.readFile(path.join(rendererDir, 'index.html'), 'utf8')
  t.absent(html.includes('id="devbToggle"'), 'the dev-mode toggle button is gone')
  t.ok(html.includes('id="settingsToggle"'), 'index.html has the settings cogwheel')
  t.ok(html.includes('id="settingsMenu"'), 'index.html has the settings menu container')
  t.ok(html.includes('.context-menu-check .check-mark'), 'index.html styles the menu checkmark')
  t.ok(
    html.includes(".context-menu-check[aria-checked='false'] .check-mark"),
    'an unchecked row hides the tick without losing its column'
  )
  t.ok(
    js.includes("els.settingsToggle.addEventListener('click', toggleSettingsMenu)"),
    'the cogwheel opens the menu'
  )
  t.ok(js.includes("label: 'Developer Mode'"), 'the menu offers Developer Mode')
  t.ok(js.includes("label: 'Copy on select'"), 'the menu offers Copy on select')
  t.ok(
    js.includes("button.setAttribute('role', 'menuitemcheckbox')") &&
      js.includes("button.setAttribute('aria-checked', item.checked ? 'true' : 'false')"),
    'menu rows render as checkable items'
  )
})

test('copy on select defaults on and persists per profile', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  t.ok(
    js.includes('`${COPY_ON_SELECT_STORAGE_KEY}.${profileId}`'),
    'the preference key carries the selected profile id'
  )
  t.ok(
    js.includes("if (saved === '0' || saved === 'false') return false") &&
      js.includes('async function preferredCopyOnSelect()'),
    'anything but an explicit off reads as on'
  )
  t.ok(
    js.includes('applyCopyOnSelect(await preferredCopyOnSelect(), false)'),
    'the preference loads once the profile is known'
  )
  t.ok(
    js.includes("window.addEventListener('mouseup', copySelectionOnPointerUp, { once: true })"),
    'the clipboard write waits for the selection to finish'
  )
})

test('programs that own the mouse can copy through OSC 52', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  t.ok(
    js.includes('state.term.parser.registerOscHandler(52, copyFromOsc52)'),
    'OSC 52 is handled, so Claude Code over ssh reaches the clipboard'
  )
  t.ok(js.includes("payload === '?'"), 'clipboard read queries are ignored')
  t.ok(
    js.includes('if (!state.liveWrites.active || !canInputToTerminal()) return true') &&
      js.includes('Date.now() - state.terminalGestureAt > OSC52_GESTURE_MS'),
    'only live output shortly after the user clicked or typed may set the clipboard'
  )
})

test('ctrl -/+ zoom is a remembered setting that flashes the Font buttons', async (t) => {
  const rendererDir = path.join(__dirname, '..', 'renderer')
  const js = await fs.promises.readFile(path.join(rendererDir, 'app.js'), 'utf8')
  const html = await fs.promises.readFile(path.join(rendererDir, 'index.html'), 'utf8')
  t.ok(
    js.includes("label: 'Change font size with CTRL -/+'"),
    'the menu offers the font size shortcut'
  )
  t.ok(
    js.includes("label: 'Zoom whole app with CTRL -/+'") &&
      js.includes('if (next && state.appZoom) applyAppZoom(false, true)') &&
      js.includes('if (next && state.ctrlZoom) applyCtrlZoom(false, true)'),
    'whole-app zoom is a second, mutually exclusive CTRL -/+ mode'
  )
  t.ok(
    js.includes("const CTRL_ZOOM_STORAGE_KEY = 'zbterm.ctrlZoom'") &&
      js.includes('applyCtrlZoom(appZoom ? false : await preferredCtrlZoom(), false)'),
    'the preference is stored and restored'
  )
  t.ok(
    js.includes("if (saved === '0' || saved === 'false') return false") &&
      js.includes('async function preferredCtrlZoom()'),
    'anything but an explicit off reads as on'
  )
  t.ok(
    js.includes('const zoomDelta = ctrlZoomDelta(event)') &&
      js.includes('zoomLiveFontSize(zoomDelta).catch(showError)'),
    'ctrl plus the zoom keys drives the same font adjustment as the buttons'
  )
  t.ok(
    js.includes("if (event.key === '+' || event.key === '=' || event.key === 'Add') return 1"),
    'the unshifted + key counts as zoom in'
  )
  t.ok(
    js.includes('if (!inTerminal && isEditableTarget(target)) return 0'),
    "typing in a text field is never a zoom, but xterm's own textarea is"
  )
  t.ok(
    js.includes('delta > 0 ? els.fontSizeIncrease : els.fontSizeDecrease') &&
      js.includes("'zoom-flash'") &&
      js.includes('if (!changed) return'),
    'the button flashes only when the size actually moved'
  )
  t.ok(
    html.includes('.text-btn.zoom-flash {') && html.includes('@keyframes zoom-flash {'),
    'index.html carries the green zoom flash'
  )
})

test('an unsaved app preference answers null instead of reaching the engine', async (t) => {
  const main = await fs.promises.readFile(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  t.ok(
    main.includes("if (appResult !== null || method === 'app.preference.get') return appResult"),
    'app.preference.get never falls through to the engine'
  )
})

test('copy on select falls back to a replayed selection', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  t.ok(
    js.includes('const text = selected || selectDraggedCells(drag, event)'),
    'a drag that produced no xterm selection still reaches the clipboard'
  )
  t.ok(
    js.includes('state.term.select(from.col, from.row, length)'),
    'the fallback selects the dragged cells through the terminal control'
  )
  t.ok(
    js.includes('anchor: terminalSelectionCell(event)'),
    'mousedown records where the drag started'
  )
  t.ok(
    js.includes('if (moved < SELECTION_DRAG_MIN_PX) return') &&
      js.includes('if (length <= 0) return'),
    'a plain click never fabricates a selection'
  )
  t.ok(
    js.includes('mouse.getCoords(event, screen, term.cols, term.rows, true)'),
    'cells come from the same rounding xterm uses for its own drags'
  )
  t.ok(
    js.includes('state.term.clearSelection()') && js.includes('state.selectionForced = false'),
    'a forced selection is dropped when the next drag begins'
  )
})

test('two-finger wheel seeking is refused in live mode and flashes Step Back + Live', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  t.ok(js.includes('function wheelSeekRefusedInLive('), 'app.js has the live-mode wheel guard')
  t.ok(
    js.includes("if (state.mode !== 'live') return false") &&
      js.includes('flashInputBlockedButtons([els.stepBack, els.goLive])'),
    'the guard flashes Step Back and Live when refusing'
  )
  const scrubber = js.indexOf('function handleScrubberWheel(')
  const global = js.indexOf('function handleGlobalScrubberWheel(')
  const seekCall = 'applyScrubberWheelSteps(scrubberWheelSteps(event))'
  for (const start of [scrubber, global]) {
    const body = js.slice(start, js.indexOf(seekCall, start))
    t.ok(body.includes('if (wheelSeekRefusedInLive()) return'), 'seek runs only when not refused')
  }
})

test('renderer gates sharing on share.backends (backend-abstraction R-9)', async (t) => {
  const rendererDir = path.join(__dirname, '..', 'renderer')
  const js = await fs.promises.readFile(path.join(rendererDir, 'app.js'), 'utf8')
  const html = await fs.promises.readFile(path.join(rendererDir, 'index.html'), 'utf8')
  t.is(js.split("api.invoke('share.backends')").length - 1, 1, 'share.backends is asked once')
  t.ok(
    js.indexOf("await api.invoke('ping')") < js.indexOf('await loadShareBackends()') &&
      js.indexOf('await loadShareBackends()') < js.indexOf("setStatus('loading sessions')"),
    'and only after the engine answered'
  )
  t.ok(js.includes("backend.state === 'available'"), 'a broken backend does not count as usable')
  t.ok(js.includes('els.joinLink.hidden = !available'), 'Join is hidden with no backend')
  t.ok(
    /els\.shareSession\.hidden =[^;]*!canOfferSharing/.test(js.replace(/\n/g, ' ')),
    'Share is hidden with no backend'
  )
  t.ok(
    js.includes('els.inputMode.hidden = !canShowInputMode || !canOfferSharing'),
    'the input mode button is hidden with no backend'
  )
  t.ok(
    js.includes("sharingAvailable() && (options.mode === 'new' || options.mode === 'copy')"),
    'the session editor drops its share box with no backend'
  )
  t.ok(js.includes('`Sharing unavailable: ${'), 'a broken expected backend is explained')
  t.ok(js.includes('pkg.zbtermBackends'), 'expected backends come from the package metadata')
  for (const id of ['#joinLink', '#shareSession', '#inputMode']) {
    t.ok(html.includes(`body.sharing-unavailable ${id}`), `index.html hides ${id}`)
  }
})

// freenet-backend F9 (D-14): the picker lists every backend the core reports;
// a broken one is a disabled radio with its reason. It used to list only the
// usable ones ('none for zero or one' asserted `usable.length < 2`).
test('share wizard offers a backend picker when the core reports several, broken ones disabled with their reason', async (t) => {
  const rendererDir = path.join(__dirname, '..', 'renderer')
  const js = await fs.promises.readFile(path.join(rendererDir, 'app.js'), 'utf8')
  const html = await fs.promises.readFile(path.join(rendererDir, 'index.html'), 'utf8')
  t.ok(js.includes('function shareBackendPicker('), 'app.js builds the picker')
  t.ok(
    js.includes('if (!usable || !usable.length || listed.length < 2) return null'),
    'none when the core reports at most one backend, or none is usable'
  )
  t.ok(js.includes('for (const backend of listed) {'), 'every reported backend is a row')
  t.ok(js.includes("const broken = backend.state !== 'available'"), 'broken is not available')
  t.ok(js.includes('input.disabled = broken'), 'a broken backend is a disabled radio')
  t.ok(js.includes('input.checked = !broken &&'), 'and is never the checked one')
  t.ok(
    js.includes("reason.textContent = backend.detail || 'unavailable'"),
    "with the core's reason as its text"
  )
  t.ok(html.includes('.share-backend-broken'), 'index.html styles the broken row')
  t.ok(js.includes('group.disabled = !!active'), 'disabled once a backend is active')
  t.ok(js.includes("input.type = 'radio'"), 'it is a radio group')
  t.ok(
    js.includes('body.replaceChildren(...(picker ? [picker, form.root] : [form.root]))'),
    'it sits above the share options'
  )
  t.ok(
    js.includes('...(settings.backend ? { backend: settings.backend } : {})'),
    'the choice travels with share.createLink, and nothing is added without one'
  )
  t.ok(html.includes('.share-backend-picker'), 'index.html styles the picker')
})

test('a join link is answered with a toast when there is no share backend', async (t) => {
  const root = path.join(__dirname, '..')
  const main = await fs.promises.readFile(path.join(root, 'electron', 'main.js'), 'utf8')
  const js = await fs.promises.readFile(path.join(root, 'renderer', 'app.js'), 'utf8')
  const html = await fs.promises.readFile(path.join(root, 'renderer', 'index.html'), 'utf8')
  const start = main.indexOf('function handleDeepLink(url) {')
  const body = main.slice(start, main.indexOf('app.setAsDefaultProtocolClient(protocol)'))
  t.ok(start > 0, 'handleDeepLink exists')
  t.ok(body.includes('hasShareBackend(engine)'), 'it asks the core first')
  t.ok(
    body.indexOf('if (!usable) {') < body.indexOf("engine.invoke('share.join'") &&
      body.indexOf('return null') < body.indexOf("engine.invoke('share.join'"),
    'and returns before share.join when nothing is usable'
  )
  t.ok(body.includes("name: 'app:toast'"), 'the refusal is a toast event')
  t.ok(js.includes("api.on('app:toast'"), 'the renderer listens for it')
  t.ok(js.includes('function showToast('), 'and shows it')
  t.ok(html.includes('.toast {'), 'index.html styles the toast')
})

test('a join the backend gave up on is a toast in plain words (freenet-backend F9)', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  t.ok(
    js.includes(
      "const JOIN_ICE_FAILED_TOAST = 'Could not connect directly to the host (ICE failed)'"
    ),
    'the ICE sentence lives beside the toast constants'
  )
  t.ok(
    js.includes('const JOIN_IDENTITY_TOAST = "The host\'s identity did not match the invite"'),
    'and the identity one'
  )
  t.ok(js.indexOf('const TOAST_MS') < js.indexOf('const JOIN_ICE_FAILED_TOAST'), 'next to TOAST_MS')
  t.ok(
    js.includes("if (status.detail === 'ice-failed') return JOIN_ICE_FAILED_TOAST"),
    'ice-failed'
  )
  t.ok(js.includes("if (status.code === 'E_AUTH') return JOIN_IDENTITY_TOAST"), 'E_AUTH')
  t.ok(js.includes('if (!status || !status.backend) return null'), 'only for a backend failure')
  t.ok(js.includes('showToast(backendToast)'), 'shown as a toast')
})

test('the settings menu has a STUN/TURN servers field pushed to the main process (D-11)', async (t) => {
  const root = path.join(__dirname, '..')
  const js = await fs.promises.readFile(path.join(root, 'renderer', 'app.js'), 'utf8')
  const preload = await fs.promises.readFile(path.join(root, 'electron', 'preload.js'), 'utf8')
  const main = await fs.promises.readFile(path.join(root, 'electron', 'main.js'), 'utf8')
  t.ok(js.includes("label: 'STUN/TURN servers…'"), 'a settings menu item')
  t.ok(js.includes("const ICE_SERVERS_STORAGE_KEY = 'zbterm.iceServers'"), 'its storage key')
  t.ok(js.includes('persistAppPreference(ICE_SERVERS_STORAGE_KEY, text)'), 'stored like the others')
  t.ok(js.includes('await app.setIceServers(text)'), 'pushed through the preload')
  t.ok(js.includes('await restoreIceServers()'), 'and pushed again at start')
  t.ok(preload.includes("exposeInMainWorld('app'"), 'the preload exposes app')
  t.ok(preload.includes("ipcRenderer.invoke('app:setIceServers'"), 'app.setIceServers')
  t.ok(main.includes("ipcMain.handle('app:setIceServers'"), 'the main process applies it')
})

// A joined session's viewer picked a new font size on every single live
// frame (e.g. a lag/resync bootstrap), even when the grid and the terminal's
// bounds were unchanged, because renderLiveFrame cleared the cached grid
// layout on every call, defeating fitPlaybackFrame's own memoization (the
// `layout.key !== layoutKey` check) below. The fix: only clear it on an
// actual transition into live mode.
test('renderLiveFrame only drops the cached grid layout on entering live mode', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  const start = js.indexOf('function renderLiveFrame(frame, options = {}) {')
  t.ok(start >= 0, 'renderLiveFrame is defined')
  const end = js.indexOf('\n  function ', start + 1)
  const body = js.slice(start, end === -1 ? undefined : end)

  t.ok(
    /if\s*\(\s*state\.mode\s*!==\s*'live'\s*\)\s*state\.playbackGridLayout\s*=\s*null/.test(body),
    'the cached layout is cleared only when mode is not already live'
  )
  t.absent(
    /\n\s*state\.playbackGridLayout\s*=\s*null\s*\n\s*state\.liveFrame\s*=\s*frame/.test(body),
    'not unconditionally, right before fitPlaybackFrame runs'
  )

  // fitPlaybackFrame's own cache must still be there for the guard above to
  // mean anything: same (cols, rows, bounds) key -> same cached fontSize.
  const fitStart = js.indexOf('function fitPlaybackFrame(frame) {')
  t.ok(fitStart >= 0, 'fitPlaybackFrame is defined')
  const fitEnd = js.indexOf('\n  function ', fitStart + 1)
  const fitBody = js.slice(fitStart, fitEnd === -1 ? undefined : fitEnd)
  t.ok(
    fitBody.includes('if (!layout || layout.key !== layoutKey)'),
    'fitPlaybackFrame recomputes only on an actual key change'
  )
})

test('the startup logo keeps one font size per container size', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  const start = js.indexOf('function fitStartupLogoTerminal() {')
  t.ok(start >= 0, 'fitStartupLogoTerminal is defined')
  const end = js.indexOf('\n  function ', start + 1)
  const body = js.slice(start, end === -1 ? undefined : end)

  t.ok(
    body.includes('if (!layout || layout.key !== layoutKey)'),
    'the font size is recomputed only when the container size key changes'
  )
  t.ok(/state\.startupLogoLayout\s*=\s*layout/.test(body), 'the computed layout is cached on state')
  t.absent(
    /const fontSize = Math\.max\(8, fontSizeForGrid[^\n]*\n\s*setTerminalFontSize\(fontSize\)/.test(
      body
    ),
    'the size is not recomputed on every call'
  )
})

test('the startup logo text ends on the last row without scrolling', async (t) => {
  const js = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  const start = js.indexOf('async function drawStartupLogo(options = {}) {')
  t.ok(start >= 0, 'drawStartupLogo is defined')
  const end = js.indexOf('\n  function ', start + 1)
  const body = js.slice(start, end === -1 ? undefined : end)

  t.ok(
    /pears\.com'\s*\n\s*\)/.test(body),
    'the last line of the credits block is written with no trailing newline'
  )
  t.absent(
    /pears\.com\\r\\n'/.test(body),
    'no line feed after the last line: it sits on the bottom row and would scroll'
  )
})
