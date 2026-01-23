# fn-15-ygz.6 Implement GlobalView keyboard shortcuts

## Description
Implement keyboard shortcuts for GlobalView navigation and actions.

**Size:** S
**Files:** 
- `src/components/GlobalView/GlobalView.tsx` (keyboard event handlers)
- `src/components/GlobalView/GlobalViewMap.tsx` (spatial navigation)

## Approach

- Use single event listener at app root level (per convention)
- Per memory: use refs for values in keydown handlers to avoid stale closures
- Per memory: disable MapLibre's built-in keyboard handler to prevent conflicts
- Arrow keys: navigate to nearest system by centroid in that direction
- Enter: open selected project(s)
- Delete: remove from recent
- Escape: deselect all
- Ctrl+A: select all systems

## Key context

- Spatial navigation uses Euclidean distance from current selection centroid
- If no selection, arrow keys do nothing (don't navigate from map center)
- Arrow key navigation: do nothing if no system in that direction
## Acceptance
- [ ] Enter opens selected project(s)
- [ ] Delete removes selected from recent
- [ ] Escape deselects all
- [ ] Ctrl+A selects all systems
- [ ] Arrow keys navigate to nearest system in direction (by centroid)
- [ ] MapLibre built-in keyboard handler disabled
- [ ] No stale closure issues with event handlers
## Done summary
Implemented GlobalView keyboard shortcuts via dedicated useGlobalViewShortcuts hook: Enter opens selected project, Delete/Backspace removes from recent, Escape deselects all, Ctrl+A selects all systems, Arrow keys navigate to nearest system by centroid. Disabled MapLibre built-in keyboard handler to prevent conflicts.
## Evidence
- Commits: f708085, fd61001, db15664, 91c0421, ed03129
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: