# fn-15-ygz.14 Persist and restore map position/zoom

## Description
Persist and restore map position/zoom state across sessions using local storage.

**Size:** S
**Files:** 
- `src/components/GlobalView/GlobalViewMap.tsx` (save/restore logic)

## Approach

- Save map center and zoom to local storage on `moveend` event
- Restore on component mount (before initial render)
- Local storage key: `globalViewMapState`
- Store: `{ center: [lng, lat], zoom: number }`
- Fit All button still works (overrides persisted position temporarily)
## Acceptance
- [ ] Map position/zoom saved to local storage on navigation
- [ ] Position restored when returning to GlobalView
- [ ] Fit All button works regardless of persisted state
- [ ] State persists across app restarts
## Done summary
Implemented map position/zoom persistence using localStorage. State is saved on every moveend event except when the Fit All button is pressed (which overrides temporarily per spec). Validation ensures corrupted storage with invalid coordinates won't crash MapLibre.
## Evidence
- Commits: d31c930, f87cea3, f8db9c8
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: