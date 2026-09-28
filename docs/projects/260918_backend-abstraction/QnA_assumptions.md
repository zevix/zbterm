# Backend abstraction spike — questions and assumptions

Phases cite these ids and do not relitigate them. `Q-n` was asked and answered on 2026-09-18.
`A-n` was taken without asking.

## Questions

### Q-1 How does the Freenet backend carry live PTY output and viewer input?

**Answer: hybrid, Freenet + WebRTC.** Contracts carry invites, rendezvous, membership, rekey
and durable encrypted history. A WebRTC data channel carries live output and viewer input. Its
SDP and ICE candidates are exchanged through a Freenet signalling contract. Viewer input is
never stored. This matches `docs/abstract-arch.md` §23.6 "Recommended hybrid mode". Recorded as
`D-01`.

Other options offered:

- Pure Freenet, contract-only: output as contract deltas; input stored in a contract or
  disabled.
- Pure Freenet, read-only viewers: `SEND_INPUT` unsupported on Freenet.
- Let the spike measure both and decide at the end.

### Q-2 What does "build without the Pear backend" exclude?

**Answer: network sharing only.** That is hyperswarm, hyperdht, protomux use, the relay
lookup and Hypercore replication to peers. Local Hypercore/Hyperbee storage, the
pear-runtime/Bare sidecar, crypto and the Pear OTA updater (`workers/main.js`) stay in every
build, including local-only. Recorded as `D-02`.

Other options offered:

- Network sharing plus the OTA updater.
- All Holepunch code, which is the full abstract-arch `BackendBundle`.

### Q-3 How deep does the spike go?

**Answer: interface + Pear adapter + Freenet probes.** The spike delivers:

- the common interface in code with a conformance suite;
- the existing ShareManager networking behind it, with every existing test green;
- the backend flag, the env var, the build variants and the UI gating;
- minimal Freenet probes.

A full Freenet backend is the follow-on project. Recorded as `D-03`.

Other options offered:

- Both adapters working end to end.
- Design documents only.

## Assumptions

| id | Taken | Other option |
|---|---|---|
| A-1 | The project lives at `docs/projects/260918_backend-abstraction/`. Phase prefix `B`. This introduces `docs/projects/` to a repo that used flat `docs/<slug>_plan.md` files. | Keep the flat convention |
| A-2 | The area ledgers are `docs/register.md` (`S-nn`) and `docs/decisions.md` (`D-nn`), created by this project. | Per-project ledgers |
| A-3 | One `ShareBackend` object, not abstract-arch's three providers. Pear's discovery and transport share one swarm, so splitting them would be artificial. Recorded as a deviation. | `TransportProvider` + `DiscoveryProvider` + `SessionStoreProvider` as separate objects |
| A-4 | The Freenet client is the TypeScript SDK the request pointed at. A Rust sidecar is only the last fallback topology. | Rust sidecar first (the better-trodden path; `riverctl` uses it) |
| A-5 | Probes use a local node that is already running (`freenet local`). Spawning, bundling and supervising the node are deferred. | Spike a node lifecycle manager |
| A-6 | The default build variant stays `pear`. The Freenet stub reports `state:'broken', detail:'probe only'` unless `ZBTERM_FREENET_EXPERIMENTAL=1`. | Default to `pear,freenet` |
| A-7 | Pear keeps emitting v1-shaped invites. v2 emission is behind `ZBTERM_INVITE_V2=1`. | Emit v2 immediately |
| A-8 | The Tabby plugin follows whichever core it resolved. It has no build flag of its own. | A plugin build variant |
| A-9 | GUI checks run only through uisolate, with a unique storage path. Electron is never killed broadly; only the instance with that storage path is. | — |
| A-10 | The control channel carries JSON objects, not a byte stream, because `zbterm/ctl` is already `c.json`. Byte-stream channels are deferred. | abstract-arch `DuplexByteStream` |
| A-11 | History calls operate on a `SessionStore` (Hypercores), not on backend-neutral segments, because Q-2 keeps local storage out of scope. | Neutral segments per abstract-arch §4.3 |

## Sources for the Freenet facts in `requirements.md` §2.3

- TS SDK: <https://freenet.org/build/manual/typescript-sdk/>,
  <https://github.com/freenet/freenet-stdlib/blob/main/typescript/src/websocket-interface.ts>
- Contracts and ABI: <https://freenet.org/build/manual/components/contracts>,
  <https://freenet.org/build/manual/contract-interface>,
  <https://freenet.org/build/manual/contract-abi>
- Key derivation:
  <https://github.com/freenet/freenet-stdlib/blob/main/rust/src/contract_interface/key.rs>
- Client API verbs:
  <https://github.com/freenet/freenet-stdlib/blob/main/rust/src/client_api/client_events.rs>
- Delegates: <https://freenet.org/build/manual/components/delegates>
- Node, ports, exit code 42: <https://freenet.org/quickstart/>,
  <https://github.com/freenet/freenet-core/blob/main/crates/core/src/bin/freenet.rs>
- Maturity: <https://freenet.org/about/faq/>, <https://github.com/freenet/freenet-core/releases>
- Licence: <https://github.com/freenet/freenet-core/blob/main/LICENSE.md>
- Closest reference app: <https://github.com/freenet/river>

Unverified: the repair-window numbers attributed to freenet-core issue #5703 came from a
search snippet, and no third-party Node.js use of the SDK was found.
