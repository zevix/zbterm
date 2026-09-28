# Questions and assumptions

- **Q-1** (answered 2026-09-19 by the owner): give up the OTA updater to remove the dependency → `D-07`.
- **A-1** The updater is dropped only from builds without the Pear backend.
- **A-2** Non-Pear builds get no replacement update channel in this project.
- **A-3** The Tabby plugin follows the core it resolved; its host uses the same spawn helper if it spawns through `pear-runtime` today.
