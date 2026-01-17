# fn-10-r0g.1 Wire showScaleBar toggle to ScaleControl

## Description
## Overview
Wire showScaleBar toggle to ScaleControl visibility.

## Implementation
1. Check uiStore has showScaleBar
2. Add/remove ScaleControl based on state
3. Persist setting

## Files
- src/components/Map/MapCanvas.tsx
- src/store/uiStore.ts
## Acceptance
- [ ] Toggle state in uiStore
- [ ] ScaleControl visibility responds
- [ ] Persists per project
- [ ] Tests pass
## Done summary
Wired the showScaleBar toggle in the Display menu to the MapLibre ScaleControl, with full per-project persistence via SQLite display_settings table and in-memory cache for unsaved projects.
## Evidence
- Commits: 0f6d6f7, e5115ab, 793269b, 8ab39c7
- Tests: pnpm tsc --noEmit, pnpm test:ui, cargo check
- PRs: