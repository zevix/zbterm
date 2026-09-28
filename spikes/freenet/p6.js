// Probe P-6: hypercore.replicate(isInitiator, stream) over a WebRTC data channel wrapped as a
// streamx Duplex with u32 length framing, split into messages no larger than `chunk` bytes.
// Writes a 16 MiB log on one side and times a full download on the other.
// Run: node spikes/freenet/p6.js [lib=node-datachannel] [chunkBytes=16384] [MiB=16] [blockBytes=16384]   (P6_POLL=1 polls bufferedAmount instead of trusting the drain event)
const fs = require('fs')
const os = require('os')
const path = require('path')
const Hypercore = require('hypercore')
const { Duplex } = require('streamx')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { libs } = require('./lib/rtc')

const libName = process.argv[2] || 'node-datachannel'
const CHUNK = Number(process.argv[3] || 16384)
const MIB = Number(process.argv[4] || 16)
const BLOCK = Number(process.argv[5] || 16384)
const HIGH_WATER = 1024 * 1024

// One stream write = one frame: u32le length, then the bytes, cut into <= CHUNK messages.
function channelDuplex(side, counters) {
  let waiting = null
  side.onDrain(HIGH_WATER / 4, () => {
    if (waiting) { const cb = waiting; waiting = null; cb(null) }
  })
  let need = -1
  let parts = []
  let have = 0
  let head = Buffer.alloc(0)
  const stream = new Duplex({
    write(data, cb) {
      try {
        const frame = Buffer.allocUnsafe(4 + data.length)
        frame.writeUInt32LE(data.length, 0)
        frame.set(data, 4)
        for (let o = 0; o < frame.length; o += CHUNK) {
          side.send(frame.subarray(o, Math.min(frame.length, o + CHUNK)))
          counters.messages++
        }
        counters.frames++
        counters.maxFrame = Math.max(counters.maxFrame, data.length)
      } catch (err) {
        return cb(err)
      }
      if (side.bufferedAmount() > HIGH_WATER) {
        counters.pauses++
        waiting = cb
        if (process.env.P6_POLL) {
          const poll = setInterval(() => {
            if (side.bufferedAmount() > HIGH_WATER / 4) return
            clearInterval(poll)
            if (waiting) { const w = waiting; waiting = null; w(null) }
          }, 5)
        }
      } else cb(null)
    }
  })
  side.onMessage((msg) => {
    let buf = head.length ? Buffer.concat([head, msg]) : msg
    head = Buffer.alloc(0)
    while (buf.length) {
      if (need < 0) {
        if (buf.length < 4) { head = buf; return }
        need = buf.readUInt32LE(0)
        buf = buf.subarray(4)
        parts = []
        have = 0
      }
      const take = Math.min(need - have, buf.length)
      parts.push(buf.subarray(0, take))
      have += take
      buf = buf.subarray(take)
      if (have === need) {
        stream.push(Buffer.concat(parts))
        need = -1
      }
    }
  })
  return stream
}

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbterm-p6-'))
  const out = { lib: libName, poll: !!process.env.P6_POLL, chunkBytes: CHUNK, logMiB: MIB, blockBytes: BLOCK }
  try {
    const stage = (s) => process.env.PROBE_VERBOSE && console.error('stage:', s)
    const writer = new Hypercore(path.join(dir, 'writer'))
    await writer.ready()
    const block = Buffer.alloc(BLOCK)
    const blocks = (MIB * 1024 * 1024) / BLOCK
    let t = performance.now()
    for (let i = 0; i < blocks; i += 64) {
      const batch = []
      for (let j = i; j < Math.min(blocks, i + 64); j++) {
        const b = Buffer.from(block)
        b.writeUInt32LE(j, 0)
        require('crypto').randomFillSync(b, 4, 64) // not compressible to nothing, still cheap
        batch.push(b)
      }
      await writer.append(batch)
    }
    stage('appended')
    out.appendMs = Math.round(performance.now() - t)
    const reader = new Hypercore(path.join(dir, 'reader'), writer.key)
    await reader.ready()

    const pair = await libs[libName]()
    stage('channel open')
    out.channelOpenMs = Math.round(pair.openMs)
    out.maxMessageSize = pair.a.maxMessageSize()
    const ca = { messages: 0, frames: 0, maxFrame: 0, pauses: 0 }
    const cb = { messages: 0, frames: 0, maxFrame: 0, pauses: 0 }
    const sa = channelDuplex(pair.a, ca)
    const sb = channelDuplex(pair.b, cb)
    sa.on('error', (err) => { out.streamErrorA = err.message })
    sb.on('error', (err) => { out.streamErrorB = err.message })
    if (process.env.PROBE_VERBOSE) setTimeout(() => console.error('after 3 s', JSON.stringify({ ca, cb, out })), 3000)
    // hypercore 11 rejects a bare Duplex ("Invalid stream": it wants `.noiseStream`), so the
    // raw channel duplex is wrapped in a NoiseSecretStream first, as Hyperswarm does.
    writer.replicate(new NoiseSecretStream(true, sa))
    reader.replicate(new NoiseSecretStream(false, sb))

    t = performance.now()
    // Stall metric: the longest gap between two 'download' events on the reader.
    let lastProgress = 0
    let firstBlockMs = null
    let longestStallMs = 0
    let downloads = 0
    reader.on('download', () => {
      const nowT = performance.now()
      if (firstBlockMs === null) firstBlockMs = nowT - t
      else longestStallMs = Math.max(longestStallMs, nowT - lastProgress)
      lastProgress = nowT
      downloads++
    })
    await reader.update({ wait: true })
    stage('updated, length ' + reader.length)
    const range = reader.download({ start: 0, end: writer.length })
    const finished = await Promise.race([
      range.done().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 120000))
    ])
    const ms = performance.now() - t
    out.complete = finished
    out.blocksDownloaded = reader.contiguousLength
    out.blocksTotal = writer.length
    out.transferMs = Math.round(ms)
    out.MiBperS = Math.round(((reader.contiguousLength * BLOCK) / 1048576 / (ms / 1000)) * 100) / 100
    out.firstBlockMs = Math.round(firstBlockMs)
    out.downloadEvents = downloads
    out.longestGapBetweenBlocksMs = Math.round(longestStallMs)
    out.writerSide = ca
    out.readerSide = cb
    const last = await reader.get(writer.length - 1, { wait: false })
    out.lastBlockIndexOk = !!last && last.readUInt32LE(0) === writer.length - 1
    console.log(JSON.stringify(out))
    sa.destroy(); sb.destroy()
    await writer.close(); await reader.close()
    pair.a.close(); pair.b.close(); pair.cleanup()
  } catch (err) {
    out.failure = err.message
    console.log(JSON.stringify(out))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    setTimeout(() => process.exit(0), 300)
  }
})()
