#!/bin/bash
#
# wdio.sh - Comprehensive WebdriverIO E2E Test Runner for Stalagmight
#
# This script handles all the common issues that can cause WebdriverIO tests to fail:
# - Platform verification (Linux/Windows only)
# - tauri-driver installation check
# - Display detection (headed vs headless with xvfb)
# - Port cleanup (kills stale tauri-driver/stalagmight processes)
# - Build freshness check (rebuilds if source is newer than binary)
#
# Usage:
#   ./scripts/wdio.sh                    # Run all tests, auto-detect display
#   ./scripts/wdio.sh --rebuild          # Force rebuild before tests
#   ./scripts/wdio.sh --skip-build       # Skip build checks (dangerous)
#   ./scripts/wdio.sh --spec e2e/legacy/specs/foo.spec.ts  # Run specific spec
#   ./scripts/wdio.sh --headed           # Force headed mode (fail if no display)
#   ./scripts/wdio.sh --headless         # Force xvfb (fail if not installed)
#

set -e

# ===== Color output =====
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }

# ===== Configuration =====
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cargo_build}"
BINARY_PATH="$CARGO_TARGET_DIR/debug/stalagmight"
IS_MACOS=false
if [[ "$(uname -s)" == Darwin* ]]; then
    IS_MACOS=true
fi

# Per-run pidfile so macOS cleanup reaps ONLY the app instances this run spawned
# (recorded by e2e/mac-app-wrapper.mjs) and never a real stalagmight you have
# open via ./scripts/dev.sh. Exported so it reaches the wrapper through the
# wdio -> tauri-wd -> app env chain (same channel as STALAGMIGHT_BINARY).
export STALAGMIGHT_TEST_PIDFILE="${TMPDIR:-/tmp}/stalagmight-wdio-pids.$$"
DIST_PATH="$PROJECT_ROOT/dist"
DEFAULT_MAX_INSTANCES=1
if command -v nproc &> /dev/null; then
    CPU_COUNT=$(nproc)
elif command -v getconf &> /dev/null; then
    CPU_COUNT=$(getconf _NPROCESSORS_ONLN)
else
    CPU_COUNT=1
fi
if [[ "$CPU_COUNT" -gt 1 ]]; then
    DEFAULT_MAX_INSTANCES=$CPU_COUNT
fi
if [[ "$DEFAULT_MAX_INSTANCES" -gt 4 ]]; then
    DEFAULT_MAX_INSTANCES=4
fi

WDIO_MAX_INSTANCES="${WDIO_MAX_INSTANCES:-$DEFAULT_MAX_INSTANCES}"
WDIO_BASE_PORT="${WDIO_BASE_PORT:-4444}"
if [[ -z "${WDIO_BASE_NATIVE_PORT:-}" ]]; then
    WDIO_BASE_NATIVE_PORT=$((WDIO_BASE_PORT + 1000))
else
    WDIO_BASE_NATIVE_PORT="${WDIO_BASE_NATIVE_PORT}"
fi
export WDIO_MAX_INSTANCES
export WDIO_BASE_PORT
export WDIO_BASE_NATIVE_PORT

# ===== Argument parsing =====
FORCE_REBUILD=false
SKIP_BUILD=false
FORCE_HEADED=false
FORCE_HEADLESS=false
WDIO_ARGS=()

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --rebuild)
                FORCE_REBUILD=true
                shift
                ;;
            --skip-build)
                SKIP_BUILD=true
                shift
                ;;
            --headed)
                FORCE_HEADED=true
                shift
                ;;
            --headless)
                FORCE_HEADLESS=true
                shift
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                WDIO_ARGS+=("$1")
                shift
                ;;
        esac
    done
}

show_help() {
    cat << EOF
Stalagmight WebdriverIO E2E Test Runner

Usage: $0 [options] [wdio-args]

Options:
  --rebuild      Force rebuild of frontend and Tauri binary before tests
  --skip-build   Skip build freshness checks (use with caution)
  --headed       Force headed mode (fail if no display available)
  --headless     Force headless mode with xvfb (fail if xvfb not installed)
  --help, -h     Show this help message

Any additional arguments are passed through to wdio.

Examples:
  $0                                    # Run all tests
  $0 --rebuild                          # Force rebuild, then run tests
  $0 --spec e2e/legacy/specs/tml-import-integration.spec.ts  # Run specific spec
  $0 --headless --spec e2e/legacy/specs/foo.spec.ts   # Force xvfb, run specific spec

Environment Variables:
  CARGO_TARGET_DIR  Location of cargo build output (default: ~/.cargo_build)
  WDIO_MAX_INSTANCES  Number of parallel workers (default: min(4, CPU count))
  WDIO_BASE_PORT      Base tauri-driver port (default: 4444)
  WDIO_BASE_NATIVE_PORT  Base native WebDriver port (default: base port + 1000)
  WDIO_PORT_RANGE        Number of ports to clean (default: spec count)
EOF
}

# ===== Platform check =====
check_platform() {
    info "Checking platform..."

    case "$(uname -s)" in
        Linux*)
            success "Platform: Linux"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            success "Platform: Windows"
            ;;
        Darwin*)
            IS_MACOS=true
            success "Platform: macOS (using tauri-wd)"
            ;;
        *)
            error "Unknown platform: $(uname -s)"
            error "WebdriverIO E2E tests require Linux, Windows, or macOS."
            exit 1
            ;;
    esac
}

# ===== tauri-driver check =====
check_tauri_driver() {
    if $IS_MACOS; then
        info "Checking tauri-wd installation (macOS WebDriver)..."
        if ! command -v tauri-wd &> /dev/null; then
            error "tauri-wd is not installed."
            echo ""
            echo "Install it with:"
            echo "  cargo install tauri-webdriver-automation"
            echo ""
            echo "After installation, ensure it's in your PATH."
            exit 1
        fi
        success "tauri-wd found: $(which tauri-wd)"
    else
        info "Checking tauri-driver installation..."
        if ! command -v tauri-driver &> /dev/null; then
            error "tauri-driver is not installed."
            echo ""
            echo "Install it with:"
            echo "  cargo install tauri-driver"
            echo ""
            echo "After installation, ensure it's in your PATH."
            exit 1
        fi
        success "tauri-driver found: $(which tauri-driver)"
    fi
}

# ===== Display detection =====
HAS_DISPLAY=false
USE_XVFB=false

check_display() {
    info "Checking display availability..."

    # macOS always has Quartz display available
    if $IS_MACOS; then
        HAS_DISPLAY=true
        success "Display available (macOS Quartz)"
        return
    fi

    # Check for X11 or Wayland display
    if [[ -n "$DISPLAY" ]] || [[ -n "$WAYLAND_DISPLAY" ]]; then
        HAS_DISPLAY=true
        success "Display available (DISPLAY=$DISPLAY, WAYLAND_DISPLAY=$WAYLAND_DISPLAY)"
    else
        warn "No display detected (DISPLAY and WAYLAND_DISPLAY not set)"
    fi

    # Handle forced modes
    if $FORCE_HEADED; then
        if ! $HAS_DISPLAY; then
            error "Headed mode requested but no display available."
            echo "Set DISPLAY environment variable or use --headless instead."
            exit 1
        fi
        info "Using headed mode (forced)"
        return
    fi

    if $FORCE_HEADLESS; then
        if ! command -v xvfb-run &> /dev/null; then
            error "Headless mode requested but xvfb-run is not installed."
            echo ""
            echo "Install it with:"
            echo "  sudo apt install xvfb    # Debian/Ubuntu"
            echo "  sudo dnf install xorg-x11-server-Xvfb  # Fedora"
            exit 1
        fi
        USE_XVFB=true
        success "Using xvfb for headless mode (forced)"
        return
    fi

    # Auto-detect: prefer display if available, otherwise try xvfb
    if $HAS_DISPLAY; then
        info "Using native display"
    elif command -v xvfb-run &> /dev/null; then
        USE_XVFB=true
        success "No display, using xvfb-run for headless mode"
    else
        error "No display available and xvfb-run not installed."
        echo ""
        echo "Options:"
        echo "  1. Run on a machine with a display (X11/Wayland)"
        echo "  2. Install xvfb:"
        echo "       sudo apt install xvfb    # Debian/Ubuntu"
        echo "       sudo dnf install xorg-x11-server-Xvfb  # Fedora"
        echo "  3. Use Playwright tests instead: pnpm test:ui"
        exit 1
    fi
}

# ===== Scoped stalagmight reaping (macOS) =====
# Kill ONLY the app instances this run (or a dead prior run) launched, recorded
# by e2e/mac-app-wrapper.mjs in a per-run pidfile. Each PID is re-verified as a
# live stalagmight process before SIGKILL, so PID reuse can't take down an
# unrelated process — and a real stalagmight you started outside the harness
# (its PID is in no pidfile) is never touched.
reap_tracked_stalagmight() {
    local pidfile owner pid comm reaped=0
    for pidfile in "${TMPDIR:-/tmp}"/stalagmight-wdio-pids.*; do
        [[ -f "$pidfile" ]] || continue
        # A pidfile owned by a *different* run is only safe to reap once that
        # run's shell is gone (don't race a concurrent run). Our own file always
        # reaps. The owner shell PID is the filename suffix.
        if [[ "$pidfile" != "$STALAGMIGHT_TEST_PIDFILE" ]]; then
            owner="${pidfile##*.}"
            # Skip a pidfile a *live* run still owns — UNLESS it's stale. The
            # owner PID can be reused by an unrelated process; an hours-old
            # pidfile is never an active run (the wrapper touches it each
            # session), so reap it instead of leaking its windows forever.
            if [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null \
               && [[ -z "$(find "$pidfile" -mmin +120 2>/dev/null || true)" ]]; then
                continue
            fi
        fi
        while IFS= read -r pid; do
            [[ "$pid" =~ ^[0-9]+$ ]] || continue
            comm=$(ps -p "$pid" -o comm= 2>/dev/null || true)
            if [[ "$comm" == *stalagmight* ]]; then
                if kill -9 "$pid" 2>/dev/null; then reaped=$((reaped + 1)); fi
            fi
        done < "$pidfile"
        rm -f "$pidfile"
    done
    [[ "$reaped" -gt 0 ]] && warn "Reaped $reaped test-spawned stalagmight window(s)"
    return 0
}

# ===== Port cleanup =====
cleanup_ports() {
    # phase: "start" (clear a prior run's stragglers) or "exit" (post-run teardown).
    local phase="${1:-start}"
    info "Cleaning up stale processes..."

    # Kill any existing tauri-driver / tauri-wd processes
    if pgrep -x tauri-driver > /dev/null 2>&1; then
        warn "Found running tauri-driver, killing..."
        pkill -9 tauri-driver 2>/dev/null || true
    fi
    if pgrep -x tauri-wd > /dev/null 2>&1; then
        warn "Found running tauri-wd, killing..."
        pkill -9 tauri-wd 2>/dev/null || true
    fi

    # Kill any existing WebKitWebDriver processes (used internally by tauri-driver)
    if pgrep -x WebKitWebDriver > /dev/null 2>&1; then
        warn "Found running WebKitWebDriver, killing..."
        pkill -9 WebKitWebDriver 2>/dev/null || true
    fi

    # Kill stalagmight app instances. On macOS, scope strictly to this harness's
    # own spawned PIDs so a real dev instance survives (issue #127). On
    # Linux/Windows there's no pidfile to scope by (no wrapper), so the broad
    # sweep runs ONLY at startup (clearing a prior run's stragglers) — never from
    # the EXIT trap, where it could kill a dev's own instance started meanwhile.
    if $IS_MACOS; then
        reap_tracked_stalagmight
    elif [[ "$phase" == start ]] && pgrep -x stalagmight > /dev/null 2>&1; then
        warn "Found running stalagmight, killing..."
        pkill -9 stalagmight 2>/dev/null || true
    fi

    # Check if ports are in use and free them (cover parallel worker range)
    local max_instances="$WDIO_MAX_INSTANCES"
    if ! [[ "$max_instances" =~ ^[0-9]+$ ]]; then
        max_instances=1
    fi

    local spec_count
    spec_count=$(find "$PROJECT_ROOT/e2e/legacy/specs" -name "*.spec.ts" 2>/dev/null | wc -l | tr -d ' ')
    if ! [[ "$spec_count" =~ ^[0-9]+$ ]] || [[ "$spec_count" -lt 1 ]]; then
        spec_count=$max_instances
    fi

    local port_range="${WDIO_PORT_RANGE:-$spec_count}"
    if ! [[ "$port_range" =~ ^[0-9]+$ ]] || [[ "$port_range" -lt 1 ]]; then
        port_range=$max_instances
    fi

    for ((i=0; i<port_range; i++)); do
        for port in "$((WDIO_BASE_PORT + i))" "$((WDIO_BASE_NATIVE_PORT + i))"; do
            if $IS_MACOS; then
                # macOS: use lsof instead of fuser
                local pid
                pid=$(lsof -ti :"$port" 2>/dev/null || true)
                if [[ -n "$pid" ]]; then
                    warn "Port $port in use (pid $pid), killing..."
                    kill -9 $pid 2>/dev/null || true
                fi
            elif command -v fuser &> /dev/null && fuser "$port/tcp" > /dev/null 2>&1; then
                warn "Port $port in use, killing process..."
                fuser -k "$port/tcp" 2>/dev/null || true
            fi
        done
    done

    # Wait for processes to terminate
    sleep 1

    success "Port cleanup complete"
}

# ===== Build freshness check =====
E2E_BUILD_MARKER="$PROJECT_ROOT/.e2e-build-marker"

check_build_freshness() {
    if $SKIP_BUILD; then
        warn "Skipping build freshness check (--skip-build)"
        warn "If tests fail with 'Could not connect to localhost', try removing --skip-build"
        return 0
    fi

    info "Checking build freshness..."

    # Check if binary exists
    if [[ ! -f "$BINARY_PATH" ]]; then
        warn "Binary not found at $BINARY_PATH"
        return 1
    fi

    # Check if dist exists
    if [[ ! -f "$DIST_PATH/index.html" ]]; then
        warn "Frontend dist not found at $DIST_PATH"
        return 1
    fi

    # Check if the asset hashes match what was built into the binary
    # This catches the case where frontend was rebuilt (new hashes) but binary wasn't
    CURRENT_ASSET_HASH=$(md5sum "$DIST_PATH/index.html" 2>/dev/null | cut -d' ' -f1 || echo "none")
    if [[ -f "$E2E_BUILD_MARKER" ]]; then
        BUILT_ASSET_HASH=$(cat "$E2E_BUILD_MARKER" 2>/dev/null || echo "")
        if [[ "$CURRENT_ASSET_HASH" != "$BUILT_ASSET_HASH" ]]; then
            warn "Frontend assets changed since last E2E build (hash mismatch)"
            warn "  Built with: $BUILT_ASSET_HASH"
            warn "  Current:    $CURRENT_ASSET_HASH"
            return 1
        fi
    else
        warn "No E2E build marker found - cannot verify binary matches frontend"
        return 1
    fi

    # Get binary modification time
    BINARY_MTIME=$(stat -c %Y "$BINARY_PATH" 2>/dev/null || stat -f %m "$BINARY_PATH" 2>/dev/null)

    # Check if any source file is newer than binary
    NEEDS_REBUILD=false

    # Check frontend source
    NEWEST_SRC=$(find "$PROJECT_ROOT/src" -name "*.ts" -o -name "*.tsx" -o -name "*.css" 2>/dev/null | head -100 | xargs stat -c %Y 2>/dev/null | sort -rn | head -1 || echo "0")
    if [[ "$NEWEST_SRC" -gt "$BINARY_MTIME" ]]; then
        warn "Frontend source is newer than binary"
        NEEDS_REBUILD=true
    fi

    # Check Rust source
    NEWEST_RUST=$(find "$PROJECT_ROOT/src-tauri/src" -name "*.rs" 2>/dev/null | head -100 | xargs stat -c %Y 2>/dev/null | sort -rn | head -1 || echo "0")
    if [[ "$NEWEST_RUST" -gt "$BINARY_MTIME" ]]; then
        warn "Rust source is newer than binary"
        NEEDS_REBUILD=true
    fi

    # Check tauri.conf.json
    TAURI_CONF_MTIME=$(stat -c %Y "$PROJECT_ROOT/src-tauri/tauri.conf.json" 2>/dev/null || echo "0")
    if [[ "$TAURI_CONF_MTIME" -gt "$BINARY_MTIME" ]]; then
        warn "tauri.conf.json is newer than binary"
        NEEDS_REBUILD=true
    fi

    # Check if dist folder is newer than binary (prevents stale embedded assets)
    # This catches the case where frontend was rebuilt but Tauri binary wasn't
    DIST_INDEX_MTIME=$(stat -c %Y "$DIST_PATH/index.html" 2>/dev/null || stat -f %m "$DIST_PATH/index.html" 2>/dev/null || echo "0")
    if [[ "$DIST_INDEX_MTIME" -gt "$BINARY_MTIME" ]]; then
        warn "Frontend dist is newer than binary (would cause 'localhost refused' error)"
        NEEDS_REBUILD=true
    fi

    # Check package.json for dependency changes
    PKG_MTIME=$(stat -c %Y "$PROJECT_ROOT/package.json" 2>/dev/null || stat -f %m "$PROJECT_ROOT/package.json" 2>/dev/null || echo "0")
    if [[ "$PKG_MTIME" -gt "$BINARY_MTIME" ]]; then
        warn "package.json is newer than binary"
        NEEDS_REBUILD=true
    fi

    if $NEEDS_REBUILD; then
        return 1
    fi

    success "Binary is up to date"
    return 0
}

# ===== Build =====
do_build() {
    info "Building Stalagmight..."

    cd "$PROJECT_ROOT"

    # Build frontend with E2E test stores exposed
    info "Building frontend..."

    # Build Tauri binary (debug mode, no bundle)
    # On macOS, include the e2e feature for tauri-plugin-webdriver-automation
    if $IS_MACOS; then
        info "Building Tauri binary (debug mode, with e2e feature)..."
        env VITE_E2E=1 ${E2E_COVERAGE:+VITE_COVERAGE=1} pnpm tauri build --debug --no-bundle -- --features e2e
    else
        info "Building Tauri binary (debug mode)..."
        env VITE_E2E=1 ${E2E_COVERAGE:+VITE_COVERAGE=1} pnpm tauri build --debug --no-bundle
    fi

    # Create marker file with hash of dist/index.html to track what assets were built into binary
    md5sum "$DIST_PATH/index.html" 2>/dev/null | cut -d' ' -f1 > "$E2E_BUILD_MARKER"
    success "Build complete: $BINARY_PATH"
    info "Created E2E build marker: $E2E_BUILD_MARKER"
}

handle_build() {
    if $FORCE_REBUILD; then
        info "Forcing rebuild (--rebuild)"
        do_build
    elif ! check_build_freshness; then
        info "Binary needs rebuild"
        do_build
    fi
}

# ===== Run tests =====
run_tests() {
    info "Running WebdriverIO tests..."

    cd "$PROJECT_ROOT"

    # Build the command - use npx wdio directly to properly handle --spec flag
    # (pnpm test:e2e -- --spec doesn't pass the flag correctly)
    # Use env to set SKIP_BUILD so it works correctly when wrapped by xvfb-run
    CMD="env SKIP_BUILD=1 npx wdio run wdio.conf.ts"

    # Add wdio arguments
    if [[ ${#WDIO_ARGS[@]} -gt 0 ]]; then
        CMD="$CMD ${WDIO_ARGS[*]}"
    fi

    # Wrap with xvfb-run if needed
    if $USE_XVFB; then
        CMD="xvfb-run -a $CMD"
    fi

    info "Executing: $CMD"
    echo ""

    # Run the tests
    eval "$CMD"
}

# ===== Main =====
main() {
    echo ""
    echo "========================================"
    echo "  Stalagmight WebdriverIO E2E Test Runner"
    echo "========================================"
    echo ""

    parse_args "$@"

    # Reap our spawned processes on ANY exit (success, failure, or Ctrl-C), not
    # just at start — otherwise tauri-wd's flaky deleteSession leaves orphaned
    # app windows behind for the user to close by hand (issue #127). EXIT runs
    # cleanup_ports and preserves the test exit code; INT/TERM route through it.
    trap 'rc=$?; cleanup_ports exit; exit $rc' EXIT
    trap 'exit 130' INT TERM

    check_platform
    check_tauri_driver
    check_display
    cleanup_ports
    handle_build
    run_tests
}

main "$@"
