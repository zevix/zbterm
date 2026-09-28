// Shared by the boundary tests (test/core-boundary.test.js,
// test/backend-boundary.test.js): walk a source tree and list the module
// specifiers each file really depends on.
const fs = require('fs')
const path = require('path')

const SPECIFIER = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)|\bfrom\s+['"]([^'"]+)['"]/g

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

// Line-based so a specifier named in a comment (engine/pty-remote.js documents
// electron/pty-host.js by path) is not mistaken for a dependency.
function specifiers(source) {
  const found = []
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    for (const match of line.matchAll(SPECIFIER)) found.push(match[1] || match[2])
  }
  return found
}

module.exports = { SPECIFIER, walk, specifiers }
