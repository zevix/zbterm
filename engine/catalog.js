const fs = require('fs')
const path = require('path')
const Hypercore = require('hypercore')
const Hyperbee = require('hyperbee')
const { findInText } = require('./buffer-search')

class Catalog {
  constructor(dir) {
    this.dir = dir
    this.core = null
    this.bee = null
  }

  async ready() {
    await fs.promises.mkdir(this.dir, { recursive: true })
    this.core = new Hypercore(path.join(this.dir, 'bee-core'))
    this.bee = new Hyperbee(this.core, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    await this.bee.ready()
  }

  async markPreviousActiveEnded() {
    for await (const { key, value } of this.bee.createReadStream({
      gt: 'session/',
      lt: 'session0'
    })) {
      if (!value.active || value.endedAt) continue
      await this.bee.put(key, { ...value, active: false, endedAt: Date.now() })
    }
  }

  async put(entry) {
    await this.bee.put(catalogKey(entry.startedAt, entry.sessionId), entry)
  }

  async update(sessionId, patch) {
    const existing = await this.get(sessionId)
    if (!existing) return null
    const next = { ...existing, ...patch }
    await this.put(next)
    return next
  }

  async delete(sessionId) {
    for await (const node of this.bee.createReadStream({ gt: 'session/', lt: 'session0' })) {
      if (node.value.sessionId === sessionId) {
        await this.bee.del(node.key)
      }
    }
  }

  async get(sessionId) {
    for await (const node of this.bee.createReadStream({ gt: 'session/', lt: 'session0' })) {
      if (node.value.sessionId === sessionId) return node.value
    }
    return null
  }

  async list(opts = {}) {
    const out = []
    const q = opts.query ? opts.query.toLowerCase() : ''
    // 261121 R15: match case / whole word use the buffer matcher on the name;
    // with neither, the filter is the plain one it always was.
    const exact = !!(opts.caseSensitive || opts.wholeWord)
    const matchOpts = { caseSensitive: !!opts.caseSensitive, wholeWord: !!opts.wholeWord }
    for await (const node of this.bee.createReadStream({ gt: 'session/', lt: 'session0' })) {
      const value = node.value
      if (opts.activeOnly && !value.active) continue
      if (q) {
        const name = String(value.name || '')
        const hit = exact
          ? findInText(name, opts.query, matchOpts).length > 0
          : name.toLowerCase().includes(q)
        if (!hit) continue
      }
      out.push(value)
    }
    out.sort((a, b) => sortTime(b) - sortTime(a))
    return out
  }

  async close() {
    if (this.bee) await this.bee.close()
  }
}

function catalogKey(startedAt, sessionId) {
  return `session/${String(startedAt).padStart(16, '0')}/${sessionId}`
}

module.exports = Catalog

// The time a session is listed by, newest first: its manual `sortAt` (a
// "pseudo time" in ms set by dragging its row, 261115 R7) when it has one,
// else the time it last started.
function sortTime(entry) {
  if (Number.isFinite(entry.sortAt)) return entry.sortAt
  return entry.lastStartedAt || entry.startedAt || 0
}

module.exports.sortTime = sortTime
