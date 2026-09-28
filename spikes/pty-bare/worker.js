// Bare-side entrypoint for Spike 1 (node-pty under Bare). Mirrors
// workers/main.js's launch pattern (FramedStream over Bare.IPC), but
// instead of doing real work, runs the seven node-pty steps from
// docs/PHASE0-WORK-PLAN.md and reports each as a JSON line so run.js can
// assert them. Throwaway: not imported by app code.
const FramedStream = require('framed-stream')
const env = require('bare-env')
const os = require('bare-os')

const pipe = new FramedStream(Bare.IPC)

function report(step, ok, detail) {
  pipe.write(JSON.stringify({ step, ok, detail: detail === undefined ? null : detail }))
}

function errDetail(err) {
  return { message: err && err.message, stack: err && err.stack, name: err && err.name }
}

async function waitFor(predicate, timeoutMs, intervalMs = 25) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return predicate()
}

async function main() {
  // Step 1: require('node-pty')
  let pty
  try {
    pty = require('node-pty')
    report(1, true, 'require(node-pty) succeeded')
  } catch (err) {
    report(1, false, errDetail(err))
    return
  }

  // Step 2: pty.spawn with the same options engine/pty-session.js uses
  let proc
  let buffer = ''
  let exitInfo = null
  try {
    const shell = env.SHELL || 'bash'
    proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: os.cwd ? os.cwd() : undefined,
      env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    })
    proc.onData((data) => {
      buffer += data
    })
    proc.onExit(({ exitCode, signal }) => {
      exitInfo = { exitCode, signal }
    })
    report(2, true, 'pty.spawn succeeded')
  } catch (err) {
    report(2, false, errDetail(err))
    return
  }

  // Step 3: echo round-trip within 5s
  try {
    buffer = ''
    proc.write("printf 'PT0-MARKER\\n'\r")
    const ok = await waitFor(() => buffer.includes('PT0-MARKER'), 5000)
    if (!ok) throw new Error('PT0-MARKER not observed within 5s; buffer=' + JSON.stringify(buffer))
    report(3, true, 'echo round-trip observed')
  } catch (err) {
    report(3, false, errDetail(err))
    return
  }

  // Step 4: throughput >= 1 MiB within 15s
  try {
    buffer = ''
    proc.write('head -c 1048576 /dev/urandom | base64\r')
    const ok = await waitFor(() => buffer.length >= 1048576, 15000, 50)
    if (!ok) {
      throw new Error(`only ${buffer.length} bytes arrived within 15s (need >= 1048576)`)
    }
    report(4, true, { bytes: buffer.length })
  } catch (err) {
    report(4, false, errDetail(err))
    return
  }

  // Step 5: resize + stty size assertion
  try {
    buffer = ''
    proc.resize(120, 40)
    proc.write('stty size\r')
    const ok = await waitFor(() => /\b40 120\b/.test(buffer), 5000)
    if (!ok) throw new Error('stty size did not report "40 120"; buffer=' + JSON.stringify(buffer))
    report(5, true, 'resize + stty size confirmed')
  } catch (err) {
    report(5, false, errDetail(err))
    return
  }

  // Step 6: pause()/resume() don't throw
  try {
    proc.pause()
    proc.resume()
    report(6, true, 'pause/resume did not throw')
  } catch (err) {
    report(6, false, errDetail(err))
    return
  }

  // Step 7: kill() -> onExit fires within 5s
  try {
    exitInfo = null
    proc.kill()
    const ok = await waitFor(() => exitInfo !== null, 5000)
    if (!ok) throw new Error('onExit did not fire within 5s of kill()')
    report(7, true, exitInfo)
  } catch (err) {
    report(7, false, errDetail(err))
    return
  }

  report('done', true, null)
}

main().catch((err) => report('fatal', false, errDetail(err)))
