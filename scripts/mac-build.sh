#!/bin/bash
# mac-build.sh - Build and test Stalagmight on macOS (standalone)
# Assumes development tools from mac-setup.sh are already installed.
set -euo pipefail

info()  { printf '\033[1;34m==> %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn()  { printf '\033[1;33m  ⚠ %s\033[0m\n' "$*"; }
die()   { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ── Parse arguments ──────────────────────────────────────────────────────────
PROJECT_DIR=""
TEST_UI=false
TEST_UI_HEADED=false
TEST_E2E=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir)
      PROJECT_DIR="$2"
      shift 2
      ;;
    --test-ui)
      TEST_UI=true
      shift
      ;;
    --test-ui-headed)
      TEST_UI_HEADED=true
      shift
      ;;
    --test-e2e)
      TEST_E2E=true
      shift
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

# Default to parent of this script's directory
if [[ -z "$PROJECT_DIR" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

[[ -f "$PROJECT_DIR/package.json" ]] || die "Not a valid project directory: $PROJECT_DIR"

# Ask cargo where it actually writes rather than assuming src-tauri/target.
# A per-clone .cargo/config.toml can redirect target-dir (this repo's clones put
# it on an external disk), and cargo resolves that config from the working
# directory, which is why this runs from inside PROJECT_DIR. Getting it wrong is
# silent: the signing and reporting steps below just find nothing.
CARGO_TARGET="$(cd "$PROJECT_DIR/src-tauri" && cargo metadata --format-version 1 --no-deps 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])' 2>/dev/null)"
if [[ -z "$CARGO_TARGET" ]]; then
  warn "Could not read cargo's target directory; assuming src-tauri/target"
  CARGO_TARGET="$PROJECT_DIR/src-tauri/target"
fi

# ── Environment ──────────────────────────────────────────────────────────────
# Treat this as a CI build (suppresses -dev version suffix in telemetry)
export CI=true

# Load .env if present (contains TELEMETRY_ENDPOINT and other secrets)
if [[ -f "$PROJECT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$PROJECT_DIR/.env"; set +a
  info "Loaded .env"
fi

# shellcheck disable=SC1091
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"

# Ensure Homebrew is on PATH
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
elif [[ -x "$HOME/.homebrew/bin/brew" ]]; then
  eval "$("$HOME/.homebrew/bin/brew" shellenv)"
fi

# If node@22 was installed via Homebrew, ensure its bin is on PATH
if command -v brew &>/dev/null; then
  NODE22_PREFIX="$(brew --prefix node@22 2>/dev/null || true)"
  if [[ -n "$NODE22_PREFIX" && -d "$NODE22_PREFIX/bin" ]]; then
    export PATH="$NODE22_PREFIX/bin:$PATH"
  fi
fi

info "Building Stalagmight in $PROJECT_DIR"
echo "  Node.js:  $(node --version)"
echo "  pnpm:     $(pnpm --version)"
echo "  Rust:     $(rustc --version)"
echo ""

# ── Step 1: Install dependencies ────────────────────────────────────────────
info "Installing dependencies"
pnpm install --dir "$PROJECT_DIR"
ok "Dependencies installed"

# ── Step 2: TypeScript check ────────────────────────────────────────────────
info "Running TypeScript type check"
(cd "$PROJECT_DIR" && pnpm tsc --noEmit)
ok "TypeScript check passed"

# ── Step 3: Install Playwright browsers (optional) ────────────────────────
if [[ "$TEST_UI" == true || "$TEST_UI_HEADED" == true ]]; then
  info "Installing Playwright browsers (Chromium)"
  (cd "$PROJECT_DIR" && pnpm exec playwright install chromium)
  ok "Playwright browsers installed"
fi

# ── Step 4: Playwright UI tests (optional) ────────────────────────────────
if [[ "$TEST_UI_HEADED" == true ]]; then
  info "Running Playwright tests (headed)"
  (cd "$PROJECT_DIR" && pnpm test:ui:headed)
  ok "Playwright tests passed (headed)"
elif [[ "$TEST_UI" == true ]]; then
  info "Running Playwright tests (headless)"
  (cd "$PROJECT_DIR" && pnpm test:ui)
  ok "Playwright tests passed (headless)"
fi

# ── Step 5: Rust tests ──────────────────────────────────────────────────────
# macOS defaults to 256 open files which is too low for the test suite
ulimit -n 4096 2>/dev/null || ulimit -n 1024 2>/dev/null || true
info "Running Rust tests (ulimit -n $(ulimit -n))"
if cargo test --manifest-path "$PROJECT_DIR/src-tauri/Cargo.toml"; then
  ok "Rust tests passed"
else
  warn "Some Rust tests failed (continuing with build)"
fi

# ── Step 5a: Build debug binary for E2E (optional) ────────────────────
if [[ "$TEST_E2E" == true ]]; then
  # Ensure CARGO_TARGET_DIR matches what wdio.conf.ts expects
  export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cargo_build}"
  info "Building debug binary with e2e feature for WebDriverIO tests"
  info "  CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
  (cd "$PROJECT_DIR" && VITE_E2E=1 pnpm tauri build --debug --no-bundle -- --features e2e)
  ok "E2E debug binary built"
fi

# ── Step 5b: Run WebDriverIO E2E tests (optional) ────────────────────
if [[ "$TEST_E2E" == true ]]; then
  info "Running WebDriverIO E2E tests"
  (cd "$PROJECT_DIR" && ./scripts/wdio.sh --skip-build)
  ok "WebDriverIO E2E tests passed"
fi

# ── Step 6: Production build ────────────────────────────────────────────────
# CI=true (exported above) tells Tauri's DMG bundler to skip AppleScript
# (needs Finder GUI). Without it, bundle_dmg.sh hangs in headless/SSH sessions.
info "Building production macOS app"
if [[ -n "${TELEMETRY_ENDPOINT:-}" ]]; then
  info "  Telemetry enabled (endpoint set)"
  (cd "$PROJECT_DIR" && pnpm tauri build -- --features telemetry)
else
  warn "  Telemetry disabled (TELEMETRY_ENDPOINT not set - add to .env)"
  (cd "$PROJECT_DIR" && pnpm tauri build)
fi
ok "Production build complete"

# ── Step 6a: Verify the ad-hoc code signature ───────────────────────────────
# Tauri signs the app itself now, via bundle.macOS.signingIdentity in
# tauri.conf.json. That matters for ordering: signing has to happen before the
# DMG is built, and this step used to run after, so the .app on disk got signed
# while the DMG next to it kept an unsigned copy. Verifying is all that is left
# to do here, and it is the more useful job, because an invalid signature is not
# a warning the user can dismiss - macOS calls the app "damaged" and refuses to
# open it at all (#350).
# Checks the app inside the DMG, not the loose bundle beside it, via the same
# script the release workflow runs. Verifying the loose .app would pass on the
# exact bug this guards: signing used to happen after the DMG was built, so the
# loose copy was signed while the shipped one was not.
DMG_OUT="$CARGO_TARGET/release/bundle/dmg"
if [[ -d "$DMG_OUT" ]] && compgen -G "$DMG_OUT/*.dmg" >/dev/null; then
  info "Verifying the code signature of the app inside the DMG"
  # Hard failure, not a warning. An unopenable bundle is the one defect that is
  # invisible until a human tries to launch it, so a yellow line a maintainer can
  # scroll past while the script still exits 0 is not enough.
  if ! "$PROJECT_DIR/scripts/verify-macos-signature.sh" "$DMG_OUT"; then
    die "The app inside the DMG is NOT validly signed, so macOS will call it damaged. Check bundle.macOS.signingIdentity in src-tauri/tauri.conf.json"
  fi
  ok "Signature valid (not notarized: first launch still has to be allowed once)"
else
  warn "No DMG found in $DMG_OUT - skipping signature verification"
fi

# ── Step 7: Report artifacts ────────────────────────────────────────────────
BUNDLE_DIR="$CARGO_TARGET/release/bundle/macos"
info "Build artifacts in $BUNDLE_DIR:"
if [[ -d "$BUNDLE_DIR" ]]; then
  find "$BUNDLE_DIR" -maxdepth 1 -type f -o -type d -maxdepth 1 | while read -r f; do
    if [[ "$f" != "$BUNDLE_DIR" ]]; then
      SIZE=$(du -sh "$f" | cut -f1)
      echo "  $SIZE  $(basename "$f")"
    fi
  done
else
  echo "  (bundle directory not found - check build output above)"
fi

# Also check for DMG
DMG_DIR="$CARGO_TARGET/release/bundle/dmg"
if [[ -d "$DMG_DIR" ]]; then
  info "DMG artifacts in $DMG_DIR:"
  find "$DMG_DIR" -maxdepth 1 -type f | while read -r f; do
    SIZE=$(du -sh "$f" | cut -f1)
    echo "  $SIZE  $(basename "$f")"
  done
fi

ok "macOS build complete!"
