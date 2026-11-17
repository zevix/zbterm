# Notes and context

## The user's list (2026-11-15, verbatim)

1) When CTRL-Q is pressed and the terminal is not in focus, brin a popup with Quit, Cancel, Send ^Q to the terminal
2) Save pinned sessions after quiting
3) when hovering the terminal / view icon of the session info box, change the icon to almost-white (dark) or almost-black (light theme) drag icon and allow changing the order of the sessions. For that add another field of "manual sort psaudo time" that will be used to override the time for sorting and will be set to the middle betwen the session before and after sort time (or first / last -/+ 42 mins)
4) apply the policy of not auto-resuming sessions also in normal out-of-search CTRL-PgUp etc navigation, and in both cases also add Enter as a key to resume the session into the terminal
5) simplify the relay story: eliminate zbterm-reay-registry-publish - automatically publish from zbterm-relay, if seed is not passed write an info message and write it into ~/.zbterm/relay-seed; same for key and ~/.zbterm/relay-key; if files exist and got different env values - do not override them and write notes; if files exist and no env passed - validate and use them; in zbterm settings menu add below STUN ... an option "ZBTerm relay key" where the user can paste it and it will be saved

Answer, Ctrl+Q with the terminal focused: "Send ^Q to terminal" (it is an ordinary key there; quitting goes through the popup).

## Readings taken (defaults, open to the user)

- Item 2: a repro on today's build (`repro_pins.sh`: pin, Ctrl+Q, restart) keeps the pin. The user's
  scenario (2026-11-15): "I lose pins when I change the AppImage version I use." Cause found in the code:
  `refreshSessions()` prunes every pin whose session is not in the list it just got, and writes the
  pruned list back. Any list that is empty or partial for a moment (a first start of a new version
  while the engine is still opening the catalog, a refresh fired by an event before the profile's pins
  were loaded, a profile switch where the old profile's pins meet the new profile's list) wipes the
  saved pins for good. Fix: no pruning on refresh at all (a pin of a missing session is only hidden);
  a pin goes only by unpin or by deleting the session; pins are written only after they were read for
  the current profile.
- Item 3: the list is newest first, so "top" is first + 42 min and "bottom" is last − 42 min. `sortAt`
  overrides the last start time for good: a resumed session no longer jumps to the top once dragged.
- Item 4: Enter in the search box steps through matches today; it resumes only while the resume toast
  for the session shows.
- Item 5, superseded by the user's two-key model (2026-11-15): a relay secret that never leaves the box
  (`~/.zbterm/relay-secret`) and a rotatable public access key, the public key of the key pair derived
  from the secret and a salt in `~/.zbterm/relay-access`; the relay listens on it, so rotating the salt
  cuts off holders of the old key. Users paste the access key. Env wins over a differing file for that
  run. The registry: a private relay never publishes its access key there (anyone can read the
  record). The built-in default relay still has to keep its registry record alive (DHT mutable records
  expire), so `zbterm-relay` publishes its access key to the registry only when `ZBTERM_REGISTRY_SEED`
  is set: that is the maintainer's official relay; no separate program.

## Proposals (the user approved P3–P6 on 2026-11-15, now R19–R22; P1 is moot under the two-key model, P2 left for later)

- P1 Settings field accepts a raw relay public key too: if no registry record is found under the
  pasted key, use it as the relay key directly (covers keys printed by older relays).
- P2 Invites carry the host's relay key: a viewer joining a host that uses a private relay gets it
  from the link, without configuring anything. Needs an invite-format field (contract change).
- P3 A relay status line in the settings field / Share dialog: "relay found / not published / in use
  now", from `/share/diagnostics`.
- P4 `zbterm-relay --print-key` (prints the paste line and exits) and `--check` (validates the files).
- P5 A systemd unit example in README, and the relay warning on start when the UDP port is not
  reachable from outside (probe through a second DHT node).
- P6 Fix the stale comment that places `REGISTRY_PUBLIC_KEY` in `engine/share-manager.js`.
