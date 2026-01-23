# fn-15-ygz.7 Add view mode toggle (survey/markers)

## Description
Add view mode toggle control to switch between survey geometry and markers-only view.

**Size:** S
**Files:** 
- `src/components/GlobalView/GlobalViewMap.tsx` (toggle control, mode switching)
- `src/components/GlobalView/ViewModeToggle.tsx` (new component)

## Approach

<!-- Updated by plan-sync: fn-15-ygz.2 layer structure and visibility -->

- Floating map control button in top-right corner
- Icon changes between survey/markers representations
- Persist preference in local storage
- Switching to markers cancels in-progress geometry loads
- Tooltip on hover explaining the toggle
- To hide survey layers, set visibility on `global-survey-shots-layer` and `global-survey-stations-layer`
- GlobalSurveyLayer ref available via `surveyLayerRef` in GlobalViewMap
- Consider adding `setVisible(visible: boolean)` method to GlobalSurveyLayer

## Key context

- Use CSS transition for icon change
- Local storage key: `globalViewMode`
- Layer IDs are private constants in GlobalSurveyLayer; may need to expose or add visibility method
## Acceptance
- [ ] Toggle button in top-right map corner
- [ ] Icon changes to reflect current mode
- [ ] Clicking toggles between survey and markers view
- [ ] Preference persisted in local storage
- [ ] Tooltip shows on hover
- [ ] Switching to markers cancels pending geometry loads
## Done summary
Added view mode toggle to GlobalView map that switches between survey geometry and markers-only views, with localStorage persistence and proper handling of in-flight geometry loads.
## Evidence
- Commits: 07aa9157f05d2e9fd0a7b5dba6b8e391b6b92478, 4d932aeaca0abb939227d91f819369dfd192883c
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: