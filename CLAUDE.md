# CaveChef

Tauri desktop app for processing underwater cave survey data (Rust backend + React/TypeScript frontend).

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

### Dev Server

Always use `./scripts/dev.sh` to restart the dev server (handles process cleanup).

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
| [Roadmap](docs/roadmap.md) | v1.0 phases, PRDs, backend changes |
