#!/usr/bin/env bash
set -euo pipefail

# release.sh — bump version, update changelog, commit and tag
#
# Usage:
#   ./scripts/release.sh <major|minor|patch|X.Y.Z> [--no-edit] [--dry-run]

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
  echo "  CHANGELOG.md:         prepend v$NEW_VERSION section"
  echo "[dry-run] Would commit: chore: release v$NEW_VERSION"
  echo "[dry-run] Would tag:    v$NEW_VERSION"
  exit 0
fi

# --- Check for uncommitted changes ---
if ! git -C "$PROJECT_ROOT" diff --quiet HEAD 2>/dev/null; then
  echo "Error: there are uncommitted changes. Commit or stash them first." >&2
  exit 1
fi

# --- Update package.json ---
sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$PROJECT_ROOT/package.json"

# --- Update tauri.conf.json ---
sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$PROJECT_ROOT/src-tauri/tauri.conf.json"

# --- Update Cargo.toml (only the package version line) ---
sed -i "s/^version = \"$CURRENT_VERSION\"/version = \"$NEW_VERSION\"/" "$PROJECT_ROOT/src-tauri/Cargo.toml"

# --- Update CHANGELOG.md ---
TODAY=$(date +%Y-%m-%d)

# Generate git log since last tag (or all commits if no tags)
LAST_TAG=$(git -C "$PROJECT_ROOT" describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
  GIT_LOG=$(git -C "$PROJECT_ROOT" log "$LAST_TAG"..HEAD --pretty=format:"- %s" --no-merges)
else
  GIT_LOG=$(git -C "$PROJECT_ROOT" log --pretty=format:"- %s" --no-merges --max-count=20)
fi

if [ -z "$GIT_LOG" ]; then
  GIT_LOG="- No changes recorded"
fi

# Insert new section after [Unreleased] line using awk (sed can't handle special chars in git log)
CHANGELOG="$PROJECT_ROOT/CHANGELOG.md"
awk -v ver="$NEW_VERSION" -v date="$TODAY" -v changes="$GIT_LOG" '
  /^## \[Unreleased\]/ {
    print
    printf "\n## [%s] - %s\n\n%s\n", ver, date, changes
    next
  }
  { print }
' "$CHANGELOG" > "$CHANGELOG.tmp" && mv "$CHANGELOG.tmp" "$CHANGELOG"

# --- Open editor for changelog review ---
if [ "$NO_EDIT" = false ]; then
  EDITOR="${EDITOR:-${VISUAL:-vi}}"
  "$EDITOR" "$PROJECT_ROOT/CHANGELOG.md"
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
