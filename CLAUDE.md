# Stalagmight

Tauri desktop app for processing underwater cave survey data (Rust backend + React/TypeScript frontend).

It is year 2026.

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

### Pinned Toolchain — enable corepack

The toolchain is pinned so every machine + CI runs the same versions:

- **pnpm `9.15.9`** via `"packageManager"` in `package.json` (corepack and
  `pnpm/action-setup@v4` both read it — no per-workflow `version:`).
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
build scripts — issue #109). Don't commit a lockfile-only drift. Coordinated
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
pnpm test:ui
cargo fmt --manifest-path src-tauri/Cargo.toml --check   # exactly what CI's check job runs (run without --check to fix)
TELEMETRY_ENDPOINT=http://localhost/dummy cargo test --manifest-path src-tauri/Cargo.toml --features telemetry
```

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

### Run `cargo fmt` — formatting is CI-gated

`cargo fmt` is the formatter for the **`src-tauri` crate**, enforced in CI: the
`check` job runs `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and
fails on any drift. Run `cargo fmt` to fix formatting before pushing; the
`--check` in the Pre-Push Checklist then passes. Config is `src-tauri/rustfmt.toml`
— stable rustfmt defaults, only `edition` pinned; do **not** add nightly-only keys
(they'd diverge local vs CI).

**Scope:** the gate formats only the `stalagmight` package. The separate
first-party `scripts/lib/slice-rs` helper crate and the vendored, locally-patched
`src-tauri/vendor/compass_data` path-dependency are **not** gated (vendored code is
left as-is on purpose) — don't assume `cargo fmt` touched them.

The crate was adopted into rustfmt in one mechanical commit (recorded in
`.git-blame-ignore-revs`, so `git blame` skips it — wire it locally once with
`git config blame.ignoreRevsFile .git-blame-ignore-revs`). If a `cargo fmt` diff
ever looks large, that's normal re-wrapping; the gate keeps it from drifting
again. (Idiomatic-Rust / clippy cleanup is tracked separately → #147.)

### Playwright Tests Require a Headless Environment

Only run `pnpm test:ui` when a display server is available or in a headless environment (e.g. `xvfb-run`). Do **not** run Playwright tests in a bare terminal without a display — they will fail.

### Dev Server

Always use `./scripts/dev.sh` to restart the dev server (handles process cleanup).

### IPC Types Are Generated

TypeScript IPC types are generated from Rust via `ts-rs`. Do **not** hand-edit or
create files under `src/types/ipc/` or `src/types/ipc.generated.ts`; run
`pnpm gen:ipc-types` and commit the regenerated output instead.

### Commit Early, Commit Often

Make small, frequent commits as you work. Don't accumulate large uncommitted changesets.

### Changelog

Update `CHANGELOG.md` every time a new version is tagged.

## Plans

Implementation plans are stored in `docs/plans/`.

## Documentation

| Document | Contents |
|----------|----------|
| [SPEC.md](docs/SPEC.md) | **Full specification** - data model, UI design, workflows, file formats, validation rules |
| [Testing Guide](docs/TESTING.md) | Test commands, Playwright/WebdriverIO/Rust patterns, UI testability requirements |
| [Architecture](docs/architecture.md) | State flow, command pattern, key files, Rust patterns |
| [Project Structure](docs/project-structure.md) | Directory tree, tech stack |
| [Configuration](docs/configuration.md) | Config file locations, options, logging |
| [Saving](docs/saving.md) | Save pipeline, auto-save, undo persistence, atomic writes |
| [Collaboration](docs/collaboration.md) | Ariane collab mode: sibling .tml, save-both, reconcile/diff, shot matching tiers |
| [Collab stress-testing](docs/collab-stress-testing.md) | Invariants, scenario matrix, adversarial inputs, fuzz/soak harness for the collab round-trip |
| [Roadmap](docs/roadmap.md) | v1.0 phases, PRDs, backend changes |
| [Telemetry](docs/telemetry.md) | Event reference, source tracking, adding telemetry to new features |
| [IPC Type Generation](docs/ipc-typegen.md) | How IPC TS types are generated and updated |
| [Performance](docs/performance.md) | Algorithm choices, profiling guide, optimization history |
| [Debug Gates](docs/debug-gates.md) | Where dev-only logs / asserts / profile harnesses live, and how to turn them on |
| [macOS Build](docs/macos-build.md) | macOS build scripts, Scaleway remote builds, known issues |
