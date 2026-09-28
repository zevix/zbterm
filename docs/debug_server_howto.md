# Debug Server How-To

ZBTerm can expose a localhost REST API for automation and end-to-end checks.
Start it with an explicit port when running more than one app instance:

```sh
npm start -- --storage /tmp/zbterm-host --debug-server --debug-server-port 17077
npm start -- --storage /tmp/zbterm-client --debug-server --debug-server-port 17078
```

The server binds to `127.0.0.1`. Requests and responses are JSON.

## Common Flow

Create and select a host session:

```sh
curl -s -X POST http://127.0.0.1:17077/sessions \
  -H 'content-type: application/json' \
  -d '{"name":"host top","cols":100,"rows":30}'
```

Type into the selected session:

```sh
curl -s -X POST http://127.0.0.1:17077/sessions/current/input \
  -H 'content-type: application/json' \
  -d '{"text":"top -d 0.1","enter":true}'
```

Create a share link:

```sh
curl -s -X POST http://127.0.0.1:17077/sessions/<sessionId>/share \
  -H 'content-type: application/json' \
  -d '{"type":"group","maxViewers":1,"autoJoin":true}'
```

Join from another app:

```sh
curl -s -X POST http://127.0.0.1:17078/join \
  -H 'content-type: application/json' \
  -d '{"uri":"zbterm://join/..."}'
```

Inspect session state, history, terminal frame, share status, and playback state:

```sh
curl -s http://127.0.0.1:17078/sessions/<sessionId>/stats
```

Move into playback, seek backward, play, pause, then return to live:

```sh
curl -s -X POST http://127.0.0.1:17078/sessions/<sessionId>/playback/open
curl -s -X POST http://127.0.0.1:17078/sessions/<sessionId>/playback/seek \
  -H 'content-type: application/json' \
  -d '{"tsMs":1760000000000}'
curl -s -X POST http://127.0.0.1:17078/sessions/<sessionId>/playback/play \
  -H 'content-type: application/json' \
  -d '{"speed":2}'
curl -s -X POST http://127.0.0.1:17078/sessions/<sessionId>/playback/pause
curl -s -X POST http://127.0.0.1:17078/sessions/<sessionId>/live
```

Inspect renderer/UI layout — window zoom factor, window/display bounds, screen
size, terminal grid + font metrics, and the DOM rects used by the fit logic:

```sh
curl -s http://127.0.0.1:17077/renderer/layout
```

`POST /invoke` is available as an escape hatch for engine methods:

```sh
curl -s -X POST http://127.0.0.1:17077/invoke \
  -H 'content-type: application/json' \
  -d '{"method":"session.list","args":{"activeOnly":true}}'
```
