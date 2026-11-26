// Single source of truth for the ZBTerm mark. Edit this, then run `npm run
// icons` to regenerate renderer/logo.svg and every packager icon from it.
// The mark stacks the two networks ZBTerm shares over: the head of the blue
// Freenet rabbit (in profile, ears swept back) on top of the green striped
// Pear (pears.com) pear, which doubles as the rabbit's body - hence the small
// blue tail off the pear's right side. The pear keeps the Pear logo's bars,
// with the right half stepped one row against the left.
//
// Every character is one square pixel. The terminal splash stacks two rows
// into one character cell with half-block glyphs, so the row count must stay
// even. STARTUP_LOGO_CELLS names the palette entry each character paints; a
// space is transparent (the rounded corners of the tile).
window.STARTUP_LOGO_RAW_LINES = [
  '    ....................................    ',
  '  ........................................  ',
  ' .........................BB............... ',
  ' ........................LBBB.............. ',
  '........................LBBBB...............',
  '........................LBBBB......DD.......',
  '.......................LBBBB.....DDDD.......',
  '......................LBBBBB...DDDDDD.......',
  '......................LBBBB...DDDDDD........',
  '.....................LBBBBB..DDDDDD.........',
  '....................LBBBBB..DDDDDD..........',
  '...................LBBBBB..DDDDD............',
  '...............LLBBBBBBB..DDDD..............',
  '.............LLBBBBBBBBBBBDD................',
  '...........LLBBBBBBBBBBBBBB.................',
  '..........LLLBBWKBBBBBBBBBB.................',
  '.........LLLLBBKKBBBBBBBBBB.................',
  '.........LLLLBBBBBBBBBBBBBB.................',
  '.........LLLBBBBBBBBBBBBBB..................',
  '..........LLBBBBBBBBBBBBB...................',
  '............BBBBBBBBBBBB....................',
  '.................GGGGGGGGGG.................',
  '.................GGGGGggggg.................',
  '.................gggggGGGGG.................',
  '................GGGGGGGGGGGG................',
  '................GGGGGGgggggg................',
  '...............gggggggGGGGGGG...............',
  '..............GGGGGGGGGGGGGGGG..............',
  '.............GGGGGGGGGggggggggg.............',
  '............ggggggggggGGGGGGGGGG............',
  '...........GGGGGGGGGGGGGGGGGGGGGG...........',
  '...........GGGGGGGGGGGggggggggggg...........',
  '..........ggggggggggggGGGGGGGGGGGG..........',
  '..........GGGGGGGGGGGGGGGGGGGGGGGG.BB.......',
  '..........GGGGGGGGGGGGggggggggggggBBBB......',
  '..........ggggggggggggGGGGGGGGGGGGBBBBB.....',
  '..........GGGGGGGGGGGGGGGGGGGGGGGGBBBB......',
  '..........GGGGGGGGGGGGgggggggggggg.BB.......',
  '...........gggggggggggGGGGGGGGGGG...........',
  '............GGGGGGGGGGGGGGGGGGGG............',
  ' .............GGGGGGGGgggggggg............. ',
  ' ................gggggGGGGG................ ',
  '  ........................................  ',
  '    ....................................    '
]

window.STARTUP_LOGO_CELLS = {
  ' ': null,
  '.': 'tile',
  G: 'green',
  g: 'greenDark',
  B: 'blue',
  L: 'blueLight',
  D: 'blueDark',
  K: 'ink',
  W: 'white'
}

window.STARTUP_LOGO_COLORS = {
  tile: '#262b33',
  green: '#9ad227',
  greenDark: '#6c9c12',
  blue: '#007fff',
  blueLight: '#62bdf2',
  blueDark: '#0058c4',
  ink: '#10141a',
  white: '#ffffff'
}
