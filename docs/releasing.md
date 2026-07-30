# Release Process

## Overview

Releases are created through Claude Code. The process:

1. Claude reviews git log since the last tag
2. Claude writes a human-readable summary into the `## [Unreleased]` section of `CHANGELOG.md`
3. Claude commits the changelog update
4. Claude runs `./scripts/release.sh <patch|minor|major> --no-edit`
5. Claude pushes the commit and tag
6. GitHub Actions builds the app and creates a release with artifacts

## Release notes

**`CHANGELOG.md` is the release notes.** There is no second place to write them:
the workflow builds the published body from the changelog via
`scripts/release-notes.sh`, so whatever is in `## [Unreleased]` when you tag is
what recipients read. Write it for someone using the app, not for someone
reading the diff.

Preview the exact body before tagging - it is the same script CI runs:

```bash
./scripts/release-notes.sh v0.5.0
./scripts/release-notes.sh v0.5.0-rc1
```

The script picks the section, then appends the install instructions and the
checksum note that every release carries:

| Tag | Notes come from |
|-----|-----------------|
| `v0.5.0`, after `release.sh` moved the section | `## [0.5.0]` |
| `v0.5.0`, before that | `## [Unreleased]` (fallback) |
| `v0.5.0-rc1` | `## [0.5.0]`, or `## [Unreleased]`, plus a candidate banner |
| anything with no matching section | `Release <tag>` (last resort) |

A candidate deliberately reuses the notes of the version it is a candidate for -
an RC *is* that release, built early - so the notes are written once.

## Release candidates

Bump once, then cut as many candidates as you like before the real thing:

```bash
./scripts/release.sh 0.5.0 --no-edit --no-tag      # bump + changelog, no tag
git push
git tag v0.5.0-rc1 && git push origin v0.5.0-rc1   # then rc2, rc3, ...
git tag v0.5.0     && git push origin v0.5.0       # the real one
```

`--no-tag` matters: without it `release.sh` creates `v0.5.0` immediately, which
would either publish the real release early or sit on the wrong commit once
further fixes land before `rc2`.

- **The version files stay at the plain `0.5.0`.** The candidate lives only in
  the tag. This is not a style choice: the Windows MSI bundler rejects a
  non-numeric pre-release identifier, so `0.5.0-rc1` in `tauri.conf.json` fails
  the Windows build outright. Artifacts are therefore named
  `Stalagmight_0.5.0_*` for every candidate.
- **A tag with a suffix is published as a GitHub pre-release**, so it never
  becomes "Latest" and is not handed to people expecting the final build.
- **About shows the tag**, so a candidate reads `0.5.0-rc1` and cannot be
  mistaken for the final release. Keep candidates rather than deleting them -
  a tester's bug report names one.

## Step-by-step (what Claude does)

```bash
# 1. Check what changed since last release
git log $(git describe --tags --abbrev=0)..HEAD --oneline --no-merges

# 2. Write summary into CHANGELOG.md under ## [Unreleased]
# (edit the file directly)

# 3. Commit the changelog
git add CHANGELOG.md
git commit -m "docs: update changelog for vX.Y.Z"

# 4. Run release script (bumps versions in 3 of the 4 version files, moves changelog, commits, tags)
./scripts/release.sh patch --no-edit

# 5. Push
git push origin master && git push origin --tags
```

## What `scripts/release.sh` does

1. Reads current version from `package.json`
2. Computes new version (major/minor/patch or explicit X.Y.Z)
3. Verifies no uncommitted changes (except CHANGELOG.md)
4. Verifies `## [Unreleased]` section is non-empty
5. Updates version in 3 of the 4 files that carry it (see [Version locations](#version-locations) - `src-tauri/Cargo.lock` is not one of them):
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
| `--no-tag` | Bump, move the changelog and commit, but create no tag - use when the next thing you cut is a candidate (`v0.5.0-rc1`) rather than the release |

## CI/CD Workflows

### CI (`.github/workflows/ci.yml`)

- **Trigger**: push to master, pull requests to master
- **Steps**: TypeScript check, Rust tests
- Installs: system libs, Rust toolchain, Node 24 (from `.nvmrc`), pnpm 9

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
- **The macOS app is ad-hoc signed; nothing is notarized, and Windows is
  unsigned.** Tauri signs the app itself, from `bundle.macOS.signingIdentity` in
  `tauri.conf.json`, which happens before the DMG is built. Do not move signing
  after the build: v0.5.0-rc1 shipped with no identity set, so Tauri skipped
  codesign and the bundle carried only the Rust linker's ad-hoc signature on the
  inner binary. That combination is *invalid* rather than merely unsigned, and
  macOS reports it as "damaged and can't be opened" with no way for the user to
  click past it, unlike the ordinary unnotarized warning
  ([#350](https://github.com/Stalagmight/Stalagmight/issues/350)). The `build`
  job re-checks the app *inside* the DMG via `scripts/verify-macos-signature.sh`,
  since that is the artifact people download, and `scripts/mac-build.sh` runs the
  same script for the same reason. Real Developer ID signing plus notarization
  needs a paid Apple Developer account and is an open decision on
  [#226](https://github.com/Stalagmight/Stalagmight/issues/226).
- **What the signature does and does not buy.** `codesign --verify --deep --strict`
  proves the bundle is internally consistent, which is what makes it launchable at
  all. It proves nothing about *who* built it: an ad-hoc signature has no
  certificate and no Team ID, and anyone able to influence the bundle can re-sign
  it ad-hoc with no key. Integrity against build breakage, not authenticity. Read
  "signature verified" in a release log accordingly.
- **Signing also turns on the hardened runtime, with no entitlements.** Tauri's
  `hardenedRuntime` defaults to `true`, so giving it a `signingIdentity` opts the
  shipped app into a restricted runtime it never had before (the signature reports
  `flags=0x10002(adhoc,runtime)`). That is deliberate here, not incidental: it is
  verified working (the app launches and WKWebView spawns its content processes),
  it keeps the artifact forward-compatible with notarization, and the binary links
  only Apple frameworks with no bundled dylibs, so library validation has nothing
  to reject. If a future dependency needs JIT, a loadable plugin, or a spawned
  helper, that assumption has to be revisited - either add entitlements or set
  `"hardenedRuntime": false` explicitly rather than discovering it in a crash.
- **An ad-hoc signature changes identity every build, which the keychain notices.**
  The SpeleoDB token is stored via the OS keychain (`src-tauri/src/speleodb/auth.rs`),
  and a keychain item's ACL is bound to the creating app's code identity. An ad-hoc
  signature's designated requirement is its cdhash, which differs for every build,
  so each release is a different app as far as the keychain is concerned and users
  may be re-prompted for their token after updating. A real Developer ID gives a
  stable identity and would remove this; it is another argument for #226. A denial
  is handled safely rather than silently - the token degrades to session-only
  memory and is never written to disk unless plaintext storage was explicitly
  opted into.
- The release notes get an "Installing" footer telling recipients how to get past
  Gatekeeper and SmartScreen. Because those steps talk people through overriding
  a security warning, the release also ships a `SHA256SUMS` generated on the
  runner that built the binaries, and the footer points at it.
- `verify` runs the test suite on Linux only. Per-platform test runs are tracked
  in [#325](https://github.com/Stalagmight/Stalagmight/issues/325); note Windows
  needs `STALAGMIGHT_TEST_MANIFEST=1` (see `scripts/test.ps1`).

**Runner cost**: macOS and Windows runners bill at a multiple of the Linux rate,
so a tag is materially more expensive than it used to be. Every job carries a
`timeout-minutes` for the same reason - the platform default is six hours, which
on the macOS runner is a large bill for a hung build.

Measured on a cold rehearsal run, 2026-07-29 (all three legs run in parallel, so
wall-clock for the whole release is roughly `verify` + the slowest leg):

| Job | Wall clock | Billing multiplier | Included minutes |
|-----|-----------|--------------------|------------------|
| `verify` (Linux, cached) | 4m03s | 1x | 4 |
| `build` linux | 17m11s | 1x | 17 |
| `build` macos | 10m16s | 10x | 103 |
| `build` windows | 27m47s | 2x | 56 |
| `release` | ~1m | 1x | 1 |
| **Total** | **~33m elapsed** | | **~181** |

macOS dominates the bill despite being the fastest leg. Re-measure rather than
trusting this table if the build changes shape; confirm the multipliers and
per-minute rates against GitHub's billing docs, which move.

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

A rehearsal covers everything except the `release` job, so two things stay
unproven until a real tag: `actions/download-artifact` and the publish step
itself. Watch the first tagged run's `release` job rather than assuming.

### The one macOS check no workflow can do

`codesign --verify` proves the signature is well-formed. It does **not** predict
what Gatekeeper shows a user, because that is a separate assessment of a
*quarantined* download, and an unnotarized app is rejected either way - `spctl
--assess` returns `rejected` for our DMG by design. So the difference between the
dismissible "Apple could not verify" prompt and the terminal "damaged and can't be
opened" cannot be read off any CI log.

Before announcing a release, open the built DMG once on a Mac that did not build
it, and note which dialog appears:

```bash
# on a second Mac, after downloading the DMG from the release
open Stalagmight_<version>_aarch64.dmg
# drag the app out, then launch it and record the exact wording
```

Building the app locally makes this test lie: the launching Mac has already run
that exact code, and Gatekeeper caches its verdict per cdhash, so the app opens
where a stranger's Mac might not. If the dialog offers a way through (System
Settings ▸ Privacy & Security ▸ **Open Anyway**), the install instructions are
accurate. If it says "damaged", signing is not sufficient and the release needs
notarization ([#226](https://github.com/Stalagmight/Stalagmight/issues/226))
before it can be handed to anyone.

## Testing the release tooling

```bash
./scripts/test-release.sh
```

Covers both scripts. For `release.sh` it clones the repo to a temp directory and
drives the real script through a normal bump plus four refusal cases
(re-releasing the current version, an existing tag, a drifted version-string
format, an empty `[Unreleased]`), asserting each time that the tree is left clean
and nothing was tagged. For `release-notes.sh` it runs the real script against a
fixture changelog and checks the section each tag shape resolves to, the
candidate banner, and that an empty changelog still yields a usable body.

Run it after touching either script; it takes a few seconds and needs no network.

## Version locations

The version string lives in 4 tracked files. The release script updates the first
three, **not** the fourth:

| File | Field | Bumped by `release.sh`? |
|------|-------|-------------------------|
| `package.json` | `"version"` | yes |
| `src-tauri/tauri.conf.json` | `"version"` | yes |
| `src-tauri/Cargo.toml` | `version` | yes |
| `src-tauri/Cargo.lock` | the `name = "stalagmight"` entry | **no** |

`Cargo.lock` records the crate's own version, and because nothing here builds with
`cargo --locked`, a mismatch never fails a build - the next `cargo` invocation just
rewrites the lock in place, leaving an unexplained dirty file. That is how the lock
sat at `0.2.0` while everything else said `0.5.0`. It is synced now; teaching
`release.sh` to keep it in step is
[#352](https://github.com/Stalagmight/Stalagmight/issues/352). Until that lands,
check `git status` after a bump and commit the lock with it.

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
