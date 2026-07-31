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

- **pnpm `11.18.0`** via `"packageManager"` in `package.json` (corepack and
  `pnpm/action-setup` both read it - no per-workflow `version:`). `scripts/mac-setup.sh`
  derives the major from the same field.
- **node `24.x`** via `.nvmrc` + advisory `engines` (a warning, not a hard block,
  on newer node). One toolchain everywhere, the agent harness included.

First-time setup on a clean clone:

```bash
corepack enable      # makes `pnpm` honor packageManager (pins to 11.18.0)
pnpm install         # build scripts are pre-approved (pnpm-workspace.yaml)
./scripts/dev.sh
```

Any pnpm 10+ self-switches to the pin before it does anything else, so a fresh
clone installs correctly even without `corepack enable`. A global pnpm 9 does not
self-switch, and installs only because it predates build approvals and runs the
scripts anyway - `corepack enable` is what puts it on the pin. Don't commit a
lockfile-only drift.

**Build-script approvals live in `pnpm-workspace.yaml`, as `allowBuilds:` keyed by
package** (`esbuild: true`), never a list. This shape is load-bearing: the older
`pnpm.onlyBuiltDependencies` block in `package.json` is ignored from pnpm 11 on, a
list under `allowBuilds` is rejected by both pnpm 10 and 11, and the list form of
`onlyBuiltDependencies` works on 10 but not 11 - the keyed map is the only form
valid on both majors (verified against the 10.34.5 and 11.18.0 release tarballs,
one isolated store per case). On the pinned pnpm 11 getting it wrong is loud: it
exits 1 with `ERR_PNPM_IGNORED_BUILDS` naming the packages, so it cannot merge
green. Do not generalise that to pnpm 10, which **exits 0 and simply does not run
the build scripts**. Nothing in CI asserts the approval shape, so on any pnpm
other than the pin a wrong shape is silent - verify an install actually builds
esbuild rather than reading the exit code.

`pnpm-lock.yaml` stays at `lockfileVersion: '9.0'`; pnpm 11 accepts it under
`--frozen-lockfile` and does not rewrite it.

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
pnpm typecheck:playwright                                 # e2e-playwright specs + IPC mock (CI smoke-job gate)
pnpm test:mock-contract                                    # IPC mock <-> generate_handler! contract (CI smoke-job gate)
pnpm exec vitest run                                      # vitest unit + component (CI check-job gate; plain "pnpm test" watches and never exits locally)
pnpm test:ui
pnpm lint:e2e-parallel                                    # Playwright parallel-safety (CI smoke-job gate)
pnpm lint:pw-timing:test                                  # Playwright timing-reporter fixtures (CI smoke-job gate)
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

`src-tauri/bindings/` is generated too, but by a *different* mechanism: it falls
out of `cargo test` (ts-rs turns each `#[ts(export)]` into an `export_bindings_*`
test), not out of `pnpm gen:ipc-types`, whose output directory is hardcoded to
`src/types/ipc`. Nothing imports that tree - it exists only as ts-rs's default
export target - but it *is* committed, so CI's `check` job fails if `cargo test`
leaves it dirty. Never hand-edit it either; run the Rust tests and commit what
they write. See [docs/ipc-typegen.md](docs/ipc-typegen.md) for the full picture,
including the one drift shape the gate cannot see.

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
| [Testing Guide](docs/TESTING.md) | Which tier a test belongs in, and the UI testability requirements |
| [Testing Recipes](docs/testing-recipes.md) | Commands per tier, Playwright/WebdriverIO/Rust/vitest patterns, mock conventions, troubleshooting |
| [Linting & Format Policy](docs/linting.md) | Rust clippy/rustfmt CI gates, the anti-AI-slop policy, the per-test-module `#[expect]` idiom, considered-but-deferred lints |
| [Architecture](docs/architecture.md) | State flow, command pattern, key files, Rust patterns |
| [Project Structure](docs/project-structure.md) | Directory tree, tech stack |
| [Configuration](docs/configuration.md) | Config file locations, options, logging |
| [Saving](docs/saving.md) | Save pipeline, auto-save, undo persistence, atomic writes |
| [Inclination convention](docs/inclination.md) | Pitch is +down everywhere; where each importer normalises, and the v12 migration |
| [SpeleoDB dev testing](docs/speleodb-dev-testing.md) | Dev box env vars, the superuser test account, env-gated self-seeding live tests, verified v2 API contract |
| [Roadmap](docs/roadmap.md) | v1.0 phases, PRDs, backend changes |
| [Telemetry](docs/telemetry.md) | Event reference, source tracking, adding telemetry to new features |
| [IPC Type Generation](docs/ipc-typegen.md) | How IPC TS types are generated and updated |
| [Performance](docs/performance.md) | Algorithm choices, renderer cost model, profiling guide |
| [Debug Gates](docs/debug-gates.md) | Where dev-only logs / asserts / profile harnesses live, and how to turn them on |
| [macOS Build](docs/macos-build.md) | macOS build scripts and known issues |
| [Agent Harness](docs/agent-harness.md) | LLM-agent harness (MCP + WebdriverIO) to drive the real app: tools, oracles, stress scenarios, replay + repro reports. Runs on the repo-pinned Node. |
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
| [Touch support](docs/touch-support.md) | What touch/pointer support exists, the long-press paths, and the verified gaps |
