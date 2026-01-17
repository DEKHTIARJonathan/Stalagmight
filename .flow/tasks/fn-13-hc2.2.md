# fn-13-hc2.2 Add GPS input UI to Import Dialog

## Description
## Overview
Add GPS input section to DmpImportDialog.
## Files
- src/components/Dialogs/DmpImportDialog.tsx
## Acceptance
- [ ] GPS input fields
- [ ] Format detection display
- [ ] Station selector
- [ ] Validation errors
- [ ] Tests pass
## Done summary
Added GPS input UI to Import Dialog with text input supporting all 7 formats (DD, DMS, DDM, UTM, MGRS, Plus Codes, What3words), real-time format detection, parsed coordinates display, validation errors, and station selector for zero datum assignment. Includes 20 Playwright E2E tests.
## Evidence
- Commits: d19dc8c0b1d809dfe058a39499f440ca98d6edd1
- Tests: pnpm tsc --noEmit, pnpm test:ui (105 passed), cargo test (62 passed)
- PRs: