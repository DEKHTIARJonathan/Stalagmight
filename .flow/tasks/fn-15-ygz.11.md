# fn-15-ygz.11 Update documentation for Global View changes

## Description

Update documentation to reflect all Global View changes.

**Size:** S
**Files:**
- `docs/SPEC.md` (sections 6.1.1, 6.3, 6.4, 13.2, Appendix A)
- `docs/architecture.md` (key files, state flow)
- `docs/configuration.md` (new config options, shortcuts)
- `docs/TESTING.md` (test patterns for new features)
- `docs/project-structure.md` (new files)

## Approach

<!-- Updated by plan-sync: fn-15-ygz.7 added view mode toggle with useViewMode hook -->
<!-- Updated by plan-sync: fn-15-ygz.14 added map position/zoom persistence -->

- Update SPEC.md section 6.1.1 with survey rendering details
- Add new keyboard shortcuts to Appendix A
- Document view mode toggle feature:
  - Toggle button in top-right corner (below navigation controls)
  - `ViewMode` type: `'survey' | 'markers'`
  - `useViewMode()` hook for localStorage persistence
  - Local storage key: `globalViewMode`
  - Switching to markers cancels pending geometry loads
- Document map position/zoom persistence:
  - Persisted to localStorage on map movement (`moveend` event)
  - Local storage key: `globalViewMapState`
  - Data structure: `{ center: [lng, lat], zoom: number }`
  - Restored on component mount
  - Fit All button temporarily overrides persisted position
  - Validation prevents corrupted storage from crashing MapLibre
- Document config options in configuration.md:
  - `global_view.fps_threshold` (default 30)
  - `global_view.tolerance` (default 0.5)
  - `global_view.throttle_tolerance` (default 1.0)
- Add test patterns for GlobalView features
- Update architecture with new files and data flow
- Follow existing documentation format and style

## Acceptance

- [ ] SPEC.md section 6.1.1 updated with survey rendering behavior
- [ ] View mode toggle documented (ViewMode type, useViewMode hook, localStorage key)
- [ ] Keyboard shortcuts documented in SPEC.md Appendix A
- [ ] Config options documented: fps_threshold, tolerance, throttle_tolerance
- [ ] Test patterns added to TESTING.md
- [ ] Architecture.md updated with new files
- [ ] project-structure.md reflects new components

## Done summary
Updated documentation for Global View survey rendering feature including SPEC.md section 6.1.1, keyboard shortcuts in Appendix A, config options in configuration.md, data flow and new files in architecture.md, test patterns in TESTING.md, and component tree in project-structure.md.
## Evidence
- Commits: 46ab97a, c571a05
- Tests: pnpm tsc --noEmit
- PRs: