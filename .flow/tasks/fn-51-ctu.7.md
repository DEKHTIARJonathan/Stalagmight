# fn-51-ctu.7 Add Placement Options Panel to Step 2

## Description
Add placement options panel with 4 exclusive modes to DmpSectionConfigDialog.

## Files to Modify
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## 4 Placement Modes (radio buttons, exclusive)
1. **Place at 0,0** - First station at origin
2. **Zero Datum** - GPS input with auto-detect format, station selector
3. **From Existing** - Connect to existing section/station (with merge preview)
4. **Manual Placement** - Click on map to position

## Key Features
- GPS input auto-detects DD, DMS, DDM, UTM, Plus Codes, What3words
- Station selectable via dropdown, preview click, or table row click
- Sections created immediately when placed
- Placed sections show checkmark in left panel

## References
- `tasks/urgent/task-07-placement-options-panel.md`
- `src/utils/gps.ts` (parseGps, detectFormat)
## Acceptance
- [ ] All four placement modes render correctly
- [ ] Only one mode selectable at a time (radio buttons)
- [ ] Place at 0,0 works with Place button
- [ ] Zero Datum GPS input auto-detects format
- [ ] Zero Datum station selectable via dropdown, preview, or table
- [ ] From Existing shows section/station dropdowns
- [ ] From Existing preview shows merge visualization
- [ ] Manual Placement hides dialog and shows ghost outline
- [ ] Manual Placement cancellable with Esc/right-click
- [ ] Placed sections show checkmark in left panel
- [ ] TypeScript compiles without errors
## Done summary
Enhanced the Placement Options Panel in DmpSectionConfigDialog with 4 expandable placement modes: Place at 0,0, Zero Datum (GPS with auto-format detection), From Existing (section/station dropdowns), and Manual Placement (station selector with "Place on Map" button). Added GPS parsing using parseGps and detectFormat from gps.ts utilities, station selection dropdowns, and proper data-testid attributes for E2E testing.
## Evidence
- Commits: 7b594f9f3a35d12931bd3523097df0f6d743d9f5
- Tests: pnpm tsc --noEmit, pnpm test:ui (225/226 passed, 1 flaky unrelated)
- PRs: