// One WebSocket client of a Freenet node, over @freenetorg/freenet-stdlib
// (design §4 `start`, §10). Ported from spikes/freenet/lib/fnet.js::{connect,
// contractKey, putRequest}; the spike is the source, not a dependency.
//
// The SDK's promises cannot be awaited naively (S-05, re-probed unchanged on
// node 0.2.136 by F0; see docs/projects/260924_freenet-backend/baseline.md):
//   (a) subscribe() never resolves: the node answers with a PutResponse for
//       the key, which is taken as the ack here, and the SDK promise is left
//       to fail quietly.
//   (b) a second Put of an existing instance is answered with an
//       UpdateResponse, so put() hangs. Callers never Put an instance twice.
//   (c) a local-mode node never answers a Get for a missing key, so every
//       request here has its own timeout.
//   (d) every notification carries the whole state; the callback gets it raw.
// No request waits longer than REQUEST_TIMEOUT_MS, whatever the SDK's own
// 30 s timer says; close() settles whatever the SDK still holds.
//
// Runs under Node and under Bare (./bare-shims.js must have run first).
const bs58 = require('bs58').default || require('bs58')
const sdk = require('@freenetorg/freenet-stdlib')
const { ContractCodeT } = require('@freenetorg/freenet-stdlib/common')
const { RelatedContractsT } = require('@freenetorg/freenet-stdlib/client-request')

const { blake3 } = require('./blake3')

const OPEN_TIMEOUT_MS = 5000
const REQUEST_TIMEOUT_MS = 10000

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// blake3(codeHash ‖ params): the instance id a contract is addressed by.
function instanceId(codeHash, params) {
  const both = new Uint8Array(codeHash.length + params.length)
  both.set(codeHash, 0)
  both.set(params, codeHash.length)
  return blake3(both)
}

// `wasm` is the raw contract code; `params` its parameter bytes.
function contractKey(wasm, params) {
  const codeHash = blake3(wasm)
  const instance = instanceId(codeHash, params)
  return { key: new sdk.ContractKey(instance, codeHash), id: bs58.encode(instance), codeHash }
}

function putRequest(wasm, params, stateBytes, subscribe = false) {
  const { key, codeHash } = contractKey(wasm, params)
  const contract = new sdk.WasmContractV1(
    new ContractCodeT(Array.from(wasm), Array.from(codeHash)),
    Array.from(params),
    key
  )
  const container = new sdk.ContractContainer(sdk.ContractType.WasmContractV1, contract)
  return new sdk.PutRequest(
    container,
    Array.from(stateBytes),
    new RelatedContractsT([]),
    subscribe,
    false
  )
}

function deltaUpdate(key, deltaBytes) {
  const data = new sdk.UpdateData(
    sdk.UpdateDataType.DeltaUpdate,
    new sdk.DeltaUpdate(Array.from(deltaBytes))
  )
  return new sdk.UpdateRequest(key, data)
}

// The state or delta bytes an UpdateNotification carries, whichever variant
// the node chose (S-05 d: in practice the whole state as a delta).
function notificationParts(n) {
  const u = n && n.update && n.update.updateData
  const parts = []
  if (!u) return parts
  for (const field of ['delta', 'state']) {
    if (u[field] && u[field].length) parts.push(Uint8Array.from(u[field]))
  }
  return parts
}

function withTimeout(promise, ms, what) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Opens one client. Resolves once the socket is open; rejects when it closes
// first or does not open within `openTimeoutMs`. `on` holds optional
// callbacks: notification(UpdateNotification), err(HostError), close().
function connect(url, { openTimeoutMs = OPEN_TIMEOUT_MS, on = {} } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = now()
    const putListeners = []
    let opened = false
    let settled = false
    let closed = false
    let api = null
    let openMs = null
    let closing = null
    let onClosed = null

    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(openTimer)
      reject(err)
    }

    const openTimer = setTimeout(() => {
      fail(new Error(`not open within ${openTimeoutMs} ms`))
      closeSocket()
    }, openTimeoutMs)

    function closeSocket() {
      try {
        if (api && api.ws) api.ws.close()
      } catch {}
    }

    try {
      api = new sdk.FreenetWsApi(new URL(url), {
        onContractPut: (res) => {
          for (let i = putListeners.length - 1; i >= 0; i--) {
            if (putListeners[i](res)) putListeners.splice(i, 1)
          }
        },
        onContractGet: () => {},
        onContractUpdate: () => {},
        onContractUpdateNotification: (n) => on.notification && on.notification(n),
        onContractNotFound: () => {},
        onSubscribeResponse: () => {},
        onDelegateResponse: () => {},
        onErr: (e) => on.err && on.err(e),
        onOpen: () => {
          opened = true
          openMs = now() - t0
          if (settled) return
          settled = true
          clearTimeout(openTimer)
          resolve(client)
        },
        onClose: (code, reason) => {
          closed = true
          for (const listener of putListeners.splice(0)) listener(null)
          if (!opened) fail(new Error(`closed before open (${code}${reason ? ' ' + reason : ''})`))
          else if (on.close) on.close()
          if (onClosed) onClosed()
        }
      })
    } catch (err) {
      fail(err)
      return
    }

    // (a) The PutResponse for the key is the subscribe ack.
    const subscribe = (key) =>
      withTimeout(
        new Promise((resolve, reject) => {
          const id = key.encode()
          putListeners.push((res) => {
            if (res === null) {
              reject(new Error('subscribe: connection closed'))
              return true
            }
            if (res.key.encode() !== id) return false
            resolve()
            return true
          })
          api.subscribe(new sdk.SubscribeRequest(key, [])).catch(() => {})
        }),
        REQUEST_TIMEOUT_MS,
        'subscribe'
      )

    // (c) Never the SDK's 30 s: a miss on a local-mode node is never answered.
    const get = (key, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) =>
      withTimeout(
        api.get(new sdk.GetRequest(key, false)),
        Math.min(timeoutMs, REQUEST_TIMEOUT_MS),
        'get'
      )

    // (b) Only for an instance this client has never Put.
    const put = (wasm, params, stateBytes, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) =>
      withTimeout(
        api.put(putRequest(wasm, params, stateBytes)),
        Math.min(timeoutMs, REQUEST_TIMEOUT_MS),
        'put'
      )

    // A delta for an instance the node holds. A delta the contract refuses
    // is never answered (S-19), so this always has its own cap.
    const update = (key, deltaBytes, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) =>
      withTimeout(
        api.update(deltaUpdate(key, deltaBytes)),
        Math.min(timeoutMs, REQUEST_TIMEOUT_MS),
        'update'
      )

    // The round trip of a Get on an instance the node holds (design §10 Health).
    const rttMs = async (key) => {
      const t = now()
      await get(key)
      return now() - t
    }

    // Safe twice. Resolves once the socket reports closed, or after
    // `waitMs` if it never does.
    const close = (waitMs = 1000) => {
      if (closed) return Promise.resolve()
      if (closing) return closing
      closing = new Promise((resolve) => {
        const timer = setTimeout(resolve, waitMs)
        onClosed = () => {
          clearTimeout(timer)
          resolve()
        }
        closeSocket()
      })
      return closing
    }

    const client = {
      api,
      url,
      get openMs() {
        return openMs
      },
      get closed() {
        return closed
      },
      subscribe,
      get,
      put,
      update,
      rttMs,
      close
    }
  })
}

module.exports = {
  OPEN_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  sdk,
  instanceId,
  contractKey,
  putRequest,
  deltaUpdate,
  notificationParts,
  connect
}
