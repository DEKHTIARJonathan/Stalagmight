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

## Quick start

```bash
# one-off session-core smoke (build check -> app -> screenshot -> crash oracle -> stop)
pnpm agent:smoke

# typecheck just the agent code
pnpm typecheck:agent
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
- `smoke.ts` - the non-MCP end-to-end smoke.

Session artifacts live under `.agent-artifacts/` (gitignored).
