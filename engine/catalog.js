const fs = require('fs')
const path = require('path')
const Hypercore = require('hypercore')
const Hyperbee = require('hyperbee')

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
    for await (const node of this.bee.createReadStream({ gt: 'session/', lt: 'session0' })) {
      const value = node.value
      if (opts.activeOnly && !value.active) continue
      if (q && !value.name.toLowerCase().includes(q)) continue
      out.push(value)
    }
    out.sort((a, b) => {
      const aLastStartedAt = a.lastStartedAt || a.startedAt || 0
      const bLastStartedAt = b.lastStartedAt || b.startedAt || 0
      return bLastStartedAt - aLastStartedAt
    })
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
