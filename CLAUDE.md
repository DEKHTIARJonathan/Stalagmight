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
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Production build | `pnpm tauri build` |

## Critical Rules

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
cargo test --manifest-path src-tauri/Cargo.toml
```

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
| [Roadmap](docs/roadmap.md) | v1.0 phases, PRDs, backend changes |
| [IPC Type Generation](docs/ipc-typegen.md) | How IPC TS types are generated and updated |
| [Performance](docs/performance.md) | Algorithm choices, profiling guide, optimization history |
| [macOS Build](docs/macos-build.md) | macOS build scripts, Scaleway remote builds, known issues |
