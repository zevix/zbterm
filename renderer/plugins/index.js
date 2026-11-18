// The launch plugins, for Node (the main process and the tests). The renderer
// loads the same files as <script>s in renderer/index.html, in this order: a
// new plugin is one file here, one line there
// (test/launch-plugins.test.js checks the two lists agree).
const launch = require('./launch-core.js')

require('./change-directory.js')
require('./shell-command.js')
require('./ssh.js')
require('./remote-directory.js')

module.exports = launch
