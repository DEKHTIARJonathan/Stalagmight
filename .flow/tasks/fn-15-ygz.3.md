# fn-15-ygz.3 Implement lazy loading with marker placeholders

## Description

Implement lazy loading of survey geometry with marker placeholders.

**Size:** M
**Files:**
- `src/components/GlobalView/GlobalViewMap.tsx` (loading state)
- `src/components/GlobalView/GlobalView.tsx` (data fetching)
- `src/store/globalViewStore.ts` (state management)

## Approach

- Track loading state per system: idle | loading | loaded | error
- Only include projects where gps_center != null (GPS filter)
- Use `map.getBounds()` to determine which systems to load
- Prioritize visible systems by distance from viewport center
- Show spinner on marker while loading
- Fade transition (150ms) when geometry appears
- Keep geometry in memory until user enters single-system view
- Cancel pending loads when user opens a project (avoid race conditions)

## Acceptance

- [ ] Systems show markers with spinner while loading
- [ ] Projects without GPS excluded from loading
- [ ] Geometry loads on demand when visible in viewport
- [ ] Loading state tracked per system (idle/loading/loaded/error)
- [ ] Fade transition (150ms) when survey data appears
- [ ] Failed loads show red marker
- [ ] Geometry cached until single-system view

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
