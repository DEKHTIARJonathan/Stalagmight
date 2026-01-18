# fn-51-ctu.9 Add Merge Preview Visualization

## Description
Show preview of how sections will be positioned when "From Existing" placement is selected.

## Files to Modify
- `src/components/Dialogs/SectionPreview.tsx`
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`
- `src/components/Map/SurveyLayer.tsx`

## Preview Features
- Show both sections in correct relative positions
- Draw dotted connection line between merge stations
- Highlight merge stations
- Live update as dropdowns change

## Map Ghost Outline
- Show ghost outline on map when From Existing configured
- Semi-transparent, dashed line style
- Position shows where section will appear after merge

## References
- `tasks/urgent/task-09-merge-preview-visualization.md`
## Acceptance
- [ ] Preview shows both sections when From Existing selected
- [ ] Sections positioned correctly relative to each other
- [ ] Connection line shown between merge stations
- [ ] Merge stations highlighted
- [ ] Map shows ghost outline of section in position
- [ ] Preview updates live as dropdowns change
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
