# fn-18-8yi.1 Add direction field with database migration

## Description
## Overview
Add direction field with migration.
## Files
- section.rs
- sqlite.rs
## Acceptance
- [ ] Direction enum
- [ ] Schema migration
- [ ] Default IN
- [ ] Tests pass
## Done summary
Added SurveyDirection enum (In/Out) to Section model with database schema migration, DMP parser integration, and TypeScript types. Defaults to "in" for backwards compatibility.
## Evidence
- Commits: 0a70c2acde26f1769a1f795ec7ba24ce318c0d40
- Tests: cargo test (18 unit tests, 62 integration tests passed), pnpm tsc --noEmit (type check passed), pnpm test:ui (127 Playwright E2E tests passed)
- PRs: