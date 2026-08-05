# Agent harness (e2e/agent)

An LLM-agent-driven harness that drives the **real** Tauri app through
WebdriverIO (`tauri-driver` -> WebKitWebDriver -> the debug binary). It exists so
an agent can interactively test, stress, and explore the app, observe its state,
and turn a discovered bug into a repro report and a replayable spec.

See **[docs/agent-harness.md](../../docs/agent-harness.md)** for the full design,
tool reference, and troubleshooting.

## Runtime: the repo-pinned Node

The harness runs on whatever `.nvmrc` pins (Node 24), like the rest of the repo -
`nvm use` is enough. An earlier note here required Node 22 and blamed a
webdriverio undici-vs-built-in-fetch mismatch; that is not what the code does and
session creation works on both 22 and 24. See
[docs/agent-harness.md](../../docs/agent-harness.md).

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

- `createSession.ts` - picks the platform session (Linux and macOS; an
  unsupported platform is refused here, by name, instead of timing out on a
  driver).
- `sessionTypes.ts` - `AgentSession`: the session surface every consumer uses.
- `session.ts` - AppSession (Linux): build check, Xvfb, tauri-driver, the
  `remote()` attach, crash detection, process-group teardown.
- `sessionMac.ts` - MacSession (macOS): tauri-wd + the in-app WebDriver plugin
  (`--features e2e` build), always headed, pidfile-reap teardown. See the
  macOS section of `docs/agent-harness.md`.
- `lib/platform.ts` - the ONE target-platform selector (honors
  STALAGMIGHT_AGENT_PLATFORM).
- `lib/sessionCore.ts` - platform-neutral half: state machine, command mutex,
  recorder + owner marker, isolated profile, orphan reaping, crash markers.
- `lib/sessionShared.ts` - the attach + readiness (hook verification) steps.
- `lib/build.ts` - build freshness (source mtimes + the E2E build stamp beside
  the binary) + `pnpm tauri build --debug` with VITE_E2E=1.
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
