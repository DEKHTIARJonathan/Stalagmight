# macOS Build

Three scripts handle building Stalagmight on macOS — locally or on a remote Scaleway Apple Silicon instance.

## Quick Start

### Local Mac

```bash
# One-time setup (idempotent)
bash scripts/mac-setup.sh

# Build + test
bash scripts/mac-build.sh

# Build + test with Playwright UI tests (headless)
bash scripts/mac-build.sh --test-ui

# Build + test with WebDriverIO E2E tests
bash scripts/mac-build.sh --test-e2e
```

### Remote Scaleway Build

```bash
# Full lifecycle: create/reuse instance → transfer → build → retrieve artifacts → cleanup
bash scripts/mac-remote-build.sh

# Include Playwright UI tests
bash scripts/mac-remote-build.sh --test-ui

# Include WebDriverIO E2E tests
bash scripts/mac-remote-build.sh --test-e2e
```

Artifacts are placed in `build/macos/`.

## Scripts Overview

| Script | Purpose |
|--------|---------|
| `scripts/mac-setup.sh` | Install dev tools on macOS (Xcode CLI, Homebrew, Node 22, pnpm 9, Rust, tauri-wd) |
| `scripts/mac-build.sh` | Run the full build pipeline (deps, tsc, cargo test, tauri build) |
| `scripts/mac-remote-build.sh` | Orchestrate a build on a Scaleway Apple Silicon cloud instance |

## `mac-setup.sh` — Dev Tool Installer

Installs all required development tools, skipping anything already present. Safe to run repeatedly.

### Tools installed

1. **Xcode Command Line Tools** — headless install via `softwareupdate`
2. **Homebrew** — standard installer if sudo is available, otherwise git-clones to `~/.homebrew`
3. **Node.js 22** — via `brew install node@22`, with PATH fix for keg-only installs
4. **pnpm 9** — via `npm install -g pnpm@9`, with CA cert fix for Homebrew's OpenSSL
5. **Rust stable** — via rustup
6. **tauri-wd** — via `cargo install tauri-webdriver-automation` (WebDriver for macOS E2E tests)

### Homebrew PATH detection

The script checks three Homebrew locations in order:

| Location | When used |
|----------|-----------|
| `/opt/homebrew/bin/brew` | Standard Apple Silicon install |
| `/usr/local/bin/brew` | Standard Intel install |
| `~/.homebrew/bin/brew` | No-sudo fallback install |

## `mac-build.sh` — Build Pipeline

Runs the complete build and test pipeline. Assumes `mac-setup.sh` has already been run.

### Options

| Flag | Description |
|------|-------------|
| `--project-dir <path>` | Override project root (defaults to parent of `scripts/`) |
| `--test-ui` | Install Playwright browsers + run headless UI tests |
| `--test-ui-headed` | Install Playwright browsers + run headed UI tests (needs display) |
| `--test-e2e` | Build debug binary with e2e feature + run WebDriverIO E2E tests |

### Build steps

1. `pnpm install` — install frontend dependencies
2. `pnpm tsc --noEmit` — TypeScript type check
3. `playwright install chromium` — install Playwright browsers *(only with `--test-ui*`)*
4. `pnpm test:ui` / `pnpm test:ui:headed` — Playwright tests *(only with `--test-ui*`)*
5. `cargo test` — Rust test suite (with `ulimit -n 4096`)
5a. `pnpm tauri build --debug --no-bundle -- --features e2e` — E2E debug binary *(only with `--test-e2e`)*
5b. `./scripts/wdio.sh --skip-build` — WebDriverIO E2E tests *(only with `--test-e2e`)*
6. `CI=true pnpm tauri build` — production build (`.app` bundle + `.dmg`)

### Build artifacts

| Artifact | Location |
|----------|----------|
| `.app` bundle | `src-tauri/target/release/bundle/macos/` |
| `.dmg` installer | `src-tauri/target/release/bundle/dmg/` |

### Playwright Tests

The `--test-ui` and `--test-ui-headed` flags add Playwright browser testing to the build pipeline. Only Chromium is installed (per `playwright.config.ts`).

| Mode | Flag | Display needed? | Notes |
|------|------|-----------------|-------|
| Headless | `--test-ui` | No | Works over SSH with no display server |
| Headed | `--test-ui-headed` | Yes | Requires a GUI session (e.g., VNC on Scaleway) |

On Scaleway instances with a VNC session running, headed mode can use the existing display. For headless mode, no display configuration is needed.

Test results (screenshots, traces on failure) are saved to `test-results/`. When using `mac-remote-build.sh`, this directory is automatically retrieved alongside build artifacts into `build/macos/test-results/`.

### WebDriverIO Tests

The `--test-e2e` flag runs WebDriverIO E2E tests against the Tauri app. On macOS, this uses `tauri-wd` (from the `tauri-webdriver-automation` crate) instead of `tauri-driver`, which only supports Linux/Windows.

#### How it works

1. The app is built with `--features e2e`, which compiles in `tauri-plugin-webdriver-automation` — a Tauri plugin that exposes W3C WebDriver protocol for WKWebView
2. `tauri-wd` is spawned as the WebDriver server (instead of `tauri-driver`)
3. WebDriverIO connects to `tauri-wd` and runs tests as normal

The `e2e` feature is gated behind a Cargo feature flag (`[features] e2e = [...]` in `Cargo.toml`), so it is **never compiled** in normal or release builds — zero impact on the production binary.

#### Prerequisites

- `tauri-wd` must be installed: `cargo install tauri-webdriver-automation` (handled by `mac-setup.sh`)

#### Artifacts

| Artifact | Location |
|----------|----------|
| Per-spec logs | `wdio-logs/` |

When using `mac-remote-build.sh --test-e2e`, the `wdio-logs/` directory is automatically retrieved into `build/macos/wdio-logs/`.

## `mac-remote-build.sh` — Scaleway Orchestrator

Manages the full lifecycle of a remote macOS build on Scaleway Apple Silicon infrastructure.

### Prerequisites

| Requirement | Details |
|-------------|---------|
| `~/.env` | Must contain `SCW_SECRET_KEY` and `SCW_DEFAULT_PROJECT_ID` |
| SSH key | `~/.ssh/id_ed25519` (registered on Scaleway as "anzu") |
| Local tools | `jq`, `curl`, `rsync`, `ssh` |

### Options

| Flag | Description |
|------|-------------|
| `--test-ui` | Pass through to `mac-build.sh` — run headless Playwright tests |
| `--test-ui-headed` | Pass through to `mac-build.sh` — run headed Playwright tests |
| `--test-e2e` | Pass through to `mac-build.sh` — run WebDriverIO E2E tests |

### Instance lifecycle

1. **Search** — scans Scaleway zones (`fr-par-1`, `fr-par-3`) for an existing `stalagmight-build` instance
2. **Reuse** — if found, unschedules any pending deletion and waits for `ready` status
3. **Create** — if no instance exists, selects the cheapest in-stock macOS server type and creates one
4. **Build** — transfers code via rsync, runs `mac-setup.sh` then `mac-build.sh`
5. **Retrieve** — downloads `.app` and `.dmg` artifacts to `build/macos/`
6. **Cleanup** — on exit (including errors/interrupts):
   - If the script created the instance: attempts to delete it, falls back to scheduling deletion
   - If reusing an existing instance: re-schedules deletion

### Code transfer

The rsync command uses `.gitignore` as a filter but overrides it to include test fixtures:

```bash
rsync -az --progress \
  --include='e2e/fixtures/*.stalx' \
  --filter=':- .gitignore' \
  --exclude='.git/' \
  ...
```

### Instance type selection

When creating a new instance, the script queries all available server types across both zones and selects the cheapest option using these heuristics:

- Skip types with `no_stock`
- Skip Linux OS types (only macOS)
- Pick the type with the smallest memory, breaking ties by smallest disk

### 24-hour minimum rental

Scaleway Apple Silicon instances have a 24-hour minimum rental period. The script handles this:

- **New instances** — if immediate deletion fails, uses the `schedule_deletion` API field
- **Reused instances** — unschedules deletion on start, re-schedules on exit

## Known Issues & Workarounds

| Issue | Cause | Workaround |
|-------|-------|------------|
| No-sudo Homebrew | Scaleway instances may lack passwordless sudo | `mac-setup.sh` git-clones Homebrew to `~/.homebrew` |
| Node.js not on PATH | `node@22` is keg-only in Homebrew | Scripts detect and prepend `$(brew --prefix node@22)/bin` to PATH |
| npm SSL certificate errors | Homebrew's source-built OpenSSL lacks CA bundle | `mac-setup.sh` sets `npm config set cafile` to Homebrew's `ca-certificates` bundle |
| DMG bundling hangs over SSH | Tauri's DMG bundler uses AppleScript (needs Finder GUI) | `mac-build.sh` sets `CI=true` which skips the AppleScript step |
| macOS `ulimit -n 256` | Default is too low for the Rust test suite | `mac-build.sh` raises to 4096 (falls back to 1024) |
| `directories` crate ignores XDG on macOS | Hardcodes `~/Library/Application Support/` regardless of `XDG_CONFIG_HOME` | 3 config/logging tests are gated to `#[cfg(target_os = "linux")]` |
| `pnpm --dir` broken for `exec` | `--dir` flag doesn't propagate to subcommands | Scripts use subshell `(cd $DIR && pnpm ...)` instead |

## Scaleway API Reference

The script uses the Scaleway Apple Silicon API (`/apple-silicon/v1alpha1`):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/zones/{zone}/servers` | GET | List existing instances |
| `/zones/{zone}/servers` | POST | Create new instance |
| `/zones/{zone}/servers/{id}` | GET | Poll instance status |
| `/zones/{zone}/servers/{id}` | PATCH | Schedule/unschedule deletion |
| `/zones/{zone}/servers/{id}` | DELETE | Delete instance (fails within 24h) |
| `/zones/{zone}/server-types` | GET | List available server types + stock |
