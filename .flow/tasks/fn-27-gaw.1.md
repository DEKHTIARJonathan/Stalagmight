# fn-27-gaw.1 Add satellite imagery toggle

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Added configurable satellite imagery toggle with ESRI satellite tiles, offline fallback error handling, and Playwright E2E tests for the Display Menu satellite option.
## Evidence
- Commits: a22ec9debc46dfb79450c174b583667b549f7283
- Tests: pnpm tsc --noEmit, pnpm test:ui --grep satellite, cd src-tauri && cargo test
- PRs: