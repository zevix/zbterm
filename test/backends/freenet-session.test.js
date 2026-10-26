// A Freenet share end to end on the core's session protocol (K14 of
// zxterm-core, stage C2; ZBTerm D-38). Every case runs two or three real
// `zxterm-core` sidecars (one per ShareManager, test/helpers/zxterm-core.js),
// real WebRTC between them and one throwaway local-mode node (never the
// owner's), with stub runtimes in place of the engine and the store (the
// suite's fixtures, test/backends/conformance.js): what is under test is
// ShareManager's Freenet path (`share.core`, `state.viaCore`) and what it
// asks of and hears from the core - the join and the approval, the identity
// gate, input, the epochs the store must install, revocation and the PV-3
// re-mint of a stored route. The Pear and loopback paths are the other
// test files' (test/share-manager.test.js, the conformance suite).
//
//   npx brittle-node test/backends/freenet-session.test.js
const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-native')

const { testCore } = require('../helpers/zxterm-core')
const { keysServer, keysBody } = require('../helpers/k9c-keys-server')
const { randomHex } = require('../helpers/ssh-wire')

const FreenetBackend = require('../../engine/backends/freenet')
const ShareManager = require('../../engine/share-manager')
const { freenetAvailable, startLocalNode } = require('../helpers/freenet-node')
const { loadOrCreateLocalDevice } = require('../../engine/crypto')
const { UNKNOWN, displayIdFor } = require('../../engine/identity/providers')
const {
  HASH_ALG,
  NAMESPACE,
  buildArmoredSignature,
  claimBytes,
  encodeEd25519PublicKey,
  fingerprint,
  signedDataBlob
} = require('../../engine/identity/claim')
const { decodeLink } = require('../../engine/invite')
const routeV1 = require('../fixtures/route-v1/route')
const { fixtures } = require('./conformance')

const { fullHostRuntime, recordingViewer, waitForJoinChange, countDebug, until, delay, temp } =
  fixtures

const GRACE_MS = 750
const SESSION = 'session-a'

let node = null

async function nodeUrl() {
  if (!node) node = await startLocalNode()
  return node.url
}

function hex(value) {
  return b4a.toString(value, 'hex')
}

async function freenetBackend(t, env) {
  const core = testCore(t, env ? { env } : {})
  const backend = new FreenetBackend({ nodeUrl: await nodeUrl(), core, iceServers: [] })
  t.teardown(() => backend.stop())
  return backend
}

// A device with an auth key, the way the engine has it once it is ready.
async function authDevice(t) {
  const record = await loadOrCreateLocalDevice({ root: await temp(t) })
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  record.authPublicKey = publicKey
  record.authSecretKey = secretKey
  return record
}

// A host ShareManager on a stub runtime of `session-a`. `opts.inputMode`
// (default 'all'), `opts.engine` (fields added to the engine stub) and
// `opts.env` (the host sidecar's environment) shape it.
async function hostPair(t, opts = {}) {
  const hostDevice = opts.hostDevice || (await authDevice(t))
  const viewerDevice = opts.viewerDevice || (await authDevice(t))
  const runtime = fullHostRuntime(SESSION, hostDevice, viewerDevice, { freshKeys: true })
  runtime.inputMode = opts.inputMode || 'all'
  const ptyWrites = []
  runtime.pty = { write: (input) => ptyWrites.push(input) }
  const calls = { putMember: 0, sealHistory: [], bootstraps: [] }
  const putMember = runtime.store.putMember
  runtime.store.putMember = (...args) => {
    calls.putMember++
    return putMember(...args)
  }
  runtime.store.sealHistoryForMember = (device, caps, options) => {
    calls.sealHistory.push({ device, caps, options })
    return Promise.resolve()
  }
  // The store's member records, as far as revoking and joining read them.
  const memberStatus = new Map()
  runtime.store.getMember = (key) => Promise.resolve({ status: memberStatus.get(key) || 'active' })
  runtime.store.setMemberStatus = (key, status) => {
    memberStatus.set(key, status)
    return Promise.resolve()
  }
  const debug = []
  const errors = []
  const engine = {
    localDevice: hostDevice,
    buildLiveBootstrap: (sessionId, options) => {
      calls.bootstraps.push(options || null)
      return Promise.resolve({ seq: 1, cols: 80, rows: 24, data: 'boot' })
    },
    sessions: new Map([[SESSION, runtime]]),
    ...opts.engine
  }
  const manager = new ShareManager(engine, { backend: await freenetBackend(t, opts.env) })
  manager.on('debug', (event) => debug.push(event))
  manager.on('error', (err) => errors.push(err))
  t.teardown(() => manager.close())
  return { manager, runtime, hostDevice, viewerDevice, ptyWrites, calls, debug, errors, engine }
}

async function viewerOf(t, device, opts = {}) {
  const viewer = recordingViewer(device, await freenetBackend(t, opts.env))
  t.teardown(() => viewer.close())
  viewer.events = []
  viewer.manager.on('join:changed', (event) => viewer.events.push(event))
  return viewer
}

async function join(viewer, link) {
  const done = waitForJoinChange(viewer.manager, link.linkId)
  await viewer.manager.join(link.uri)
  return await done
}

function statusesOf(viewer, linkId) {
  return viewer.events.filter((event) => event.linkId === linkId).map((event) => event.status)
}

// What SessionEngine#input does for a joined session.
function sendInput(viewer, sessionId, text) {
  const remote = viewer.remoteSessions.get(sessionId)
  remote.message.send({ type: 'input', data: viewer.manager.sealInput(sessionId, text) })
}

// brittle ends the whole file when a case throws; a case that throws is failed
// here instead, so the cases after it still run and report.
function guarded(title, fn) {
  test(title, async (t) => {
    try {
      await fn(t)
    } catch (err) {
      t.fail(`the case threw: ${(err && err.stack) || err}`)
    }
  })
}

if (!freenetAvailable()) {
  test('freenet session: skipped', (t) => t.skip('freenet binary not on PATH'))
} else {
  guarded(
    'freenet session: an auto-join runs on the core and shows the UI what it always saw',
    async (t) => {
      const h = await hostPair(t)
      const link = await h.manager.createLink(SESSION, { type: 'group' })
      t.ok(decodeLink(link.uri).route.params, 'the invite carries the route the core minted')

      const identity = []
      h.manager.on('share:peer-identity', (event) => identity.push(event))
      const approvals = []
      h.manager.on('approval:pending', (event) => approvals.push(event))
      const changed = []
      h.manager.on('share:changed', (status) => changed.push(status))

      const viewer = await viewerOf(t, h.viewerDevice)
      const status = await join(viewer, link)
      t.is(status.status, 'joined', 'the join reaches joined')
      t.alike(statusesOf(viewer, link.linkId), ['connecting', 'joined'], 'through connecting')
      t.alike(approvals, [], 'an auto-join raises no approval')
      t.is(
        countDebug(h.debug, 'host:join-confirm'),
        1,
        "the core's debug event reaches share:debug"
      )
      t.is(countDebug(h.debug, 'host:join-request'), 1, 'as does the join request')

      // The host's identity event for a peer that presented no claim.
      t.alike(
        identity.map((event) => event.status),
        ['unknown'],
        'one share:peer-identity event, unknown (no claim, no challenge)'
      )
      t.alike(
        Object.keys(identity[0]).sort(),
        [
          'deviceKey',
          'direction',
          'displayId',
          'identityKey',
          'provider',
          'reason',
          'sessionId',
          'status'
        ],
        'with the payload shape the UI has always had'
      )
      t.is(identity[0].direction, 'viewer')
      t.is(identity[0].sessionId, SESSION)
      t.is(identity[0].identityKey, hex(h.viewerDevice.identityPublicKey))

      const host = h.manager.status(SESSION)
      t.is(host.isSharing, true)
      t.is(host.viewerCount, 1, 'status() counts the confirmed peer')
      t.alike(
        host.viewers,
        [
          {
            identityKey: hex(h.viewerDevice.identityPublicKey),
            deviceKey: hex(h.viewerDevice.publicKey),
            displayId: displayIdFor(UNKNOWN, hex(h.viewerDevice.identityPublicKey)),
            status: 'unknown'
          }
        ],
        'and the peer carries its identity'
      )
      t.is(host.inputMode, 'all')
      t.ok(
        changed.some((s) => s.viewerCount === 1),
        'share:changed reported it'
      )
      const details = h.manager.diagnostics().hostShares[0].peerDetails
      t.is(details.length, 1)
      t.is(details[0].canSendInput, true, 'diagnostics shows the peer may send input')
      t.is(details[0].canViewLive, true)
      const links = h.manager.diagnostics().hostShares[0].links
      t.is(links[0].viewers, 1, "the link's viewer count follows the grant")
      t.alike(h.errors, [], 'the host raised no error')
      t.alike(viewer.errors, [], 'nor the viewer')
      t.is(viewer.applied.bootstrap.length, 1, 'the viewer applied the bootstrap the host built')
      t.alike(h.calls.bootstraps, [null], 'built with no scrollback limit (a grant, not a resync)')
      t.ok(
        h.calls.sealHistory.length >= 1,
        'the store sealed the history of the epochs before the core'
      )
      t.is(
        h.calls.sealHistory[0].options.upTo,
        1,
        'up to the epoch the store had before the core minted its own'
      )
      t.is(h.calls.putMember, 1, 'the member is written to the store')
    }
  )

  guarded(
    'freenet session: the store installs every epoch the core mints, and only those',
    async (t) => {
      const h = await hostPair(t)
      t.is(h.runtime.store.epoch, 1, 'a fresh store starts at epoch 1')
      const link = await h.manager.createLink(SESSION, { type: 'group' })
      t.is(h.runtime.store.epoch, 2, 'the core mints the first epoch it holds when the share opens')
      const keysOpen = h.runtime.store.keys.liveKey

      const viewer = await viewerOf(t, h.viewerDevice)
      await join(viewer, link)
      await until(() => h.runtime.store.epoch === 3)
      t.unlike(h.runtime.store.keys.liveKey, keysOpen, 'a join rotates the live key')
      const remote = viewer.remoteSessions.get(SESSION)
      t.is(remote.store.epoch, 3, 'the viewer is on the same epoch')
      t.alike(remote.store.keys.liveKey, h.runtime.store.keys.liveKey, 'with the same live key')

      // A disconnect does not rotate (zxterm Q-15).
      await viewer.close()
      await delay(GRACE_MS)
      t.is(h.runtime.store.epoch, 3, 'a viewer leaving mints no epoch')
      t.is(h.manager.status(SESSION).viewerCount, 0, 'and the host notices it left')
    }
  )

  guarded(
    "freenet session: an approval is the host UI's, and a refusal reaches the viewer with its reason",
    async (t) => {
      const h = await hostPair(t)
      const link = await h.manager.createLink(SESSION, { type: 'group', autoJoin: false })
      const approvals = []
      h.manager.on('approval:pending', (event) => approvals.push(event))

      const viewer = await viewerOf(t, h.viewerDevice)
      const joined = waitForJoinChange(viewer.manager, link.linkId)
      await viewer.manager.join(link.uri)
      await until(() => approvals.length === 1)
      t.alike(
        Object.keys(approvals[0]).sort(),
        [
          'deviceKey',
          'deviceName',
          'identityKey',
          'linkId',
          'linkType',
          'maxViewers',
          'requestId',
          'sessionId'
        ],
        'approval:pending has the payload shape the UI has always had'
      )
      t.is(approvals[0].linkId, link.linkId)
      t.is(approvals[0].linkType, 'group')
      t.is(approvals[0].maxViewers, 99)
      t.is(approvals[0].sessionId, SESSION)
      t.is(approvals[0].deviceKey, hex(h.viewerDevice.publicKey))
      t.is(h.manager.diagnostics().hostShares[0].pendingApprovals, 1, 'diagnostics counts it')
      await until(() => statusesOf(viewer, link.linkId).includes('approval-pending'))

      t.ok(await h.manager.approveJoin(SESSION, approvals[0].requestId), 'the host approves')
      t.is((await joined).status, 'joined', 'the viewer joins')
      t.alike(
        statusesOf(viewer, link.linkId),
        ['connecting', 'approval-pending', 'joined'],
        'having been told it waits'
      )
      await t.exception(
        h.manager.approveJoin(SESSION, approvals[0].requestId),
        /no longer pending/,
        'a request is decided once'
      )

      // A second viewer is denied.
      const second = await authDevice(t)
      const denied = await viewerOf(t, second)
      const refused = waitForJoinChange(denied.manager, link.linkId)
      await denied.manager.join(link.uri)
      await until(() => approvals.length === 2)
      await h.manager.denyJoin(SESSION, approvals[1].requestId)
      const status = await refused
      t.is(status.status, 'failed', 'a denied join fails')
      t.is(status.reason, 'denied', 'with the reason the UI turns into a sentence')
      t.is(status.code, 'E_AUTH')
      t.is(status.message, 'Join request denied')
      t.is(denied.registered.length, 0, 'and registers no remote session')
      t.alike(h.errors, [], 'the host raised no error')
    }
  )

  // S-42: approving a pending join after revokeLink granted it and un-revoked
  // the link; the core cancels the approval with the link.
  guarded(
    'freenet session: a pending join on a revoked link is cancelled, and approving it grants nothing (S-42)',
    async (t) => {
      const h = await hostPair(t)
      const link = await h.manager.createLink(SESSION, { type: 'single', autoJoin: false })
      const approvals = []
      const cancelled = []
      h.manager.on('approval:pending', (event) => approvals.push(event))
      h.manager.on('approval:cancelled', (event) => cancelled.push(event))

      const viewer = await viewerOf(t, h.viewerDevice)
      const failed = waitForJoinChange(viewer.manager, link.linkId)
      await viewer.manager.join(link.uri)
      await until(() => approvals.length === 1)

      t.ok(await h.manager.revokeLink(SESSION, link.linkId), 'the host revokes the link')
      await until(() => cancelled.length === 1)
      t.alike(
        cancelled,
        [{ requestId: approvals[0].requestId, sessionId: SESSION }],
        'approval:cancelled names the request'
      )
      await t.exception(
        h.manager.approveJoin(SESSION, approvals[0].requestId),
        /no longer pending/,
        'approving it is refused'
      )
      const status = await failed
      t.is(status.status, 'failed', 'the viewer is refused')
      t.is(status.reason, 'revoked', 'because the link was revoked')
      t.is(countDebug(h.debug, 'host:join-confirm'), 0, 'the host confirmed nothing')
      t.is(h.calls.putMember, 0, 'and recorded no member')
      const stored = (await h.manager.listLinks(SESSION)).find(
        (item) => item.linkId === link.linkId
      )
      t.is(stored.revoked, true, 'the link is still revoked')
      t.is(stored.consumed, false, 'and was not consumed')
      t.is(h.manager.status(SESSION).viewerCount, 0)
      t.is(viewer.registered.length, 0, 'no remote session was registered for the refused peer')
    }
  )

  // S-43: a viewer's input was silently refused after it restarted and
  // rejoined; the core scopes the counter by device and epoch.
  guarded(
    'freenet session: input is accepted after the viewer restarts and rejoins (S-43)',
    async (t) => {
      const h = await hostPair(t)
      const link = await h.manager.createLink(SESSION, { type: 'group' })

      const first = await viewerOf(t, h.viewerDevice)
      t.is((await join(first, link)).status, 'joined')
      sendInput(first, SESSION, 'one\n')
      sendInput(first, SESSION, 'two\n')
      await until(() => h.ptyWrites.length === 2)
      t.alike(h.ptyWrites, ['one\n', 'two\n'], 'input reaches the host pty, in order')
      t.is(first.remoteSessions.get(SESSION).inputCtr, 2, "and the viewer's counter is the core's")
      t.ok(countDebug(h.debug, 'host:input:accepted') >= 2, 'the host reports it accepted')

      // A restart: a new process, its counter back at 0, the same device.
      await first.close()
      await until(() => h.manager.status(SESSION).viewerCount === 0)
      // Input went back to the host's when the last viewer left; the host
      // allows it again.
      h.runtime.inputMode = 'all'
      h.manager.broadcastInfo(SESSION, { inputMode: 'all' })
      const second = await viewerOf(t, h.viewerDevice)
      t.is((await join(second, link)).status, 'joined', 'the same device joins again')
      sendInput(second, SESSION, 'three\n')
      try {
        await until(() => h.ptyWrites.length === 3, 5000)
      } catch (err) {
        t.comment(`host errors: ${h.errors.map((e) => e.message)}`)
        t.comment(
          `host debug: ${JSON.stringify(h.debug.filter((e) => /input|peer|socket/.test(e.event)).map((e) => [e.event, e.details]))}`
        )
        throw err
      }
      t.alike(h.ptyWrites, ['one\n', 'two\n', 'three\n'], 'its first input is accepted')
      t.alike(h.errors, [], 'and nothing was refused')
    }
  )

  guarded(
    'freenet session: input is dropped unless the host allows it, and info reaches the viewer',
    async (t) => {
      const h = await hostPair(t, { inputMode: 'host' })
      const link = await h.manager.createLink(SESSION, { type: 'group' })
      const viewer = await viewerOf(t, h.viewerDevice)
      await join(viewer, link)

      sendInput(viewer, SESSION, 'ignored\n')
      await until(() => countDebug(h.debug, 'host:input:dropped') === 1)
      await delay(GRACE_MS)
      t.alike(h.ptyWrites, [], 'in mode host the input is dropped, not written')
      t.alike(h.errors, [], 'and is no error')

      h.runtime.inputMode = 'all'
      h.manager.broadcastInfo(SESSION, { inputMode: 'all' })
      await until(() => viewer.infos.length === 1)
      t.alike(
        viewer.infos,
        [{ sessionId: SESSION, info: { inputMode: 'all' } }],
        'the viewer is told, as the info object it always got'
      )
      sendInput(viewer, SESSION, 'allowed\n')
      await until(() => h.ptyWrites.length === 1)
      t.alike(h.ptyWrites, ['allowed\n'], 'now it is written')

      h.manager.broadcastInfo(SESSION, { name: 'renamed' })
      await until(() => viewer.infos.length === 2)
      t.alike(viewer.infos[1].info, { name: 'renamed' }, 'a rename arrives as {name}')

      // The last viewer leaving turns input back to the host's.
      await viewer.close()
      await until(() => h.manager.status(SESSION).viewerCount === 0)
      t.is(h.runtime.inputMode, 'host', 'input goes back to the host when the last viewer leaves')
      t.ok(
        countDebug(h.debug, 'host:input:disabled') >= 1,
        'the core says so in its own debug event'
      )
    }
  )

  guarded('freenet session: live output, end and a revoked member reach the viewer', async (t) => {
    const h = await hostPair(t)
    const link = await h.manager.createLink(SESSION, { type: 'group' })
    const viewer = await viewerOf(t, h.viewerDevice)
    await join(viewer, link)

    h.manager.broadcastData(SESSION, b4a.from('hello viewer'))
    h.manager.broadcastData(SESSION, b4a.from('!'), { hd: true })
    await until(() => viewer.applied.data.length === 2)
    t.alike(
      viewer.applied.data.map((item) => item.text),
      ['hello viewer', '!'],
      'live output arrives whole and in order'
    )

    const epoch = h.runtime.store.epoch
    t.ok(
      await h.manager.revokeMember(SESSION, hex(h.viewerDevice.identityPublicKey)),
      'the member is revoked'
    )
    t.is(h.runtime.store.epoch, epoch + 1, 'the store holds the epoch the revocation minted')
    t.is(h.manager.status(SESSION).viewerCount, 0, 'the peer is gone from the status')
    await until(() => viewer.offlines.length === 1)
    t.is(viewer.offlines[0].sessionId, SESSION, 'the viewer sees the share go offline')
    t.is(
      await h.manager.revokeMember(SESSION, hex(h.viewerDevice.identityPublicKey)),
      false,
      'a member is revoked once'
    )

    // A second viewer, then the session ends.
    const other = await authDevice(t)
    const second = await viewerOf(t, other)
    t.is((await join(second, link)).status, 'joined')
    h.manager.broadcastEnd(SESSION, { code: 7, signal: null })
    await until(() => second.offlines.length === 1)
    t.alike(
      second.offlines[0],
      { sessionId: SESSION, exit: { code: 7, signal: null } },
      'the viewer of an ended session gets its exit status'
    )
    t.alike(h.errors, [], 'the host raised no error')
  })

  guarded(
    'freenet session: revoking a link disconnects its viewers, revokes them and rotates',
    async (t) => {
      const h = await hostPair(t)
      const link = await h.manager.createLink(SESSION, { type: 'group' })
      const viewer = await viewerOf(t, h.viewerDevice)
      await join(viewer, link)
      h.calls.members = []
      const setMemberStatus = h.runtime.store.setMemberStatus
      h.runtime.store.setMemberStatus = (identity, status) => {
        h.calls.members.push({ identity, status })
        return setMemberStatus(identity, status)
      }
      h.runtime.store.listActiveMembers = () =>
        Promise.resolve([
          {
            identityKeyHex: hex(h.viewerDevice.identityPublicKey),
            deviceKeyHex: hex(h.viewerDevice.publicKey),
            caps: 31,
            linkId: link.linkId
          }
        ])

      const epoch = h.runtime.store.epoch
      t.ok(await h.manager.revokeLink(SESSION, link.linkId), 'the link is revoked')
      t.is(h.runtime.store.epoch, epoch + 1, 'the epoch the revocation minted is in the store')
      t.alike(
        h.calls.members,
        [{ identity: hex(h.viewerDevice.identityPublicKey), status: 'revoked' }],
        'the member that joined through it is revoked in the store'
      )
      t.is(h.manager.status(SESSION).viewerCount, 0, 'and its peer is gone')
      await until(() => viewer.offlines.length === 1)
      t.is(await h.manager.revokeLink(SESSION, 'ee'.repeat(16)), false, 'an unknown link is not')
    }
  )

  // K17 (ZBTerm D-40): a session's history is the core's. It opens the history
  // the host made (engine/zxterm/history.js::HostHistory, test/freenet-history
  // .test.js) and serves it on its own `history` channel, so the host no
  // longer attaches anything of the store to the joiner's connection.
  guarded(
    'freenet session: the host serves the session history on the connection that asked to join',
    async (t) => {
      const h = await hostPair(t)
      const link = await h.manager.createLink(SESSION, { type: 'group' })
      const served = []
      const serveHistory = h.manager._backend.serveHistory.bind(h.manager._backend)
      h.manager._backend.serveHistory = (conn, store) => {
        served.push(store)
        return serveHistory(conn, store)
      }
      const viewer = await viewerOf(t, h.viewerDevice)
      await join(viewer, link)
      t.is(served.length, 0, "the host attached nothing of the store to the joiner's connection")
      t.is(
        h.manager.hostShares.get(SESSION).history,
        null,
        'a store with no directory has no core history'
      )
      t.is(h.manager._backend.historyRouteFor(h.runtime.store), null, 'and so no route to one')
      t.is(
        typeof viewer.remoteSessions.get(SESSION).history.fetch,
        'function',
        "the viewer's handle asks the core"
      )
    }
  )

  guarded(
    'freenet session: a device the host refuses is refused before it is granted',
    async (t) => {
      const revoked = await authDevice(t)
      const account = {
        listDevices: () =>
          Promise.resolve([{ deviceKey: hex(revoked.publicKey), status: 'revoked' }]),
        getDevice: (key) => Promise.resolve({ deviceKey: String(key) }),
        isDeviceActive: () => Promise.resolve(false)
      }
      const h = await hostPair(t, { viewerDevice: revoked, engine: { account } })
      const link = await h.manager.createLink(SESSION, { type: 'group' })
      const approvals = []
      h.manager.on('approval:pending', (event) => approvals.push(event))
      const identity = []
      h.manager.on('share:peer-identity', (event) => identity.push(event))

      const viewer = await viewerOf(t, revoked)
      const status = await join(viewer, link)
      t.is(status.status, 'failed', 'a revoked device of the host account is refused')
      t.is(status.code, 'E_AUTH')
      t.is(countDebug(h.debug, 'host:join-confirm'), 0, 'the host confirmed nothing')
      t.ok(
        h.debug.some((e) => e.event === 'host:join-deny' && e.details.reason === 'revoked'),
        'and says why'
      )
      t.alike(approvals, [], 'the host user was never asked')
      t.is(h.calls.putMember, 0, 'no member was recorded')
      t.is(h.runtime.store.epoch, 2, "and no epoch minted beyond the share's first")
      t.is(viewer.registered.length, 0)

      // The control: with the account clean, the same link is joined at once
      // (the gate is only there when a refusal could apply).
      const clean = await hostPair(t)
      const cleanLink = await clean.manager.createLink(SESSION, { type: 'group' })
      const other = await viewerOf(t, clean.viewerDevice)
      t.is((await join(other, cleanLink)).status, 'joined', 'an ungated link joins straight away')
    }
  )

  // PV-3 (zxterm protocol.md section 12.3): a link stored before the session
  // protocol v2 has a pv-less route, which the core refuses; listing the
  // links re-mints it, stores it and announces it.
  guarded(
    'freenet session: a stored pre-C2 route is re-minted when the links are listed (PV-3)',
    async (t) => {
      const h = await hostPair(t)
      const link = await h.manager.createLink(SESSION, { type: 'group' })
      const current = decodeLink(link.uri).route

      // The link as an earlier build stored it: a route with no pv.
      const contracts = {
        current: current.code,
        known: new Map([[current.code, Buffer.alloc(1)]]),
        pointer: { code: 'ab'.repeat(32) }
      }
      const hostKey = Buffer.from(decodeLink(link.uri).peer, 'hex')
      const old = routeV1.mint('old-link', hostKey, contracts)
      const oldId = 'dd'.repeat(16)
      await h.runtime.store.meta.put(`link/${oldId}`, {
        ...link,
        linkId: oldId,
        route: old,
        createdAt: 1
      })

      const links = await h.manager.listLinks(SESSION)
      const listed = links.find((item) => item.linkId === oldId)
      const route = decodeLink(listed.uri).route
      t.is(route.params.pv, 2, 'the invite of the old link carries a pv 2 route')
      t.not(route.sig, old.sig, 'a new route, so a new invite')
      const stored = (await h.runtime.store.meta.get(`link/${oldId}`)).value
      t.is(stored.route.params.pv, 2, 'the store holds the new route')
      t.alike(stored.route, route, 'the one the invite carries')
      t.ok(
        h.debug.some((e) => e.event === 'host:link:route-refreshed' && e.details.linkId === oldId),
        'a debug event says it was refreshed'
      )
      const again = await h.manager.listLinks(SESSION)
      t.is(
        decodeLink(again.find((item) => item.linkId === oldId).uri).route.sig,
        route.sig,
        'the next listing keeps it'
      )
      t.is(
        decodeLink(again.find((item) => item.linkId === link.linkId).uri).route.sig,
        current.sig,
        'a link that is current is left alone'
      )
    }
  )

  // The identity handshake of the join, on the core (`identity-handshake.test.js`
  // drives the same gate through ShareManager's own Pear path).
  guarded(
    'freenet session: a viewer claim is verified by the core, and a tampered one is refused',
    async (t) => {
      const hostDevice = await authDevice(t)
      const viewerDevice = await authDevice(t)
      const alice = await claimFor(viewerDevice, 'alice')
      const bob = await claimFor(hostDevice, 'bob')
      const server = await keysServer(t, () => ({
        status: 200,
        body: keysBody([alice.published, bob.published])
      }))
      const env = { ZBTERM_GITHUB_KEYS_BASE: server.base }

      const h = await hostPair(t, {
        hostDevice,
        viewerDevice,
        env,
        engine: { selfIdentityClaim: bob.claim }
      })
      const link = await h.manager.createLink(SESSION, { type: 'group' })
      const hostEvents = []
      h.manager.on('share:peer-identity', (event) => hostEvents.push(event))

      const viewer = await viewerOf(t, viewerDevice, { env })
      viewer.manager.engine.selfIdentityClaim = alice.claim
      const viewerEvents = []
      viewer.manager.on('share:peer-identity', (event) => viewerEvents.push(event))
      const status = await join(viewer, link)
      t.is(status.status, 'joined', 'a verified viewer joins')
      t.alike(
        hostEvents.map((event) => event.status),
        ['pending', 'verified'],
        'the host sees pending, then verified'
      )
      t.is(hostEvents[1].displayId, 'alice@github')
      t.is(hostEvents[1].provider, 'github')
      t.is(hostEvents[1].direction, 'viewer')
      t.is(hostEvents[1].identityKey, hex(viewerDevice.identityPublicKey))
      t.is(hostEvents[1].reason, null)
      t.alike(
        viewerEvents.map((event) => event.status),
        ['pending', 'verified'],
        'the viewer verifies the host the same way'
      )
      t.is(viewerEvents[1].displayId, 'bob@github')
      t.is(viewerEvents[1].direction, 'host')
      t.is(viewerEvents[1].deviceKey, hex(hostDevice.publicKey))
      const badge = h.manager.status(SESSION).viewers[0]
      t.is(badge.displayId, 'alice@github', 'status() carries the verified viewer for the badge')
      t.is(badge.status, 'verified')
      t.is(h.calls.putMember, 1)

      // A claim whose subject was changed after it was signed.
      const forged = await authDevice(t)
      const mallory = await claimFor(forged, 'mallory')
      const tampered = { ...mallory.claim, subject: 'someone-else' }
      const epoch = h.runtime.store.epoch
      const other = await viewerOf(t, forged, { env })
      other.manager.engine.selfIdentityClaim = tampered
      const refused = await join(other, link)
      t.is(refused.status, 'failed', 'a tampered claim is refused')
      t.is(refused.code, 'E_AUTH')
      t.is(refused.reason, 'identity', 'with the identity reason')
      t.is(refused.message, 'Identity verification failed')
      t.is(h.calls.putMember, 1, 'it is no member')
      t.is(h.runtime.store.epoch, epoch, 'and no epoch was minted for it')
      t.is(other.registered.length, 0)
    }
  )

  // Last: the node this file started.
  test('freenet session: teardown', async (t) => {
    if (node) await node.stop()
    t.pass(node ? `stopped the local node (pid ${node.pid})` : 'no node was started')
  })
}

// One SSH-signed identity claim of `device` for the github user `subject`,
// and the key a provider would publish for it.
async function claimFor(device, subject) {
  const sshPublicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const sshSecretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(sshPublicKey, sshSecretKey)
  const pubkeyBlob = await encodeEd25519PublicKey(sshPublicKey)
  const claim = {
    version: 2,
    provider: 'github',
    subject,
    identityKey: hex(device.identityPublicKey),
    authKey: hex(device.authPublicKey),
    sshPublicKey: b4a.toString(pubkeyBlob, 'base64'),
    sshKeyType: 'ssh-ed25519',
    sshFingerprint: await fingerprint(pubkeyBlob),
    issuedAt: Date.now(),
    nonce: randomHex(16)
  }
  const rawSig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(
    rawSig,
    await signedDataBlob(NAMESPACE, HASH_ALG, await claimBytes(claim)),
    sshSecretKey
  )
  claim.signature = await buildArmoredSignature({ pubkeyBlob, rawSig })
  return {
    claim,
    published: {
      keyType: 'ssh-ed25519',
      blobBase64: claim.sshPublicKey,
      fingerprint: claim.sshFingerprint
    }
  }
}
