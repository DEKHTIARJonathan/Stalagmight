# fn-16-9mr.1 Add section adjustment dialog and context menu

## Description
## Overview
Section adjustment dialog with dx/dy.
## Files
- SectionAdjustDialog.tsx (new)
- SectionsPanel.tsx
## Acceptance
- [ ] Context menu item
- [ ] Dialog opens
- [ ] dx/dy works
- [ ] Live preview
- [ ] Undo works
- [ ] Tests pass
## Done summary
Added section adjustment dialog with dx/dy offset inputs accessible from the sections panel context menu. Includes live preview, Cancel/Apply buttons, and comprehensive Playwright E2E tests.
## Evidence
- Commits: ebac5c8aa6d36ca36830e65026709462196a2f31
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: