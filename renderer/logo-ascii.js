// Single source of truth for the ZBTerm mark. Edit this, then run `npm run
// icons` to regenerate renderer/logo.svg and every packager icon from it.
// The mark stacks the two networks ZBTerm shares over: the blue Freenet
// rabbit's head (ears, eyes, chin) on top of the green Pear (pears.com) pear,
// with a small blue rabbit tail off the pear's right side.
// Cells: '.' background, '-' scanline grey, 'G' accent green, 'B' Freenet blue.
// Two horizontal cells make up one SVG unit; one vertical cell makes up one unit.
window.STARTUP_LOGO_RAW_LINES = [
  '.---------------------------------------BBBB---------------------.',
  '------------------------BBBBBB--------BBBBBB----------------------',
  '..................................................................',
  '------------------BBBBBBBBBBBBBB----BBBBBB------------------------',
  '----------------BBBB------BBBBBBBBBBBBBBBB------------------------',
  '..................................................................',
  '----------------------BBBBB..BBBBBBBB..BBBBB----------------------',
  '------------------------BBBBBBBB..BBBBBBBB------------------------',
  '..................................................................',
  '----------------------------BBBBBBBBBB----------------------------',
  '----------------------------GGGGGGGGGG----------------------------',
  '..................................................................',
  '------------------------GGGGGGGGGGGGGGGGGG------------------------',
  '----------------------GGGGGGGGGGGGGGGGGGGGGG----------------------',
  '..................................................................',
  '--------------------GGGGGGGGGGGGGGGGGGGGGGGGGG-BBBB---------------',
  '--------------------GGGGGGGGGGGGGGGGGGGGGGGGGG-BBB----------------',
  '..................................................................',
  '--------------------GGGGGGGGGGGGGGGGGGGGGGGGGG--------------------',
  '.-----------------------GGGGGGGGGGGGGGGGGG-----------------------.'
]

window.STARTUP_LOGO_COLORS = {
  black: '#444444',
  grey: '#696969',
  green: '#9ad227',
  blue: '#007fff'
}
