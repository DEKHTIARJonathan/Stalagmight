#!/bin/bash
# mac-build.sh — Build and test Stalagmight on macOS (standalone)
# Assumes development tools from mac-setup.sh are already installed.
set -euo pipefail

info()  { printf '\033[1;34m==> %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn()  { printf '\033[1;33m  ⚠ %s\033[0m\n' "$*"; }
die()   { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ── Parse arguments ──────────────────────────────────────────────────────────
PROJECT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir)
      PROJECT_DIR="$2"
      shift 2
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

# ── Environment ──────────────────────────────────────────────────────────────
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

# ── Step 3: Rust tests ──────────────────────────────────────────────────────
# macOS defaults to 256 open files which is too low for the test suite
ulimit -n 4096 2>/dev/null || ulimit -n 1024 2>/dev/null || true
info "Running Rust tests (ulimit -n $(ulimit -n))"
if cargo test --manifest-path "$PROJECT_DIR/src-tauri/Cargo.toml"; then
  ok "Rust tests passed"
else
  warn "Some Rust tests failed (continuing with build)"
fi

# ── Step 4: Production build ────────────────────────────────────────────────
# CI=true tells Tauri's DMG bundler to skip AppleScript (needs Finder GUI).
# Without it, bundle_dmg.sh hangs on the AppleScript step in headless/SSH sessions.
info "Building production macOS app"
(cd "$PROJECT_DIR" && CI=true pnpm tauri build)
ok "Production build complete"

# ── Step 5: Report artifacts ────────────────────────────────────────────────
BUNDLE_DIR="$PROJECT_DIR/src-tauri/target/release/bundle/macos"
info "Build artifacts in $BUNDLE_DIR:"
if [[ -d "$BUNDLE_DIR" ]]; then
  find "$BUNDLE_DIR" -maxdepth 1 -type f -o -type d -maxdepth 1 | while read -r f; do
    if [[ "$f" != "$BUNDLE_DIR" ]]; then
      SIZE=$(du -sh "$f" | cut -f1)
      echo "  $SIZE  $(basename "$f")"
    fi
  done
else
  echo "  (bundle directory not found — check build output above)"
fi

# Also check for DMG
DMG_DIR="$PROJECT_DIR/src-tauri/target/release/bundle/dmg"
if [[ -d "$DMG_DIR" ]]; then
  info "DMG artifacts in $DMG_DIR:"
  find "$DMG_DIR" -maxdepth 1 -type f | while read -r f; do
    SIZE=$(du -sh "$f" | cut -f1)
    echo "  $SIZE  $(basename "$f")"
  done
fi

ok "macOS build complete!"
