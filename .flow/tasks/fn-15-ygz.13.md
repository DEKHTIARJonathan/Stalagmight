# fn-15-ygz.13 Add context menu and error popup interactions

## Description
Add context menu options for systems and error popup for failed loads.

**Size:** S
**Files:** 
- `src/components/GlobalView/GlobalViewMap.tsx` (context menu, error popup)
- `src/components/GlobalView/GlobalView.tsx` (menu actions)

## Approach

- Context menu on right-click: Open, Zoom to System, Remove from Recent, Show in Folder
- Add "Merge N Projects" option when multiple systems selected
- Menu shows count for multi-selection: "Remove 3 from Recent"
- Error popup: click red marker → show popup with error message
- Reuse existing context menu patterns from `GlobalView.tsx`
## Acceptance
- [ ] Right-click shows context menu with: Open, Zoom to System, Remove, Show in Folder
- [ ] "Merge N Projects" appears when multiple selected
- [ ] Menu shows count for multi-selection actions
- [ ] Clicking red error marker shows popup with error details
- [ ] Menu actions work correctly
## Done summary
Added right-click context menu for GlobalView map with Open, Zoom to System, Remove from Recent, and Show in Folder options. Context menu shows counts for multi-selection (e.g., "Remove 3 from Recent", "Merge N Projects"). Clicking red error markers now shows an error popup with details.
## Evidence
- Commits: eae40fbb47b9bc46fddb06aef0e5fdf87f5ba6d9, 5b9837c347b734aaa6156e30577611abd902af04
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: