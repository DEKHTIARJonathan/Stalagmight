#!/usr/bin/env bash
set -euo pipefail

# test-release.sh - exercise scripts/release.sh against a throwaway clone.
#
# release.sh rewrites version strings across three files and then commits and
# tags. Nothing else in the repo verifies it, and it only runs for real when
# someone is cutting a release - the worst moment to discover a bug in it. Each
# case below drives the real script and asserts on the resulting tree.
#
# Usage: ./scripts/test-release.sh

SCRIPT_DIR="$(dirname "$(realpath "$0")")"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/release-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

fail() {
  echo "  FAIL: $1" >&2
  FAIL=$((FAIL + 1))
}

pass() {
  echo "  ok: $1"
  PASS=$((PASS + 1))
}

# assert "label" cmd...  - the command must succeed
# refute "label" cmd...  - the command must fail
# Spelled out rather than `cmd && pass || fail`, which double-reports if `pass`
# ever returns non-zero.
assert() {
  local msg="$1"
  shift
  if "$@"; then pass "$msg"; else fail "$msg"; fi
}

refute() {
  local msg="$1"
  shift
  if "$@"; then fail "$msg"; else pass "$msg"; fi
}

tree_clean() {
  [ -z "$(git -C "$1" status --porcelain)" ]
}

has_tag() {
  git -C "$1" rev-parse -q --verify "refs/tags/$2" >/dev/null
}

# A fresh clone per case, so one case's mutations can't reach the next.
fresh_clone() {
  local dir="$WORK/$1" sha
  sha="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
  rm -rf "$dir"
  git clone --quiet --local --no-hardlinks "$PROJECT_ROOT" "$dir"
  # Detach at the exact commit under test rather than trusting which branch the
  # clone checked out, which works the same on a branch and in CI's detached HEAD.
  git -C "$dir" checkout --quiet --detach "$sha"
  # Test the script as it exists on disk, not as last committed, so this is
  # useful while iterating on it too. Committed in the clone so the cases can
  # assert on a clean tree without seeing this copy as a modification.
  cp "$PROJECT_ROOT/scripts/release.sh" "$dir/scripts/release.sh"
  git -C "$dir" add scripts/release.sh
  git -C "$dir" -c user.email=test@example.invalid -c user.name=test \
    commit --quiet --allow-empty -m "test: script under test"
  echo "$dir"
}

version_of() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" | head -1
}

echo "== case 1: a normal bump rewrites all three files, commits and tags =="
D=$(fresh_clone case1)
if "$D/scripts/release.sh" 9.9.9 --no-edit >/dev/null 2>&1; then
  assert "package.json bumped"       test "$(version_of "$D")" = "9.9.9"
  assert "tauri.conf.json bumped"    grep -q '"version": "9.9.9"' "$D/src-tauri/tauri.conf.json"
  assert "Cargo.toml bumped"         grep -q '^version = "9.9.9"' "$D/src-tauri/Cargo.toml"
  assert "changelog section created" grep -q '^## \[9\.9\.9\]' "$D/CHANGELOG.md"
  assert "tag created"               has_tag "$D" v9.9.9
  assert "tree clean after release"  tree_clean "$D"
else
  fail "release.sh exited non-zero on the happy path"
fi

echo "== case 2: re-releasing the current version is refused =="
D=$(fresh_clone case2)
CUR=$(version_of "$D")
if "$D/scripts/release.sh" "$CUR" --no-edit >/dev/null 2>&1; then
  fail "accepted a no-op bump to the current version"
else
  pass "refused a no-op bump"
  assert "tree untouched" tree_clean "$D"
fi

echo "== case 3: an existing tag is refused =="
D=$(fresh_clone case3)
git -C "$D" tag v8.8.8
if "$D/scripts/release.sh" 8.8.8 --no-edit >/dev/null 2>&1; then
  fail "accepted a version whose tag already exists"
else
  pass "refused an existing tag"
  assert "tree untouched" tree_clean "$D"
fi

echo "== case 4: a drifted version format aborts before ANY file is written =="
# This is the case that used to leave two of three files bumped on disk.
D=$(fresh_clone case4)
sed 's/^version = /version    = /' "$D/src-tauri/Cargo.toml" > "$D/ct" && mv "$D/ct" "$D/src-tauri/Cargo.toml"
git -C "$D" commit --quiet -am "perturb the Cargo.toml version format"
if "$D/scripts/release.sh" 7.7.7 --no-edit >/dev/null 2>&1; then
  fail "accepted a drifted version format"
else
  pass "refused a drifted version format"
  refute "package.json left untouched" grep -q '"version": "7.7.7"' "$D/package.json"
  assert "tree clean, nothing to hand-revert" tree_clean "$D"
fi

echo "== case 5: an empty [Unreleased] section aborts before anything is written =="
# Guards against shipping a release whose notes are just "Release vX.Y.Z": the
# workflow falls back to that bare body when it finds no changelog section.
D=$(fresh_clone case5)
printf '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n- something old\n' \
  > "$D/CHANGELOG.md"
git -C "$D" commit --quiet -am "empty the Unreleased section"
if "$D/scripts/release.sh" 6.6.6 --no-edit >/dev/null 2>&1; then
  fail "accepted an empty [Unreleased] section"
else
  pass "refused an empty [Unreleased] section"
  refute "version files untouched" grep -q '"version": "6.6.6"' "$D/package.json"
  refute "no tag created" has_tag "$D" v6.6.6
fi

echo "== release-notes.sh =="
NOTES="$PROJECT_ROOT/scripts/release-notes.sh"
FIXTURE="$WORK/CHANGELOG.md"
printf '%s\n' \
  '# Changelog' '' \
  '## [Unreleased]' '' '- unreleased thing' '' \
  '## [0.4.0] - 2026-01-01' '' '- the 0.4.0 thing' '' \
  > "$FIXTURE"

# A final tag takes its own section.
assert "final tag uses its version's section" \
  bash -c 'CHANGELOG='"$FIXTURE"' bash '"$NOTES"' v0.4.0 | grep -q "the 0.4.0 thing"'
refute "final tag has no candidate banner" \
  bash -c 'CHANGELOG='"$FIXTURE"' bash '"$NOTES"' v0.4.0 | grep -q "Release candidate"'

# A candidate takes the notes of the version it is a candidate for, not its own
# (nonexistent) section, and says clearly that it is a candidate.
assert "candidate uses the base version's section" \
  bash -c 'CHANGELOG='"$FIXTURE"' bash '"$NOTES"' v0.4.0-rc1 | grep -q "the 0.4.0 thing"'
assert "candidate is labelled as one" \
  bash -c 'CHANGELOG='"$FIXTURE"' bash '"$NOTES"' v0.4.0-rc1 | grep -q "Release candidate for 0.4.0"'

# Before release.sh moves it, a version has no section yet - fall back to
# [Unreleased] rather than publishing an empty body.
assert "unmoved version falls back to Unreleased" \
  bash -c 'CHANGELOG='"$FIXTURE"' bash '"$NOTES"' v9.9.9 | grep -q "unreleased thing"'

# Every release explains how to install an unsigned build and how to check it.
assert "installing footer present" \
  bash -c 'CHANGELOG='"$FIXTURE"' bash '"$NOTES"' v0.4.0 | grep -q "SHA256SUMS"'
assert "apple silicon caveat present" \
  bash -c 'CHANGELOG='"$FIXTURE"' bash '"$NOTES"' v0.4.0 | grep -q "Apple Silicon only"'

# An empty changelog must still yield a usable body, never nothing.
printf '%s\n' '# Changelog' '' '## [Unreleased]' '' > "$WORK/empty.md"
assert "empty changelog still produces a body" \
  bash -c 'CHANGELOG='"$WORK"'/empty.md bash '"$NOTES"' v1.2.3 | grep -q "Release v1.2.3"'

echo
echo "release tooling: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
