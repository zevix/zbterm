# Improvements and fixes — phases (the HOW)

Brief per phase: AGENTS.md, one section below, `goal_requirements.md`, `baseline.md`, the status file.

## Conventions

npm only; tests one file per run, `HOME=<scratch> TMPDIR=<short>` (AGENTS.md *Commands*); lint =
`npm run lint`; every renderer/engine/main change is repackaged into `/tmp/claude-<uid>/zblive/out`
before a kit script runs. Logs under `/tmp/claude-<uid>/zbruns/` and the kit's own log dirs.

**Host.** This Linux box, with the tools in `acceptance/README.md` *Host*.

## Order

```
P0  baseline.md (suite, static test, R8 on the old build)   needs: —
P1  R1/U1 close confirmation (main process + setting)        needs: P0   (built 2026-11-21, first session)
P2  R2–R4, U2 search: cyan names, Esc, N/M in the status     needs: P0
P3  R5–R8 settings menu icons, Advanced, steady dialog       needs: P0
P4  R9–R12, U3, U4 Resume, profile menu, liveLinks           needs: P0
P5  R13 tests, README, CORE-CONTRACT note, package, kit      needs: P1–P4
```

## Phase P1–P4

**Covers / code map.** As `design.md` *Interface* (one row per requirement, `file::symbol`).
**Acceptance.** P1 `R1_close_confirm.sh`; P2 `R2_search_keys.sh`; P3 `R5_settings_menu.sh`,
`R8_dialog_steady.sh`; P4 `R10_profile_menu.sh`.
**Gotchas.** A closed `<details>` still gives its content a rect (R5 checks geometry); filtered
remote entries stay in the DOM, hidden (R8 checks heights); the native close box takes keys only
when focused (`xdotool windowfocus`); the main process's preferences live in Electron's userData.

## Phase P5

**Acceptance.** `R13_release.sh`, then `acceptance/run_all.sh` by a verifier in a fresh context, and
the full `npm test` with only `baseline.md`'s four failures.

## Do not

Publish, tag or release; edit `docs/decisions.md` rows; weaken an assertion or re-bless the golden
diagnostics test to get green (it is the baseline's, reported).
