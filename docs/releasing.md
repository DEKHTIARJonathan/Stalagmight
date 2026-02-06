# Release Process

## Overview

Releases are created through Claude Code. The process:

1. Claude reviews git log since the last tag
2. Claude writes a human-readable summary into the `## [Unreleased]` section of `CHANGELOG.md`
3. Claude commits the changelog update
4. Claude runs `./scripts/release.sh <patch|minor|major> --no-edit`
5. Claude pushes the commit and tag
6. Gitea Actions builds the app and creates a release with artifacts

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
- **Steps**: TypeScript check, Rust tests, `pnpm tauri build`
- **Artifacts**: `.deb`, `.rpm`, `.AppImage` (Linux only — current runner is Linux)
- Creates a Gitea release via API with changelog content as the body
- Uploads all artifacts to the release

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
Currently Linux-only. Windows/Mac builds require runners on those platforms — Tauri can't cross-compile due to platform-specific system library dependencies.
