# Debug Server How-To

ZBTerm can expose a localhost REST API for automation and end-to-end checks
(`electron/debug-server.js`, started from `electron/main.js`). It is off by
default. Turn it on with `--debug-server` (or `ZBTERM_DEBUG_SERVER=1`); the port
is `17077` unless `--debug-server-port <port>` (or `ZBTERM_DEBUG_SERVER_PORT`)
says otherwise.

Give every instance its own storage and its own port, so a test never touches
your real profile or collides with a live instance:

```sh
npm start -- --storage /tmp/zbterm-host --debug-server --debug-server-port 17177
npm start -- --storage /tmp/zbterm-client --debug-server --debug-server-port 17178
```

`./run.sh --scratch --debug-server [port]` does the same from a source checkout
(`--packaged` for a build in `out/`): throwaway `HOME`, storage and Electron
user data, and a free port when none is given; it prints the URL. The packaged
app accepts the same flags. `--profile <id-or-name>` / `--profile-path <dir>`
open a specific profile instead of showing the picker.

The server binds to `127.0.0.1` only and logs
`[ZBTerm debug server] http://127.0.0.1:<port>` once it listens. Requests and
responses are JSON (request bodies up to 1 MiB). Every response also carries an
`X-ZBTerm-Popups` header with the pending popups (see below). Errors come back
as `{ "error": { name, code, message, details } }` with an HTTP status: `400`
for a bad body, `404` for an unknown route or popup, `409` when no session is
selected, `503` while the engine (or a window) is not ready, `500` for an
engine error.

While the debug server is on, the npm-registry update check is off (unless
`ZBTERM_REGISTRY_URL` points it at a fake registry), so an automated run never
reaches the live registry.

## Common flow

The examples use the two instances above: `17177` hosts, `17178` joins.

Wait for readiness (`ok` is true once the engine is up and the renderer has
finished starting; `engineReady` alone says the engine is up):

```sh
curl -s http://127.0.0.1:17177/health
```

Create and select a host session (`select: false` creates it without selecting
it; `cwd` and `command` are optional):

```sh
curl -s -X POST http://127.0.0.1:17177/sessions \
  -H 'content-type: application/json' \
  -d '{"name":"host top","cols":100,"rows":30}'
```

Type into the selected session. The body is one of `{"data":"..."}` (raw),
`{"text":"...","enter":true}` (`enter` appends `\r`) or `{"keys":["a","\r"]}`:

```sh
curl -s -X POST http://127.0.0.1:17177/sessions/current/input \
  -H 'content-type: application/json' \
  -d '{"text":"top -d 0.1","enter":true}'
```

Create a share link. The body is passed to `share.createLink` (`type`,
`maxViewers`, `caps`, `autoJoin`, and `backend` to pick the network, e.g.
`"freenet"`; `inputMode` first calls `share.setInputMode`).
The response is the link record with its `zbterm://join/…` invite in `uri` (and
again in `key`):

```sh
curl -s -X POST http://127.0.0.1:17177/sessions/<sessionId>/share \
  -H 'content-type: application/json' \
  -d '{"type":"group","maxViewers":1,"autoJoin":true}'
```

Join from the other instance (a joined session becomes the selected one):

```sh
curl -s -X POST http://127.0.0.1:17178/join \
  -H 'content-type: application/json' \
  -d '{"uri":"zbterm://join/..."}'
```

If the link needs approval, the host gets a `share-approval` popup; approve it
with:

```sh
curl -s -X POST http://127.0.0.1:17177/sessions/<sessionId>/approvals/<requestId>/approve
```

Inspect session state, history, terminal frame, share status and playback
state:

```sh
curl -s http://127.0.0.1:17178/sessions/<sessionId>/stats
```

Move into playback, seek, play, pause, then return to live (`tsMs` is a
timestamp from the recording's timeline, in ms):

```sh
curl -s -X POST http://127.0.0.1:17178/sessions/<sessionId>/playback/open
curl -s -X POST http://127.0.0.1:17178/sessions/<sessionId>/playback/seek \
  -H 'content-type: application/json' \
  -d '{"tsMs":1760000000000}'
curl -s -X POST http://127.0.0.1:17178/sessions/<sessionId>/playback/play \
  -H 'content-type: application/json' \
  -d '{"speed":2}'
curl -s -X POST http://127.0.0.1:17178/sessions/<sessionId>/playback/pause
curl -s -X POST http://127.0.0.1:17178/sessions/<sessionId>/live
```

Inspect renderer/UI layout — window zoom factor, window/display bounds, screen
size, terminal grid + font metrics, and the DOM rects used by the fit logic:

```sh
curl -s http://127.0.0.1:17177/renderer/layout
```

`POST /invoke` is the escape hatch for any engine method in
[`CORE-CONTRACT.md`](CORE-CONTRACT.md) §5.1 (for example `session.diagnostics`,
which has no route of its own):

```sh
curl -s -X POST http://127.0.0.1:17177/invoke \
  -H 'content-type: application/json' \
  -d '{"method":"session.list","args":{"activeOnly":true}}'
```

## Endpoints

"Engine" means the route answers `503` until the engine is ready; the others
work as soon as the server listens.

| Method & path                                            | Engine | What it does                                                                                     |
| -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `GET /health`                                            | no     | `{ ok, engineReady, renderer, selectedSessionId, selectedMode, identity, popups }`               |
| `GET /events`                                            | no     | the last 100 engine events `{ name, data, ts }` (terminal bytes reduced to a `bytes` count)      |
| `GET /popups`                                            | no     | pending popups `{ id, type, title, data, actions }`                                              |
| `POST /popups/:popupId/actions/:action`                  | no     | acts on a popup (body: the action's arguments)                                                   |
| `GET /renderer/layout`                                   | no     | zoom, window/content/display bounds and the renderer's layout snapshot                           |
| `GET /renderer/terminal-display`                         | no     | the same window data plus the terminal's rows, dimensions and row visibility                     |
| `POST /renderer/command`                                 | no     | drives the renderer UI (body `{ command, ... }`, see below)                                      |
| `GET /window/bounds`                                     | no     | `{ bounds, contentBounds, isMaximized, display }`                                                |
| `POST /window/bounds`                                    | no     | `{ x, y, width, height, animate? }`; unmaximizes, clamps to at least 640x420, saves window state |
| `GET /debug/worker-pid`                                  | no     | `{ pid }` of the Bare engine worker (`null` before it runs)                                      |
| `GET /identity`                                          | yes    | `identity.get`                                                                                   |
| `GET /account/profile`                                   | yes    | `account.profile`                                                                                |
| `GET /account/devices`                                   | yes    | `account.devices`                                                                                |
| `GET /account/local-device`                              | yes    | `account.localDevice`                                                                            |
| `GET /share/diagnostics`                                 | yes    | `share.diagnostics` (active backend's swarm/relay/ICE report)                                    |
| `GET /sessions`                                          | yes    | `session.list` (`?query=`, `?activeOnly=true`)                                                   |
| `POST /sessions`                                         | yes    | `session.create` (`name`, `cols`, `rows`, `cwd`, `command`); selects it unless `select: false`   |
| `GET /sessions/current`                                  | yes    | the selected session and mode                                                                    |
| `POST /sessions/current/input`                           | yes    | input to the selected session (`409` if none)                                                    |
| `GET /sessions/:sessionId`                               | yes    | `{ entry, opened }`: catalog entry plus `session.open`                                           |
| `POST /sessions/:sessionId/switch`                       | yes    | selects the session (live mode) without changing it                                              |
| `POST /sessions/:sessionId/live`                         | yes    | pauses playback, `session.open`, selects it live                                                 |
| `POST /sessions/:sessionId/extend`                       | yes    | `session.extend` (revives an ended session at its last grid), selects it                         |
| `POST /sessions/:sessionId/input`                        | yes    | input to that session                                                                            |
| `POST /sessions/:sessionId/resize`                       | yes    | `session.resize` (`cols`, `rows`, `fontSize?`)                                                   |
| `GET /sessions/:sessionId/stats`                         | yes    | location, history, terminal frame, playback and share summary                                    |
| `GET /sessions/:sessionId/input/diagnostics`             | yes    | stats + `share.diagnostics` + the recent `share:debug` input events                              |
| `POST /sessions/:sessionId/share`                        | yes    | `share.createLink` (see above)                                                                   |
| `GET /sessions/:sessionId/shares`                        | yes    | `share.listLinks`                                                                                |
| `DELETE /sessions/:sessionId/shares/:linkId`             | yes    | `share.revokeLink`                                                                               |
| `POST /sessions/:sessionId/approvals/:requestId/approve` | yes    | approves a pending join (the `share-approval` popup)                                             |
| `POST /sessions/:sessionId/approvals/:requestId/deny`    | yes    | denies it                                                                                        |
| `POST /sessions/:sessionId/playback/open`                | yes    | `player.open`, selects playback mode                                                             |
| `POST /sessions/:sessionId/playback/seek`                | yes    | `player.seek` (`tsMs`)                                                                           |
| `POST /sessions/:sessionId/playback/play`                | yes    | `player.play` (`speed`)                                                                          |
| `POST /sessions/:sessionId/playback/pause`               | yes    | `player.pause`                                                                                   |
| `POST /sessions/:sessionId/playback/step`                | yes    | `player.step` (`delta`)                                                                          |
| `POST /join`                                             | yes    | `share.join` (`uri`); selects the joined session                                                 |
| `POST /invoke`                                           | yes    | any engine method: `{ method, args }`                                                            |

The approve/deny routes act on the `share-approval:<sessionId>:<requestId>`
popup, so they answer `404` when no such request is pending.

## Popups

Dialogs the app would show are also exposed as popups, so a headless run can
answer them:

| Popup id                                 | Actions                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `profile-picker`                         | `fill-name` (`name`), `select` (`profileId`), `create-and-select` (`name`)      |
| `share-approval:<sessionId>:<requestId>` | `approve`, `deny`                                                               |
| `identity-setup`                         | `choose-unknown`, `fill-username`, `select-key`, `add-key`, `submit`, `dismiss` |

For example, to pick a profile on a fresh start:

```sh
curl -s -X POST http://127.0.0.1:17177/popups/profile-picker/actions/create-and-select \
  -H 'content-type: application/json' -d '{"name":"e2e"}'
```

## Renderer commands

`POST /renderer/command` with `{ "command": "<name>", ... }` clicks through the
real UI instead of calling the engine: `share-open` (`autoJoin`),
`share-select` (`type`), `share-backend` (`backend`), `share-submit`,
`share-copy`, `share-done`, `join-open`, `join-paste`, `join-submit`,
`identity-open`, `identity-peers`, `identity-annotate`, `identity-choose`
(`provider`), `identity-username` (`value`), `identity-select-key`,
`identity-add-key`, `identity-submit`, `modal-state`. The implementation is
`window.__zbtermDebugCommand` in `renderer/app.js`.

## End-to-end script

`npm run test:debug-server` (`test/debug-server-e2e.js`) drives several app
instances through this API (create, share, approve, join, playback, identity).
It picks free ports unless `ZBTERM_E2E_HOST_PORT` / `ZBTERM_E2E_CLIENT_PORT` /
`ZBTERM_E2E_CLIENT2_PORT` / `ZBTERM_E2E_CLIENT3_PORT` are set; run it with its
own `HOME` and a short `TMPDIR`, under an isolated display.
