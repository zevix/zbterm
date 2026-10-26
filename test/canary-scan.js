const fs = require('fs')
const path = require('path')

const root = process.argv[2]
const canary = Buffer.from(process.argv[3] || 'ZBTERM_PLAINTEXT_CANARY_1234')

if (!root) {
  console.error('usage: node test/canary-scan.js <storage-dir> [canary]')
  process.exit(2)
}

scan(root).catch((err) => {
  console.error(err)
  process.exit(1)
})

async function scan(dir) {
  const hits = []
  await walk(dir, hits)
  if (hits.length) {
    console.error('plaintext canary found in:')
    for (const hit of hits) console.error(hit)
    process.exit(1)
  }
}

async function walk(file, hits) {
  const stat = await fs.promises.stat(file)
  if (stat.isDirectory()) {
    for (const name of await fs.promises.readdir(file)) await walk(path.join(file, name), hits)
    return
  }
  const data = await fs.promises.readFile(file)
  if (data.includes(canary)) hits.push(file)
}
