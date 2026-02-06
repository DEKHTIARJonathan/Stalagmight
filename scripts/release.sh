#!/usr/bin/env bash
set -euo pipefail

# release.sh — bump version, update changelog, commit and tag
#
# Usage:
#   ./scripts/release.sh <major|minor|patch|X.Y.Z> [--no-edit] [--dry-run]
#
# The changelog is driven by the ## [Unreleased] section in CHANGELOG.md.
# Write your release notes there BEFORE running this script. The script
# moves that content under the new version header.
#
# If the [Unreleased] section is empty, the script aborts (unless --no-edit
# is omitted, in which case it opens $EDITOR so you can write notes).

SCRIPT_DIR="$(dirname "$(realpath "$0")")"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# --- Parse arguments ---
VERSION_ARG=""
NO_EDIT=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --no-edit) NO_EDIT=true ;;
    --dry-run) DRY_RUN=true ;;
    -*) echo "Unknown flag: $arg" >&2; exit 1 ;;
    *) VERSION_ARG="$arg" ;;
  esac
done

if [ -z "$VERSION_ARG" ]; then
  echo "Usage: $0 <major|minor|patch|X.Y.Z> [--no-edit] [--dry-run]" >&2
  exit 1
fi

# --- Read current version from package.json ---
CURRENT_VERSION=$(grep -oP '"version":\s*"\K[^"]+' "$PROJECT_ROOT/package.json" | head -1)
echo "Current version: $CURRENT_VERSION"

# --- Compute new version ---
IFS='.' read -r CUR_MAJOR CUR_MINOR CUR_PATCH <<< "$CURRENT_VERSION"

case "$VERSION_ARG" in
  major) NEW_VERSION="$((CUR_MAJOR + 1)).0.0" ;;
  minor) NEW_VERSION="$CUR_MAJOR.$((CUR_MINOR + 1)).0" ;;
  patch) NEW_VERSION="$CUR_MAJOR.$CUR_MINOR.$((CUR_PATCH + 1))" ;;
  *)
    # Validate explicit X.Y.Z
    if [[ ! "$VERSION_ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Error: version must be 'major', 'minor', 'patch', or X.Y.Z" >&2
      exit 1
    fi
    NEW_VERSION="$VERSION_ARG"
    ;;
esac

echo "New version: $NEW_VERSION"

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "[dry-run] Would update:"
  echo "  package.json:         $CURRENT_VERSION -> $NEW_VERSION"
  echo "  src-tauri/tauri.conf.json: $CURRENT_VERSION -> $NEW_VERSION"
  echo "  src-tauri/Cargo.toml: $CURRENT_VERSION -> $NEW_VERSION"
  echo "  CHANGELOG.md:         move [Unreleased] content under v$NEW_VERSION"
  echo "[dry-run] Would commit: chore: release v$NEW_VERSION"
  echo "[dry-run] Would tag:    v$NEW_VERSION"
  exit 0
fi

# --- Check for uncommitted changes (allow staged CHANGELOG.md) ---
CHANGED=$(git -C "$PROJECT_ROOT" diff --name-only HEAD 2>/dev/null | grep -v '^CHANGELOG.md$' || true)
if [ -n "$CHANGED" ]; then
  echo "Error: there are uncommitted changes (other than CHANGELOG.md). Commit or stash them first." >&2
  exit 1
fi

# --- Read [Unreleased] section from CHANGELOG.md ---
CHANGELOG="$PROJECT_ROOT/CHANGELOG.md"
UNRELEASED=$(awk '
  /^## \[Unreleased\]/ { found=1; next }
  found && /^## \[/ { exit }
  found { print }
' "$CHANGELOG" | sed '/^$/d')

if [ -z "$UNRELEASED" ] && [ "$NO_EDIT" = true ]; then
  echo "Error: ## [Unreleased] section in CHANGELOG.md is empty." >&2
  echo "Write release notes there before running with --no-edit." >&2
  exit 1
fi

if [ -z "$UNRELEASED" ] && [ "$NO_EDIT" = false ]; then
  echo "## [Unreleased] section is empty. Opening editor..."
  EDITOR="${EDITOR:-${VISUAL:-vi}}"
  "$EDITOR" "$CHANGELOG"
  # Re-read after edit
  UNRELEASED=$(awk '
    /^## \[Unreleased\]/ { found=1; next }
    found && /^## \[/ { exit }
    found { print }
  ' "$CHANGELOG" | sed '/^$/d')
  if [ -z "$UNRELEASED" ]; then
    echo "Error: [Unreleased] section is still empty. Aborting." >&2
    exit 1
  fi
fi

# --- Update package.json ---
sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$PROJECT_ROOT/package.json"

# --- Update tauri.conf.json ---
sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$PROJECT_ROOT/src-tauri/tauri.conf.json"

# --- Update Cargo.toml (only the package version line) ---
sed -i "s/^version = \"$CURRENT_VERSION\"/version = \"$NEW_VERSION\"/" "$PROJECT_ROOT/src-tauri/Cargo.toml"

# --- Update CHANGELOG.md: move [Unreleased] content under new version header ---
TODAY=$(date +%Y-%m-%d)

awk -v ver="$NEW_VERSION" -v date="$TODAY" '
  /^## \[Unreleased\]/ {
    print "## [Unreleased]"
    printf "\n## [%s] - %s\n", ver, date
    # Skip blank lines between [Unreleased] and content, content is already there
    next
  }
  { print }
' "$CHANGELOG" > "$CHANGELOG.tmp" && mv "$CHANGELOG.tmp" "$CHANGELOG"

# --- Open editor for final review ---
if [ "$NO_EDIT" = false ]; then
  EDITOR="${EDITOR:-${VISUAL:-vi}}"
  "$EDITOR" "$CHANGELOG"
fi

# --- Commit and tag ---
git -C "$PROJECT_ROOT" add \
  package.json \
  src-tauri/tauri.conf.json \
  src-tauri/Cargo.toml \
  CHANGELOG.md

git -C "$PROJECT_ROOT" commit -m "chore: release v$NEW_VERSION"
git -C "$PROJECT_ROOT" tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

echo ""
echo "Released v$NEW_VERSION"
echo ""
echo "Next steps:"
echo "  git push && git push --tags"
