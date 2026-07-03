# Agent harness (e2e/agent)

An LLM-agent-driven harness that drives the **real** Tauri app through
WebdriverIO (`tauri-driver` -> WebKitWebDriver -> the debug binary). It exists so
an agent can interactively test, stress, and explore the app, observe its state,
and turn a discovered bug into a repro report and a replayable spec.

See **[docs/agent-harness.md](../../docs/agent-harness.md)** for the full design,
tool reference, and troubleshooting.

## Runtime requirement: Node 22

The harness must run under the repo-pinned **Node 22** (`.nvmrc`). webdriverio 9's
HTTP layer is incompatible with Node >= 23 (fails at `POST /session` with
`UND_ERR_INVALID_ARG`). Use `nvm use` before running.

The agent-facing workflow is the `app-harness` skill
(`.claude/skills/app-harness/SKILL.md`).

## Quick start

```bash
pnpm agent:smoke        # session-core smoke (build -> app -> screenshot -> crash oracle -> stop)
pnpm agent:mcp:smoke    # MCP-layer smoke (spawn the server, round-trip every tool)
pnpm agent:scenarios    # run all 8 stress scenarios once at small n
pnpm typecheck:agent    # typecheck just the agent code
```

## Layout

- `session.ts` - AppSession: build check, isolated profile, tauri-driver, the
  `remote()` attach, hook verification, command mutex, crash detection, teardown.
- `lib/build.ts` - build freshness + `pnpm tauri build --debug` with VITE_E2E=1.
- `lib/procs.ts` - port probing + scoped (comm-verified) process reaping.
- `lib/recorder.ts` - per-session `.agent-artifacts/sessions/<id>/` + actions.jsonl.
- `lib/waiters.ts` - app-ready / ui-idle / map-idle waiters (browser-parameterized).
- `lib/stores.ts` - Zustand store reads/actions via `window.__E2E_TEST__`.
- `lib/logs.ts` - checkpointed ring-buffer reads via `get_recent_logs_since`.
- `lib/page.ts` - low-level page-context IPC/eval helpers.
- `lib/oracles.ts` - cheap + full problem sweeps (crash, logs, integrity, memory).
- `lib/replayHelpers.ts` - helpers imported by generated replay specs.
- `mcp/server.ts` - the MCP stdio server (`.mcp.json` -> `stalagmight-app`).
- `mcp/hygiene.ts` - stdout hygiene, imported before webdriverio.
- `mcp/smoke-client.ts` - MCP-layer smoke.
- `scenarios/` - 8 seeded stress scenarios + `framework`/`common`/`index` runner.
- `smoke.ts` / `scenarios-smoke.ts` - the non-MCP smokes.
- `replays/` - curated, committed regression replays (see its README).

Generators: `scripts/generate-replay.mjs`, `scripts/generate-repro-report.mjs`.
Session artifacts live under `.agent-artifacts/` (gitignored, 20 newest kept).
`e2e/agent/**` is CI `paths-ignore`d; `e2e/lib/**` is not (wdio.conf.ts uses it).
