// Probe P-9 (plan 260924_freenet-backend F10, design §8.2 option A): a read-only Hypercore replica
// filled from bytes that could live in a contract, with no live host.
//
// Host side: writes a log (default 1 MiB), cuts it into ~64 KiB segments and exports, per segment,
// the blocks plus the Merkle nodes a viewer cannot recompute from those blocks plus the signed tree
// head at the segment's end. Then the writer is closed and its storage deleted.
// Viewer side: a replica opened by key replicates (`core.replicate`, NoiseSecretStream-wrapped, as
// S-07 requires) with an in-process "virtual peer" that speaks the hypercore/alpha protomux channel
// and answers sync/request messages from the exported bytes only, generating proofs with
// Hypercore's own `MerkleTree.proof` over a fake session whose tree nodes come from those bytes.
// Step 2 (skipped with P9_NO_NODE=1 or without `freenet` on PATH): one segment is Put into a
// contract instance on a throwaway local-mode node (P-5 probe contract, free port, temp dirs),
// read back with Get, and fed to a fresh replica through the same virtual peer.
//
// Run: node spikes/freenet/p9-virtual-peer.js [logBytes=1048576] [segmentBytes=65536]
// Env: P9_NO_NODE=1 skips step 2; P9_NO_ROOTS=1 drops the per-segment root nodes; P9_DL_MS bounds
// the full download (default 30000); PROBE_VERBOSE=1 logs stages and the first requests/answers.
// Prints one JSON line: {"verified": n, "length": n, ...} or {"failure": ...}.
// Throwaway spike code: depends on Hypercore 11.33.5 internals (lib/merkle-tree.js, lib/messages.js,
// lib/caps.js), which are not a public format.
const fs = require('fs')
const os = require('os')
const path = require('path')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')

// Everything below resolves through hypercore's own dependency tree, so the codecs, hashes and the
// protomux instance are exactly the ones the replica uses.
const HC_DIR = path.dirname(require.resolve('hypercore'))
const hcRequire = (name) => require(require.resolve(name, { paths: [HC_DIR] }))
const { MerkleTree } = require('hypercore/lib/merkle-tree.js')
const messages = require('hypercore/lib/messages.js')
const caps = require('hypercore/lib/caps.js')
const Protomux = hcRequire('protomux')
const c = hcRequire('compact-encoding')
const hcrypto = hcRequire('hypercore-crypto')
const flat = hcRequire('flat-tree')

const HC_VERSION = require('hypercore/package.json').version
const LOG_BYTES = Number(process.argv[2] || 1024 * 1024)
const SEG_BYTES = Number(process.argv[3] || 64 * 1024)
const NOT_AVAILABLE = 1 // hypercore/lib/replicator.js NOT_AVAILABLE
const now = () => performance.now()
const round = (x) => Math.round(x * 100) / 100

// ---------------------------------------------------------------------------------------------
// Segment wire format (probe-only, binary, compact-encoding):
//   u32 magic 'P9S1' | uint seg | uint start | uint end | uint fork | buffer signature (manifest-v1 multisig encoding)
//   | buffer manifest (encoded hypercore manifest, empty unless seg 0)
//   | array<buffer> blocks | array<{uint index, uint size, fixed32 hash}> ancestor + root nodes
// "Ancestor nodes" = tree nodes created while appending blocks [start, end) whose span starts before
// `start`: they are the only nodes the viewer cannot recompute from the segment's own blocks.
const MAGIC = 0x31533950
const nodeEnc = {
  preencode(s, n) {
    c.uint.preencode(s, n.index)
    c.uint.preencode(s, n.size)
    c.fixed32.preencode(s, n.hash)
  },
  encode(s, n) {
    c.uint.encode(s, n.index)
    c.uint.encode(s, n.size)
    c.fixed32.encode(s, n.hash)
  },
  decode(s) {
    return { index: c.uint.decode(s), size: c.uint.decode(s), hash: c.fixed32.decode(s) }
  }
}
const segmentEnc = {
  preencode(s, m) {
    c.uint32.preencode(s, MAGIC)
    c.uint.preencode(s, m.seg)
    c.uint.preencode(s, m.start)
    c.uint.preencode(s, m.end)
    c.uint.preencode(s, m.fork)
    c.buffer.preencode(s, m.signature)
    c.buffer.preencode(s, m.manifest)
    c.array(c.buffer).preencode(s, m.blocks)
    c.array(nodeEnc).preencode(s, m.nodes)
  },
  encode(s, m) {
    c.uint32.encode(s, MAGIC)
    c.uint.encode(s, m.seg)
    c.uint.encode(s, m.start)
    c.uint.encode(s, m.end)
    c.uint.encode(s, m.fork)
    c.buffer.encode(s, m.signature)
    c.buffer.encode(s, m.manifest)
    c.array(c.buffer).encode(s, m.blocks)
    c.array(nodeEnc).encode(s, m.nodes)
  },
  decode(s) {
    if (c.uint32.decode(s) !== MAGIC) throw new Error('not a P9 segment')
    return {
      seg: c.uint.decode(s),
      start: c.uint.decode(s),
      end: c.uint.decode(s),
      fork: c.uint.decode(s),
      signature: c.buffer.decode(s),
      manifest: c.buffer.decode(s),
      blocks: c.array(c.buffer).decode(s),
      nodes: c.array(nodeEnc).decode(s)
    }
  }
}

// Every flat-tree node that becomes complete when leaf `j` is appended: the leaf, then each parent
// for which the node just completed is the right child.
function nodesCreatedBy(j) {
  const out = [2 * j]
  const ite = flat.iterator(2 * j)
  while (ite.isRight()) {
    ite.parent()
    out.push(ite.index)
  }
  return out
}

// A deterministic stand-in for terminal output: sealed packets of 40..4096 bytes (random content,
// so nothing compresses), cut into segments once a segment holds >= SEG_BYTES of blocks.
function makeLog(totalBytes) {
  const crypto = require('crypto')
  const blocks = []
  let bytes = 0
  let x = 12345
  const rnd = () => (x = (x * 1103515245 + 12345) >>> 0) / 4294967296
  while (bytes < totalBytes) {
    const size = Math.min(totalBytes - bytes, 40 + Math.floor(rnd() * rnd() * 4057))
    const b = crypto.randomBytes(size)
    b.writeUInt32LE(blocks.length, 0) // block index in the first bytes (size >= 40)
    blocks.push(b)
    bytes += size
  }
  return blocks
}

async function hostExport(dir, logBlocks) {
  const writer = new Hypercore(path.join(dir, 'writer'))
  await writer.ready()
  const segments = []
  const indexes = []
  const stats = { appendMs: 0, exportMs: 0, fullNodes: 0, ancestorNodes: 0, rootNodes: 0 }
  let i = 0
  while (i < logBlocks.length) {
    const start = i
    let bytes = 0
    const blocks = []
    while (i < logBlocks.length && bytes < SEG_BYTES) {
      blocks.push(logBlocks[i])
      bytes += logBlocks[i].length
      i++
    }
    // One append per block, as engine/session-store.js::appendPlain does; the head at the
    // segment's end is the last append's signature.
    let t = now()
    for (const b of blocks) await writer.append(b)
    stats.appendMs += now() - t
    t = now()
    const end = writer.length
    const rx = writer.state.storage.read()
    const pending = []
    for (let j = start; j < end; j++) {
      for (const index of nodesCreatedBy(j)) {
        stats.fullNodes++
        if (flat.leftSpan(index) >= 2 * start) continue // recomputable from this segment's blocks
        pending.push(rx.getTreeNode(index))
      }
    }
    // Plus the tree's full roots at `end` that the segment cannot recompute: without them a viewer
    // holding only this segment cannot take the upgrade to this head (sparse fetch).
    const have = new Set()
    for (let j = start; j < end; j++) for (const index of nodesCreatedBy(j)) have.add(index)
    let roots = 0
    if (!process.env.P9_NO_ROOTS) {
      for (const index of flat.fullRoots(2 * end)) {
        if (have.has(index)) continue // recomputable, or already an ancestor node above
        pending.push(rx.getTreeNode(index))
        roots++
      }
    }
    // The segment's maximal in-segment subtrees (created here, parent not created here): with the
    // ancestor and root nodes they form the "tree index" record, which lets a viewer verify any
    // other segment's blocks without this segment's blocks.
    const subtreeRoots = []
    const inSegment = (index) => have.has(index) && flat.leftSpan(index) >= 2 * start
    for (const index of have) {
      if (inSegment(index) && !inSegment(flat.parent(index)))
        subtreeRoots.push(rx.getTreeNode(index))
    }
    rx.tryFlush()
    const nodes = await Promise.all(pending)
    const subtrees = await Promise.all(subtreeRoots)
    stats.ancestorNodes += nodes.length - roots
    stats.rootNodes += roots
    const seg = {
      seg: segments.length,
      start,
      end,
      fork: writer.fork,
      signature: writer.state.signature,
      manifest:
        segments.length === 0 ? c.encode(messages.manifest, writer.manifest) : Buffer.alloc(0),
      blocks,
      nodes
    }
    segments.push(c.encode(segmentEnc, seg))
    indexes.push(
      c.encode(segmentEnc, {
        ...seg,
        manifest: Buffer.alloc(0),
        blocks: [],
        nodes: nodes.concat(subtrees)
      })
    )
    stats.exportMs += now() - t
  }
  const key = writer.key
  const discoveryKey = writer.discoveryKey
  const length = writer.length
  await writer.close()
  return { key, discoveryKey, length, segments, indexes, stats }
}

// ---------------------------------------------------------------------------------------------
// The virtual peer. Holds what the viewer has fetched (blocks, tree nodes, the newest signed head)
// and answers the replica on one hypercore/alpha protomux channel.
class VirtualPeer {
  constructor(key) {
    this.key = key
    this.discoveryKey = hcrypto.discoveryKey(key)
    this.blocks = new Map()
    this.nodes = new Map()
    this.head = { length: 0, fork: 0, signature: null }
    this.manifest = null
    this.ranges = []
    this.channel = null
    this.remoteLength = 0
    this.stats = { requests: 0, answered: 0, noData: 0, upgrades: 0, proofNodesSent: 0, errors: [] }
  }

  // Decodes one segment's bytes, recomputes the in-segment nodes from its blocks, keeps the head
  // if it is newer. Returns the decoded segment.
  addSegment(bytes) {
    const seg = c.decode(segmentEnc, bytes)
    if (seg.manifest.length) this.manifest = c.decode(messages.manifest, seg.manifest)
    for (const n of seg.nodes) this.nodes.set(n.index, n)
    for (let j = seg.start; j < seg.end; j++) {
      const value = seg.blocks[j - seg.start]
      this.blocks.set(j, value)
      for (const index of nodesCreatedBy(j)) {
        if (flat.leftSpan(index) < 2 * seg.start) continue
        if (index === 2 * j) {
          this.nodes.set(index, { index, size: value.byteLength, hash: hcrypto.data(value) })
        } else {
          const [l, r] = flat.children(index)
          const a = this.nodes.get(l)
          const b = this.nodes.get(r)
          this.nodes.set(index, { index, size: a.size + b.size, hash: hcrypto.parent(a, b) })
        }
      }
    }
    this.ranges.push([seg.start, seg.end - seg.start])
    if (seg.end > this.head.length)
      this.head = { length: seg.end, fork: seg.fork, signature: seg.signature }
    if (this.channel && this.channel.opened) {
      this._sendSync()
      this.channel.messages[8].send({ drop: false, start: seg.start, length: seg.end - seg.start })
    }
    return seg
  }

  // A tree-index record: nodes and head only, no blocks and no ranges advertised.
  addIndex(bytes) {
    const seg = c.decode(segmentEnc, bytes)
    for (const n of seg.nodes) this.nodes.set(n.index, n)
    if (seg.end > this.head.length)
      this.head = { length: seg.end, fork: seg.fork, signature: seg.signature }
    if (this.channel && this.channel.opened) this._sendSync()
  }

  async attach(stream) {
    const mux = Protomux.from(stream)
    await stream.opened
    const noop = () => {}
    this.channel = mux.createChannel({
      protocol: 'hypercore/alpha',
      aliases: ['hypercore'],
      id: this.discoveryKey,
      handshake: messages.wire.handshake,
      messages: [
        { encoding: messages.wire.sync, onmessage: (m) => this._onsync(m) },
        { encoding: messages.wire.request, onmessage: (m) => this._onrequest(m) },
        { encoding: messages.wire.cancel, onmessage: noop },
        { encoding: messages.wire.data, onmessage: noop },
        { encoding: messages.wire.noData, onmessage: noop },
        { encoding: messages.wire.want, onmessage: noop },
        { encoding: messages.wire.unwant, onmessage: noop },
        { encoding: messages.wire.bitfield, onmessage: noop },
        { encoding: messages.wire.range, onmessage: noop },
        { encoding: messages.wire.extension, onmessage: noop }
      ],
      onopen: (hs) => this._onopen(hs, stream)
    })
    this.channel.open({
      seeks: false,
      capability: caps.replicate(stream.isInitiator, this.key, stream.handshakeHash)
    })
  }

  _onopen({ capability }, stream) {
    const expected = caps.replicate(!stream.isInitiator, this.key, stream.handshakeHash)
    if (!capability.equals(expected)) this.stats.errors.push('remote capability mismatch')
    this._sendSync()
    for (const [start, length] of this.ranges)
      this.channel.messages[8].send({ drop: false, start, length })
  }

  _sendSync() {
    this.channel.messages[0].send({
      fork: this.head.fork,
      length: this.head.length,
      remoteLength: this.remoteLength,
      canUpgrade: true,
      uploading: true,
      downloading: true, // keeps the replica from closing the channel as idle
      hasManifest: this.manifest !== null,
      allowPush: false
    })
  }

  _onsync(m) {
    this.remoteLength = m.length
  }

  async _onrequest(req) {
    this.stats.requests++
    if (process.env.PROBE_VERBOSE && this.stats.requests <= 5)
      console.error('request', JSON.stringify(req))
    const noData = () => {
      this.stats.noData++
      this.channel.messages[4].send({ request: req.id, reason: NOT_AVAILABLE })
    }
    if (req.fork !== this.head.fork || this.head.length === 0) return noData()
    if (req.block && !this.blocks.has(req.block.index)) return noData()
    if (req.upgrade && req.upgrade.start + req.upgrade.length > this.head.length) return noData()
    const session = {
      fork: this.head.fork,
      length: this.head.length,
      signature: this.head.signature,
      prologue: null
    }
    const rx = { getTreeNode: async (index) => this.nodes.get(index) || null }
    try {
      const proof = await MerkleTree.proof(session, rx, {
        block: req.block,
        hash: req.hash,
        seek: req.seek,
        upgrade: req.upgrade
      })
      const settled = await proof.settle()
      if (settled.block) settled.block.value = this.blocks.get(req.block.index)
      if (req.manifest) settled.manifest = this.manifest
      if (settled.upgrade) this.stats.upgrades++
      this.stats.proofNodesSent +=
        (settled.block ? settled.block.nodes.length : 0) +
        (settled.upgrade
          ? settled.upgrade.nodes.length + settled.upgrade.additionalNodes.length
          : 0)
      this.stats.answered++
      if (process.env.PROBE_VERBOSE && this.stats.answered <= 3) {
        console.error(
          'answer',
          JSON.stringify({
            block: settled.block && {
              index: settled.block.index,
              nodes: settled.block.nodes.map((n) => n.index)
            },
            upgrade: settled.upgrade && {
              start: settled.upgrade.start,
              length: settled.upgrade.length,
              nodes: settled.upgrade.nodes.map((n) => n.index),
              extra: settled.upgrade.additionalNodes.map((n) => n.index),
              sig: settled.upgrade.signature && settled.upgrade.signature.length
            },
            manifest: !!settled.manifest
          })
        )
      }
      this.channel.messages[3].send({ request: req.id, ...settled })
    } catch (err) {
      if (this.stats.errors.length < 5) this.stats.errors.push(err.message)
      noData()
    }
  }
}

// A replica by key, wired to a virtual peer over an in-process NoiseSecretStream pair.
async function openViewer(dir, name, key) {
  const reader = new Hypercore(path.join(dir, name), key)
  await reader.ready()
  const a = new NoiseSecretStream(true)
  const b = new NoiseSecretStream(false)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  a.on('error', () => {})
  b.on('error', () => {})
  const peer = new VirtualPeer(key)
  reader.replicate(a)
  await peer.attach(b)
  let verificationErrors = 0
  reader.on('verification-error', () => verificationErrors++)
  return {
    reader,
    peer,
    verificationErrors: () => verificationErrors,
    async close() {
      a.destroy()
      b.destroy()
      await reader.close()
    }
  }
}

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))])

async function waitLength(reader, length, ms = 5000) {
  const deadline = Date.now() + ms
  while (reader.length < length && Date.now() < deadline) {
    await withTimeout(reader.update({ wait: true }), 250)
  }
  return reader.length
}

// Counts the blocks of [start, end) the replica holds locally (no network wait) and that equal the
// host's original (the original is used only for this check, never by the viewer path).
async function countVerified(reader, original, start, end) {
  let verified = 0
  for (let i = start; i < end; i++) {
    const got = await reader.get(i, { wait: false }).catch(() => null)
    if (got && Buffer.compare(got, original[i]) === 0) verified++
  }
  return verified
}

const stage = (s) => process.env.PROBE_VERBOSE && console.error('stage:', s, Math.round(now()))

// ---------------------------------------------------------------------------------------------
async function scenarioAll(dir, host, original) {
  const v = await openViewer(dir, 'all', host.key)
  const t0 = now()
  for (const s of host.segments) v.peer.addSegment(s)
  const length = await waitLength(v.reader, host.length)
  const tUpgraded = now()
  const dl = v.reader.download({ start: 0, end: host.length })
  const done = await withTimeout(
    dl.done().then(() => true),
    Number(process.env.P9_DL_MS || 30000)
  )
  const tDone = now()
  const verified = await countVerified(v.reader, original, 0, host.length)
  const out = {
    length,
    hostLength: host.length,
    downloadComplete: done === true,
    contiguousLength: v.reader.contiguousLength,
    verified,
    upgradeMs: round(tUpgraded - t0),
    downloadMs: round(tDone - tUpgraded),
    verificationErrors: v.verificationErrors(),
    peer: v.peer.stats
  }
  await v.close()
  return out
}

// Segments arrive one at a time; each is downloaded while the replica's length is its end.
async function scenarioProgressive(dir, host, original) {
  const v = await openViewer(dir, 'progressive', host.key)
  let complete = 0
  for (const s of host.segments) {
    const seg = v.peer.addSegment(s)
    await waitLength(v.reader, seg.end)
    const done = await withTimeout(
      v.reader
        .download({ start: seg.start, end: seg.end })
        .done()
        .then(() => true),
      10000
    )
    if (done === true) complete++
  }
  const out = {
    length: v.reader.length,
    segmentsDownloaded: complete,
    verified: await countVerified(v.reader, original, 0, host.length),
    verificationErrors: v.verificationErrors(),
    peer: v.peer.stats
  }
  await v.close()
  return out
}

// Only some segments fetched (first, a middle one, last): which of their blocks verify against
// the newest head, and what an unfetched segment's request gets.
async function scenarioSparse(dir, host, original, withIndex) {
  const v = await openViewer(dir, withIndex ? 'sparse-index' : 'sparse', host.key)
  const n = host.segments.length
  const picked = [0, Math.floor(n / 2), n - 1]
  if (withIndex) for (const x of host.indexes) v.peer.addIndex(x)
  const segs = picked.map((i) => v.peer.addSegment(host.segments[i]))
  const length = await waitLength(v.reader, host.length)
  const perSegment = []
  for (const seg of segs) {
    const done = await withTimeout(
      v.reader
        .download({ start: seg.start, end: seg.end })
        .done()
        .then(() => true),
      3000
    )
    const verified = await countVerified(v.reader, original, seg.start, seg.end)
    perSegment.push({
      seg: seg.seg,
      blocks: seg.end - seg.start,
      downloadComplete: done === true,
      verified
    })
  }
  const missing = segs[0].end // first block of segment 1, never fetched
  const unfetched = await withTimeout(
    v.reader.get(missing, { timeout: 500 }).catch((e) => e.code || e.message),
    1000
  )
  const out = {
    picked,
    withIndex: !!withIndex,
    length,
    perSegment,
    unfetchedBlockGet: unfetched === 'timeout' ? 'timeout' : String(unfetched),
    peer: v.peer.stats
  }
  await v.close()
  return out
}

// One flipped byte in one block of one segment: the replica must refuse that block.
async function scenarioTamper(dir, host, original) {
  const v = await openViewer(dir, 'tamper', host.key)
  const target = Math.min(3, host.segments.length - 1)
  const seg = c.decode(segmentEnc, host.segments[target])
  const victim = seg.start + 1
  // Feed every segment honestly, then swap the stored block for a tampered copy: the in-segment
  // nodes stay the honest ones, so the proof is honest and only the block value lies.
  for (const s of host.segments) v.peer.addSegment(s)
  const bad = Buffer.from(v.peer.blocks.get(victim))
  bad[bad.length - 1] ^= 0xff
  v.peer.blocks.set(victim, bad)
  await waitLength(v.reader, host.length)
  const got = await withTimeout(
    v.reader.get(victim, { timeout: 1000 }).catch((e) => e.code || e.message),
    1500
  )
  await withTimeout(
    v.reader.get(victim + 1, { timeout: 1000 }).catch(() => null),
    1500
  )
  const neighbour = await countVerified(v.reader, original, victim + 1, victim + 2)
  const out = {
    victim,
    victimGet:
      got === 'timeout'
        ? 'timeout'
        : Buffer.isBuffer(got)
          ? Buffer.compare(got, bad) === 0
            ? 'ACCEPTED TAMPERED'
            : 'got original?'
          : String(got),
    victimAccepted: Buffer.isBuffer(got),
    verificationErrors: v.verificationErrors(),
    neighbourVerified: neighbour === 1,
    peer: { noData: v.peer.stats.noData, answered: v.peer.stats.answered }
  }
  await v.close()
  return out
}

// Step 2: segment 0 through a contract on a throwaway local-mode node and back into a replica.
async function scenarioContract(dir, host, original) {
  if (process.env.P9_NO_NODE) return { skipped: 'P9_NO_NODE' }
  const {
    freenetAvailable,
    startLocalNode,
    freePort
  } = require('../../test/helpers/freenet-node.js')
  if (!freenetAvailable()) return { skipped: 'freenet not on PATH' }
  const f = require('./lib/fnet')
  const wasm = new Uint8Array(
    fs.readFileSync(
      path.join(
        __dirname,
        'contracts/signalling/target/wasm32-unknown-unknown/release/zbterm_signalling.wasm'
      )
    )
  )
  const segBytes = host.segments[0]
  // The P-5 probe contract holds JSON entries with <= 16 KiB string payloads: base64 in 12 KiB
  // slices, one entry each, one instance per segment (params carry a nonce and a huge TTL).
  const entries = []
  for (let o = 0, s = 0; o < segBytes.length; o += 12288, s++) {
    entries.push({
      l: 'p9',
      r: 'seg0',
      s,
      t: 1,
      d: false,
      p: segBytes.subarray(o, o + 12288).toString('base64')
    })
  }
  const state = f.enc({ e: entries })
  const params = f.enc({ ttl_ms: 1e15, n: `p9-${Date.now()}-${process.pid}` })
  const { key } = f.contractKey(wasm, params)
  const out = { segmentBytes: segBytes.length, stateBytes: state.length, entries: entries.length }
  let port = await freePort()
  while (port === 17069 || port === 7509) port = await freePort() // the owner's ZBTerm / node
  const node = await startLocalNode({ port })
  out.node = { port: node.port, pid: node.pid }
  let client = null
  try {
    client = await f.connect(node.port)
    let t = now()
    const put = await withTimeout(client.api.put(f.putRequest(wasm, params, state)), 20000)
    if (put === 'timeout')
      throw new Error('Put not answered in 20 s (S-19: a refused Put is never answered)')
    out.putMs = round(now() - t)
    const gets = []
    let back = null
    for (let i = 0; i < 10; i++) {
      t = now()
      const res = await withTimeout(client.api.get(new f.sdk.GetRequest(key, false)), 10000)
      if (res === 'timeout') throw new Error('Get not answered in 10 s')
      gets.push(now() - t)
      back = res.state
    }
    out.getMs = f.stats(gets)
    out.getStateBytes = back.length
    const decoded = Buffer.concat(
      f
        .dec(back)
        .e.sort((a, b) => a.s - b.s)
        .map((e) => Buffer.from(e.p, 'base64'))
    )
    out.bytesIdentical = Buffer.compare(decoded, segBytes) === 0
    const v = await openViewer(dir, 'contract', host.key)
    const seg = v.peer.addSegment(decoded)
    const length = await waitLength(v.reader, seg.end)
    const done = await withTimeout(
      v.reader
        .download({ start: seg.start, end: seg.end })
        .done()
        .then(() => true),
      10000
    )
    out.replica = {
      length,
      segmentEnd: seg.end,
      downloadComplete: done === true,
      verified: await countVerified(v.reader, original, seg.start, seg.end)
    }
    await v.close()
  } finally {
    if (client) {
      try {
        client.api.close?.()
        client.api.ws?.close?.()
      } catch {}
    }
    await node.stop()
  }
  return out
}

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbterm-p9-'))
  const out = { hypercore: HC_VERSION, logBytes: LOG_BYTES, segmentBytes: SEG_BYTES }
  try {
    const original = makeLog(LOG_BYTES)
    const host = await hostExport(dir, original)
    // No live host from here on: the writer is closed, its storage removed.
    fs.rmSync(path.join(dir, 'writer'), { recursive: true, force: true })

    const sizes = host.segments.map((b) => {
      const s = c.decode(segmentEnc, b)
      const blockBytes = s.blocks.reduce((n, x) => n + x.length, 0)
      return {
        blocks: s.end - s.start,
        blockBytes,
        total: b.length,
        proof: b.length - blockBytes,
        nodes: s.nodes.length
      }
    })
    const per64 = sizes.map((s) => (s.proof * 65536) / s.blockBytes)
    out.blocks = host.length
    out.segments = host.segments.length
    out.sizes = {
      blocksPerSegment: stat(sizes.map((s) => s.blocks)),
      ancestorNodesPerSegment: stat(sizes.map((s) => s.nodes)),
      proofBytesPerSegment: stat(sizes.map((s) => s.proof)),
      proofBytesPer64KiB: stat(per64),
      manifestBytes: c.decode(segmentEnc, host.segments[0]).manifest.length,
      allNodesIfShippedWhole: host.stats.fullNodes,
      ancestorNodesShipped: host.stats.ancestorNodes,
      extraRootNodesShipped: host.stats.rootNodes,
      totalSegmentBytes: sizes.reduce((n, s) => n + s.total, 0),
      indexRecordBytes: stat(host.indexes.map((b) => b.length)),
      indexNodesPerSegment: stat(host.indexes.map((b) => c.decode(segmentEnc, b).nodes.length))
    }
    out.hostMs = { append: round(host.stats.appendMs), export: round(host.stats.exportMs) }

    stage('exported')
    out.all = await scenarioAll(dir, host, original)
    out.verified = out.all.verified
    out.length = out.all.length
    stage('all')
    out.progressive = await scenarioProgressive(dir, host, original)
    stage('progressive')
    out.sparse = await scenarioSparse(dir, host, original, false)
    stage('sparse')
    out.sparseWithIndex = await scenarioSparse(dir, host, original, true)
    stage('sparse')
    out.tamper = await scenarioTamper(dir, host, original)
    stage('tamper')
    out.contract = await scenarioContract(dir, host, original)
    out.outcome =
      out.verified === host.length && out.all.downloadComplete && !out.tamper.victimAccepted
        ? 'A works'
        : 'A failed'
  } catch (err) {
    out.failure = err && err.stack ? err.stack : String(err)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log(JSON.stringify(out))
  setTimeout(() => process.exit(out.failure ? 1 : 0), 100)
})()

function stat(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return {
    n: s.length,
    min: round(s[0]),
    p50: round(s[Math.floor(s.length / 2)]),
    max: round(s[s.length - 1])
  }
}
