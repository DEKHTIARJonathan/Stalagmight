# Stalagmight

Tauri desktop app for processing underwater cave survey data (Rust backend + React/TypeScript frontend).

It is year 2026. No em-dashes: write an ASCII hyphen instead, instead of '—' use '-'. This covers the
hyphen, non-breaking hyphen, figure dash, en dash, em dash, horizontal bar and
minus sign (U+2010..U+2015,U+2212). Box-drawing 
characters in ASCII diagrams are fine.

## Quick Reference

| Task | Command |
|------|---------|
| Install deps | `pnpm install` |
| Dev server | `./scripts/dev.sh` |
| Type check | `pnpm tsc --noEmit` |
| Playwright tests | `pnpm test:ui` |
| Rust tests (Linux/macOS) | `TELEMETRY_ENDPOINT=http://localhost/dummy cargo test --manifest-path src-tauri/Cargo.toml --features telemetry` |
| Rust tests (Windows) | `./scripts/test.ps1` |
| Production build | `pnpm tauri build` |

## Critical Rules

### Pinned Toolchain - enable corepack

The toolchain is pinned so every machine + CI runs the same versions:

- **pnpm `9.15.9`** via `"packageManager"` in `package.json` (corepack and
  `pnpm/action-setup@v4` both read it - no per-workflow `version:`).
- **node `22.x`** via `.nvmrc` + advisory `engines` (a warning, not a hard block,
  on newer node).

First-time setup on a clean clone:

```bash
corepack enable      # makes `pnpm` honor packageManager (pins to 9.15.9)
pnpm install         # build scripts are pre-approved (pnpm.onlyBuiltDependencies)
./scripts/dev.sh
```

Without `corepack enable`, a globally-installed **pnpm 11** hard-fails
`pnpm tauri dev` on a fresh clone (its stricter deps check rejects unapproved
build scripts - issue #109). Don't commit a lockfile-only drift. Coordinated
pnpm/node upgrades are a deliberate, separate change (Phase 2).

### Never Use `cd` in Bash Commands

The shell session persists working directory changes, causing commands to run from wrong locations. This has caused files to be created in `src-tauri/src-tauri/` and committed to git.

```bash
# BAD - persists directory change
cd src-tauri && cargo check

# GOOD - use manifest path
cargo check --manifest-path src-tauri/Cargo.toml

# GOOD - subshell isolates change
(cd src-tauri && cargo check)
```

### Pre-Push Checklist

All must pass before pushing:

```bash
pnpm tsc --noEmit
pnpm typecheck:agent                                      # agent-harness typecheck (CI check-job gate)
pnpm exec vitest run                                      # vitest unit + component (CI check-job gate; plain "pnpm test" watches and never exits locally)
pnpm test:ui
pnpm lint:e2e-parallel                                    # Playwright parallel-safety (CI smoke-job gate)
pnpm lint:rust-file-size                                  # Rust file-size ratchet (CI check-job gate)
pnpm lint:ts-file-size                                     # TS file-size ratchet (CI check-job gate)
pnpm lint:private-leaks                                   # no internal/personal refs in the public tree (CI leak-scan gate)
pnpm lint:readonly-gates:test && pnpm lint:readonly-gates # read-only gating tripwire (CI check-job gate)
pnpm lint:no-em-dash:test && pnpm lint:no-em-dash        # Unicode-dash guard (CI leak-scan gate)
cargo fmt --manifest-path src-tauri/Cargo.toml --check   # exactly what CI's check job runs (run without --check to fix)
TELEMETRY_ENDPOINT=http://localhost/dummy cargo clippy --manifest-path src-tauri/Cargo.toml --features telemetry --all-targets   # deny-level lint gate
TELEMETRY_ENDPOINT=http://localhost/dummy cargo test --manifest-path src-tauri/Cargo.toml --features telemetry
```

Running full `pnpm test:ui` is not recommended as it is heavy. You must select
playwright tests relevant to the code and funcitonality changed/affected by the
changes made and run those selectively.

CI runs the Rust tests with `--features telemetry`, which gates the
registry-coverage tests (`registry_covers_all_*`). A plain `cargo test` filters
those out, so it can pass locally while CI fails; `build.rs` also requires
`TELEMETRY_ENDPOINT` to be set under that feature.

On **Windows**, run the Rust tests via `./scripts/test.ps1` (sets
`STALAGMIGHT_TEST_MANIFEST=1`). Without that env var, every `cargo test` harness
binary aborts at startup with `STATUS_ENTRYPOINT_NOT_FOUND` (`0xC0000139`)
before any test runs: the loader binds to comctl32 v5 (System32), which lacks
`TaskDialogIndirect` (statically imported via rfd / tauri-plugin-dialog). The
env var makes `build.rs` delay-load comctl32 for test binaries so the symbol is
never resolved at startup. The shipping app is unaffected (it gets a
Common-Controls v6 manifest from `tauri_build`).

### Pre-PR Review - required before every PR

Never open a PR (`gh pr create`, push-to-open, or marking ready) until the repository
pre-PR review has run at least once on the current change: `/pre-pr` in Claude Code or
`$pre-pr` in Codex. If it hasn't run, run it first and decline any request to skip it.
If the user states that the pre-PR review has already run, take them at their word and
proceed.

### Rust lints + formatting are CI-gated

The `check` job enforces **both** `cargo fmt --check` and `cargo clippy`
(deny-level) on `src-tauri`. The full policy - the strict anti-AI-slop clippy
config, the per-test-module `#[expect]` idiom (no `#[allow]`, no `clippy.toml`),
and which lints were deliberately deferred - is in
[docs/linting.md](docs/linting.md).

`cargo fmt` is the formatter for the **`src-tauri` crate**, enforced in CI: the
`check` job runs `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and
fails on any drift. Run `cargo fmt` to fix formatting before pushing; the
`--check` in the Pre-Push Checklist then passes. Config is `src-tauri/rustfmt.toml`
- stable rustfmt defaults, only `edition` pinned; do **not** add nightly-only keys
(they'd diverge local vs CI).

**Scope:** the gate formats only the `stalagmight` package. The separate
first-party `scripts/lib/slice-rs` helper crate and the vendored, locally-patched
`src-tauri/vendor/compass_data` path-dependency are **not** gated (vendored code is
left as-is on purpose) - don't assume `cargo fmt` touched them.

The crate was adopted into rustfmt in one mechanical commit (recorded in
`.git-blame-ignore-revs`, so `git blame` skips it - wire it locally once with
`git config blame.ignoreRevsFile .git-blame-ignore-revs`). If a `cargo fmt` diff
ever looks large, that's normal re-wrapping; the gate keeps it from drifting
again. (Idiomatic-Rust / clippy cleanup is tracked separately → #147.)

### Playwright Tests Require a Headless Environment

Only run `pnpm test:ui` when a display server is available or in a headless environment (e.g. `xvfb-run`). Do **not** run Playwright tests in a bare terminal without a display - they will fail.

### Dev Server

Always use `./scripts/dev.sh` to restart the dev server (handles process cleanup).

### IPC Types Are Generated

TypeScript IPC types are generated from Rust via `ts-rs`. Do **not** hand-edit or
create files under `src/types/ipc/` or `src/types/ipc.generated.ts`; run
`pnpm gen:ipc-types` and commit the regenerated output instead.

### Commit Early, Commit Often

Make small, frequent commits as you work. Don't accumulate large uncommitted changesets.
Do not wait for user to prompt for commits, make commits as you go.

### Changelog

Update `CHANGELOG.md` every time a new version is tagged.

## Documentation

| Document | Contents |
|----------|----------|
| [Docs index](docs/README.md) | Every page under `docs/`, grouped, with a contributor reading order |
| [SPEC.md](docs/SPEC.md) | **Full specification** - data model, UI design, workflows, file formats, validation rules |
| [Testing Guide](docs/TESTING.md) | Test commands, Playwright/WebdriverIO/Rust patterns, UI testability requirements |
| [Linting & Format Policy](docs/linting.md) | Rust clippy/rustfmt CI gates, the anti-AI-slop policy, the per-test-module `#[expect]` idiom, considered-but-deferred lints |
| [Architecture](docs/architecture.md) | State flow, command pattern, key files, Rust patterns |
| [Project Structure](docs/project-structure.md) | Directory tree, tech stack |
| [Configuration](docs/configuration.md) | Config file locations, options, logging |
| [Saving](docs/saving.md) | Save pipeline, auto-save, undo persistence, atomic writes |
| [Inclination convention](docs/inclination.md) | Pitch is +down everywhere; where each importer normalises, and the v12 migration |
| [Collaboration](docs/collaboration.md) | Ariane collab mode: sibling .tml, save-both, reconcile/diff, shot matching tiers |
| [Collab stress-testing](docs/collab-stress-testing.md) | Invariants, scenario matrix, adversarial inputs, fuzz/soak harness for the collab round-trip |
| [SpeleoDB dev testing](docs/speleodb-dev-testing.md) | Dev box env vars, the superuser test account, env-gated self-seeding live tests, verified v2 API contract |
| [Roadmap](docs/roadmap.md) | v1.0 phases, PRDs, backend changes |
| [Telemetry](docs/telemetry.md) | Event reference, source tracking, adding telemetry to new features |
| [IPC Type Generation](docs/ipc-typegen.md) | How IPC TS types are generated and updated |
| [Performance](docs/performance.md) | Algorithm choices, profiling guide, optimization history |
| [Debug Gates](docs/debug-gates.md) | Where dev-only logs / asserts / profile harnesses live, and how to turn them on |
| [macOS Build](docs/macos-build.md) | macOS build scripts and known issues |
| [Agent Harness](docs/agent-harness.md) | LLM-agent harness (MCP + WebdriverIO) to drive the real app: tools, oracles, stress scenarios, replay + repro reports. Runs under Node 22. |
| [App modes](docs/app-modes.md) | Survey/Plan/Export modes and the read-only contract every mutation path must check |
| [Loop closures](docs/closures.md) | Measured vs closure-adjusted display, the least-squares solve, co-location with the move tools |
| [Undo/Redo](docs/undo-redo.md) | Command-pattern undo: two-phase capture, `UndoData` variants, batch commands, persistence, lock ordering |
| [Move tools](docs/move-tools.md) | Move Station/Shot/Segment: scope, the shared drag-preview engine, Ctrl+drag panning, immovable stations |
| [Map renderer](docs/map-renderer.md) | The custom WebGL survey layers: tessellation, shaders, labels, incremental updates |
| [Gas planning](docs/gas-planning.md) | Plan mode's gas engine: gas-weighted reachability over the survey graph, turnaround and stage-drop points |
| [DMP import](docs/dmp-import.md) | The mNemo `.dmp` import wizard: phases, virtual connections, suggestion scoring, overlap handling |
| [Ariane import](docs/ariane-import.md) | Reading `.tml`/`.tmlu`: schema, topology reconstruction, unit conversion, azimuth semantics, limitations |
| [Ariane export](docs/ariane-export.md) | Writing `.tml`/`.tmlu`: data mapping, topology, color conversion, station-comment co-encoding |
| [Releasing](docs/releasing.md) | Changelog -> tag -> release: `scripts/release.sh`, the CI workflows, where version numbers live |
| [UI style guide](docs/style-guide.md) | Design tokens, typography, buttons, panels, tables, forms, accessibility |
| [macOS pan/zoom lockup](docs/debugging-macos-pan-zoom.md) | Postmortem of the macOS UI lockup, and how to re-enable the pan/zoom debug toolkit |
| [Touch support](docs/touch-support.md) | Pointer events and long-press handling for tablets. Dated - a rewrite is queued |
