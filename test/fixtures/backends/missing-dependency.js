// A backend whose own dependency was dropped from the build: MODULE_NOT_FOUND
// from inside it means the backend is absent, exactly as if its directory were.
module.exports = require('zbterm-no-such-backend-dependency')
