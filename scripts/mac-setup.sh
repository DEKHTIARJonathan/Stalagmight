#!/bin/bash
# mac-setup.sh - Install development tools on macOS (standalone, idempotent, non-interactive)
# Safe to run on any Mac. Skips tools that are already installed.
set -euo pipefail

info()  { printf '\033[1;34m==> %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
die()   { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ── Xcode Command Line Tools ────────────────────────────────────────────────
info "Checking Xcode Command Line Tools"
if xcode-select -p &>/dev/null; then
  ok "Already installed at $(xcode-select -p)"
else
  info "Installing Xcode Command Line Tools…"
  # Trigger the install (headless-friendly approach)
  touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  XCODE_PKG=$(softwareupdate -l 2>/dev/null \
    | grep -o '.*Command Line Tools.*' \
    | head -1 \
    | sed 's/^[* ]*//' \
    | sed 's/^ *Label: //')
  if [[ -n "${XCODE_PKG:-}" ]]; then
    softwareupdate -i "$XCODE_PKG" --agree-to-license
  else
    # Fallback: trigger the GUI prompt and poll
    xcode-select --install 2>/dev/null || true
    info "Waiting for Xcode CLI Tools installation (up to 30 min)…"
    for i in $(seq 1 360); do
      if xcode-select -p &>/dev/null; then break; fi
      sleep 5
    done
  fi
  rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  xcode-select -p &>/dev/null || die "Xcode CLI Tools installation failed"
  ok "Installed"
fi

# Helper: add Homebrew to PATH (handles standard + no-sudo locations)
_brew_setup() {
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  elif [[ -x "$HOME/.homebrew/bin/brew" ]]; then
    eval "$("$HOME/.homebrew/bin/brew" shellenv)"
  fi
}

# ── Homebrew ─────────────────────────────────────────────────────────────────
_brew_setup
info "Checking Homebrew"
if command -v brew &>/dev/null; then
  ok "Already installed at $(command -v brew)"
else
  if sudo -n true 2>/dev/null; then
    # Has passwordless sudo - use the standard installer
    info "Installing Homebrew (standard)…"
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  else
    # No sudo - install to $HOME/.homebrew
    info "Installing Homebrew (no-sudo, to ~/.homebrew)…"
    git clone --depth=1 https://github.com/Homebrew/brew "$HOME/.homebrew"
  fi
  _brew_setup
  command -v brew &>/dev/null || die "Homebrew installation failed"
  ok "Installed"
fi

# ── Node.js ──────────────────────────────────────────────────────────────────
# The major comes from .nvmrc so this script cannot drift from CI, which selects
# node with `node-version-file: .nvmrc`. Keep them reading the same file.
REPO_ROOT="$(dirname "$(dirname "$(realpath "$0")")")"
NVMRC="$REPO_ROOT/.nvmrc"
[[ -f "$NVMRC" ]] || die "Could not find .nvmrc next to the repo root ($NVMRC)"
# Take the leading version component, tolerating a `v` prefix and a full semver -
# both of which are valid .nvmrc and both of which `setup-node` accepts. Stripping
# every non-digit instead would turn "24.1.0" into "24100".
NODE_MAJOR="$(tr -d 'v \t\r\n' < "$NVMRC" | cut -d. -f1)"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || die "Could not read a node major from $NVMRC (got '$NODE_MAJOR')"

# Homebrew installs node@<major> as keg-only; ensure its bin is on PATH
NODE_PREFIX="$(brew --prefix "node@$NODE_MAJOR" 2>/dev/null || true)"
if [[ -n "$NODE_PREFIX" && -d "$NODE_PREFIX/bin" ]]; then
  export PATH="$NODE_PREFIX/bin:$PATH"
fi

info "Checking Node.js $NODE_MAJOR"
if command -v node &>/dev/null && [[ "$(node --version)" == v"$NODE_MAJOR".* ]]; then
  ok "Already installed: $(node --version)"
else
  info "Installing Node.js $NODE_MAJOR via Homebrew…"
  brew install "node@$NODE_MAJOR"
  brew link --overwrite "node@$NODE_MAJOR" 2>/dev/null || true
  # Refresh PATH for keg-only install
  NODE_PREFIX="$(brew --prefix "node@$NODE_MAJOR")"
  export PATH="$NODE_PREFIX/bin:$PATH"
  node --version | grep -q "^v$NODE_MAJOR\." || die "Node.js $NODE_MAJOR installation failed"
  ok "Installed: $(node --version)"
fi

# ── pnpm ─────────────────────────────────────────────────────────────────────
# The version comes from package.json's `packageManager` so this script cannot
# drift from CI, where pnpm/action-setup reads that same field.
#
# That field carries a corepack integrity suffix (`pnpm@<version>+sha512.<hex>`),
# so strip it two ways: PNPM_VERSION is what we install, PNPM_MAJOR is what we
# accept as already-present. We install the EXACT pinned version rather than a
# floating `pnpm@<major>` so this script never fetches an unpinned tarball; an
# existing install only has to match the major, because any pnpm 10+ self-switches
# to the exact pin (and verifies the hash) before it runs anything.
PKG_JSON="$REPO_ROOT/package.json"
[[ -f "$PKG_JSON" ]] || die "Could not find package.json at the repo root ($PKG_JSON)"
PNPM_SPEC="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"]*\)".*/\1/p' "$PKG_JSON")"
[[ -n "$PNPM_SPEC" ]] || die "Could not read a pnpm version from $PKG_JSON"
PNPM_VERSION="${PNPM_SPEC%%+*}"
PNPM_MAJOR="${PNPM_VERSION%%.*}"
# Guard both before either is interpolated into a command: PNPM_SPEC comes from a
# file in a cloned repo, so treat it as untrusted input.
[[ "$PNPM_VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]] || die "Could not read a pnpm version from $PKG_JSON (got '$PNPM_VERSION')"
[[ "$PNPM_MAJOR" =~ ^[0-9]+$ ]] || die "Could not read a pnpm major from $PKG_JSON (got '$PNPM_MAJOR')"

# Ensure npm can reach the registry (Homebrew's source-built OpenSSL may not
# have CA certs configured; point npm at Homebrew's ca-certificates bundle).
CA_BUNDLE="$(brew --prefix ca-certificates 2>/dev/null)/share/ca-certificates/cacert.pem"
if [[ -f "$CA_BUNDLE" ]]; then
  npm config set cafile "$CA_BUNDLE"
fi

info "Checking pnpm $PNPM_MAJOR"
if command -v pnpm &>/dev/null && [[ "$(pnpm --version)" == "$PNPM_MAJOR".* ]]; then
  ok "Already installed: pnpm $(pnpm --version)"
else
  info "Installing pnpm $PNPM_VERSION…"
  npm install -g "pnpm@$PNPM_VERSION"
  command -v pnpm &>/dev/null || die "pnpm installation failed"
  ok "Installed: pnpm $(pnpm --version)"
fi

# ── Rust (stable) ────────────────────────────────────────────────────────────
info "Checking Rust"
if command -v rustc &>/dev/null; then
  ok "Already installed: $(rustc --version)"
else
  info "Installing Rust stable…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  ok "Installed"
fi

# Source cargo env for version display
# shellcheck disable=SC1091
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"

# ── tauri-wd (WebDriver for macOS E2E tests) ─────────────────────────────
info "Checking tauri-wd (WebDriver for macOS)"
# Use the fix branch that resolves W3C element references in execute/sync
# (PR #3: https://github.com/danielraffel/tauri-webdriver/pull/3)
# TODO: Switch back to `cargo install tauri-webdriver-automation` once fix is released
TAURI_WD_GIT="https://github.com/FumblingBarbell/tauri-webdriver"
TAURI_WD_BRANCH="fix/resolve-element-refs-in-execute-sync"
TAURI_WD_MARKER="$HOME/.cargo/.tauri-wd-fix-branch"
if command -v tauri-wd &>/dev/null && [[ -f "$TAURI_WD_MARKER" ]]; then
  ok "Already installed from fix branch: $(tauri-wd --version 2>/dev/null || echo 'unknown version')"
else
  info "Installing tauri-webdriver-automation from fix branch…"
  cargo install --git "$TAURI_WD_GIT" --branch "$TAURI_WD_BRANCH" tauri-webdriver-automation --force
  touch "$TAURI_WD_MARKER"
  ok "Installed"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
info "Tool versions:"
echo "  Xcode CLI:  $(xcode-select -p)"
echo "  Homebrew:   $(brew --version | head -1)"
echo "  Node.js:    $(node --version)"
echo "  pnpm:       $(pnpm --version)"
echo "  Rust:       $(rustc --version)"
echo "  Cargo:      $(cargo --version)"
echo "  tauri-wd:   $(tauri-wd --version 2>/dev/null || echo 'installed')"

ok "All development tools are ready"
