# Test tiers

ZBTerm's checks come in three tiers, run by one script, `docs/acceptance/run.sh`, from one
index, `docs/acceptance/index.json` (asked by the user on 2026-11-13; built in
`docs/projects/261111_buffer-search/` fix round F2).

| tier | when | what | wall time |
|---|---|---|---|
| **sanity** | every change | `npm run lint`, every quick unit test file (45 files under ~3 s each, the known failures left out), and three short GUI checks against the packaged app: the search box and Ctrl+Shift+F (`bs/R1`), Ctrl+Shift+B never typed (`uc/U1`), Ctrl+Shift+T never typed (`st/U4`) | 73 s (2026-11-13, `-j 4`, with `--package`) |
| **topics** | what a change touches | sanity plus one or more topics: `search`, `chrome`, `keyboard`, `timeline`, `templates`, `sharing`, `identity`, `engine`, `build` (`run.sh --list`) | from ~1 min (`build`) to ~10 min (`search`) |
| **full** | before a release | lint, every test file under `test/`, every `R*`/`U*` script of every project kit | 905 s (2026-11-13, `-j 4`) |

```sh
docs/acceptance/run.sh --sanity --package     # package into the scratch dir, then sanity
docs/acceptance/run.sh --changed              # sanity + the topics the working tree's changes select
docs/acceptance/run.sh --changed main..HEAD   # the same for a commit range (anything git diff takes)
docs/acceptance/run.sh --topic search,keyboard
docs/acceptance/run.sh --full --package       # the release set
docs/acceptance/run.sh --list                 # topics, their scripts and tests
docs/acceptance/run.sh --changed --dry-run    # what would run, and why each file selects what
```

Options: `-j N` (parallel jobs, default 4), `--package` (`ZBTERM_FORGE_OUT_DIR=<out> npm run
package` first), `--out DIR` (the package under test, default `/tmp/claude-$UID/zbtiers/out`),
`--logs DIR` (default `/tmp/claude-$UID/zbtiers/runs/<stamp>-<tier>`; logs are kept), `--dry-run`.
It prints one line per item (`PASS`, `FAIL`, `CANNOT RUN`, `KNOWN`), the time of each phase and
a summary with the wall time; `results.txt` in the log dir holds the same lines. Exit 0 when
nothing failed.

## The index

`index.json` holds:

- `kits`: the project kits by short name (`bs` buffer-search, `uc` ui-chrome, `tf`
  timeline-fixes, `st` session-templates). A script id is `<kit>/<script>` (`bs/R7_stream_and_cancel`).
- `sanity`: `lint`, `tests`, `scripts`.
- `topics.<name>`: `about`, `seconds` (rough, sequential), `scripts`, `tests`, `paths` (files that
  select the topic) and `content` (`{file: regex}`: the topic is selected when a line the change
  added or removed in that file matches; this is how a change to `renderer/app.js`, one large
  file, selects only the topics it touches).
- `fallback`: for a changed file no topic claims, the topics to run (first matching pattern):
  an unclassified change in `renderer/` runs every renderer topic; `.md` and `docs/` run nothing
  beyond sanity.
- `serial`: scripts that time things (`bs/U3_responsive`, `bs/R7_stream_and_cancel`); they run
  alone, after the parallel ones.
- `known_failures`: test files that fail on this host before any of this work (`doctor`,
  `native-linkage`, `zxterm-seam`); a failure there is `KNOWN`, not `FAIL`, and they are not in
  sanity. Remove an entry once its file passes.

Patterns are bash `[[ == ]]` patterns, where `*` also matches `/`. A changed test file selects the
topics that list it. A new kit script or test file belongs in at least one topic (the full tier
finds it anyway, by globbing).

## How it runs

- GUI scripts are the project kits' own scripts, run as their `run_all.sh` runs them: each
  sources its kit's `activate` (its own scratch HOME, storage and `uisolate` display, a free debug
  port), with `ZBUI_OUT`/`ZBUI_APP` pointing at `--out`, a short `ZBUI_TMP` of this run and
  `ACCEPT_LOG_DIR` in the run's log dir. Each project's `run_all.sh` still works on its own.
- Test files run one per process (`brittle-node <file>`), each with its own scratch HOME and a
  short shared TMPDIR (`/tmp/zbtt<pid>`, under 20 characters for the SSH-agent socket). After the
  tests, processes whose command line carries that TMPDIR (the `zxterm-seam` fixture worker and
  its `zxterm-core`) are stopped; the PIDs are listed in `reaped.txt`.
- The short TMPDIRs `/tmp/zbtt<pid>`/`/tmp/zbtg<pid>` are left behind (`safe_delete` removes only
  paths under `/tmp/claude-$UID`); the scratch HOMEs are removed.

## Where `npm test` and lint fit

`npm run lint` is in every tier. `npm test` (all files in one brittle process) stops at
`zxterm-seam`'s crash on this host, so the tiers run the same files one per process instead:
sanity runs the quick ones, each topic its own, `--full` all of them.

## Measured

- 2026-11-13, host `zr`: `--sanity --package` 73 s (50 PASS). `--full` (`-j 4`) 905 s: 106 PASS, 3 KNOWN, 0 FAIL (test files 112 s, GUI scripts 789 s). Details:
  `docs/projects/261111_buffer-search/status--verifying.md` *Measured* (F2).
