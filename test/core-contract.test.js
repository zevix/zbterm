const fs = require('fs')
const path = require('path')
const test = require('brittle')

const { FrameKind, LOW_RATE_EVENTS, EVENT_DATA_NAMES } = require('../engine/rpc/schema')
const { RESTART_LIMIT, RESTART_WINDOW_MS } = require('../electron/engine-lifecycle')

// docs/CORE-CONTRACT.md is what adapters (a Tabby plugin, a headless CLI) are
// allowed to depend on. A published contract that quietly disagrees with the
// code is worse than no contract, so the tables in it are checked against
// engine/index.js and engine/rpc/schema.js at runtime here: add a method or an
// event without documenting it - or document one that no longer exists - and
// this fails.
const ROOT = path.join(__dirname, '..')
const DOC = path.join(ROOT, 'docs', 'CORE-CONTRACT.md')

test('the contract documents every invoke() method, and no method that is gone', (t) => {
  const documented = markedTable(read(DOC), 'methods')
  const implemented = invokeMethods(read(path.join(ROOT, 'engine', 'index.js')))

  t.ok(implemented.length > 10, `found ${implemented.length} methods in invoke()'s dispatch`)
  t.alike(diff(implemented, documented), [], 'no invoke() method is missing from the contract')
  t.alike(diff(documented, implemented), [], 'the contract documents no method invoke() lacks')
})

test('the contract documents every event name from engine/rpc/schema.js', (t) => {
  const doc = read(DOC)
  const lowRate = markedTable(doc, 'low-rate-events')
  const eventData = markedTable(doc, 'event-data-names')

  t.alike(diff(LOW_RATE_EVENTS, lowRate), [], 'no LOW_RATE_EVENTS entry is undocumented')
  t.alike(diff(lowRate, LOW_RATE_EVENTS), [], 'the contract invents no low-rate event')
  t.alike(diff(EVENT_DATA_NAMES, eventData), [], 'no EVENT_DATA_NAMES entry is undocumented')
  t.alike(diff(eventData, EVENT_DATA_NAMES), [], 'the contract invents no binary event')
})

test('the contract names every frame kind and the supervision numbers', (t) => {
  const doc = read(DOC)
  const missing = Object.keys(FrameKind).filter((name) => !doc.includes('`' + name + '`'))
  t.alike(missing, [], 'every FrameKind is named in the contract')
  for (const [name, value] of Object.entries(FrameKind)) {
    t.ok(
      new RegExp(`\\|\\s*${value}\\s*\\|\\s*\`${name}\``).test(doc),
      `${name} is documented with wire number ${value}`
    )
  }
  t.ok(doc.includes(`RESTART_LIMIT = ${RESTART_LIMIT}`), 'the restart limit is documented')
  t.ok(doc.includes(`RESTART_WINDOW_MS = ${RESTART_WINDOW_MS}`), 'the restart window is documented')
})

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

// The doc's lists are markdown tables fenced by
// <!-- contract:<name>:begin --> / <!-- contract:<name>:end --> so this parser
// never has to guess which table it is looking at.
function markedTable(doc, name) {
  const begin = `<!-- contract:${name}:begin -->`
  const end = `<!-- contract:${name}:end -->`
  const from = doc.indexOf(begin)
  const to = doc.indexOf(end)
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`docs/CORE-CONTRACT.md has no '${name}' section`)
  }
  const rows = []
  for (const line of doc.slice(from + begin.length, to).split('\n')) {
    const match = /^\|\s*`([A-Za-z][A-Za-z0-9.:_-]*)`\s*\|/.exec(line.trim())
    if (match) rows.push(match[1])
  }
  if (!rows.length) throw new Error(`docs/CORE-CONTRACT.md's '${name}' section lists nothing`)
  return rows
}

// The dispatch table is a chain of `method === '...'` comparisons inside
// invoke(); reading it from the source keeps the check honest even for methods
// that need real state to reach.
function invokeMethods(source) {
  const start = source.indexOf('async invoke(method, args = {})')
  if (start === -1) throw new Error("engine/index.js: invoke()'s dispatch table moved")
  const end = source.indexOf('async createSession(', start)
  const body = source.slice(start, end === -1 ? undefined : end)
  const methods = []
  for (const match of body.matchAll(/method === '([^']+)'/g)) {
    if (!methods.includes(match[1])) methods.push(match[1])
  }
  return methods
}

function diff(from, against) {
  return from.filter((item) => !against.includes(item)).sort()
}
