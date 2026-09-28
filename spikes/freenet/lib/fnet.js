// Shared helpers for the Freenet probes. Throwaway spike code; runs under Node and Bare.
// Nothing here requires a Node builtin: file reading is injected by the caller.
const { blake3 } = require('./blake3')
const bs58 = require('bs58').default || require('bs58')
const sdk = require('@freenetorg/freenet-stdlib')

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function contractKey(wasm, params) {
  const codeHash = blake3(wasm)
  const both = new Uint8Array(codeHash.length + params.length)
  both.set(codeHash, 0)
  both.set(params, codeHash.length)
  const instance = blake3(both)
  return { key: new sdk.ContractKey(instance, codeHash), id: bs58.encode(instance), codeHash }
}

// Opens a client. `on` holds optional callbacks: notification(UpdateNotification), err(HostError).
function connect(port, on = {}) {
  return new Promise((resolve, reject) => {
    const t0 = now()
    const url = new URL(`ws://127.0.0.1:${port}/v1/contract/command`)
    const putListeners = []
    // Node 0.2.135 encodes a SubscribeResponse as a PutResponse ("SubscribeResponse FBS type
    // not yet in generated code", freenet-stdlib 0.10.0 client_events.rs), so SDK 0.4.0's
    // subscribe() promise never settles until its 30 s timeout. The ack is the PutResponse.
    const subscribe = (key) =>
      new Promise((resolve, reject) => {
        const id = key.encode()
        const timer = setTimeout(() => reject(new Error('subscribe: no ack within 10 s')), 10000)
        putListeners.push((res) => {
          if (res.key.encode() !== id) return false
          clearTimeout(timer)
          resolve()
          return true
        })
        api.subscribe(new sdk.SubscribeRequest(key, [])).catch(() => {})
      })
    const api = new sdk.FreenetWsApi(url, {
      onContractPut: (res) => {
        for (let i = putListeners.length - 1; i >= 0; i--) if (putListeners[i](res)) putListeners.splice(i, 1)
      },
      onContractGet: () => {},
      onContractUpdate: () => {},
      onContractUpdateNotification: (n) => on.notification && on.notification(n),
      onContractNotFound: (id) => on.notFound && on.notFound(id),
      onSubscribeResponse: () => {},
      onDelegateResponse: () => {},
      onErr: (e) => (on.err ? on.err(e) : console.log('host error:', e.cause)),
      onOpen: () => resolve({ api, subscribe, openMs: now() - t0 }),
      onClose: (code, reason) => reject(new Error(`closed ${code} ${reason}`))
    })
  })
}

function putRequest(wasm, params, stateBytes, subscribe = false) {
  const { key, codeHash } = contractKey(wasm, params)
  const { ContractCodeT } = require('@freenetorg/freenet-stdlib/common')
  const contract = new sdk.WasmContractV1(
    new ContractCodeT(Array.from(wasm), Array.from(codeHash)),
    Array.from(params),
    key
  )
  const container = new sdk.ContractContainer(sdk.ContractType.WasmContractV1, contract)
  const { RelatedContractsT } = require('@freenetorg/freenet-stdlib/client-request')
  return new sdk.PutRequest(container, Array.from(stateBytes), new RelatedContractsT([]), subscribe, false)
}

function deltaUpdate(key, deltaBytes) {
  const data = new sdk.UpdateData(sdk.UpdateDataType.DeltaUpdate, new sdk.DeltaUpdate(Array.from(deltaBytes)))
  return new sdk.UpdateRequest(key, data)
}

const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj))
const dec = (bytes) => JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)))

// The payload of an UpdateNotification, whichever variant the node chose.
function notificationEntries(n) {
  const u = n.update && n.update.updateData
  if (!u) return []
  const out = []
  for (const field of ['delta', 'state']) {
    if (u[field] && u[field].length) out.push(...dec(u[field]).e)
  }
  return out
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b)
  const r = (x) => Math.round(x * 100) / 100
  return { n: s.length, min: r(s[0]), p50: r(pct(s, 50)), p95: r(pct(s, 95)), max: r(s[s.length - 1]) }
}

module.exports = { sdk, now, contractKey, connect, putRequest, deltaUpdate, enc, dec, notificationEntries, stats }
