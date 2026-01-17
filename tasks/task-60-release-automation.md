# Task 60: Release Checklist Automation

## Overview
Create GitHub Actions workflow for automated releases. Tag-triggered builds for all platforms with auto-generated changelog.

## Priority
Medium - Phase H (Polish)

## Risk Level
Medium

## Dependencies
- None

## Files to Modify
- `.github/workflows/release.yml` - New workflow
- `.github/workflows/test.yml` - Test workflow (if not exists)
- `scripts/changelog.sh` - New script for changelog generation

## Specifications

### Trigger
Tag-based release:
```yaml
on:
  push:
    tags:
      - 'v*'
```

### Build Matrix
All three platforms:
```yaml
strategy:
  matrix:
    include:
      - os: ubuntu-latest
        target: linux
      - os: windows-latest
        target: windows
      - os: macos-latest
        target: macos
```

### Workflow Steps
```yaml
jobs:
  build:
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Install dependencies
        run: pnpm install

      - name: Run tests
        run: |
          pnpm tsc --noEmit
          cd src-tauri && cargo test
          pnpm test:ui

      - name: Build
        run: pnpm tauri build

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.target }}
          path: src-tauri/target/release/bundle/
```

### Release Job
```yaml
  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Download artifacts
        uses: actions/download-artifact@v4

      - name: Generate changelog
        run: ./scripts/changelog.sh > CHANGELOG.md

      - name: Create release
        uses: softprops/action-gh-release@v1
        with:
          files: |
            linux/*
            windows/*
            macos/*
          body_path: CHANGELOG.md
```

### Changelog Generation
```bash
#!/bin/bash
# scripts/changelog.sh

# Get commits since last tag
LAST_TAG=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo "")
if [ -z "$LAST_TAG" ]; then
  RANGE="HEAD"
else
  RANGE="${LAST_TAG}..HEAD"
fi

echo "## Changes"
echo ""

# Group by type
git log $RANGE --pretty=format:"- %s" | \
  grep -E "^- (feat|fix|docs|chore|refactor)" | \
  sort
```

### Pre-Release Checks
Before release job:
- [ ] All tests pass
- [ ] TypeScript compiles
- [ ] Rust tests pass
- [ ] Build succeeds on all platforms
- [ ] Version numbers match

### Version Verification
```yaml
- name: Verify version
  run: |
    PKG_VERSION=$(node -p "require('./package.json').version")
    CARGO_VERSION=$(grep '^version' src-tauri/Cargo.toml | head -1 | cut -d'"' -f2)
    TAG_VERSION=${GITHUB_REF#refs/tags/v}

    if [ "$PKG_VERSION" != "$TAG_VERSION" ] || [ "$CARGO_VERSION" != "$TAG_VERSION" ]; then
      echo "Version mismatch!"
      exit 1
    fi
```

## Acceptance Criteria
- [ ] Workflow triggers on tag push
- [ ] Builds on all three platforms
- [ ] Tests run before build
- [ ] Changelog auto-generated
- [ ] Release created with artifacts
- [ ] Version verification passes
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### CI/CD Tests (GitHub Actions)
1. Test workflow triggers on v* tag push
2. Test Node.js setup succeeds
3. Test Rust toolchain setup succeeds
4. Test pnpm install succeeds
5. Test TypeScript type check passes
6. Test Rust tests pass
7. Test Playwright tests pass
8. Test Tauri build succeeds on Linux
9. Test Tauri build succeeds on Windows
10. Test Tauri build succeeds on macOS

### Manual Verification
1. Verify artifacts uploaded to release
2. Verify changelog generated correctly
3. Verify version numbers match tag
4. Verify all three platform builds present
5. Verify release notes formatted correctly

## Edge Cases
- Build fails on one platform
- No commits since last tag
- Invalid tag format
- Concurrent releases
