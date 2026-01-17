# fn-46-kbp.1 Implement 6 map integration tests

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Added 6 WebdriverIO E2E tests for map integration covering survey rendering after import, station selection on click, merge tool workflow, section movement, zoom/pan navigation, and station label display.
## Evidence
- Commits: fb1ffc3935b1a038c5fc11d8c0826b5906e17d37
- Tests: pnpm tsc --noEmit, pnpm test:ui (226 passed), cd src-tauri && cargo test (72 passed)
- PRs: