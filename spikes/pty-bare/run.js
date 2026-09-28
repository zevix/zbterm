// Node-side launcher for Spike 1 (node-pty under Bare). Mirrors
// electron/main.js's getWorker(): PearRuntime.run(...) + FramedStream over
// the returned pipe. Prints each worker-reported step verdict and exits
// nonzero on any failed step or a 60s overall timeout. Throwaway spike code.
const PearRuntime = require('pear-runtime')
const FramedStream = require('framed-stream')

const TOTAL_STEPS = 7
const OVERALL_TIMEOUT_MS = 60000

const worker = PearRuntime.run(require.resolve('./worker.js'), [])
const pipe = new FramedStream(worker)

const results = []
let finished = false
let timeoutHandle

function finish(code) {
  if (finished) return
  finished = true
  clearTimeout(timeoutHandle)
  pipe.destroy()
  try {
    worker.destroy()
  } catch {
    // already gone
  }
  console.log('\n--- spike 1 verdict ---')
  console.log(JSON.stringify(results, null, 2))
  process.exitCode = code
}

timeoutHandle = setTimeout(() => {
  console.error(`Overall 60s timeout hit; results so far: ${JSON.stringify(results)}`)
  finish(1)
}, OVERALL_TIMEOUT_MS)

pipe.on('data', (data) => {
  let msg
  try {
    msg = JSON.parse(data.toString('utf8'))
  } catch (err) {
    console.error('Non-JSON line from worker:', data.toString('utf8'))
    return
  }
  console.log('step', msg.step, msg.ok ? 'OK' : 'FAIL', JSON.stringify(msg.detail))
  results.push(msg)
  if (msg.step === 'done') {
    finish(0)
    return
  }
  if (msg.step === 'fatal' || msg.ok === false) {
    finish(1)
    return
  }
  if (results.filter((r) => typeof r.step === 'number' && r.ok).length === TOTAL_STEPS) {
    // all seven numbered steps reported ok but no 'done' yet; keep waiting briefly
  }
})

worker.on('exit', (code) => {
  if (!finished) {
    console.error(`worker process exited early with code ${code}`)
    finish(1)
  }
})

worker.stderr.on('data', (d) => process.stderr.write(`[worker stderr] ${d}`))
