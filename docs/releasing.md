# Release Process

## Overview

Releases are created through Claude Code. The process:

1. Claude reviews git log since the last tag
2. Claude writes a human-readable summary into the `## [Unreleased]` section of `CHANGELOG.md`
3. Claude commits the changelog update
4. Claude runs `./scripts/release.sh <patch|minor|major> --no-edit`
5. Claude pushes the commit and tag
6. GitHub Actions builds the app and creates a release with artifacts

## Step-by-step (what Claude does)

```bash
# 1. Check what changed since last release
git log $(git describe --tags --abbrev=0)..HEAD --oneline --no-merges

# 2. Write summary into CHANGELOG.md under ## [Unreleased]
# (edit the file directly)

# 3. Commit the changelog
git add CHANGELOG.md
git commit -m "docs: update changelog for vX.Y.Z"

# 4. Run release script (bumps versions in 3 files, moves changelog, commits, tags)
./scripts/release.sh patch --no-edit

# 5. Push
git push origin master && git push origin --tags
```

## What `scripts/release.sh` does

1. Reads current version from `package.json`
2. Computes new version (major/minor/patch or explicit X.Y.Z)
3. Verifies no uncommitted changes (except CHANGELOG.md)
4. Verifies `## [Unreleased]` section is non-empty
5. Updates version in 3 files:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
6. Moves `[Unreleased]` content under a new `## [X.Y.Z] - YYYY-MM-DD` header
7. Commits: `chore: release vX.Y.Z`
8. Tags: `vX.Y.Z`

### Flags

| Flag | Effect |
|------|--------|
| `--no-edit` | Skip opening `$EDITOR` on the changelog (required for Claude) |
| `--dry-run` | Print what would happen without making changes |

## CI/CD Workflows

### CI (`.github/workflows/ci.yml`)

- **Trigger**: push to master, pull requests to master
- **Steps**: TypeScript check, Rust tests
- Installs: system libs, Rust toolchain, Node 22, pnpm 9

### Release (`.github/workflows/release.yml`)

- **Trigger**: push of `v*` tags
- **Jobs**: `verify` -> `build` (3-platform matrix) -> `release`

| Job | Runner | Does |
|-----|--------|------|
| `verify` | `ubuntu-latest` | TypeScript check + Rust tests - a subset of the CI `check` job, not the whole gate. It does not run `cargo fmt --check`, clippy, vitest, the file-size ratchets or leak-scan; those gate the merge, and a tag is cut from already-merged code |
| `build` | `ubuntu-latest`, `macos-latest`, `windows-latest` | `pnpm tauri build`, collects that platform's bundles, checksums them, uploads them as a job artifact |
| `release` | `ubuntu-latest` | Downloads all three artifact sets, re-verifies the checksums, asserts every platform is represented, extracts the changelog section, creates the GitHub release via the `gh` CLI |

- **Artifacts**: `.deb` / `.rpm` / `.AppImage` (Linux), `.dmg` (macOS, Apple Silicon
  only), `.msi` / `-setup.exe` (Windows), plus a `SHA256SUMS` covering all of them
- **macOS is Apple Silicon only, on purpose.** No maintainer has an Intel Mac, so
  an architecture-specific bug on Intel could not be reproduced or fixed. Shipping
  a binary nobody can debug is worse than not shipping it, so the build is native
  to the `macos-latest` runner (arm64) rather than universal. Intel users build
  from source. Revisit if someone on the team gets Intel hardware: give the
  macOS row `--target universal-apple-darwin`, add `rustup target add
  aarch64-apple-darwin x86_64-apple-darwin` for that row, and point `BUNDLE_DIR`
  at `src-tauri/target/universal-apple-darwin/release/bundle` - passing
  `--target` relocates Tauri's bundle output under the triple. That last part is
  the easy one to miss.
- `fail-fast` is off so every platform reports its own failure, but `release`
  depends on all three builds, so a partial artifact set is never published.
- Nothing is code-signed. The release notes get an "Installing" footer telling
  recipients how to get past Gatekeeper and SmartScreen. Because those steps
  talk people through overriding a security warning, the release also ships a
  `SHA256SUMS` generated on the runner that built the binaries, and the footer
  points at it. Signing/notarization is an open decision on
  [#226](https://github.com/Stalagmight/Stalagmight/issues/226).
- `verify` runs the test suite on Linux only. Per-platform test runs are tracked
  in [#325](https://github.com/Stalagmight/Stalagmight/issues/325); note Windows
  needs `STALAGMIGHT_TEST_MANIFEST=1` (see `scripts/test.ps1`).

**Runner cost**: macOS and Windows runners bill at a multiple of the Linux rate,
so a tag is materially more expensive than it used to be. Check the current
multipliers against GitHub's billing docs before tagging on a tight budget. Every
job carries a `timeout-minutes` for the same reason - the platform default is six
hours, which on the macOS runner is a large bill for a hung build.

### Rehearsing before you tag

The workflow also has a `workflow_dispatch` trigger. A manual run executes
`verify` and the whole `build` matrix but skips `release` (it is gated on
`startsWith(github.ref, 'refs/tags/')`), so the per-platform bundle paths and
globs can be proven without publishing anything:

```bash
gh workflow run release.yml --ref <branch>
gh run watch
```

Do this before the first tag after any change to the build matrix. The
platform-specific `bundle_dir` values and artifact globs are only really
confirmed by a run that produces the files.

## Testing `scripts/release.sh`

```bash
./scripts/test-release.sh
```

Clones the repo to a temp directory and drives the real script through a normal
bump plus four refusal cases (re-releasing the current version, an existing tag,
a drifted version-string format, an empty `[Unreleased]`), asserting each time
that the tree is left clean and nothing was tagged. Run it after touching
`release.sh`; it takes a few seconds and needs no network.

## Version locations

The version string lives in 3 files (all updated by the release script):

| File | Field |
|------|-------|
| `package.json` | `"version"` |
| `src-tauri/tauri.conf.json` | `"version"` |
| `src-tauri/Cargo.toml` | `version` |

The About dialog reads the version dynamically via `__APP_VERSION__` (injected by Vite from `package.json` at build time).

## Troubleshooting

### "uncommitted changes" error
Stash or commit changes first. The script allows uncommitted `CHANGELOG.md` but nothing else.

### "[Unreleased] section is empty" error
Write release notes into the `## [Unreleased]` section of `CHANGELOG.md` before running with `--no-edit`.

### Multi-platform builds
Linux, macOS and Windows are all built from the tag by the `build` matrix. Each
platform builds on its own runner because Tauri can't cross-compile - it needs
that platform's system libraries.

If one platform fails, the other two still build and report, but no release is
created. Fix the failing platform and re-run the workflow, or delete and re-push
the tag.

### `release.sh` fails on macOS
Shouldn't anymore, but this is what to look for: the script used `grep -oP` and
GNU-style `sed -i`, neither of which exists in the BSD userland macOS ships. It
now reads the version with POSIX `sed` and rewrites files through a helper that
avoids `sed -i` entirely. **The script has to run under BSD userland, so don't
reach for GNU-only flags here** - `scripts/test-release.sh` runs on whatever
machine invokes it and will catch a regression.
