# fn-15-ygz.5 Add search filter in GlobalView toolbar

## Description

Add search/filter functionality in GlobalView toolbar.

**Size:** S
**Files:**
- `src/components/GlobalView/GlobalView.tsx` (toolbar with search)
- `src/components/GlobalView/GlobalSurveyLayer.ts` (opacity filtering)

## Approach

<!-- Updated by plan-sync: fn-15-ygz.2 layer IDs and source structure -->

- Add text input in GlobalView toolbar
- Filter by name using index-of + downcase expression (NOT `in` which is for array membership):
  ```javascript
  ['case',
    ['>=', ['index-of', ['downcase', searchTerm], ['downcase', ['get', 'name']]], 0],
    1.0, 0.25]
  ```
- Apply opacity to visual layers: `global-survey-shots-layer` and `global-survey-stations-layer`
- Source ID is `global-survey-data` with features containing `name` property
- Add `setSearchFilter(term: string | null)` method to GlobalSurveyLayer
- Instant filtering, dimmed systems still clickable
- Preserve selection when search cleared
- Clear with Escape key or X button

## Acceptance

- [ ] Search input in GlobalView toolbar
- [ ] Case-insensitive substring match using `index-of` + `downcase` expression
- [ ] Non-matching systems dim to 25% opacity
- [ ] Dimmed systems still clickable/selectable
- [ ] Selection preserved when search cleared

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
