#!/usr/bin/env bash
set -euo pipefail

# release-tag.sh - tag an already-bumped tree, with the checks release.sh has.
#
# Usage:
#   ./scripts/release-tag.sh <vX.Y.Z|vX.Y.Z-rcN> [--allow-unannounced] [--dry-run]
#
# There are two release flows (docs/releasing.md). release.sh owns the first:
# bump the four version files, move the changelog, commit. This script owns the
# second - tagging a tree that is already at the right version - which is how
# every release candidate and every release that follows one gets cut.
#
# That second flow used to be three hand-typed git commands outside every guard
# the tooling has, which is how four fixes shipped unannounced between v0.5.0-rc1
# and rc2 (#406). What it checks, none of it new information, all of it
# previously left to the operator remembering:
#
#   - the tag is well-formed and does not already exist
#   - the tree is clean, so the tag means what the commit says
#   - all four version files read the tag's base version, so v0.5.1-rc1 cannot
#     be cut from a tree still saying 0.5.0
#   - the notes that will actually be published are non-empty, and nothing is
#     left under [Unreleased] to ship unannounced
#
# It creates a local tag and stops. Pushing is the irreversible step - it starts
# a paid three-platform build and, for a bare vX.Y.Z, publishes as "Latest" - so
# it stays a deliberate act, printed as the next step rather than done for you.
#
# The version files deliberately stay at the plain X.Y.Z for a candidate: the
# Windows MSI bundler rejects a non-numeric pre-release identifier, so an
# in-tree 0.5.0-rc1 fails the Windows build outright. The candidate lives only
# in the tag.

SCRIPT_DIR="$(dirname "$(realpath "$0")")"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/release-version.sh
. "$SCRIPT_DIR/lib/release-version.sh"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/release-tag.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# --- Parse arguments ---
TAG=""
ALLOW_UNANNOUNCED=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --allow-unannounced) ALLOW_UNANNOUNCED=true ;;
    --dry-run) DRY_RUN=true ;;
    -*) echo "Unknown flag: $arg" >&2; exit 1 ;;
    *)
      # Refuse a second tag rather than silently keeping the last one: the two
      # spellings of a near-miss ("v0.5.0 v0.5.1") should not quietly pick one.
      if [ -n "$TAG" ]; then
        echo "Error: more than one tag given ('$TAG' and '$arg'). Tag one at a time." >&2
        exit 1
      fi
      TAG="$arg"
      ;;
  esac
done

if [ -z "$TAG" ]; then
  echo "Usage: $0 <vX.Y.Z|vX.Y.Z-rcN> [--allow-unannounced] [--dry-run]" >&2
  exit 1
fi

# A suffixed tag is a pre-release. The shape accepted here has to stay in step
# with .github/workflows/release.yml, which decides `--prerelease` from the same
# property by matching `*-*` on the tag name: anything this script accepts as a
# candidate must be something that workflow will refuse to mark as "Latest".
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "Error: '$TAG' is not a release tag." >&2
  echo "Expected vX.Y.Z for a release, or vX.Y.Z-<suffix> (e.g. v0.5.1-rc1) for a candidate." >&2
  exit 1
fi

VERSION="${TAG#v}"
BASE_VERSION="${VERSION%%-*}"
PRERELEASE=false
[ "$VERSION" != "$BASE_VERSION" ] && PRERELEASE=true

# --- Pre-flight: everything read-only, before the tag is created ---

if git -C "$PROJECT_ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists." >&2
  echo "Candidates are kept, not recycled - a tester's bug report names one." >&2
  echo "Cut the next number instead." >&2
  exit 1
fi

# Stricter than release.sh, which tolerates a dirty CHANGELOG.md because it is
# about to commit it. Here there is no commit: anything uncommitted is by
# definition not in the tree being tagged, so a dirty changelog means the notes
# on disk are not the notes that will publish.
#
# Untracked files count too, and the message has to say so: `git stash` without
# `-u` does not take them, so "commit or stash" alone is advice that does not
# work. An untracked file cannot change what the tag names, but a release cut
# with one sitting there is usually a forgotten `git add`, which can.
DIRT="$(git -C "$PROJECT_ROOT" status --porcelain)"
if [ -n "$DIRT" ]; then
  echo "Error: the working tree is not clean." >&2
  echo "A tag names a commit, so nothing below is in the release:" >&2
  printf '%s\n' "$DIRT" | sed 's/^/  /' >&2
  echo "Commit them (or 'git stash -u' - plain stash leaves '??' files behind)." >&2
  echo "Nothing was tagged." >&2
  exit 1
fi

# The check the manual flow never had. Cutting v0.5.1-rc1 from a tree whose
# manifests still say 0.5.0 builds artifacts named Stalagmight_0.5.0_* and an
# About box reading 0.5.0, from a tag promising otherwise.
if ! version_files_match "$BASE_VERSION" "tag $TAG" "for $TAG"; then
  echo "" >&2
  echo "The version files do not match the tag. Either you meant a different tag," >&2
  echo "or the bump never ran: ./scripts/release.sh $BASE_VERSION --no-edit --no-tag" >&2
  echo "Nothing was tagged." >&2
  exit 1
fi

# --- The notes that will actually be published ---
#
# Rendered by the same script the workflow runs, rather than re-deriving which
# changelog section wins here. That is the whole point: a check built on a second
# model of the selection rule can agree with itself and still disagree with what
# publishes.
#
# CHANGELOG is pinned rather than inherited. release-notes.sh takes
# `${CHANGELOG:-...}` so a caller can point it at a fixture, which is how
# test-release.sh exercises it - but here that override would aim the gate at
# one file while CI publishes from the repository's own, and the stale-date
# advisory below already reads the real one. An exported CHANGELOG would then
# wave through a tag whose actual notes leave entries unannounced.
NOTES_ERR="$SCRATCH/notes.err"
if ! BODY="$(CHANGELOG="$PROJECT_ROOT/CHANGELOG.md" "$SCRIPT_DIR/release-notes.sh" "$TAG" 2>"$NOTES_ERR")"; then
  echo "Error: release-notes.sh failed for $TAG, so the published body is unknown." >&2
  cat "$NOTES_ERR" >&2
  echo "Nothing was tagged." >&2
  exit 1
fi

# release-notes.sh falls back to this exact one-line body when it finds no
# section at all. Publishing it would announce a release by restating its
# version number, so treat it as a missing changelog rather than a valid body.
# -F because the tag's dots are literals here, not wildcards.
if printf '%s\n' "$BODY" | grep -qxF "Release $TAG"; then
  echo "Error: CHANGELOG.md has no notes for $TAG." >&2
  echo "Neither '## [$BASE_VERSION]' nor '## [Unreleased]' has any content, so the" >&2
  echo "published body would be the bare string 'Release $TAG'." >&2
  echo "Write the notes first. Nothing was tagged." >&2
  exit 1
fi

# The gate this script exists for. Once '## [X.Y.Z]' exists - the state every
# candidate after the first is cut from - release-notes.sh stops reading
# [Unreleased] entirely, so entries left there ship in the binary and appear in
# no notes. It has always warned about this; nothing called it before a tag
# existed, and the warning it prints from CI arrives after publication.
#
# Coupled to that script's wording on purpose, so there is one definition of the
# condition rather than two. test-release.sh pins both ends: that release-notes.sh
# still emits this string, and that this script refuses when it does.
if grep -q "will NOT be published" "$NOTES_ERR"; then
  if [ "$ALLOW_UNANNOUNCED" = false ]; then
    cat "$NOTES_ERR" >&2
    echo "Refusing to tag. Fold those entries into '## [$BASE_VERSION]' in CHANGELOG.md," >&2
    echo "commit, and re-run - or pass --allow-unannounced to ship them unmentioned." >&2
    echo "Nothing was tagged." >&2
    exit 1
  fi
  cat "$NOTES_ERR" >&2
  echo "Continuing anyway: --allow-unannounced was passed." >&2
  echo "" >&2
fi

# --- Advisories: worth seeing, not worth blocking on ---

# A final release that was never a candidate is legitimate (a hotfix, a patch
# nobody needs to test first), so this is a note. It is here because the
# opposite mistake - believing rc3 was tested when the tag was never pushed - is
# invisible otherwise.
if [ "$PRERELEASE" = false ]; then
  if [ -z "$(git -C "$PROJECT_ROOT" tag --list "v${BASE_VERSION}-*")" ]; then
    echo "note: no v${BASE_VERSION}-rcN tag exists - this release was never cut as a candidate." >&2
  fi

  # release.sh stamped the section header the day the version was bumped, which
  # for anything that went through candidates is well before the day it ships.
  # The date is published verbatim in the notes.
  # A literal prefix via index(), not a regex. awk re-processes backslash escapes
  # in a -v assignment, so a grep/sed-escaped version arrives with its dots bare
  # and "## [0X5Y0] - ..." would match - the escaping defeated by the tool it was
  # handed to. release.sh writes exactly this header shape; anything else simply
  # yields no date and no advisory.
  SECTION_DATE="$(awk -v hdr="## [$BASE_VERSION] - " '
    index($0, hdr) == 1 { print $NF; exit }
  ' "$PROJECT_ROOT/CHANGELOG.md")"
  TODAY="$(date +%Y-%m-%d)"
  if [ -n "$SECTION_DATE" ] && [ "$SECTION_DATE" != "$TODAY" ]; then
    echo "note: CHANGELOG.md dates $BASE_VERSION as $SECTION_DATE, but today is $TODAY." >&2
    echo "      That date is published as-is; it is stamped when the version is bumped," >&2
    echo "      not when it ships. Update it first if it should read today." >&2
  fi
fi

# Pushing a tag pushes the commit with it, so this is not broken - but it would
# publish a release built from a commit that is on nobody else's master.
if git -C "$PROJECT_ROOT" rev-parse -q --verify refs/remotes/origin/master >/dev/null 2>&1; then
  if ! git -C "$PROJECT_ROOT" merge-base --is-ancestor HEAD refs/remotes/origin/master 2>/dev/null; then
    echo "note: HEAD is not an ancestor of origin/master (as last fetched)." >&2
    echo "      Push the branch before the tag, or the release ships a commit master does not have." >&2
  fi
fi

# --- Show the operator what they are about to publish ---
echo "Tag:      $TAG"
echo "Version:  $BASE_VERSION (in package.json, tauri.conf.json, Cargo.toml, Cargo.lock)"
echo "Commit:   $(git -C "$PROJECT_ROOT" log -1 --format='%h %s')"
if [ "$PRERELEASE" = true ]; then
  echo "Kind:     pre-release (published as a candidate, never as Latest)"
else
  echo "Kind:     release (published as Latest)"
fi
echo ""
echo "--- release body ---"
printf '%s\n' "$BODY"
echo "--- end release body ---"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would tag: $TAG"
  exit 0
fi

if [ "$PRERELEASE" = true ]; then
  git -C "$PROJECT_ROOT" tag -a "$TAG" -m "Release candidate $TAG"
else
  git -C "$PROJECT_ROOT" tag -a "$TAG" -m "Release $TAG"
fi

echo "Created $TAG locally. Nothing is published until it is pushed."
echo ""
echo "Next step:"
echo "  git push origin $TAG"
