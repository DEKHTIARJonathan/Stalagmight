#!/bin/bash
#
# wdio.sh - Comprehensive WebdriverIO E2E Test Runner for CaveChef
#
# This script handles all the common issues that can cause WebdriverIO tests to fail:
# - Platform verification (Linux/Windows only)
# - tauri-driver installation check
# - Display detection (headed vs headless with xvfb)
# - Port cleanup (kills stale tauri-driver/cavechef processes)
# - Build freshness check (rebuilds if source is newer than binary)
#
# Usage:
#   ./scripts/wdio.sh                    # Run all tests, auto-detect display
#   ./scripts/wdio.sh --rebuild          # Force rebuild before tests
#   ./scripts/wdio.sh --skip-build       # Skip build checks (dangerous)
#   ./scripts/wdio.sh --spec e2e/specs/foo.spec.ts  # Run specific spec
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
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cargo_build}"
BINARY_PATH="$CARGO_TARGET_DIR/debug/cavechef"
DIST_PATH="$PROJECT_ROOT/dist"

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
CaveChef WebdriverIO E2E Test Runner

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
  $0 --spec e2e/specs/dmp-integration.spec.ts  # Run specific spec
  $0 --headless --spec e2e/specs/foo.spec.ts   # Force xvfb, run specific spec

Environment Variables:
  CARGO_TARGET_DIR  Location of cargo build output (default: ~/.cargo_build)
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
            error "macOS is not supported by tauri-driver."
            error "WebdriverIO E2E tests can only run on Linux or Windows."
            echo ""
            echo "Alternative options:"
            echo "  - Use Playwright tests: pnpm test:ui"
            echo "  - Run tests in a Linux VM or container"
            exit 1
            ;;
        *)
            error "Unknown platform: $(uname -s)"
            error "WebdriverIO E2E tests require Linux or Windows."
            exit 1
            ;;
    esac
}

# ===== tauri-driver check =====
check_tauri_driver() {
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
}

# ===== Display detection =====
HAS_DISPLAY=false
USE_XVFB=false

check_display() {
    info "Checking display availability..."

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

# ===== Port cleanup =====
cleanup_ports() {
    info "Cleaning up stale processes..."

    # Kill any existing tauri-driver processes
    if pgrep -x tauri-driver > /dev/null 2>&1; then
        warn "Found running tauri-driver, killing..."
        pkill -9 tauri-driver 2>/dev/null || true
    fi

    # Kill any existing WebKitWebDriver processes (used internally by tauri-driver)
    if pgrep -x WebKitWebDriver > /dev/null 2>&1; then
        warn "Found running WebKitWebDriver, killing..."
        pkill -9 WebKitWebDriver 2>/dev/null || true
    fi

    # Kill any stale cavechef processes
    if pgrep -x cavechef > /dev/null 2>&1; then
        warn "Found running cavechef, killing..."
        pkill -9 cavechef 2>/dev/null || true
    fi

    # Check if ports are in use and free them
    for port in 4444 4445; do
        if command -v fuser &> /dev/null && fuser "$port/tcp" > /dev/null 2>&1; then
            warn "Port $port in use, killing process..."
            fuser -k "$port/tcp" 2>/dev/null || true
        fi
    done

    # Wait for processes to terminate
    sleep 1

    success "Port cleanup complete"
}

# ===== Build freshness check =====
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

    if $NEEDS_REBUILD; then
        return 1
    fi

    success "Binary is up to date"
    return 0
}

# ===== Build =====
do_build() {
    info "Building CaveChef..."

    cd "$PROJECT_ROOT"

    # Build frontend
    info "Building frontend..."
    pnpm build

    # Build Tauri binary (debug mode, no bundle)
    info "Building Tauri binary (debug mode)..."
    pnpm tauri build --debug --no-bundle

    success "Build complete: $BINARY_PATH"
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

    # Build the command
    CMD="pnpm test:e2e"

    # Add wdio arguments
    if [[ ${#WDIO_ARGS[@]} -gt 0 ]]; then
        CMD="$CMD -- ${WDIO_ARGS[*]}"
    fi

    # Wrap with xvfb-run if needed
    if $USE_XVFB; then
        CMD="xvfb-run -a $CMD"
    fi

    # Prepend SKIP_BUILD (after xvfb-run handling)
    CMD="SKIP_BUILD=1 $CMD"

    info "Executing: $CMD"
    echo ""

    # Run the tests
    eval "$CMD"
}

# ===== Main =====
main() {
    echo ""
    echo "========================================"
    echo "  CaveChef WebdriverIO E2E Test Runner"
    echo "========================================"
    echo ""

    parse_args "$@"
    check_platform
    check_tauri_driver
    check_display
    cleanup_ports
    handle_build
    run_tests
}

main "$@"
