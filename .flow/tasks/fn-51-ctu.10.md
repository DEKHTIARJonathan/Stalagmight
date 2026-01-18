# fn-51-ctu.10 Implement Manual Placement Mode

## Description
Implement manual placement where dialog hides, ghost outline follows cursor, click places section.

## Files to Modify
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`
- `src/components/Map/MapCanvas.tsx`
- `src/components/Map/SurveyLayer.tsx`
- `src/store/uiStore.ts`

## Flow
1. Click "Start Placement" - dialog hides
2. Instruction overlay: "Click to place section. Press Esc or right-click to cancel."
3. Ghost outline follows cursor on map
4. Click places section, dialog reappears with section marked as placed
5. Esc/right-click cancels, dialog reappears unchanged

## No Rotation
Section keeps original orientation during placement.

## References
- `tasks/urgent/task-10-manual-placement-mode.md`
## Acceptance
- [ ] "Start Placement" button hides dialog
- [ ] Ghost outline follows cursor on map
- [ ] Instruction overlay bar visible at top
- [ ] Click on map places section and reopens dialog
- [ ] Escape key cancels and reopens dialog
- [ ] Right-click cancels and reopens dialog
- [ ] Section created at correct position after placement
- [ ] Section marked as placed in left panel
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
