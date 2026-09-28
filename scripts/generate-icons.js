#!/usr/bin/env node
'use strict'

// renderer/logo-ascii.js is the single source of truth for the ZBTerm mark: a
// grid of cells plus the palette they are painted with. Every other form of the
// logo in this repo is generated from it by this script and must never be
// edited by hand:
//
//   renderer/logo.svg               vector mark (README, and the raster source below)
//   build/icon/icon-<N>x<N>.png     Linux hicolor icons (install-desktop reads these)
//   build/icon.png                  512px master (Electron/Linux packager icon)
//   build/icon.ico                  Windows packager icon
//   build/icon.icns                 macOS packager icon
//
// Run `npm run icons` after changing the ASCII. Colors are read out of
// STARTUP_LOGO_COLORS, never hardcoded, so a recolored logo propagates
// everywhere on its own.
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ASCII_SOURCE = path.join(ROOT, 'renderer', 'logo-ascii.js')
const SVG_OUT = path.join(ROOT, 'renderer', 'logo.svg')
const SIZES = [16, 32, 64, 128, 256, 512]

// Terminal cells are about twice as tall as they are wide, so two horizontal
// cells make up one SVG unit while one vertical cell makes up one unit. That is
// what keeps the ASCII rendering square-ish in a terminal and the SVG square-ish
// on screen.
const CELLS_PER_UNIT_X = 2

// Which palette entry of STARTUP_LOGO_COLORS each cell character paints.
const CELL_COLORS = {
  '.': 'black',
  '-': 'grey',
  G: 'green'
}

const ICON_DIR = path.join(ROOT, 'build', 'icon')
const PNG_MASTER = path.join(ROOT, 'build', 'icon.png')
const ICO_OUT = path.join(ROOT, 'build', 'icon.ico')
const ICNS_OUT = path.join(ROOT, 'build', 'icon.icns')

// Sizes baked into the Windows .ico. 512 is deliberately excluded - the ICO
// directory stores each dimension in a single byte (0 meaning 256).
const ICO_SIZES = [16, 32, 64, 128, 256]

// macOS icns chunk type per pixel size. Types below ic07 are the "icpN" PNG
// variants; all of these carry a plain PNG payload.
const ICNS_TYPES = {
  16: 'icp4',
  32: 'icp5',
  64: 'icp6',
  128: 'ic07',
  256: 'ic08',
  512: 'ic09'
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err)
  process.exitCode = 1
})

async function main() {
  const { lines, colors } = loadAsciiLogo()
  const svgText = svgFromAscii(lines, colors)
  fs.writeFileSync(SVG_OUT, svgText)

  const svg = Buffer.from(svgText, 'utf8')
  const cols = lines[0].length
  const rows = lines.length

  fs.mkdirSync(ICON_DIR, { recursive: true })

  // Rendered once per size and reused by the png, ico and icns writers, so
  // the three containers can never drift from each other.
  const pngs = new Map()
  for (const size of SIZES) {
    const buffer = await renderSquare(svg, size, cols / CELLS_PER_UNIT_X, rows)
    pngs.set(size, buffer)
    fs.writeFileSync(path.join(ICON_DIR, `icon-${size}x${size}.png`), buffer)
  }
  fs.writeFileSync(PNG_MASTER, pngs.get(512))

  fs.writeFileSync(ICNS_OUT, buildIcns(pngs))
  makeIco()

  console.log('icons written from ' + path.relative(ROOT, ASCII_SOURCE) + ':')
  console.log('  ' + path.relative(ROOT, SVG_OUT))
  for (const size of SIZES) console.log('  build/icon/icon-' + size + 'x' + size + '.png')
  for (const out of [PNG_MASTER, ICO_OUT, ICNS_OUT]) {
    console.log('  ' + path.relative(ROOT, out))
  }
}

// The ASCII file is written for the browser (it assigns onto `window`), so it is
// evaluated here against a stand-in global rather than require()d.
function loadAsciiLogo() {
  const source = fs.readFileSync(ASCII_SOURCE, 'utf8')
  const window = {}
  new Function('window', source)(window)

  const lines = window.STARTUP_LOGO_RAW_LINES
  const colors = window.STARTUP_LOGO_COLORS
  if (!Array.isArray(lines) || lines.length === 0 || !colors) {
    throw new Error(
      'renderer/logo-ascii.js must define STARTUP_LOGO_RAW_LINES and STARTUP_LOGO_COLORS'
    )
  }
  for (const [index, line] of lines.entries()) {
    if (line.length !== lines[0].length) {
      throw new Error(
        `renderer/logo-ascii.js line ${index + 1} is ${line.length} cells wide, expected ${lines[0].length}`
      )
    }
    for (const char of line) {
      if (!CELL_COLORS[char]) {
        throw new Error(
          `renderer/logo-ascii.js line ${index + 1} uses unknown cell character ${JSON.stringify(char)}`
        )
      }
      if (!colors[CELL_COLORS[char]]) {
        throw new Error(
          `renderer/logo-ascii.js has no ${CELL_COLORS[char]} entry in STARTUP_LOGO_COLORS`
        )
      }
    }
  }
  return { lines, colors }
}

// One <rect> per maximal block of same-colored cells. Runs are found per row and
// then merged downwards, so a solid bar is a single rect rather than one rect
// per cell - that keeps the SVG small and keeps editors like Inkscape usable on
// it if anyone wants to inspect the output.
function svgFromAscii(lines, colors) {
  const cellW = 1 / CELLS_PER_UNIT_X
  const width = (lines[0].length * cellW).toString()
  const height = lines.length.toString()

  const runs = lines.map(rowRuns)
  const merged = runs.map(() => new Set())
  const rects = []
  for (let y = 0; y < runs.length; y++) {
    for (const run of runs[y]) {
      if (merged[y].has(run.start)) continue
      let h = 1
      while (y + h < runs.length) {
        const below = runs[y + h].find(
          (other) => other.start === run.start && other.end === run.end && other.char === run.char
        )
        if (!below) break
        merged[y + h].add(below.start)
        h++
      }
      rects.push(
        rect(
          run.start * cellW,
          y,
          (run.end - run.start + 1) * cellW,
          h,
          colors[CELL_COLORS[run.char]]
        )
      )
    }
  }

  // The background is a full-canvas rect rather than per-cell rects so the
  // black cells cost nothing, and shape-rendering keeps the cell grid from
  // developing hairline seams when rasterized at icon sizes.
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Auto-generated by scripts/generate-icons.js from renderer/logo-ascii.js. Do not edit by hand. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges">
${rect(0, 0, Number(width), Number(height), colors.black)}
${rects.join('\n')}
</svg>
`
}

function rect(x, y, w, h, fill) {
  return `  <rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="${fill}" />`
}

function num(value) {
  return Number(value.toFixed(4)).toString()
}

// Maximal runs of a single non-background character within one row.
function rowRuns(line) {
  const runs = []
  let start = -1
  for (let x = 0; x <= line.length; x++) {
    const char = line[x]
    if (start !== -1 && char !== line[start]) {
      runs.push({ start, end: x - 1, char: line[start] })
      start = -1
    }
    if (start === -1 && char && char !== '.') start = x
  }
  return runs
}

function renderSquare(svg, size, unitsW, unitsH) {
  const logoH = Math.round((size * unitsH) / unitsW)
  const padTop = Math.floor((size - logoH) / 2)

  return sharp(svg, { density: Math.ceil((size / unitsW) * 96) })
    .resize(size, logoH, { fit: 'fill' })
    .extend({
      top: padTop,
      bottom: size - logoH - padTop,
      left: 0,
      right: 0,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer()
}

// Apple's icns container: the 8-byte 'icns' header followed by typed chunks,
// each itself prefixed with its OSType and its own total length. ImageMagick
// has no ICNS delegate on Linux and icnsutils is not a build dependency, so
// the container is assembled here rather than shelled out.
function buildIcns(pngs) {
  const chunks = []
  for (const size of SIZES) {
    const type = ICNS_TYPES[size]
    if (!type) continue
    const png = pngs.get(size)
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    chunks.push(header, png)
  }

  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([header, body])
}

function makeIco() {
  run('magick', [
    ...ICO_SIZES.map((size) => path.join(ICON_DIR, `icon-${size}x${size}.png`)),
    ICO_OUT
  ])
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error(
      `${command} is required to build build/icon.ico - install ImageMagick and re-run \`npm run icons\``
    )
  }
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}
