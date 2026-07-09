# e2e/agent/replays

Curated, committed regression replays generated from agent sessions. A replay is
a WebdriverIO spec that re-executes a recorded session (using the `resolved`
selectors/coordinates the harness captured) to reproduce a bug deterministically.

## Generate + run

```bash
# from a session under .agent-artifacts/sessions/<id>/
node scripts/generate-replay.mjs <sessionDir> --assert-final --out e2e/agent/replays/<name>.spec.ts

# run it (Node 22)
REPLAY_SPEC=e2e/agent/replays/<name>.spec.ts pnpm test:e2e:replay
```

`test:e2e:replay` uses `wdio.replay.conf.ts` (the base wdio config, single
instance, no retries). With no `REPLAY_SPEC` it runs everything here.

## What to commit here

Only durable repros worth keeping as regression tests: deterministic (re-run
green twice), leak-scanned (no `$HOME`/personal paths - the generator scrubs
reports, but check the spec), and minimal. Uncommitted/exploratory replays stay
in their session dir under `.agent-artifacts/` (gitignored).

These specs use wdio ambient globals (`browser`/`$`) and are typechecked by
`tsconfig.e2e.json`, not `tsconfig.agent.json` (which excludes this dir).
