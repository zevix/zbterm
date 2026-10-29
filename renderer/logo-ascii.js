// Single source of truth for the ZBTerm mark. Edit this, then run `npm run
// icons` to regenerate renderer/logo.svg and every packager icon from it.
// The mark is split down the middle: the left half of the Pear (pears.com) pear and, on the
// right, the Freenet rabbit, pixelated the same way - the two networks ZBTerm
// shares over.
// Cells: '.' background, '-' scanline grey, 'G' accent green, 'B' Freenet blue.
// Two horizontal cells make up one SVG unit; one vertical cell makes up one unit.
window.STARTUP_LOGO_RAW_LINES = [
  '.---------------------------GG--------------BBBB-----------------.',
  '----------------------------GG----------BBBBBBBB------------------',
  '..................................................................',
  '--------------------------------------BBBBBBBBB-------------------',
  '-----------------------GGGGGGG------BBBBBBBBBB--------------------',
  '..................................................................',
  '-----------------------------------BBBBBBBBBB---------------------',
  '---------------------GGGGGGGGG----BBBBBBBBB-----------------------',
  '..................................................................',
  '----------------------------------BBBBBB---BBBBBBBB---------------',
  '-------------------GGGGGGGGGGG--BBBBBBBBBBBBBBBB------------------',
  '..................................................................',
  '-------------------------------BBBBBBBBBBBBBBBBBBBBB--------------',
  '--------------GGGGGGGGGGGGGGGG-BBBBBBBBBBBBBBBBBBBB---------------',
  '..................................................................',
  '-----------------------------------BBBBBBBBBB---------------------',
  '--------------GGGGGGGGGGGGGGGG-----BBBBB--------------------------',
  '..................................................................',
  '----------------------------------BBB-----------------------------',
  '.-------------------GGGGGGGGGG----B------------------------------.'
]

window.STARTUP_LOGO_COLORS = {
  black: '#444444',
  grey: '#696969',
  green: '#9ad227',
  blue: '#007fff'
}
