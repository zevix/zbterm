// Starts a Bare script the way electron/main.js starts the core worker (PearRuntime.run), so
// it runs on pear-runtime's embedded Bare rather than the standalone `bare` binary.
// pear-runtime resolves from the repo root node_modules.
// Run: node spikes/freenet/pear-run.js <script.js> [args...]
const path = require('path')
const PearRuntime = require('pear-runtime')
const [script, ...args] = process.argv.slice(2)
const worker = PearRuntime.run(path.resolve(script), args)
const timer = setTimeout(() => {
  console.error('timeout after 120 s')
  try { worker.destroy() } catch {}
  process.exit(1)
}, 120000)
if (worker.stdout) worker.stdout.on('data', (d) => process.stdout.write(d))
if (worker.stderr) worker.stderr.on('data', (d) => process.stderr.write(d))
worker.on('exit', (code) => {
  clearTimeout(timer)
  console.log(`worker exit code ${code}`)
  process.exit(code || 0)
})
