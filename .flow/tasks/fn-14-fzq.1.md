# fn-14-fzq.1 Add existing station placement to Import Dialog

## Description
## Overview
Add placement mode and station connection.
## Files
- src/components/Dialogs/DmpImportDialog.tsx
## Acceptance
- [ ] Placement mode selector
- [ ] Station dropdown
- [ ] Preview shows connection
- [ ] Import merges
- [ ] Disabled without project
- [ ] Tests pass
## Done summary
Added "Placement" panel to Import Dialog with two modes: "Origin" (default) places section at (0,0), and "From Existing Station" allows connecting an import station to an existing project station with automatic merge on import. Includes station selectors, preview connection indicator, and proper disabled states.
## Evidence
- Commits: a80d600ac78f56fba0fa1d968987192c523c652f
- Tests: pnpm tsc --noEmit, pnpm test:ui (112 passed), cargo test (62 passed)
- PRs: