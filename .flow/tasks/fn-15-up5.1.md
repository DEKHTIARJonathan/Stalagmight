# fn-15-up5.1 Implement manual map placement mode

## Description
## Overview
Manual placement mode implementation.
## Files
- MapCanvas.tsx
- uiStore.ts
- useMapTools.ts
## Acceptance
- [ ] Follows cursor
- [ ] Click places
- [ ] Escape cancels
- [ ] Snaps to stations
- [ ] Tests pass
## Done summary
Implemented manual map placement mode for imported sections. Users can now select "Manual placement on map" in the Import Dialog, which enters an interactive mode where the section preview follows the cursor and click confirms placement with optional snap-to-station support.
## Evidence
- Commits: 6163c5eb6f334801ca22506f80fe10f38538714b
- Tests: pnpm tsc --noEmit, pnpm test:ui (119 passed), cd src-tauri && cargo test (62 passed)
- PRs: