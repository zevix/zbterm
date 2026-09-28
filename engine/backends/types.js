// The ShareBackend contract (backend-abstraction R-1).
//
// A share backend is the one object that knows how two ZBTerm cores find and
// reach each other over a network. ShareManager owns everything above it (link
// records, caps, approval, the `zbterm/ctl` message set, identity, live
// encryption, rekey, sealed input) and talks to a backend only through the
// members declared here.
//
// Vocabulary follows docs/abstract-arch.md §10.1 (provider lifecycle), §14.2
// (storage capabilities), §16 (TransportProvider) and §17 (DiscoveryProvider).
//
// Deviations from docs/abstract-arch.md:
//   - A-3:  one ShareBackend object instead of separate Transport, Discovery
//           and SessionStore providers. Pear's discovery and transport share
//           one swarm, so splitting them would be artificial.
//   - A-10: a channel carries JSON objects (`zbterm/ctl` is already c.json),
//           not a DuplexByteStream. Byte-stream channels are deferred.
//   - A-11: history calls operate on a SessionStore (its `log` and `metaCore`
//           Hypercores), not on backend-neutral segments.
//   - §16 `bind`/`accept`/`listener_routes` collapse into `announce`, the
//     `'connection'` event and `routeFor`; §17 `publish`/`resolve` collapse
//     into `announce`/`dial`. `request_id`s and deadlines (§10.2) are omitted;
//     `dial` takes an AbortSignal instead.
//   - `start(ctx)` takes `{ keyPair }` rather than a full §10.1
//     ProviderContext: local storage and the process model are out of scope.
//   - `PeerConnection.initiator` is an addition: which side opened the
//     connection, for diagnostics only.
//
// The interface never exposes a mux, a socket or a swarm.

// Capability bitset. Transport capabilities are §16.2, history ones §14.2.
const CAP = Object.freeze({
  AUTHENTICATED_PEER: 1 << 0,
  MULTIPLEXED_STREAMS: 1 << 1,
  ORDERED_STREAM: 1 << 2,
  EPHEMERAL_DELIVERY: 1 << 3,
  DIRECT_DIAL: 1 << 4,
  NAT_TRAVERSAL: 1 << 5,
  RELAY: 1 << 6,
  BROKERED: 1 << 7,
  PATH_MIGRATION: 1 << 8,
  HISTORY_SPARSE_READ: 1 << 9,
  HISTORY_HEAD_WATCH: 1 << 10,
  HISTORY_EVENTUAL_MERGE: 1 << 11,
  HISTORY_OFFLINE_HOST: 1 << 12
})

// PeerConnection.path() values (§16 Connection.path).
const PATH = Object.freeze({
  DIRECT: 'DIRECT',
  RELAY: 'RELAY',
  BROKER: 'BROKER',
  LOCAL: 'LOCAL'
})

/**
 * @typedef {object} BackendDescriptor
 * @property {string} id            Stable backend id, eg. `'pear'`.
 * @property {string} label         Human-readable name.
 * @property {number} interfaceVersion
 * @property {number} capabilities  Bitwise OR of `CAP` flags.
 */

/**
 * @typedef {object} BackendContext
 * @property {() => ({publicKey: Uint8Array, secretKey: Uint8Array} | null)} keyPair
 *   The device transport keypair, read lazily on every use.
 */

/**
 * @typedef {object} HealthReport
 * @property {boolean} started
 * @property {boolean} listening
 * @property {string | null} detail
 */

/**
 * An opaque, JSON-safe rendezvous address. Only the backend that minted a
 * route reads inside it; for Pear it is `{ topic: <64 hex> }`.
 * @typedef {object} Route
 */

/**
 * @typedef {object} Announcement
 * @property {Route} route
 * @property {string} linkId
 */

/**
 * @typedef {object} AnnounceOptions
 * @property {Route} [route]  Announce this route instead of minting a new one.
 * @property {object} [tag]   Extra fields copied into debug events.
 */

/**
 * @typedef {object} DialOptions
 * @property {AbortSignal} [signal]  Aborting it is the same as `cancel()`.
 * @property {object} [tag]          Extra fields copied into debug events.
 */

/**
 * @typedef {object} DialHandle
 * @property {Promise<PeerConnection>} connected
 *   Settles with a connection whose `remotePeerKey` equals the expected key. A
 *   connection from any other key is rejected before it is surfaced. Rejects
 *   when the dial is cancelled first.
 * @property {() => void} cancel  Idempotent. Never closes a live connection.
 */

/**
 * Decides whether an inbound connection from `remotePeerKey` is admitted. A
 * key pinned by an active `dial` is always admitted.
 * @typedef {((remotePeerKey: Uint8Array) => boolean) | boolean} AdmissionPolicy
 */

/**
 * @typedef {object} ChannelHandlers
 * @property {(message: object) => any} onmessage  Not awaited by the backend.
 * @property {() => void} [onclose]                Fires once.
 */

/**
 * Reliable and ordered per channel.
 * @typedef {object} MessageChannel
 * @property {(message: object) => boolean} send  `false` under backpressure or once closed.
 * @property {() => void} close
 */

/**
 * One authenticated connection to one remote peer. It can carry several
 * channels, in both roles at once. Events: `'close'`, `'error'`, `'path'`.
 * @typedef {object} PeerConnection
 * @property {Uint8Array} remotePeerKey  32-byte transport key of the remote peer.
 * @property {boolean} closed
 * @property {boolean | null} initiator  `true` when this side opened it; `null` when unknown.
 * @property {() => string} path  One of `PATH`.
 * @property {(protocol: string, id: Uint8Array, handlers: ChannelHandlers) => MessageChannel} openChannel
 * @property {(protocol: string, cb: (id: Uint8Array) => void) => void} onChannel
 *   `cb` fires for every channel id the remote opens on `protocol`.
 * @property {(reason?: string) => void} close
 */

/**
 * @typedef {object} HistoryKeys
 * @property {string} [logKey]   hex
 * @property {string} [metaKey]  hex
 */

/**
 * @typedef {object} HistoryHandle
 * @property {(range: {start: number, end: number}) => object} fetch
 *   Requests a linear range of the session log; the result has `done()` and `destroy()`.
 * @property {() => void} close
 */

/**
 * Events: `'connection'` `(conn: PeerConnection, info)` once per connection,
 * on BOTH the dialing and the accepting side (the dialing side hears the same
 * object its `dial().connected` resolves to: the dialed peer may open channels
 * of its own on it); `'debug'` `({event, details})`; `'error'`.
 * @typedef {object} ShareBackend
 * @property {() => BackendDescriptor} describe
 * @property {(ctx: BackendContext) => Promise<void>} start  Opens no share sockets.
 * @property {() => Promise<void>} stop                       Safe to call twice.
 * @property {() => HealthReport} health
 * @property {() => (Uint8Array | null)} localPeerKey         32-byte transport key.
 * @property {(linkId: string, opts?: AnnounceOptions) => Promise<Announcement>} announce
 * @property {(linkId: string) => Promise<void>} withdraw
 *   Stops announcing the link's route, and nothing more (D-04): it ends
 *   discovery of the route, not reachability of the host. Idempotent. A live
 *   connection survives it. A backend MAY refuse a later dial of that route;
 *   it need not (Pear still connects a peer that holds the host key, S-08).
 *   Refusing a join on a withdrawn or revoked link is the share manager's job.
 * @property {(linkId: string, stored?: object | null) => Route} routeFor
 *   The route of a stored link record, or a freshly minted one when `stored` is empty.
 * @property {(route: Route, expectedPeerKey: Uint8Array, opts?: DialOptions) => DialHandle} dial
 * @property {(policy: AdmissionPolicy) => void} setAdmission
 * @property {(conn: PeerConnection, store: object) => void} serveHistory
 *   Idempotent per connection and session.
 * @property {(conn: PeerConnection, store: object, keys?: HistoryKeys) => HistoryHandle} attachHistory
 * @property {(store: object) => (object | null)} historyRouteFor
 * @property {() => object} diagnostics
 *   JSON-safe, no secrets. Always carries `announced`: the number of links
 *   currently announced (it rises on `announce`, falls on `withdraw`).
 */

const BACKEND_MEMBERS = [
  'describe',
  'start',
  'stop',
  'health',
  'localPeerKey',
  'announce',
  'withdraw',
  'routeFor',
  'dial',
  'setAdmission',
  'serveHistory',
  'attachHistory',
  'historyRouteFor',
  'diagnostics',
  // EventEmitter surface: 'connection', 'debug', 'error'.
  'on',
  'once',
  'off',
  'emit'
]

// Shape check only: throws naming the first missing member.
function assertBackend(obj) {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) {
    throw new TypeError('ShareBackend must be an object')
  }
  for (const member of BACKEND_MEMBERS) {
    if (typeof obj[member] !== 'function') {
      throw new TypeError(`ShareBackend is missing member: ${member}()`)
    }
  }
  return obj
}

module.exports = { CAP, PATH, BACKEND_MEMBERS, assertBackend }
