# shellcheck shell=bash
# release-version.sh - the version-file checks shared by the release scripts.
#
# Sourced, never executed. The caller must set PROJECT_ROOT before sourcing.
#
# Two scripts need to answer "do all four version files agree on X?":
# release.sh before it rewrites them, and release-tag.sh before it tags a tree
# somebody else already rewrote. Keeping one copy is not tidiness - the failure
# mode of two copies is that a fifth version file gets added to one of them, and
# the other keeps reporting a clean bill of health for a file it never looks at.
#
# Every function here is read-only. Writing is release.sh's business alone.

# How many stanzas in Cargo.lock name this crate. Anything but 1 means the file's
# shape is not what the rewrite assumes, which is a different failure from the
# recorded version being wrong - and worth a different message, since the two send
# the operator to different places.
#
# The `[[:space:]]*$` tolerates a trailing `\r`: the other patterns are not
# end-anchored so they survive a CRLF checkout, and this one has to as well or a
# `core.autocrlf=true` clone cannot release at all.
lock_stanza_count() {
  grep -c '^name = "stalagmight"[[:space:]]*$' "$PROJECT_ROOT/src-tauri/Cargo.lock" || true
}

# Print the version of the local `stalagmight` package recorded in Cargo.lock,
# one line per matching stanza (so a caller can notice if there is more than one).
#
# Cargo.lock carries a `version = "..."` line for EVERY dependency, so the plain
# pattern the other files use would match dozens of unrelated entries. The only
# line that belongs to this crate is the one directly after its `name` line.
lock_version() {
  awk '
    /^name = "stalagmight"[[:space:]]*$/ {
      if ((getline nxt) > 0) {
        sub(/\r$/, "", nxt)
        if (nxt ~ /^version = "/) {
          gsub(/^version = "|"$/, "", nxt)
          print nxt
        }
      }
    }
  ' "$PROJECT_ROOT/src-tauri/Cargo.lock"
}

# Assert a file matches a pattern on exactly one line.
#
# "The string is present somewhere" is too weak a check: it passes just as
# happily when a substitution hit two lines and clobbered an unrelated field as
# when it hit the one line it was aimed at. Counting is what distinguishes them.
# A file that cannot be read is checked EXPLICITLY rather than left to the count
# below. `grep -c` on a missing file prints nothing, so `n` is empty, and `[ ""
# -ne 1 ]` is not false - it is a bash *error* (status 2), which an `if` reads as
# false, skipping the branch and returning 0. The check would report a clean bill
# of health for a file it never opened, which is the exact failure this file's
# header claims to prevent. `-e`/`--` keep a future caller's leading-dash pattern
# from being read as a grep option.
require_one_match() {
  local file="$1" pattern="$2" when="$3" n
  if [ ! -r "$PROJECT_ROOT/$file" ]; then
    echo "Error: $file is missing or unreadable, so its version could not be checked $when." >&2
    return 1
  fi
  n=$(grep -c -e "$pattern" -- "$PROJECT_ROOT/$file" || true)
  if [ "${n:-x}" != 1 ]; then
    echo "Error: $file has ${n:-no} lines matching /$pattern/ $when, expected exactly 1." >&2
    return 1
  fi
}

# Escape a version for use in a grep/sed pattern, where an unescaped dot is a
# wildcard - "0.2.0" would otherwise match "0X2Y0".
version_pattern() {
  printf '%s' "$1" | sed 's/\./\\./g'
}

# Do all four version files record exactly this version, on exactly one line each?
#
#   version_files_match 0.5.0 "package.json" "before the rewrite"
#
# `source_label` names where the expected version came from, because the operator
# fixes a mismatch differently depending on the answer: disagreeing with
# package.json means the lock drifted, disagreeing with a tag means the tag is
# wrong for this tree. `when` describes the moment, for the count messages.
#
# Returns 1 with an explanation on stderr; the caller decides whether that is
# fatal and prints its own "nothing was modified" line, since only the caller
# knows what it had already done.
version_files_match() {
  local version="$1" source_label="$2" when="$3" re json toml stanzas lock

  re="$(version_pattern "$version")"
  json="\"version\": \"$re\""
  toml="^version = \"$re\""

  require_one_match "package.json" "$json" "$when" || return 1
  require_one_match "src-tauri/tauri.conf.json" "$json" "$when" || return 1
  require_one_match "src-tauri/Cargo.toml" "$toml" "$when" || return 1

  # The lock is checked by value rather than by pattern count, so its two failure
  # shapes stay distinguishable: a stanza that is missing or duplicated is a
  # format problem, a stanza holding the wrong number is a drift problem.
  if [ ! -r "$PROJECT_ROOT/src-tauri/Cargo.lock" ]; then
    echo "Error: src-tauri/Cargo.lock is missing or unreadable." >&2
    return 1
  fi
  # String comparison, not `-ne`: an empty count is an error rather than a
  # number, and `[ "" -ne 1 ]` would abort the test itself into a false `if`.
  stanzas="$(lock_stanza_count)"
  if [ "${stanzas:-x}" != 1 ]; then
    echo "Error: src-tauri/Cargo.lock has ${stanzas:-no} lines matching 'name = \"stalagmight\"'," >&2
    echo "expected exactly 1. The lock's shape is not what the rewrite assumes." >&2
    return 1
  fi
  lock="$(lock_version)"
  if [ -z "$lock" ]; then
    echo "Error: src-tauri/Cargo.lock has the stalagmight stanza but no 'version =' line" >&2
    echo "directly after its 'name =' line." >&2
    return 1
  fi
  if [ "$lock" != "$version" ]; then
    echo "Error: src-tauri/Cargo.lock records stalagmight at '$lock'," >&2
    echo "but $source_label says '$version'. Sync them, then re-run." >&2
    return 1
  fi
}
