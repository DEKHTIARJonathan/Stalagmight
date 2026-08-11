# e2e/agent/replays

Curated, committed regression replays generated from agent sessions. A replay
spec re-executes a recorded session step-by-step (using the `resolved`
selectors/coordinates the harness captured) to reproduce a bug
deterministically.

## Status (#549)

The WDIO runner that executed these (`test:e2e:replay` / `wdio.replay.conf.ts`)
was retired with the legacy suite. The corpus was empty at that point, so no
coverage was lost. `scripts/generate-replay.mjs` still emits a spec as the
precise, reviewable record of a session's steps; a harness-native replay
runner is the replay-corpus phase of #466 and will replace the WDIO one.

## What to commit here

Only durable repros worth keeping as regression records: deterministic,
leak-scanned (no `$HOME`/personal paths - the generator scrubs reports, but
check the spec), and minimal. Uncommitted/exploratory replays stay in their
session dir under `.agent-artifacts/` (gitignored).
