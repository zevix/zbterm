# Security policy

ZBTerm records terminal sessions and shares them with other machines, so security reports are
taken seriously.

## Reporting a vulnerability

Please **do not** open a public issue. Report it privately through GitHub's
[private vulnerability reporting](https://github.com/zevix/zbterm/security/advisories/new) for this
repository.

Include what you found, how to reproduce it, the ZBTerm version (`zbterm --version`) and your
platform. We aim to acknowledge reports within a few days and will keep you updated until a fix
is released. We are happy to credit you in the advisory unless you prefer otherwise.

## Supported versions

Only the latest release published to npm receives security fixes.

## Scope

In scope: the ZBTerm app, its core (`engine/`), the share protocol, local storage encryption, the
relay (`relay/`) and the debug server.

Worth knowing before you report:

- The debug server (`--debug-server`) is a development tool. It is off by default, listens only
  on `127.0.0.1`, and gives full control of the app to local processes.
- Freenet sharing discloses your IP address to the configured STUN servers, as documented in the
  README.
- A relay's public key is not a secret, and relays do not yet restrict who can use them (see
  "Abuse considerations" in the README).
