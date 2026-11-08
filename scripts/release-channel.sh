#!/usr/bin/env bash
set -euo pipefail

# release-channel.sh - what a release tag bakes and publishes, in one place.
#
# Usage:
#   scripts/release-channel.sh classify <tag>
#   scripts/release-channel.sh is-newer <version> <than>
#
# The release workflow asks the same question of a tag in three places (the
# build's baked identity, the preflight before anything is public, and the
# manifest publish), and the repoint workflow asks it in reverse. One answer
# here, rather than one regex per step, is what keeps a tag shape from
# building as a candidate and then publishing as nothing (#650).
#
# `classify` prints six key=value lines, the format $GITHUB_OUTPUT takes. Every
# key is printed for every tag, empty when it does not apply:
#
#   kind              final | candidate | none
#   base              the plain X.Y.Z the version files and artifacts carry
#   prerelease        candidate only: rc.N, baked as STALAGMIGHT_PRERELEASE
#   channel           candidate only: beta, baked as STALAGMIGHT_CHANNEL
#   manifest_version  what the updater manifest announces
#   manifests         the manifest files the tag publishes, space-separated
#
#   tag            kind       manifest_version  manifests
#   vX.Y.Z         final      X.Y.Z             latest-stable.json latest-beta.json latest-weekly.json
#   vX.Y.Z-rc.N    candidate  X.Y.Z-rc.N        latest-beta.json latest-weekly.json
#   anything else  none       (empty)           (empty)
#
# N counts from 1 with no leading zero: rc.0 is not a candidate anyone cut,
# and semver forbids a leading zero in a numeric identifier (rc.01), which the
# updater's parser would reject.
#
# Beta gets candidates and the finals they lead to; Stable gets finals only.
# `manifests` is what a tag may publish: the release job still leaves Beta and
# the weekly mirror alone when a final is not newer than what Beta holds.
# latest-weekly.json is a mirror of latest-beta.json: the weekly track is
# retired, and 0.5.0/0.5.1 installs set to "Weekly" read that file. Anything
# else with a suffix (the old -rcN shape, a weekly-looking tag) publishes no
# manifest at all.
#
# `is-newer` exits 0 when <version> is strictly newer than <than>, 1 when it is
# not, and 2 when either is not an X.Y.Z or X.Y.Z-rc.N version (the only two
# shapes this pipeline writes into a manifest). Semver precedence: the numeric
# core first, then a final above any of its own candidates, then the rc number
# as a number.
#
# The value printed is never the input string itself, only captures of the
# anchored patterns below, so a hostile ref name cannot inject extra
# $GITHUB_OUTPUT lines. Bash 3.2 compatible, for the macOS userland.

FINAL_RE='^v([0-9]+\.[0-9]+\.[0-9]+)$'
CANDIDATE_RE='^v([0-9]+\.[0-9]+\.[0-9]+)-(rc\.[1-9][0-9]*)$'

usage() {
  echo "Usage: $0 classify <tag> | is-newer <version> <than>" >&2
  exit 2
}

classify() {
  local tag="$1"
  local kind=none base="" prerelease="" channel="" manifest_version="" manifests=""
  if [[ "$tag" =~ $FINAL_RE ]]; then
    kind=final
    base="${BASH_REMATCH[1]}"
    manifest_version="$base"
    manifests="latest-stable.json latest-beta.json latest-weekly.json"
  elif [[ "$tag" =~ $CANDIDATE_RE ]]; then
    kind=candidate
    base="${BASH_REMATCH[1]}"
    prerelease="${BASH_REMATCH[2]}"
    channel=beta
    manifest_version="$base-$prerelease"
    manifests="latest-beta.json latest-weekly.json"
  fi
  printf 'kind=%s\n' "$kind"
  printf 'base=%s\n' "$base"
  printf 'prerelease=%s\n' "$prerelease"
  printf 'channel=%s\n' "$channel"
  printf 'manifest_version=%s\n' "$manifest_version"
  printf 'manifests=%s\n' "$manifests"
}

# "MAJOR MINOR PATCH FINAL RC" for an X.Y.Z (FINAL=1, RC=0) or X.Y.Z-rc.N
# (FINAL=0, RC=N) version; fails on anything else.
version_key() {
  if [[ "$1" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]} 1 0"
  elif [[ "$1" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)-rc\.([1-9][0-9]*)$ ]]; then
    echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]} 0 ${BASH_REMATCH[4]}"
  else
    return 1
  fi
}

is_newer() {
  local a b i
  if ! a="$(version_key "$1")"; then
    echo "is-newer: '$1' is not an X.Y.Z or X.Y.Z-rc.N version" >&2
    return 2
  fi
  if ! b="$(version_key "$2")"; then
    echo "is-newer: '$2' is not an X.Y.Z or X.Y.Z-rc.N version" >&2
    return 2
  fi
  local -a av bv
  read -r -a av <<<"$a"
  read -r -a bv <<<"$b"
  # `[ -gt ]` rather than $(( )): arithmetic reads a leading zero as octal.
  for i in 0 1 2 3 4; do
    if [ "${av[i]}" -gt "${bv[i]}" ]; then return 0; fi
    if [ "${av[i]}" -lt "${bv[i]}" ]; then return 1; fi
  done
  return 1
}

[ "$#" -ge 1 ] || usage
case "$1" in
  classify)
    [ "$#" -eq 2 ] || usage
    classify "$2"
    ;;
  is-newer)
    [ "$#" -eq 3 ] || usage
    is_newer "$2" "$3"
    ;;
  *)
    usage
    ;;
esac
