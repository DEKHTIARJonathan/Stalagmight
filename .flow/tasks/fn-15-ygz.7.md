# fn-15-ygz.7 Add view mode toggle (survey/markers)

## Description
Add view mode toggle control to switch between survey geometry and markers-only view.

**Size:** S
**Files:** 
- `src/components/GlobalView/GlobalViewMap.tsx` (toggle control, mode switching)
- `src/components/GlobalView/ViewModeToggle.tsx` (new component)

## Approach

- Floating map control button in top-right corner
- Icon changes between survey/markers representations
- Persist preference in local storage
- Switching to markers cancels in-progress geometry loads
- Tooltip on hover explaining the toggle

## Key context

- Use CSS transition for icon change
- Local storage key: `globalViewMode`
## Acceptance
- [ ] Toggle button in top-right map corner
- [ ] Icon changes to reflect current mode
- [ ] Clicking toggles between survey and markers view
- [ ] Preference persisted in local storage
- [ ] Tooltip shows on hover
- [ ] Switching to markers cancels pending geometry loads
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
