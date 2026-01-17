# fn-44-z0b.1 Implement 6 map tools tests

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Implemented 6 Playwright E2E tests for map tools: tool switching via keyboard shortcuts (s, p, z, d, x, m, r, v, t), station selection with select/multi-select, pan tool and middle mouse button, measure tool, fit view (Ctrl+0), and delete key with confirmation dialog.
## Evidence
- Commits: e99289ee46f1d226a53e480e31d010ced058e1db
- Tests: pnpm test:ui --grep 'Map Tools', pnpm tsc --noEmit
- PRs: