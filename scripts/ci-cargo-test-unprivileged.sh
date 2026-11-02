#!/usr/bin/env bash
# Make the rest of a CI job run the Rust test binaries as an unprivileged user
# (#576 NF-ROOT-PERM).
#
# Root - and any process holding CAP_DAC_OVERRIDE - ignores mode bits, so a
# test that takes a permission away (a read-only folder, a 0444 file, an
# unsearchable directory) cannot mean anything there. Those tests assert that
# the bits bite and fail otherwise (stalagmight_models::test_support), and the
# self-hosted runner is a container running as uid 0. On a runner that is
# already unprivileged (GitHub-hosted) this script does nothing.
#
# Compilation stays with the job's user: cargo, the target dir, the registry
# and sccache are untouched, so the build cache works as before. Only the test
# binaries cross over, through Cargo's target runner: the script appends
# CARGO_TARGET_<HOST TRIPLE>_RUNNER to $GITHUB_ENV, and every later `cargo test`
# in the job then starts each test binary under `setpriv`, as the test user.
# Doctests are run by rustdoc rather than through the runner and stay with the
# job's user; none of them depends on permissions.
#
# The test user must be able to write what the tests write: their HOME (a
# fresh temp dir), the temp dir, XDG_CONFIG_HOME when the job sets it (pass
# the same value to this step), and src-tauri/bindings, which the ts-rs export
# tests regenerate.
#
# STALAGMIGHT_TEST_USER names an existing account to use instead of creating
# `stalagmight-test` (for a local dry run).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Already unprivileged ($(id -un)): the Rust tests run as this user."
  exit 0
fi
: "${GITHUB_ENV:?this script configures the later steps of a job through GITHUB_ENV}"
command -v setpriv >/dev/null || {
  echo "::error::setpriv (util-linux) is missing, so the Rust tests cannot drop root"
  exit 1
}

user=${STALAGMIGHT_TEST_USER:-stalagmight-test}
if ! id -u "$user" >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$user"
fi
uid=$(id -u "$user")
gid=$(id -g "$user")
if [ "$uid" -eq 0 ]; then
  echo "::error::$user is root"
  exit 1
fi

repo=$(cd "$(dirname "$0")/.." && pwd)
home=$(mktemp -d)
chown "$uid:$gid" "$home"
chown -R "$uid:$gid" "$repo/src-tauri/bindings"
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  mkdir -p "$XDG_CONFIG_HOME"
  chown -R "$uid:$gid" "$XDG_CONFIG_HOME"
fi

runner=(setpriv "--reuid=$uid" "--regid=$gid" --clear-groups env "HOME=$home" "USER=$user" "LOGNAME=$user")

# Prove the drop before the tests rely on it: as the test user, a read-only
# directory it owns must refuse a new file.
probe=$(mktemp -d)
chown "$uid:$gid" "$probe"
chmod 0555 "$probe"
if "${runner[@]}" touch "$probe/probe" 2>/dev/null; then
  echo "::error::$user still writes a read-only directory: mode bits do not bite"
  exit 1
fi
chmod 0755 "$probe"
rm -rf "$probe"

host=$(rustc -vV | sed -n 's/^host: //p')
if [ -z "$host" ]; then
  echo "::error::cannot read the host triple from rustc -vV"
  exit 1
fi
var="CARGO_TARGET_$(printf '%s' "$host" | tr '[:lower:]-' '[:upper:]_')_RUNNER"
echo "$var=${runner[*]}" >>"$GITHUB_ENV"
echo "The Rust test binaries run as $user ($uid:$gid) through $var."
