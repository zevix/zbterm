#!/usr/bin/env node
'use strict'

// Prints the ZBTerm logo in the terminal, the same way the renderer's startup
// splash does. Both read renderer/logo-ascii.js, the source of truth for the
// mark, so this and the renderer can never disagree about what the logo looks
// like. Run `npm run icons` after editing it to regenerate renderer/logo.svg
// and the packager icons.
const fs = require('fs')
const path = require('path')
const pkg = require('../package.json')

const ASCII_SOURCE = path.join(__dirname, '..', 'renderer', 'logo-ascii.js')

const CAPTION_ROWS = 3

main().catch((err) => {
  process.stdout.write('\x1b[0m\x1b[?25h')
  console.error(err && err.stack ? err.stack : err)
  process.exitCode = 1
})

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const { lines, cells, colors: svgColors } = loadGeneratedLogo()
  const colors = { greenText: ansiFg(hexToRgb(svgColors.green)) }
  const logoRows = logoCellRows(lines, cells, svgColors)
  const logoWidth = Math.max(...logoRows.map((row) => row.length))

  const rows = process.stdout.rows || 24
  const cols = process.stdout.columns || 80
  const blockHeight = logoRows.length + CAPTION_ROWS
  const startRow = Math.max(1, Math.floor((rows - blockHeight) / 2) + 1 - 2)
  const startCol = Math.max(1, Math.floor((cols - logoWidth) / 2) + 1)

  process.stdout.write('\x1b[2J\x1b[H\x1b[?25l')
  for (let rowIndex = 0; rowIndex < logoRows.length; rowIndex++) {
    const cells = logoRows[rowIndex]
    for (let colIndex = 0; colIndex < cells.length; colIndex++) {
      process.stdout.write(`\x1b[${startRow + rowIndex};${startCol + colIndex}H${cells[colIndex]}`)
      if (options.delayMs) await delay(options.delayMs)
    }
  }
  drawCenteredText(startRow + logoRows.length + 1, `ZBTerm v${pkg.version}`, cols, {
    color: colors.greenText
  })
  drawCenteredText(startRow + logoRows.length + 2, 'Written by Zeev Kotzer', cols)
  process.stdout.write(`\x1b[0m\x1b[${startRow + blockHeight + 2};1H\x1b[?25h`)
  await waitForEnter()
}

// The ASCII file is written for the browser (it assigns onto `window`), so it
// is evaluated here against a stand-in global rather than require()d.
function loadGeneratedLogo() {
  let source
  try {
    source = fs.readFileSync(ASCII_SOURCE, 'utf8')
  } catch {
    throw new Error('renderer/logo-ascii.js is missing')
  }

  const window = {}
  new Function('window', source)(window)

  if (
    !Array.isArray(window.STARTUP_LOGO_RAW_LINES) ||
    !window.STARTUP_LOGO_CELLS ||
    !window.STARTUP_LOGO_COLORS
  ) {
    throw new Error('renderer/logo-ascii.js is malformed')
  }
  return {
    lines: window.STARTUP_LOGO_RAW_LINES,
    cells: window.STARTUP_LOGO_CELLS,
    colors: window.STARTUP_LOGO_COLORS
  }
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function ansiBg([r, g, b]) {
  return `\x1b[48;2;${r};${g};${b}m`
}

function ansiFg([r, g, b]) {
  return `\x1b[38;2;${r};${g};${b}m`
}

function parseOptions(args) {
  const positionalDelay = args[0] && !args[0].startsWith('-') ? args[0] : 0
  return {
    delayMs: parseNumberOption(
      args,
      ['--delay', '--logo-delay'],
      positionalDelay,
      0,
      Number.MAX_SAFE_INTEGER,
      false
    )
  }
}

function parseNumberOption(args, names, fallback, min, max, round) {
  const index = args.findIndex((arg) => names.includes(arg))
  const raw = index === -1 ? fallback : args[index + 1]
  const value = Number(raw)
  if (!Number.isFinite(value)) return Number(fallback)
  const normalized = round ? Math.round(value) : value
  return Math.max(min, Math.min(max, normalized))
}

// The mark is a grid of square pixels; a terminal cell is about twice as tall
// as it is wide, so each cell shows two of them, one above the other, as a
// half-block glyph: the upper pixel is the foreground, the lower one the
// background. A transparent pixel leaves the terminal's own background. Same
// pairing as logoCellLines in renderer/app.js.
function logoCellRows(lines, cells, colors) {
  const rgb = (char) => (cells[char] ? hexToRgb(colors[cells[char]]) : null)
  const width = Math.max(...lines.map((line) => line.length))
  const reset = '\x1b[0m'
  const out = []
  for (let y = 0; y < lines.length; y += 2) {
    const upper = lines[y].padEnd(width, ' ')
    const lower = (lines[y + 1] || '').padEnd(width, ' ')
    const row = []
    for (let x = 0; x < width; x++) {
      const top = rgb(upper[x])
      const bottom = rgb(lower[x])
      if (!top && !bottom) row.push(`${reset} `)
      else if (top && bottom && top.join() === bottom.join()) row.push(`${ansiBg(top)} ${reset}`)
      else if (!bottom) row.push(`${ansiFg(top)}\u2580${reset}`)
      else if (!top) row.push(`${ansiFg(bottom)}\u2584${reset}`)
      else row.push(`${ansiFg(top)}${ansiBg(bottom)}\u2580${reset}`)
    }
    out.push(row)
  }
  return out
}

function drawCenteredText(row, text, cols, opts = {}) {
  const col = Math.max(1, Math.floor((cols - text.length) / 2) + 1)
  const color = opts.color || ''
  process.stdout.write(`\x1b[${row};${col}H${color}${text}\x1b[0m`)
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdin.once('data', resolve)
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
