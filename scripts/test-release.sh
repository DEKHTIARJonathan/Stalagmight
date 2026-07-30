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
  # Give the clone its own identity. Several commits land here that this script
  # does not make itself - release.sh's, and the fixture commits below - so a
  # machine with no global user.name/user.email (a fresh runner or container)
  # would fail them with "Author identity unknown".
  git -C "$dir" config user.email "test@example.invalid"
  git -C "$dir" config user.name "release test"
  # Detach at the exact commit under test rather than trusting which branch the
  # clone checked out, which works the same on a branch and in CI's detached HEAD.
  git -C "$dir" checkout --quiet --detach "$sha"
  # Test the script as it exists on disk, not as last committed, so this is
  # useful while iterating on it too. Committed in the clone so the cases can
  # assert on a clean tree without seeing this copy as a modification.
  cp "$PROJECT_ROOT/scripts/release.sh" "$dir/scripts/release.sh"
  git -C "$dir" add scripts/release.sh
  git -C "$dir" commit --quiet --allow-empty -m "test: script under test"
  echo "$dir"
}

version_of() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" | head -1
}

# Cargo.lock has a `version = "..."` line per dependency, so read only the one
# belonging to this crate: the line right after its `name` line.
lock_version_of() {
  awk '
    /^name = "stalagmight"$/ {
      if ((getline nxt) > 0 && nxt ~ /^version = "/) {
        gsub(/^version = "|"$/, "", nxt)
        print nxt
      }
    }
  ' "$1/src-tauri/Cargo.lock"
}

# Rewrite that line to an arbitrary value, to fixture a drifted lock.
set_lock_version() {
  awk -v v="$2" '
    /^name = "stalagmight"$/ { print; getline; print "version = \"" v "\""; next }
    { print }
  ' "$1/src-tauri/Cargo.lock" > "$1/.locktmp"
  mv "$1/.locktmp" "$1/src-tauri/Cargo.lock"
}

echo "== case 1: a normal bump rewrites all four files, commits and tags =="
D=$(fresh_clone case1)
if "$D/scripts/release.sh" 9.9.9 --no-edit >/dev/null 2>&1; then
  assert "package.json bumped"       test "$(version_of "$D")" = "9.9.9"
  assert "tauri.conf.json bumped"    grep -q '"version": "9.9.9"' "$D/src-tauri/tauri.conf.json"
  assert "Cargo.toml bumped"         grep -q '^version = "9.9.9"' "$D/src-tauri/Cargo.toml"
  # Cargo.lock is the fourth version file. Before #352 it was left behind, which
  # nothing failed on: the next cargo invocation rewrote it in place, so the only
  # symptom was an unexplained dirty lock in a tree the release called clean.
  assert "Cargo.lock bumped"         test "$(lock_version_of "$D")" = "9.9.9"
  assert "Cargo.lock is in the release commit" \
    bash -c 'git -C "$1" show --name-only --format= HEAD | grep -qx "src-tauri/Cargo.lock"' _ "$D"
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

echo "== case 4b: a Cargo.lock already out of step aborts before ANY file is written =="
# The lock drifting behind is the #352 bug. If it is ALREADY wrong when a release
# starts, bumping it to the new version would paper over that instead of pointing
# at it, so the pre-flight refuses rather than guessing which one is right.
D=$(fresh_clone case4b)
set_lock_version "$D" 0.0.1
git -C "$D" commit --quiet -am "desync Cargo.lock from Cargo.toml"
if "$D/scripts/release.sh" 7.7.7 --no-edit >/dev/null 2>&1; then
  fail "accepted a Cargo.lock that disagreed with package.json"
else
  pass "refused a Cargo.lock that disagreed with package.json"
  refute "package.json left untouched" grep -q '"version": "7.7.7"' "$D/package.json"
  assert "lock left as found"          test "$(lock_version_of "$D")" = "0.0.1"
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

echo "== case 6: --no-tag bumps and commits but creates no tag =="
D=$(fresh_clone case6)
if "$D/scripts/release.sh" 5.5.5 --no-edit --no-tag >/dev/null 2>&1; then
  assert "package.json bumped"      test "$(version_of "$D")" = "5.5.5"
  assert "changelog moved"          grep -q '^## \[5\.5\.5\]' "$D/CHANGELOG.md"
  assert "committed, tree clean"    tree_clean "$D"
  refute "no tag created"           has_tag "$D" v5.5.5
else
  fail "release.sh --no-tag exited non-zero"
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

# Every release explains how to get past the first-launch block and how to check
# what was downloaded.
assert "installing footer present" \
  bash -c 'CHANGELOG='"$FIXTURE"' bash '"$NOTES"' v0.4.0 | grep -q "SHA256SUMS"'
assert "apple silicon caveat present" \
  bash -c 'CHANGELOG='"$FIXTURE"' bash '"$NOTES"' v0.4.0 | grep -q "Apple Silicon only"'

# The signing claim in this footer went stale once already: the very change that
# made the macOS app signable (#350) was about to publish notes still saying the
# builds were unsigned, because the fix updated the changelog and docs but not the
# script that generates what recipients read. Pin both directions, so a future
# signing change has to update this text deliberately rather than silently ship a
# contradiction.
refute "footer no longer claims the builds are unsigned" \
  bash -c 'CHANGELOG='"$FIXTURE"' bash '"$NOTES"' v0.4.0 | grep -q "not code-signed"'
assert "footer says macOS is ad-hoc signed" \
  bash -c 'CHANGELOG='"$FIXTURE"' bash '"$NOTES"' v0.4.0 | grep -q "ad-hoc signed"'
# The quarantine command is the one instruction that holds on every macOS version;
# the Control-click override was removed in macOS 15, so it cannot be the only path
# offered.
assert "footer gives the version-independent quarantine command" \
  bash -c 'CHANGELOG='"$FIXTURE"' bash '"$NOTES"' v0.4.0 | grep -q "xattr -dr com.apple.quarantine"'

# An empty changelog must still yield a usable body, never nothing.
printf '%s\n' '# Changelog' '' '## [Unreleased]' '' > "$WORK/empty.md"
assert "empty changelog still produces a body" \
  bash -c 'CHANGELOG='"$WORK"'/empty.md bash '"$NOTES"' v1.2.3 | grep -q "Release v1.2.3"'

echo
echo "release tooling: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
