# macOS Build

Two scripts handle building Stalagmight locally on macOS.

## Quick Start

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

Build artifacts land under `src-tauri/target/release/bundle/`.

## Scripts Overview

| Script | Purpose |
|--------|---------|
| `scripts/mac-setup.sh` | Install dev tools on macOS (Xcode CLI, Homebrew, Node 22, pnpm 9, Rust, tauri-wd) |
| `scripts/mac-build.sh` | Run the full build pipeline (deps, tsc, cargo test, tauri build) |

## `mac-setup.sh` - Dev Tool Installer

Installs all required development tools, skipping anything already present. Safe to run repeatedly.

### Tools installed

1. **Xcode Command Line Tools** - headless install via `softwareupdate`
2. **Homebrew** - standard installer if sudo is available, otherwise git-clones to `~/.homebrew`
3. **Node.js 22** - via `brew install node@22`, with PATH fix for keg-only installs
4. **pnpm 9** - via `npm install -g pnpm@9`, with CA cert fix for Homebrew's OpenSSL
5. **Rust stable** - via rustup
6. **tauri-wd** - via `cargo install tauri-webdriver-automation` (WebDriver for macOS E2E tests)

### Homebrew PATH detection

The script checks three Homebrew locations in order:

| Location | When used |
|----------|-----------|
| `/opt/homebrew/bin/brew` | Standard Apple Silicon install |
| `/usr/local/bin/brew` | Standard Intel install |
| `~/.homebrew/bin/brew` | No-sudo fallback install |

## `mac-build.sh` - Build Pipeline

Runs the complete build and test pipeline. Assumes `mac-setup.sh` has already been run.

### Options

| Flag | Description |
|------|-------------|
| `--project-dir <path>` | Override project root (defaults to parent of `scripts/`) |
| `--test-ui` | Install Playwright browsers + run headless UI tests |
| `--test-ui-headed` | Install Playwright browsers + run headed UI tests (needs display) |
| `--test-e2e` | Build debug binary with e2e feature + run WebDriverIO E2E tests |

### Build steps

1. `pnpm install` - install frontend dependencies
2. `pnpm tsc --noEmit` - TypeScript type check
3. `playwright install chromium` - install Playwright browsers *(only with `--test-ui*`)*
4. `pnpm test:ui` / `pnpm test:ui:headed` - Playwright tests *(only with `--test-ui*`)*
5. `cargo test` - Rust test suite (with `ulimit -n 4096`)
5a. `pnpm tauri build --debug --no-bundle -- --features e2e` - E2E debug binary *(only with `--test-e2e`)*
5b. `./scripts/wdio.sh --skip-build` - WebDriverIO E2E tests *(only with `--test-e2e`)*
6. `CI=true pnpm tauri build` - production build (`.app` bundle + `.dmg`)

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
| Headed | `--test-ui-headed` | Yes | Requires a GUI session (e.g. a local display or a VNC session over SSH) |

Test results (screenshots, traces on failure) are saved to `test-results/`.

### WebDriverIO Tests

The `--test-e2e` flag runs WebDriverIO E2E tests against the Tauri app. On macOS, this uses `tauri-wd` (from the `tauri-webdriver-automation` crate) instead of `tauri-driver`, which only supports Linux/Windows.

#### How it works

1. The app is built with `--features e2e`, which compiles in `tauri-plugin-webdriver-automation` - a Tauri plugin that exposes W3C WebDriver protocol for WKWebView
2. `tauri-wd` is spawned as the WebDriver server (instead of `tauri-driver`)
3. WebDriverIO connects to `tauri-wd` and runs tests as normal

The `e2e` feature is gated behind a Cargo feature flag (`[features] e2e = [...]` in `Cargo.toml`), so it is **never compiled** in normal or release builds - zero impact on the production binary.

#### Prerequisites

- `tauri-wd` must be installed: `cargo install tauri-webdriver-automation` (handled by `mac-setup.sh`)

#### Artifacts

| Artifact | Location |
|----------|----------|
| Per-spec logs | `wdio-logs/` |

## Known Issues & Workarounds

| Issue | Cause | Workaround |
|-------|-------|------------|
| No-sudo Homebrew | Some build hosts lack passwordless sudo | `mac-setup.sh` git-clones Homebrew to `~/.homebrew` |
| Node.js not on PATH | `node@22` is keg-only in Homebrew | Scripts detect and prepend `$(brew --prefix node@22)/bin` to PATH |
| npm SSL certificate errors | Homebrew's source-built OpenSSL lacks CA bundle | `mac-setup.sh` sets `npm config set cafile` to Homebrew's `ca-certificates` bundle |
| DMG bundling hangs over SSH | Tauri's DMG bundler uses AppleScript (needs Finder GUI) | `mac-build.sh` sets `CI=true` which skips the AppleScript step |
| macOS `ulimit -n 256` | Default is too low for the Rust test suite | `mac-build.sh` raises to 4096 (falls back to 1024) |
| `directories` crate ignores XDG on macOS | Hardcodes `~/Library/Application Support/` regardless of `XDG_CONFIG_HOME` | 3 config/logging tests are gated to `#[cfg(target_os = "linux")]` |
| `pnpm --dir` broken for `exec` | `--dir` flag doesn't propagate to subcommands | Scripts use subshell `(cd $DIR && pnpm ...)` instead |
