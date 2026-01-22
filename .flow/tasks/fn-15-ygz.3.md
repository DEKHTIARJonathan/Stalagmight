# fn-15-ygz.3 Implement lazy loading with marker placeholders

## Description
Implement lazy loading of survey geometry with marker placeholders. Systems show markers initially, then load geometry on demand when visible in viewport.

**Size:** M
**Files:** 
- `src/components/GlobalView/GlobalViewMap.tsx` (loading state management)
- `src/components/GlobalView/GlobalView.tsx` (data fetching)
- `src/store/globalViewStore.ts` (new or extend existing store)

## Approach

- Track loading state per system: `idle` | `loading` | `loaded` | `error`
- Use viewport bounds to determine which systems to load
- Prioritize visible systems, load in order of distance from viewport center
- Keep geometry in memory until user enters single-system view
- Show spinner on marker while loading
- Fade transition (150ms) when geometry appears

## Key context

- Use `map.getBounds()` to get current viewport
- Check if system's `gps_bounds` intersects viewport
- Cancel pending loads when user opens a project (avoid race conditions)
## Acceptance
- [ ] Systems show markers initially with spinner while loading
- [ ] Geometry loads on demand when system is visible in viewport
- [ ] Loading state tracked per system (idle/loading/loaded/error)
- [ ] Fade transition (150ms) when survey data replaces marker
- [ ] Failed loads show red marker with error state
- [ ] Geometry cached until user enters single-system view
- [ ] No race conditions when opening project while loading
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
