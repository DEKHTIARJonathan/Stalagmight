# fn-15-ygz.5 Add search filter in GlobalView toolbar

## Description
Add search/filter functionality in the GlobalView toolbar. Filter dims non-matching systems to 25% opacity while matching systems stay normal.

**Size:** S
**Files:** 
- `src/components/GlobalView/GlobalView.tsx` (add toolbar with search input)
- `src/components/GlobalView/GlobalSurveyLayer.ts` (opacity filtering)

## Approach

- Add text input in GlobalView header/toolbar area
- Filter by project name (case-insensitive substring match)
- Use layer paint property for opacity: `['case', ['in', searchTerm, ['get', 'name']], 1, 0.25]`
- Instant filtering as user types
- Dimmed systems still clickable and selectable
- Preserve selection when search is cleared

## Key context

- Use controlled input with debounce if needed for performance
- Clear search with Escape key or X button
## Acceptance
- [ ] Search input in GlobalView toolbar
- [ ] Typing filters systems instantly (case-insensitive)
- [ ] Non-matching systems dim to 25% opacity
- [ ] Matching systems stay at normal opacity
- [ ] Dimmed systems still clickable/selectable
- [ ] Selection preserved when search cleared
- [ ] Escape or X button clears search
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
