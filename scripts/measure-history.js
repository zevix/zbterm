#!/usr/bin/env node
// Measures live history over the Freenet backend with the worker <-> host pipe
// in the path (design §8.1; R-7's 1 MiB/s gate, phase F8 of
// docs/projects/260924_freenet-backend/). Prints one JSON line.
//
//   node scripts/measure-history.js [--mib 16] [--block 16384]
//   -> {"MiBps":…,"firstBlockMs":…,…}
//
// Two EngineClients in this one process, each with its own real Bare sidecar
// worker (test/fixtures/history-measure-worker.js, spawned through
// engine/spawn-worker.js::spawnWorker), its own userData directory, a stub
// ptyHost and a real electron/rtc-host.js RtcHost with no ICE servers. Worker
// A holds a `--mib` MiB store of `--block`-byte blocks and announces it;
// worker B dials, attaches and fetches the whole log. Every history byte
// crosses A's pipe, A's RtcHost, a WebRTC data channel, B's RtcHost and B's
// pipe. `MiBps` is the log bytes over the time from attachHistory to the end
// of the fetch; `firstBlockMs` is attachHistory to the first block.
//
// Both workers talk to a throwaway local-mode Freenet node this script
// starts (test/helpers/freenet-node.js: its own port and directories under
// os.tmpdir(), stopped by its pid), never to the owner's node. The workers
// are closed by client.close(), never signalled by this script.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

const { EngineClient } = require('../engine/client')
const { RtcHost } = require('../electron/rtc-host')
const { startLocalNode } = require('../test/helpers/freenet-node')

const WORKER = path.join(__dirname, '..', 'test', 'fixtures', 'history-measure-worker.js')
const MIB = 1024 * 1024

function arg(name, fallback) {
  const at = process.argv.indexOf(name)
  return at > 0 && process.argv[at + 1] ? Number(process.argv[at + 1]) : fallback
}

function stubPtyHost() {
  const host = new EventEmitter()
  host.sessions = new Map()
  return host
}

async function main() {
  const mib = arg('--mib', 16)
  const blockBytes = arg('--block', 16384)
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zbterm-measure-history-'))
  const node = await startLocalNode()
  const clients = []
  const rtcHosts = []
  try {
    const client = async (name) => {
      const userData = path.join(root, name)
      await fs.promises.mkdir(userData)
      const rtcHost = new RtcHost({ iceServers: [] })
      rtcHosts.push(rtcHost)
      const c = new EngineClient({
        userData,
        workerEntrypoint: WORKER,
        ptyHost: stubPtyHost(),
        rtcHost
      })
      clients.push(c)
      await c.ready()
      return { client: c, dir: path.join(userData, 'store') }
    }
    const a = await client('host')
    const b = await client('viewer')

    const hosted = await a.client.invoke('history.host', {
      nodeUrl: node.url,
      dir: a.dir,
      mib,
      blockBytes
    })
    const fetched = await b.client.invoke('history.attach', {
      nodeUrl: node.url,
      dir: b.dir,
      route: hosted.route,
      hostKey: hosted.hostKey,
      logKey: hosted.logKey,
      metaKey: hosted.metaKey,
      length: hosted.length
    })
    const bytes = fetched.blocks * blockBytes
    console.log(
      JSON.stringify({
        MiBps: Math.round((bytes / MIB / (fetched.transferMs / 1000)) * 100) / 100,
        firstBlockMs: fetched.firstBlockMs,
        transferMs: fetched.transferMs,
        logMiB: mib,
        blockBytes,
        blocks: fetched.blocks,
        blocksTotal: hosted.length,
        complete: fetched.blocks === hosted.length && fetched.lastBlockOk,
        metaOk: fetched.metaOk,
        longestGapMs: fetched.longestGapMs,
        connectMs: fetched.connectMs,
        appendMs: hosted.appendMs,
        workerPids: clients.map((c) => c.pid),
        nodePid: node.pid
      })
    )
  } finally {
    // bare-sidecar does not pass the pipe's end on to the worker, so each
    // close() ends in EngineClient's own destroy of its worker after 5 s.
    await Promise.all(clients.map((c) => c.close().catch(() => {})))
    for (const rtcHost of rtcHosts) rtcHost.closeAll('done')
    RtcHost.cleanup()
    await node.stop()
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
