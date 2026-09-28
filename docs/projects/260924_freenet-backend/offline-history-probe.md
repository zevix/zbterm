# Offline history: the option A probe (F10)

Plan `260924_freenet-backend` phase F10. Design `260918_backend-abstraction/freenet-backend-design.md`
§8.2 (option A, "virtual peer"), parent `open-issues.md` item 41, `R-12`, `D-13`. Nothing here ships.

- **Box:** started 2026-09-24 21:38 +03:00, ended 2026-09-24 21:55 +03:00 (one agent session, about
  17 minutes, well inside the plan's two days).
- **Code:** `spikes/freenet/p9-virtual-peer.js` (one file). Run it with
  `node spikes/freenet/p9-virtual-peer.js [logBytes] [segmentBytes]`. It prints one JSON line.
  `P9_NO_NODE=1` skips step 2.
- **Register:** `S-28`.
- **Verdict:** **open A as a follow-on project.** Option B is not needed to unblock offline history.
  The reasons and conditions are in "Recommendation" below.

## Pinned versions (the result holds for these only)

The spike resolves `hypercore` from `spikes/freenet/node_modules` and takes every other module from
hypercore's own dependency tree:

| package | version | note |
|---|---|---|
| `hypercore` | **11.33.5** | Same version as the root tree, which the product uses |
| `protomux` | 3.12.0 | The root tree has 3.11.0 |
| `@hyperswarm/secret-stream` | 6.9.1 | Same at the root |
| `hypercore-crypto` | 3.7.0 | Same at the root |
| `flat-tree` | 1.13.0 | Same at the root |
| `compact-encoding` | 3.5.0 | |
| `hypercore-storage` | 3.3.1 | The root tree has 3.1.2 |
| `freenet` (step 2) | 0.2.137 (10e859e256a6) | `~/.local/bin`, started with `freenet local` |

Node v24.18.0.

## What was built

**Host side (`hostExport`).**
1. Writes a 1 MiB log of random blocks, 40–4 096 B each (980 blocks). Each block is its own
   `append`, as `engine/session-store.js::appendPlain` does.
2. Cuts the log into segments at the first block boundary at or past 64 KiB, so segments are cut
   by bytes and are **not** aligned to the Merkle tree: 16 segments of 46–73 blocks.
3. For each segment, exports one binary record: the header, the signed tree head at the segment's
   end, the blocks, and only the tree nodes the viewer **cannot recompute** from those blocks. The
   header holds `seg`, `start`, `end` and `fork`. The signed head is `writer.state.signature`, 68
   bytes in the manifest-v1 multisig encoding. The nodes fall into two groups:
   - **Ancestor nodes:** nodes completed while appending `[start, end)` whose span starts before
     `start`.
   - **Root nodes:** full roots of the tree at `end` that the segment doesn't hold.

   Segment 0 also carries the encoded manifest (70 B).
4. Reads the nodes from storage with `writer.state.storage.read().getTreeNode(i)`.
5. Also exports a second, block-free **tree-index record** for each segment. It holds the ancestor
   and root nodes plus the segment's maximal in-segment subtree roots.
6. Closes the writer and **deletes its storage before any viewer starts**. No live host exists from
   that point on.

**Viewer side (`VirtualPeer`).**
1. A replica is opened by key only (`new Hypercore(dir, key)`). It replicates over an in-process
   `NoiseSecretStream` pair. `S-07` requires that wrap on hypercore 11, and it is the same wrap the
   product uses.
2. The other end is our object, not a Hypercore. It opens the `hypercore/alpha` protomux channel on
   the discovery key, with the ten messages in `lib/replicator.js::Replicator#_makePeer`'s order.
   It sends the capability `caps.replicate(isInitiator, key, handshakeHash)`.
3. It advertises the newest head it holds with `sync`, and the segments it holds with `range`.
4. It answers each `request` with a `data` message. The proof comes from Hypercore's own
   `MerkleTree.proof(session, rx, req)`. `session` is a plain object holding
   `{fork, length, signature, prologue: null}`, and `rx.getTreeNode(i)` reads from a `Map` built
   from the fetched bytes.
5. The in-segment nodes are **recomputed** from the blocks with `hypercore-crypto` `data` and
   `parent`.
6. Anything it can't prove gets a `noData` reply (reason 1).

## What worked (final run, 1 MiB, `hypercore` 11.33.5)

| scenario | result |
|---|---|
| **all**: every segment fetched, then `update` + `download({start: 0, end})` | `length` 980 = host 980; download complete; **verified 980 / 980**; 981 requests, 981 answered, 0 `noData`, 0 verification errors; upgrade 20 ms, download 188 ms |
| **progressive**: segments arrive one at a time; each is downloaded while the replica's length is that segment's end | 16 / 16 segments; **verified 980 / 980**; 16 upgrades (`start > 0` "connect existing tree" proofs work) |
| **sparse with index**: all 16 index records, plus blocks of segments 0, 8 and 15 only | upgrade to 980; **verified 59/59, 63/63 and 46/46**; an unfetched block's `get` times out (`REQUEST_TIMEOUT`) and is never answered with wrong data |
| **tamper**: one flipped byte in block 189, honest proof | block **refused**; `verification-error` fired once; nothing accepted |
| **contract round trip** (step 2): segment 0 through a contract on a local-mode node and back into a fresh replica | bytes identical after Get; replica length 59 = segment end; download complete; **verified 59 / 59** |

A second run with 16 MiB (`node spikes/freenet/p9-virtual-peer.js 16777216`, `P9_NO_NODE=1`)
produced 15 890 blocks in 252 segments. It verified 15 890 / 15 890 in both the "all" and the
"progressive" scenario (download 2.36 s), and 59/59, 62/62 and 57/57 with the index.

## What did not work

- **Sparse fetch without the index record fails.** The replica takes the upgrade to the newest head
  once the root nodes are in the record. Earlier runs without them failed even at the upgrade
  (`Expected tree node 1279 … got (nil)`). Its block proofs still fail, **0 of 168** blocks, with
  `MerkleTree.proof` answering `Expected tree node 95 from storage, got (nil)`.
  - Because the segments are cut by bytes, a block's uncle path against a later head needs subtree
    hashes that live in *neighbouring* segments, including right siblings that did not exist yet
    when the segment was written.
  - A record written once, at the segment's end, cannot carry them.
  - **Fix measured:** a separate block-free tree-index record per segment. Fetching every index
    record plus any subset of segments verifies them all, as shown above. The index can be cheap
    to fetch (see "Sizes").
- **One invalid block pauses the peer.** In the tamper run, block 190's fetch sometimes succeeded
  and sometimes did not (`neighbourVerified` true in 3 runs, false in 3). This is
  `lib/replicator.js::Peer#_handleData`: on invalid data, without `allowPush`, it sets
  `this.paused = true`. A product virtual peer must therefore drop a segment that fails
  verification and re-open the channel, rather than keep serving from it.

## Sizes (reported, not gated)

Per ~64 KiB segment, 1 MiB log (n = 16). "Proof bytes" means the segment record minus the raw block
bytes: header, signature, varint length prefixes, the manifest in segment 0, and the nodes (each
node is a varint index, a varint size and a 32 B hash).

| measure | min | p50 | max |
|---|---|---|---|
| blocks per segment | 46 | 62 | 73 |
| ancestor nodes shipped per segment (plus 18 root nodes over all 16) | 0 | 8 | 9 |
| **proof bytes per segment** | 303 | 525 | 595 |
| **proof bytes per 64 KiB of blocks** | 293 | **531** (≈ 0.8 %) | 623 |
| tree-index record per segment | 260 | 586 | 696 |
| nodes per index record | 5 | 13 | 16 |

- **Totals:** the 16 records hold 1 056 650 B for 1 048 576 B of blocks. The whole log has 1 954
  tree nodes; only 89 ancestor nodes and 18 root nodes are shipped, and the rest are recomputed.
- **16 MiB (n = 252):** proof bytes per 64 KiB p50 602, max 788; index record p50 664, max 858 B.
  Growth is about log₂ of the log length, as expected.
- **Host cost:** exporting a segment takes about 0.3–0.6 ms, beside the appends (9.1 ms in total
  for 1 MiB).
- **Viewer cost:** the full 1 MiB download from records takes ≈ 190 ms, with the proof generation
  in JS.

## Contract round trip (step 2)

- **Setup:**
  - Contract: the P-5 probe contract (`spikes/freenet/contracts/signalling`, the 181 292 B WASM).
  - Node: a throwaway `freenet local` node from `test/helpers/freenet-node.js::startLocalNode` on a
    free port (40639 in the final run; 38591 and 46303 in the other two). It used temp dirs, and the helper
    stopped it by its own pid; `ps -p` confirmed it had exited and the temp dirs were gone.
  - Encoding: the segment record went in base64, in 12 KiB slices, as the payloads of 6 entries in
    one instance. Params were a nonce and a large TTL.
- **Segment 0:** the binary record is 68 077 B, and the **contract state is 91 085 B** (the JSON
  plus base64 overhead, 1.34×). A binary segment contract would store about the record size.
- **Put** (whole state at once): 138.85 ms in the final run; 157.17 and 163.57 ms in the other two
  runs.
- **Get:** p50 / p95 4.53 / 8.92 ms (n = 10; the other runs 4.20 / 8.61 and 5.68 / 13.12). The
  state came back byte-identical, 91 085 B, in all three runs.
- **Not measured:**
  - Segment put→notification (the P-2 update→notification on 0.2.136 was 38 ms p50).
  - The state size of a long session in a *growing* instance. Abstract-arch §23.8's first two gates
    are still open for a real segment contract.
- **Size:** at ≈ 0.8 % overhead, a segment's contract state is essentially its blocks. A per-segment
  instance of about 64 KiB is far under the P-5 bound tested so far.

## Hypercore internals touched (and how fragile each is)

| where | symbol | used for | fragility |
|---|---|---|---|
| `hypercore/lib/merkle-tree.js` | `MerkleTree.proof` → `generateProof`, `TreeProof#settle` | building every `data` answer from our node map | **High.** It's an internal API that expects a session shape (`fork`, `length`, `signature`, `prologue`) and an `rx.getTreeNode`. In 11.33.5 it is async; the first draft missed that. |
| `hypercore/lib/messages.js` | `wire.{handshake,sync,request,cancel,data,noData,want,unwant,bitfield,range,extension}`, `manifest` | the channel codecs, and the manifest in segment 0 | **High.** The wire format is protocol-versioned (`hypercore/alpha`), but the message *order* is copied from `Replicator#_makePeer` by hand |
| `hypercore/lib/caps.js` | `replicate(isInitiator, key, handshakeHash)` | the channel-open capability | Medium |
| `hypercore/lib/replicator.js` | `Replicator#_makePeer`, `Peer#onopen`, `Peer#onsync` / `closeIfIdle`, `Peer#_handleData`, `NOT_AVAILABLE = 1` | read only, to learn the behaviour we must satisfy: the sync flags (we claim `downloading: true` so the replica does not close the channel as idle), the capability check, and pausing on invalid data | **High.** It is behavioural, not a format |
| `hypercore/index.js` | `Hypercore#state.storage.read().getTreeNode`, `#state.signature`, `#manifest` | host-side export | Medium. Only the host needs these; a host could instead derive the nodes from `Hypercore#proof` (public). |
| `flat-tree`, `hypercore-crypto` | `iterator`, `fullRoots`, `leftSpan`, `children`, `parent`; `data`, `parent`, `discoveryKey` | node numbering and recomputing nodes | Low. These are small, stable, public modules |

- **What the stored bytes depend on.** The exported record depends only on things a signed
  Hypercore tree already commits to: node index, size, BLAKE2b hash and the manifest-v1 signature.
  An upgrade that keeps the tree hash format keeps old records valid.
- **What an upgrade can break.** The fragile part is the *virtual peer* (the protocol and internal
  API), not the stored bytes. It needs a pin and a test on every `hypercore` bump.
- **Scope.** The probe covers `store.log` only. `store.metaCore` would need the same treatment.

## Recommendation

**Open A as a follow-on project. Do not open B now.**

1. The central risk is resolved on 11.33.5: "a replica accepts blocks only through replication
   from a peer". An in-process peer that is not a Hypercore fills a key-only replica from exported
   bytes. Every block verifies, a tampered block is refused, and the viewer path does not change:
   `remote.store.log` stays a Hypercore replica, so A-11, `_scheduleRemoteHistoryDownload` and the
   player stay untouched.
2. The bytes survive a real contract round trip unchanged, and the proof overhead is small: ≈ 0.8 %
   per 64 KiB, plus an index record of ≈ 0.6 KiB per segment for random access.
3. The follow-on must carry:
   - **Pin.** An exact `hypercore` pin, and a contract test that runs this probe's scenarios on
     every bump. That test is the fragility guard.
   - **Tree index.** A tree-index record per segment, or segments aligned to power-of-two block
     counts, so that sparse seek works.
   - **Contract.** A binary segment contract instead of the JSON probe contract. It must also meet
     abstract-arch §23.8's open gates: segment put→notification latency and growing-state size.
   - **Invalid segments.** Handle a segment that fails verification: drop it and reopen the
     channel.
   - **Encryption.** A decision on who encrypts segments. Blocks are already sealed by
     `SessionStore`, but the tree nodes and sizes are public.
   - **`metaCore`.** The same treatment for `metaCore`.
4. B remains the fallback if a `hypercore` upgrade breaks the virtual peer in a way a patch cannot
   follow.
