# Terminal Sharing Application Requirements

## 1. Purpose and status

This document defines the product and functional requirements for a secure,
distributed terminal-sharing application. It is the requirements baseline for
the Rust rewrite of ZBTerm.

The requirements intentionally do not prescribe a JavaScript runtime, desktop
shell, terminal component, database, replication library, peer-to-peer stack,
discovery system, relay implementation, or cryptographic library. Concrete
technology choices belong in the new architecture and implementation plans.

Normative language is used as follows:

- **MUST** and **MUST NOT** identify required behavior.
- **SHOULD** and **SHOULD NOT** identify a strong default that may be changed
  only for a documented reason.
- **MAY** identifies optional behavior.
- **TBD** identifies an unresolved product or security decision.

## 2. Product goals

The application MUST:

1. Start and display an interactive operating-system terminal.
2. Record terminal output and terminal resize events as encrypted session
   history.
3. Allow a host to share an active session with one or more authorized viewers.
4. Let viewers receive a current terminal frame quickly and then follow live
   output.
5. Let authorized users replay available history, seek through it, and continue
   viewing live output without interrupting the host or other viewers.
6. Let the host control who may join and who may send terminal input.
7. Support multiple isolated local profiles and multiple concurrent sessions.
8. Preserve useful offline playback when the host is unavailable, subject to
   authorization and key-retention policy.
9. Remain usable across unreliable networks, duplicate delivery, reconnects,
   partial history availability, process failure, and application restart.
10. Expose a stable automation and diagnostics interface in addition to the
    graphical UI.

## 3. Terms and roles

- **Profile:** an isolated local data root containing account state, device
  state, preferences, session catalog, encrypted history, indexes, snapshots,
  and network identity/configuration.
- **Session:** one logical terminal lifetime. An ended session may later be
  extended while retaining its identity and earlier history.
- **Host:** the device that owns the live terminal process and is the
  authoritative writer of the session.
- **Viewer:** an authorized device receiving live output and/or history.
- **Input user:** a viewer currently authorized to send terminal input.
- **Session admin:** the host, or in a future version a delegated identity,
  authorized to manage links, viewers, and permissions.
- **Local session:** a session hosted by the current profile.
- **Joined session:** a session hosted elsewhere and joined by the current
  profile.
- **Live mode:** the current terminal state and subsequent live output.
- **Playback mode:** a historical view reconstructed from recorded packets.
- **Epoch:** one generation of session encryption keys.
- **Snapshot:** a derived terminal-state checkpoint used to accelerate joining
  or seeking. A snapshot is not the canonical history.
- **Share link/key:** a bearer invitation that contains or identifies the
  secret and routing material needed to request access.
- **Direct invite:** an invitation addressed to a known identity, contact, or
  group rather than an anonymous bearer link.

The authorization model MUST support these independent capabilities:

| Capability | Meaning |
| --- | --- |
| View live | Receive and decrypt current live terminal output |
| Read history | Retrieve and decrypt authorized recorded history |
| Quick catch-up | Receive a bounded bootstrap snapshot and recent diffs |
| Send input | Send protected terminal input to the host |
| Administer | Manage joins, links, viewers, and policies allowed to an admin |

## 4. Architecture-neutral system requirements

### 4.1 Runtime and trust boundaries

1. The user-interface layer MUST NOT directly own long-term private keys,
   replicated storage, distributed-transport sockets, or unrestricted terminal
   process handles.
2. Privileged terminal-process operations and the distributed session engine
   SHOULD be separated by a narrow, versioned, session-addressed interface.
3. The terminal-process owner MUST validate every requested operation against a
   known live session.
4. Network-facing parsing, replication, authorization, and cryptography MUST be
   isolated from the UI. The precise process/thread/service boundary is an
   implementation decision.
5. Commands, replies, state events, high-volume terminal data, and terminal
   lifecycle events MUST preserve causal ordering. If more than one transport
   channel is used internally, the implementation MUST explicitly reconstruct
   that ordering.
6. High-volume terminal data SHOULD use a binary representation and MUST avoid
   unnecessary text encoding or repeated copies.
7. The UI-facing contract MUST use a stable request/reply command model and an
   asynchronous event stream so that the engine can be replaced without
   redesigning the UI.

### 4.2 Engine command families

The engine interface MUST provide equivalent operations for:

- session create, open, close, delete, rename, list, input, resize, acknowledge
  processed output, enable/disable HD timing, remove HD timing, clear history,
  and extend;
- player open, seek, play, pause, change speed, and step;
- profile list, create, select, rename, and deletion of an unused empty profile;
- identity/account inspection and device listing/revocation;
- share-link create/list/revoke, member revoke, join, approve, deny, input-mode
  change, and diagnostics;
- durable preference get/set;
- application health, version, current selection, and debug state.

Names and wire formats MAY differ in the Rust implementation, but equivalent
semantics and structured errors MUST be retained.

### 4.3 Storage abstraction

1. The host MUST be the only writer of canonical session history and canonical
   session metadata.
2. The distributed storage layer MUST support an authenticated append-only
   history and authenticated structured metadata, or an equivalent design with
   the same single-writer and integrity properties.
3. Viewers MAY replicate/cache encrypted data but MUST NOT mutate canonical host
   history.
4. Storage MUST permit sparse or lazy retrieval of history ranges.
5. Key envelopes MUST be stored separately from encrypted output packets.
6. Local playback snapshots and sequence-to-time indexes MUST be treated as
   rebuildable caches.
7. Local snapshots MUST be encrypted to the local device or profile.
8. A profile MUST have a durable session catalog that can be read without
   loading every session log.
9. A session identifier MUST be cryptographically bound to the canonical
   history identity or authenticated session manifest.
10. Deleting a session MUST stop its live/join activity, close readers and
    writers, delete its local encrypted store and snapshots, and remove its
    catalog entry.
11. Truncating host history MUST update the canonical history length, clear its
    canonical timeline, invalidate local snapshots, and notify connected
    viewers. It cannot force a viewer to delete blocks or plaintext already
    replicated or observed, and the UI MUST disclose that limitation.

### 4.4 Distributed transport abstraction

1. The transport MUST provide mutually authenticated encrypted connections or
   an application layer with equivalent peer authentication and confidentiality.
2. The application MUST verify that the connected host identity matches the
   identity bound into the invitation before sending viewer identity data.
3. A host MUST route a connection using authenticated session/link identifiers,
   not unauthenticated discovery metadata.
4. One physical connection MAY carry multiple sessions and MAY carry both host
   and viewer relationships. Authorization and state MUST therefore be scoped
   at least to `(connection, session/link)`, not only to the connection.
5. Direct connectivity SHOULD be attempted first. A privacy-preserving relay or
   other fallback MAY be raced after a configurable delay.
6. A relay MUST NOT need terminal plaintext or session keys.
7. The live protocol MUST tolerate reconnection, duplicates, delayed packets,
   and out-of-order delivery.
8. Every protected message MUST be bound to its session, sender/device, epoch,
   message type, and sequence/counter as applicable.
9. History replication MAY begin before approval only when all replicated
   content is encrypted and no readable key material is released before
   authorization.
10. Transport diagnostics SHOULD expose connection phase, direct/fallback path,
    remote identity, retry timing, and failure category without exposing
    secrets.

## 5. Profile, account, and device requirements

1. On startup, if no usable profile is selected, the application MUST show a
   profile picker.
2. Only one running process may own a profile at a time. Different profiles MAY
   run concurrently.
3. A profile already owned by another process MUST remain visible in the picker
   but disabled and labeled as running.
4. The profile picker MUST display profile name, last-used time when available,
   and Open/Running state.
5. A user MUST be able to create a named profile from the picker and open it
   immediately.
6. Profile creation MUST support either:
   - creating a new user identity and first device; or
   - adding the device to an existing identity using a short-lived,
     single-use add-device credential.
7. Each user MUST have a long-term identity key. Each device MUST have a
   distinct key and an identity-signed device attestation.
8. Device state MUST distinguish active and revoked devices.
9. Revoking a device MUST prevent future account/session material from being
   sent to it and MUST trigger required future session/group key rotation.
10. Active devices belonging to the host's own user identity MAY discover and
    join that user's sessions without a public link or manual approval, but the
    host MUST verify device attestation and revocation state first.
11. The application MUST provide device management that lists active and
    revoked devices, creates add-device credentials, and revokes devices.
12. An add-device credential MUST be one-time and expiring. The joining device
    MUST generate its own local keys, prove possession of the credential, and
    receive an identity/device attestation plus only the account material
    needed by that profile.
13. Same-user devices SHOULD replicate a private session catalog so a user can
    discover sessions hosted on their other active devices. Catalog visibility
    does not itself grant session keys.
14. Profile preferences MUST be durable and isolated per profile unless a
    setting is explicitly defined as application-global.
15. The window title SHOULD include the application name, selected profile, and
    enabled local debug endpoint.

## 6. Session lifecycle and terminal requirements

### 6.1 Creating and running a session

1. Creating a session MUST allocate canonical encrypted history, metadata,
   catalog state, and a live terminal process before presenting the session as
   ready.
2. The default session name SHOULD be
   `<operating-system user> @ <host> [(profile)] #<monotonic local number>`.
3. The terminal MUST start with the currently fitted columns and rows. A
   fallback size MAY be used before layout is known.
4. Output MUST be rendered locally with low latency while the same bytes are
   queued for encrypted canonical history and authorized live viewers.
5. Terminal resize events MUST be recorded in order and replayed.
6. Terminal output packets MUST be numbered from 1 and include, either directly
   or through authenticated metadata, version, epoch, sequence, timestamp,
   packet kind, terminal dimensions where relevant, HD state, and ciphertext.
7. Packet kinds MUST support at least data, resize, and future markers.
8. Input keystrokes MUST NOT be stored as a separate input log. The resulting
   terminal output remains recordable.
9. On terminal exit, buffered output MUST be flushed before final session state
   is committed. The session becomes recorded/offline and the UI automatically
   opens playback if it was displaying the live session.
10. Sessions that appeared active before an unclean engine start MUST be marked
    ended unless their terminal processes are positively recovered and
    reattached.

### 6.2 Output batching, HD mode, and flow control

1. Normal recording MAY coalesce output to reduce packet and storage overhead.
2. HD mode MUST use shorter batching intervals and smaller boundary thresholds
   so playback preserves finer output timing.
3. Toggling HD MUST take effect without restarting the session, be represented
   in subsequent packets, propagate to viewers, and be visible in the UI.
4. Removing HD timing MUST be available only for ended, locally owned sessions
   that contain HD packets. It MUST preserve terminal content while replacing
   or normalizing high-resolution timing.
5. Backpressure MUST propagate to the terminal process when unacknowledged UI
   output or an internal transport buffer exceeds a bounded threshold.
6. The UI MUST acknowledge processed terminal bytes even when a non-selected
   session receives data, preventing hidden sessions from permanently blocking
   their terminal processes.
7. When pressure falls below the recovery threshold, the terminal process MUST
   resume.
8. Output accumulated while a network write is in progress MUST be sent as soon
   as that write completes.

### 6.3 Terminal interaction

1. The terminal MUST support text selection in live mode and forced selection
   while playback is paused.
2. Its context menu MUST provide:
   - Copy when text is selected;
   - Copy All for the active terminal buffer; and
   - Paste only when terminal input is currently permitted.
3. Middle-click paste MAY be supported on platforms where it is conventional.
4. Dropping files onto an input-enabled terminal MUST insert shell-quoted local
   paths, separated by spaces. Dropping files when input is blocked MUST not
   navigate away from or replace the application.
5. File paths MUST be quoted so whitespace and single quotes are preserved for
   a conventional shell. Support for non-shell terminal applications is TBD.
6. After toolbar or dialog operations, focus SHOULD return to the terminal so a
   user does not accidentally activate the last clicked button with a keypress.
7. `Ctrl+PageUp` and `Ctrl+PageDown` SHOULD cycle through selectable sessions.
8. Tab handling MUST avoid moving focus into controls while terminal input is
   intended. Accessibility implications and an alternative keyboard-navigation
   mode are TBD.

### 6.4 Extending and deleting sessions

1. An ended locally owned session MAY be extended. A joined session MUST NOT be
   extended locally.
2. Extension MUST reconstruct the last terminal grid, reopen a terminal with
   the last dimensions, append future packets to the same canonical history,
   and mark the session live again.
3. Rename MUST update the local catalog and authoritative session metadata and
   propagate the new name to connected viewers.
4. Delete History MUST require confirmation and remove locally retained
   recorded history/caches according to the session's ownership and retention
   policy. For a locally owned session, it MUST truncate the host's canonical
   history and timeline; it MUST NOT be represented as secure erasure from
   viewers that already received the data.
5. Delete Session MUST require confirmation and remove the session, active join
   relationship, playback handles, snapshots, local store, and catalog entry.
6. Deleting a still-pending join MUST cancel and remove the pending UI entry.

## 7. Terminal state, snapshots, and playback

1. The canonical history is the ordered packet sequence, not a sequence of
   screenshots.
2. Terminal state MUST be reconstructed by applying data and resize packets in
   order to a compatible terminal-state emulator.
3. Live bootstrap MUST contain a current terminal frame and the sequence from
   which subsequent live diffs continue.
4. Local snapshots SHOULD be generated periodically based on both elapsed time
   and output volume.
5. Seeking MUST:
   - find the nearest usable snapshot at or before the target;
   - restore it;
   - decrypt and apply remaining packets up to the target; and
   - atomically replace the visible terminal with the reconstructed frame.
6. If no snapshot exists, playback MUST reconstruct from the beginning.
7. Playback MUST preserve timing, resize events, dimensions, styling/control
   sequences, alternate screens, cursor state, and HD timing where recorded.
8. Only one active player SHOULD consume heavy reconstruction resources per
   profile; opening another session MAY close the previous player.
9. Playback controls MUST include previous packet, play/pause, next packet,
   empty-time compression, seek, current/total time, and selectable speed.
10. Supported speeds MUST include 0.5×, 1×, 2×, 4×, and 8× unless the new UI
    provides a strict superset.
11. Starting playback at the end of an ended session SHOULD restart from the
    beginning.
12. Playback MUST stop cleanly at the last available packet and update control
    state.
13. For an active session, stepping backward or seeking away from the end MUST
    enter playback without affecting the live host or other viewers.
14. Moving the active-session scrubber to its end MUST return to live mode.
15. Each session's last playback position SHOULD be retained while the
    application remains open.
16. Seeking while playing MUST pause data application, reconstruct the selected
    frame, then resume when appropriate.
17. Repeated drag seeks MUST be debounced and stale seek results MUST NOT
    overwrite newer selections.
18. Horizontal wheel/touchpad motion over the timeline or terminal SHOULD seek;
    Shift+vertical-wheel MAY provide the same behavior.
19. The hover/drag tooltip MUST show the selected elapsed time. When empty time
    is compressed, it SHOULD show both compressed and real elapsed time.
20. Empty-time compression MUST map long inactive gaps to a bounded duration
    while preserving packet order. Toggling it during playback MUST preserve the
    same real timestamp.
21. The timeline MUST visually distinguish, where data is available:
    - output activity and relative activity level;
    - viewer socket/live activity;
    - locally available joined history;
    - history still downloading or missing; and
    - significant idle regions.
22. Active-session total duration MUST advance with wall-clock time.
23. Playback of already authorized and locally available history MUST work
    without a live host connection.

## 8. Sharing and joining

### 8.1 Link types

1. The UI MUST support single-use and group share links.
2. A single-use link MUST allow at most one successful viewer authorization and
   then become consumed.
3. A group link MUST define a maximum concurrent viewer count. The supported
   range MUST include at least 2 through 99.
4. A session admin MUST be able to increase a group link's limit later.
5. Each link MUST record type, limit, capabilities, approval policy, creation
   time, consumed state, revocation state, and current viewer count.
6. A link MAY auto-approve eligible viewers or require manual approval.
7. The current UI defaults single-use links to automatic join and group links
   to approval required.
8. The link creator MUST be able to choose whether the generated invitation is
   copied automatically.
9. Invitations MUST be validated for scheme/version, required routing material,
   expected host identity, and link identifier before a connection is
   attempted.
10. Invitations MUST expire or be explicitly configured for indefinite use.
11. Share links MUST be revocable. Revocation MUST reject future joins and
    rotate keys when required to protect future output.

### 8.2 Join protocol

The join flow MUST:

1. Decode and validate the invitation without disclosing local identity.
2. Pin or otherwise bind the expected host identity before dialing.
3. Establish an authenticated encrypted connection directly or through an
   opaque fallback transport.
4. Verify the connected host against the invitation.
5. Route the request to the intended link/session.
6. Send an identity proof, device attestation, device name/metadata, requested
   capabilities, and proof of invitation possession.
7. Validate link state, capacity, expiry, consumption, revocation, identity,
   device, and requested capabilities.
8. Enter auto-approval or notify an admin of a pending approval.
9. On approval, register membership, grant only authorized past history,
   rotate to a new epoch, and send a device-sealed key envelope.
10. Send session metadata, input mode, live bootstrap, history/timeline
    references, and subsequent live diffs according to capabilities.
11. Expose joining states to the UI: connecting, approval pending, syncing,
    joined, failed, and host unavailable.
12. Remove failed pending joins from the session list and present a structured,
    actionable error.

### 8.3 Initial state and background history

1. A newly authorized viewer with live capability MUST see the current live
   terminal as soon as the bootstrap is verified; full history download MUST
   not block the live reveal.
2. Timeline metadata SHOULD be transferred in bounded chunks.
3. Useful snapshots SHOULD be transferred in bounded batches, prioritizing
   coverage over redundant density.
4. Authorized history MUST download progressively in bounded ranges while live
   viewing continues.
5. Availability changes MUST update the playback timeline.
6. Playback operations on a joined session MUST refresh the known timeline and
   available length so a long-open player does not remain frozen at its initial
   history boundary.
7. Joined snapshots MAY be built or backfilled locally as history becomes
   available.

### 8.4 Quick catch-up

1. A session MAY enable quick catch-up with a configurable maximum size in KB.
2. A viewer with the Quick catch-up capability MAY request recent output up to
   that bound.
3. Quick catch-up MUST start with a snapshot followed by ordered diffs.
4. Quick catch-up is a transport optimization and MUST NOT replace canonical
   history.
5. Whether authorized peers other than the host may serve catch-up remains TBD.

### 8.5 Direct contact and group invites

1. A session MAY be shared by direct invitation to an accepted contact or a
   group in which the inviter is a current member.
2. A direct invite MUST use the same authenticated join, capability, and key
   distribution rules as a link join.
3. A group invite MUST expand to per-user/per-device authorization; it MUST NOT
   act as a permanent bearer credential.
4. Later group membership changes MUST cause explicit session grants or
   revocations and key rotation where confidentiality changes.
5. Users who are neither a direct contact nor a member of a shared group may
   still join through an appropriate bearer link.

## 9. Identity, contacts, and groups

1. Contact discovery MAY use an exact identity code, an invite, or an
   explicitly published discovery card.
2. Contact relationships MUST require acceptance.
3. A locally private contact MUST never be disclosed through
   contacts-of-contacts discovery.
4. Contacts-of-contacts search MUST reveal only cards explicitly published for
   that purpose; it MUST NOT implicitly expose a social graph.
5. Any user MAY create a group and invite accepted contacts.
6. Group membership and admin changes MUST be authenticated by the actor and
   distributed only to current group members.
7. A group admin MAY add eligible contacts, subject to acceptance, and remove
   members.
8. Any group member MAY leave unilaterally.
9. Full contacts and groups management UI is a future requirement described in
   §18.

## 10. Encryption, integrity, and key lifecycle

1. Terminal output and history MUST be encrypted at rest and in transit.
2. Live traffic and persisted history MUST use separate keys or keys derived
   with unambiguous domain separation.
3. Every stored output packet MUST use authenticated encryption.
4. Associated authenticated data MUST bind at least session, epoch, sequence,
   packet/message type, and authoritative sender device.
5. Input MUST be encrypted specifically to the host device and MUST include
   session, epoch, sender identity/device proof, and a monotonic replay counter.
6. The host MUST reject input with the wrong session, epoch, sender, proof,
   capability, policy state, or non-increasing counter.
7. Session epoch keys MUST rotate when a member joins, is revoked, or has an
   access change that affects confidentiality.
8. Epoch master keys MUST be generated by the authoritative host.
9. Key envelopes MUST be sealed independently to each authorized recipient
   device.
10. A live-only device MUST not receive history keys. A history-only device
    MUST not receive live keys unless also authorized for live view.
11. A newly joined authorized user MAY receive explicitly granted prior history
    keys before the new epoch is created.
12. Removed or revoked users/devices MUST NOT receive new epoch keys.
13. Revocation protects future epochs. The product MUST NOT claim it can erase
    plaintext a viewer has already observed or copied.
14. Unknown storage/protocol versions, invalid authentication tags, missing key
    material, or inconsistent sequence/epoch metadata MUST fail closed.
15. No plaintext terminal output, history, or input may be written to
    distributed storage.
16. Local plaintext caches MUST be minimized, scoped, and clearable.

## 11. Input authorization

1. Input modes MUST support:
   - host only;
   - no viewers;
   - all authorized viewers; and
   - selected users/devices.
2. Input MAY additionally require approval by the host, current controller,
   both, or neither.
3. Input is sent only to the authoritative host and MUST never be replicated as
   a viewer-input history.
4. The host MUST be able to revoke input immediately.
5. The current UI exposes Host/Local versus Shared-for-all. Selected-user and
   controller approval modes require future UI.
6. Enabling all-viewer input MUST require an explicit warning confirmation.
7. If the last confirmed viewer disconnects, all-viewer input SHOULD
   automatically return to host-only.
8. A joined viewer may paste, drop file paths, or type only when the session is
   active, the UI is in live mode, the viewer has Send input capability, and
   the current input policy permits it.
9. Typing while input is blocked in live mode MUST flash the keyboard control
   red.
10. Typing while in playback MUST flash both the keyboard and Live controls red
    and MUST NOT send the key.

## 12. Screenshot-indexed UI requirements

The following list is retained as-is from the numbered UI review. Numbers refer
to the supplied screenshots; number 33 was absent and number 58 was reused. The
historical `xterm.js` wording in item 3 identifies what the screenshot showed;
it is not a technology requirement for the Rust rewrite.

1. **Developer diagnostics toggle** — opens or hides the developer terminal diagnostics view.
2. **Theme and version area** — gear toggles the visual theme; the current ZBTerm version is displayed beside it.
3. **Terminal font controls** — increase or decrease the xterm.js font size.
4. **Share session** — opens the sharing workflow for the active hosted session.
5. **Keyboard/input mode** — “Local” means only the host can type; this later changes to “Shared.”
6. **HD recording mode** — enables higher-detail terminal timing during recording.
7. **Extend session** — resumes or extends an eligible recorded session as a new live terminal.
8. **Live mode** — shows that the active session is being viewed live or returns from playback to live output.
9. **Step backward** — moves playback to the previous recorded event.
10. **Play/Pause** — starts or pauses recorded-session playback.
11. **Step forward** — moves playback to the next recorded event.
12. **Collapse empty time** — removes or restores inactive gaps in the playback timeline.
13. **Playback scrubber/timeline** — seeks through recorded terminal history; indicators show recorded/available regions.
14. **Playback playhead** — the draggable marker representing the selected playback position.
15. **Current and total time** — displays playback position versus session duration.
16. **Playback speed** — selects speeds such as 0.5×, 1×, 2×, 4×, or 8×.
17. **Rename** — changes the selected session’s display name.
18. **Delete History** — removes the selected session’s recorded history.
19. **Remove HD** — strips HD timing information from an eligible recording.
20. **Delete session** — deletes the complete session entry after confirmation.
21. **No-session welcome/splash area** — displayed when no session is selected.
22. **ZBTerm branding** — application icon and product name.
23. **New session** — creates and starts a new local PTY-backed terminal session.
24. **Join session** — opens the workflow for joining a shared session.
25. **Session search** — filters the session history by search text.
26. **Active-session filter** — toggles between all sessions and active sessions only.
27. **Session list entry** — shows the session name, live/recorded state, start time, sharing state, and recorded size.
28. **Session-state icon** — visually distinguishes active/live sessions from recorded sessions and other sharing states.
29. **Profile picker** — selects which isolated ZBTerm profile/data directory to open.
30. **Open profile** — launches the selected available profile.
31. **Create profile** — creates a profile using the entered name.
32. **Running profile state** — disables a profile already owned by another ZBTerm process and labels it “Running.”
33. **Not present** — no callout numbered 33 appears in the supplied screenshots.
34. **Share Session dialog** — opened from the Share toolbar action.
35. **Single-use link option** — creates a link allowing one viewer.
36. **Group link option** — creates a link allowing multiple viewers.
37. **Maximum-users input** — sets the capacity of a group sharing link.
38. **Require approval to join** — makes each join request wait for host approval.
39. **Auto Copy preference** — automatically copies the generated share key to the clipboard.
40. **Selected group capacity** — demonstrates a group link configured for up to four viewers.
41. **Group-link identity warning** — warns that the current implementation cannot reliably identify who is joining through a group link.
42. **Enabled group-link preferences** — shows both approval-required and Auto Copy selected.
43. **Share key** — generated `zbterm://join/...` invitation URI.
44. **Share-key clipboard controls** — Auto Copy preference and the manual Copy button.
45. **Copied confirmation** — indicates that the invitation URI was successfully copied.
46. **Join Session dialog** — accepts a ZBTerm invitation URI.
47. **Paste button** — reads a join URI from the clipboard.
48. **Join-key input** — field containing the `zbterm://join/...` URI.
49. **Auto Paste preference** — automatically fills the join field from the clipboard.
50. **Join action** — validates the URI and begins the authenticated peer-to-peer join flow.
51. **Join approval prompt** — asks the host whether to approve the named requesting device/viewer.
52. **Approval identity warning** — repeats the warning about unverifiable group-link identities.
53. **Deny request** — rejects the pending viewer join request.
54. **Approve request** — authorizes the viewer and delivers the permitted session material.
55. **Joined-viewer icon** — the eye icon identifies a live session joined as a viewer rather than hosted locally.
56. **Viewer Live control** — returns a joined viewer from historical playback to the current live frame.
57. **Joined-session playback position** — shows that a viewer can seek backward through authorized history while the session remains live.
58. **This number is used twice in the screenshots:**
    - The bracketed toolbar shows controls unavailable or restricted for a joined viewer, including host-only sharing, input-policy, HD, and extension actions.
    - The second occurrence is the confirmation dialog for allowing all viewers to control the terminal keyboard.
59. **Share Keyboard** — confirms switching the input policy from host-only to all viewers.
60. **Host “Shared” keyboard state** — shows that viewer input has been enabled.
61. **Shared-keyboard session icon** — the red keyboard icon in the session list indicates that viewers may type.
62. **Viewer “Shared” keyboard state** — tells the joined viewer that terminal input permission is available while live.
63. **Playback input-blocked feedback** — pressing a terminal key during playback flashes the Shared and Live controls red, indicating that playback is read-only and the viewer must return to Live before typing.

## 13. Detailed UI behavior

### 13.1 Application shell and preferences

1. The application MUST provide a dark and light theme. The selected theme MUST
   persist for the profile and update terminal colors immediately.
2. The version MUST be visible without opening a separate About dialog.
3. Developer diagnostics MAY replace the idle splash with an interactive
   status terminal. Its enabled state MUST persist.
4. Right-clicking the developer toggle SHOULD reveal the idle diagnostics
   surface immediately.
5. When developer diagnostics are disabled and no session is selected, the UI
   MUST show the branded welcome surface.
6. Status text at the bottom MUST report startup phases, selected operation,
   share/join progress, playback state, copy results, and structured errors.
7. Controls MUST be hidden or disabled when invalid for the selected session,
   ownership role, or live/playback state. Disabled host-only controls MUST not
   invoke engine commands for joined sessions.
8. An available application update SHOULD surface an Update action and clear
   progress states while applying/restarting. The distribution mechanism is
   implementation-specific.
9. Window position, normal size, maximized state, and display/resolution context
   MUST be stored per profile and restored on the next launch. Restored bounds
   MUST be clamped to a currently visible display.
10. Concurrent windows using different profiles MUST retain independent window
    state.

### 13.2 Session sidebar

1. Sessions MUST be sorted newest-first by start or most recent extension time.
2. Search MUST update results as the user types.
3. The All/Active toggle MUST update its text, pressed state, and list query.
4. The complete product UI MUST also provide an ownership filter for My versus
   All sessions. The activity and ownership filters MUST compose with search.
5. Empty states MUST distinguish “No sessions yet” from “No matching sessions.”
6. Each row MUST show:
   - an ownership/state icon;
   - name;
   - live, recorded, joining, or approval-pending state;
   - joined state where applicable;
   - viewer count when sharing;
   - human-friendly start time; and
   - locally retained size.
7. Icons or badges MUST distinguish at least:
   - locally hosted live terminal;
   - remotely joined live viewer;
   - locally hosted session with shared keyboard;
   - locally hosted shared session;
   - recorded/offline session; and
   - pending join.
   Shared-with-others state SHOULD remain visible independently of live versus
   recorded state, and permission to type SHOULD have its own indicator.
8. Selecting a live session MUST open its current frame and live stream.
9. Selecting an ended session MUST open playback.
10. Selecting a pending join MUST keep the terminal in a pending surface and
   show Connecting, Waiting for host approval, or Syncing initial frame.
11. Expanding a session row MUST show connected viewers, pending approval
    requests, input-control state, recording state, and link settings.
12. A compact session selector MAY replace or supplement rows at narrow window
    widths.
13. Session actions MUST be available through an overflow button and a context
    menu. The menu MUST remain within the window bounds and close on outside
    click or Escape.
14. Session timestamps SHOULD display time for today, weekday/time within the
    last week, month/day/time within the current year, and date/year for older
    entries.
15. Session sizes SHOULD use human-readable binary units.

### 13.3 New, select, rename, extend, and delete operations

1. New MUST create a terminal immediately using the fitted grid, refresh the
   list, select the new session, and focus the terminal.
2. Rename MUST prompt with the current name, reject an empty result, update all
   visible metadata, and propagate to viewers.
3. Extend MUST be enabled only for an ended, locally owned session.
4. Delete History MUST be disabled for pending and joined sessions unless the
   future retention model explicitly permits deleting only the viewer's local
   copy.
5. Remove HD MUST be enabled only when the session is ended and contains HD
   timing.
6. Delete MUST remain available for pending, local, and joined entries, with
   ownership-appropriate cleanup.
7. Destructive operations MUST state the target session name and require
   confirmation.

### 13.4 Sharing dialog

1. Share MUST be visible and enabled only for a locally hosted active session
   in live mode.
2. The dialog MUST present single-use and group cards with plain-language
   capacity descriptions.
3. Selecting Group MUST default Require approval to enabled.
4. The maximum-user numeric input MUST clamp to the supported range and update
   the group description immediately.
5. Auto Copy MUST be a durable preference.
6. The unauthenticated-group warning MUST become visually prominent whenever a
   group bearer link lacks reliable user authentication.
7. Submitting MUST show a non-blocking Sharing progress state and prevent
   duplicate submissions.
8. The ready state MUST show the full invitation in a selectable read-only
   field, select it by default, and provide Done and Copy actions.
9. Copy MUST change to Copied or Copy failed based on the actual clipboard
   result.
10. Cancel, Escape, and clicking outside the modal MUST close it without
    creating a link, except once creation has already been committed.
11. Link management UI MUST eventually list active links, viewer counts,
    capacity, policy, consumption/revocation state, and provide revoke/update
    operations.

### 13.5 Join dialog and pending states

1. Join MUST open a modal with Paste, invitation input, Auto Paste, Cancel, and
   Join.
2. Paste MUST read only a valid application invitation from the clipboard.
3. Auto Paste MUST be durable and MUST synchronize the field when enabled.
4. The field MUST accept application deep links delivered by the operating
   system in addition to manual entry.
5. Invalid, missing, or unsupported invitations MUST fail before identity
   disclosure and show an authorization-format error.
6. Submitting MUST create a temporary pending session row immediately so
   progress remains visible while connecting.
7. Approval-pending and initial-sync state MUST be visible in both status text
   and the terminal overlay.
8. A successful join MUST replace the temporary row with the real joined
   session and reveal the live frame.
9. Failure MUST remove the pending row, clear the pending terminal, and preserve
   other sessions.

### 13.6 Approval and keyboard dialogs

1. Approval prompts MUST identify the requesting device or viewer and target
   session.
2. Group-link prompts MUST display the identity-confidence warning.
3. Deny and Approve MUST map to distinct authenticated engine actions and
   update status text.
4. Enabling shared keyboard MUST present a danger-styled confirmation explaining
   that all eligible viewers can control the terminal.
5. The input control label MUST be:
   - Local for a host-only active local session;
   - Host for a joined session whose host has not shared input;
   - Shared when viewer input is enabled; and
   - Offline for an ended session.
6. Host and viewer Shared states MUST have visually distinct styling.
7. The session-list icon MUST change to a keyboard while a locally hosted
   session allows viewer input.

### 13.7 Terminal sizing and live/playback layout

1. A locally hosted live terminal MUST fit the available window and send
   resulting rows/columns to the terminal process.
2. Manual font controls MUST adjust the live grid within defined minimum and
   maximum sizes and trigger a terminal resize.
3. Joined live frames and playback frames MUST preserve the host/recorded grid;
   the UI SHOULD choose the largest font that fits without changing the
   recorded rows/columns.
4. Playback resize packets MUST resize the visible grid at the correct point.
5. Window resizing MUST recalculate available terminal height after accounting
   for the top toolbar and playback/status footer.
6. The terminal surface MUST remain one persistent focus target across splash,
   live, and playback modes to minimize focus and renderer churn.

## 14. Automation, debug console, and observability

1. The application MUST expose an optional loopback-only automation API.
2. The API MUST use structured requests and responses and MUST never bind to a
   non-loopback interface without explicit authentication and user consent.
3. The debug port MUST be configurable and, as a future improvement, have a
   per-profile default.
4. The API MUST provide equivalent operations for:
   - health/readiness, version, identity, account, local device, and devices;
   - recent structured events;
   - session list/create/get/select/live/input/resize/extend;
   - share create/list/revoke and approval approve/deny;
   - player open/seek/play/pause/step;
   - join;
   - share/transport and input-pipeline diagnostics;
   - get/set window bounds;
   - renderer layout and terminal display inspection; and
   - generic invocation of documented engine commands.
5. UI modal state and actions MAY be inspectable/controllable for end-to-end
   automation, but production builds SHOULD require an explicit debug mode.
6. Debug output MUST redact private keys, link secrets, plaintext terminal
   content unless explicitly requested locally, and protected input.
7. A future interactive debug console MUST expose the same command surface as
   the loopback API.
8. Diagnostics MUST distinguish network failure, authorization failure, missing
   key material, corrupted history, host unavailable, invalid input state,
   profile lock conflict, storage failure, and internal failure.

## 15. Reliability and recovery

1. Privileged terminal processes SHOULD survive a recoverable session-engine
   crash.
2. During engine restart, terminal output MAY be buffered only up to a bounded
   cap; pressure beyond that cap MUST pause the terminal process or fail safely.
3. A restarted engine MUST recover catalog/store state, report recognized live
   sessions, reattach only those terminal processes, replay buffered output in
   order, and terminate unrecognized orphan processes.
4. Restart attempts MUST use bounded retry/backoff and MUST surface a fatal
   engine error rather than crash-loop indefinitely.
5. In-flight connections and join approvals MAY be lost on an engine restart
   until automatic reconnect is implemented.
6. Storage writes that finalize, delete, or rotate keys MUST wait for earlier
   queued appends to settle.
7. Races between multiple connection paths for the same joined session MUST be
   deduplicated so only one local store owner is created.
8. Deleting a joined session MUST unregister it before tearing down storage so
   late replication messages become harmless no-ops.
9. The application MUST never display a session-close event before earlier
   terminal data for that session has been processed or explicitly discarded.

## 16. Security and privacy requirements

1. The UI MUST make join approval state, viewer count, input permission,
   sharing state, recording state, and host/viewer role visible.
2. A bearer invitation MUST display the session name and claimed host
   username/hostname before the viewer is encouraged to send sensitive input.
3. The product MUST warn that a malicious host can display a fake login prompt
   and capture viewer keystrokes when keyboard control is shared.
4. Reuse of a one-time invitation MUST be detected and reported.
5. If an invitation associated with a known intended user is presented by a
   different identity, the host MUST be warned and the join MUST require an
   explicit policy decision.
6. Secrets MUST never appear in ordinary diagnostics, crash reports, or
   telemetry.
7. The UI MUST not overstate identity assurance. Anonymous bearer links,
   first-contact keys, accepted contacts, external identity providers, and
   same-user devices MUST be labeled with their actual assurance level.
8. Sensitive-session clients cannot technically be forced to forget keys or
   plaintext. The UI MUST clearly disclose this limitation.
9. Clipboard operations involving invitation secrets SHOULD provide clear
   success/failure state and SHOULD support clearing or expiry policies in a
   future version.
10. All destructive and security-sensitive actions MUST identify their scope
    and require confirmation proportional to risk.

## 17. Current non-goals and open decisions

### 17.1 Current non-goals

- Multi-host execution of one terminal process.
- Replicated storage of viewer keystroke history.
- Claiming retroactive erasure of plaintext already observed by a viewer.
- Relying on socket access alone as authorization.
- Requiring one specific distributed database, network, UI toolkit, or relay.
- Requiring a centralized account or session service for core operation.

### 17.2 Open decisions

- Exact distributed transport, discovery, replication, and relay architecture.
- Exact cryptographic primitives, envelope format, and key derivation.
- Whether non-host admins may rotate keys and under what consensus policy.
- Whether history grants may be limited by time or packet range.
- Whether quick catch-up may be served by authorized peers.
- Retention semantics of Delete History for hosts versus viewers.
- Accessibility-compatible keyboard navigation while keeping terminal focus.
- Meaning and UX of the incomplete “Authentication via” roadmap item.
- Whether password/key redaction should conceal length and layout as well as
  characters.

## 18. Future planned improvements

The following items are requirements or feature ideas for later milestones.
They are not claims about the current implementation.

### 18.1 Contacts and invitation authentication

- Provide full contacts management in the UI: search/discovery, incoming and
  outgoing requests, acceptance, removal, privacy marking, safety-number/key
  display, groups, membership, and direct session invites.
- Use first-key sending for initial authentication. The exact meaning,
  key-continuity behavior, trust-on-first-use warnings, reset detection, and
  recovery workflow are TBD and require a security design.
- TBD — integration with Keet for user invites and authorization.
- Clearly distinguish anonymous bearer links, first-contact identities,
  verified contacts, same-user devices, SSH-authenticated identities, and
  external-provider identities.

### 18.2 Administration and revocation

- Support additional session admins with scoped capabilities, auditable admin
  actions, and a defined rule for key rotation.
- Expose user and device revocation in the UI, including current access,
  affected sessions/groups, confirmation, future-key rotation, and the
  limitation that previously seen plaintext cannot be recovered.
- Add manual disconnect for individual viewers, all viewers on a link, or all
  viewers in a session. Disconnect and revoke MUST remain distinct operations.
- Support sensitive sessions in which viewers do not persist historical or
  live epoch keys. Viewers must request keys from the host when needed, enabling
  theoretical retroactive revocation after disconnect. The UI MUST warn that a
  modified client can retain keys or plaintext.

### 18.3 Reconnect and catch-up

- Add an automatic reconnect option with bounded exponential backoff, explicit
  connecting/offline state, host re-authentication, authorization revalidation,
  epoch reconciliation, duplicate suppression, and ordered catch-up.
- Let the user or session policy choose whether reconnect automatically
  requests catch-up, returns directly to the current live frame, or stays
  offline.
- Add Manual disconnect and “do not reconnect” controls for viewers and hosts.

### 18.4 Secret-leakage reduction

- Add best-effort prevention of displaying passwords, private keys, access
  tokens, recovery phrases, and other likely secrets.
- Allow detected secrets to be replaced with `***` or a stable, colorful,
  easy-to-recognize representation that lets users distinguish repeated values
  without revealing them.
- Detection/redaction MUST happen before output is sent to viewers or persisted
  if it is intended to protect recordings; display-only masking is insufficient.
- Redaction MUST preserve terminal control sequences and must not corrupt the
  terminal state.
- TBD: whether masking must hide the original secret length.
- TBD: how to prevent length/layout leakage when replacement changes column
  widths, especially in indented tables, aligned output, progress UIs, and
  cursor-addressed applications.
- The feature MUST be described as best effort and MUST not claim complete
  prevention.

### 18.5 Optional daemon

- Provide an optional background daemon for advanced, long-running features.
- Support cross-device access by the same user and by additional explicitly
  authorized devices.
- Allow authorized devices to attach to existing terminal multiplexers or
  equivalent persistent terminal sessions.
- Support detached/no-hangup sessions that continue after the desktop UI exits.
- The daemon MUST use the same identity, authorization, encryption, recording,
  input-control, and audit requirements as desktop-hosted sessions.
- Daemon privileges, operating-system account isolation, service installation,
  and unattended key protection require a separate threat model.

### 18.6 Application and server log collection

- Allow ZBTerm to operate as an add-on for other desktop and server
  applications that collect or emit logs.
- A log-source adapter MUST define framing, timestamps, source identity,
  retention, redaction, backpressure, and whether input/control is possible.
- Read-only log sources MUST never expose terminal-input controls.
- Multiple sources SHOULD be distinguishable within a session or collected into
  separately authorized sessions.

### 18.7 Additional authentication layers

- Add an optional stricter authentication layer based on SSH keys.
- Allow access to another user device to be authorized using an SSH key when
  the device is directly reachable, reducing setup friction.
- Allow a policy that accepts new users only after authentication by one or
  more configured external identity providers, including SSH.
- Add authentication based on GitHub account keys. The exact source of truth,
  key-discovery endpoint, account-binding proof, revocation/rotation handling,
  and protection against a compromised GitHub account are TBD.
- External authentication MUST supplement, not replace, per-device session key
  delivery, capability checks, and revocation.

### 18.8 Small UI and quality-of-life improvements

- Add an interactive debug console with the same commands as the loopback
  automation server.
- Flash the keyboard button red when the user tries to type while the keyboard
  is not shared.
- Flash both the Keyboard and Live buttons red when the user tries to type in
  playback mode.
- Store a per-profile default debug-server port and detect/report conflicts.
- Retain and improve the existing per-profile window-state behavior: save the
  last position, size, display, and maximized/full-screen state and restore them
  safely. If the saved display is unavailable, the window MUST be moved into
  the visible area of an available display.
- Allow the same user identity in multiple profiles on one machine for
  different multi-window layouts while preserving independent profile locks,
  preferences, catalogs, and local caches.
