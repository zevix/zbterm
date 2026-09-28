#!/usr/bin/env node
// Copies the renderer's third-party assets (xterm + addons, Font Awesome) out of
// node_modules and into renderer/vendor/, so index.html can reference them with
// package-relative URLs. Without this the renderer only works when node_modules
// happens to sit next to renderer/ - which is true for a git clone but not for a
// global/npx/hoisted npm install.
//
// Copy only: no bundling, no minification, no version rewriting.
//
// Usage:
//   node scripts/vendor-assets.js            # quiet on success, exit 0
//   node scripts/vendor-assets.js --verbose  # list every file copied
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const VENDOR = path.join(ROOT, 'renderer', 'vendor')
const verbose = process.argv.includes('--verbose')

// specifier -> destination relative to renderer/vendor
const FILES = [
  ['@xterm/xterm/lib/xterm.js', 'xterm/xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm/xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'xterm/addon-fit.js'],
  ['@xterm/addon-webgl/lib/addon-webgl.js', 'xterm/addon-webgl.js'],
  ['@fortawesome/fontawesome-free/css/all.min.css', 'fontawesome/css/all.min.css']
]

// Font Awesome's CSS points at ../webfonts/*, so the css/ + webfonts/ sibling
// layout has to survive the copy.
const FONT_DIR = ['@fortawesome/fontawesome-free/webfonts', 'fontawesome/webfonts', /\.woff2$/]

function fail(message) {
  console.error(`vendor-assets: ${message}`)
  process.exit(1)
}

// Never hardcode a node_modules path: resolve the specifier, and if the package
// has a restrictive "exports" map that hides the subpath, resolve its package.json
// (or its main entry) and join from the package directory instead.
function resolveAsset(specifier) {
  try {
    return require.resolve(specifier)
  } catch {}
  const slash = specifier.indexOf('/', specifier.startsWith('@') ? specifier.indexOf('/') + 1 : 0)
  const name = slash === -1 ? specifier : specifier.slice(0, slash)
  const subpath = slash === -1 ? '' : specifier.slice(slash + 1)
  let dir = null
  try {
    dir = path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    try {
      dir = path.dirname(require.resolve(name))
    } catch {
      fail(`cannot resolve ${specifier} - is ${name} installed?`)
    }
  }
  const full = path.join(dir, subpath)
  if (!fs.existsSync(full)) fail(`cannot resolve ${specifier} - ${full} does not exist`)
  return full
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  if (verbose) console.log(`vendor-assets: ${path.relative(ROOT, to)}`)
}

for (const [specifier, dest] of FILES) {
  copy(resolveAsset(specifier), path.join(VENDOR, dest))
}

const [fontSpecifier, fontDest, fontMatch] = FONT_DIR
const fontSrc = resolveAsset(fontSpecifier)
const fonts = fs.readdirSync(fontSrc).filter((name) => fontMatch.test(name))
if (fonts.length === 0) fail(`no files matching ${fontMatch} in ${fontSpecifier}`)
for (const name of fonts.sort()) {
  copy(path.join(fontSrc, name), path.join(VENDOR, fontDest, name))
}
