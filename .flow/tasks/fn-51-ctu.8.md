# fn-51-ctu.8 Integrate ShotTableEditor in Step 2

## Description
Integrate ShotTableEditor component into DmpSectionConfigDialog with DMP data conversion.

## Files to Modify
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Features
- Convert DMP shots to EditableShot format
- Add Shot button adds row at end
- Insert before/after via context menu
- Delete mid-section shows confirmation
- Row selection syncs with preview station selection
- Undo/redo within dialog (Ctrl+Z, Ctrl+Shift+Z)

## DMP Conversion
```tsx
function dmpShotToEditable(shot: DmpShot, index: number): EditableShot {
  return {
    id: index,
    azimuth_in: shot.heading_in,
    azimuth_out: shot.heading_out,
    length: shot.length,
    depth_in: shot.depth_in,
    depth_out: shot.depth_out,
    // ... LRUD, pitch, comment
  };
}
```

## References
- `tasks/urgent/task-08-shot-table-integration.md`
## Acceptance
- [ ] Shot table renders with correct columns
- [ ] DMP shots converted to editable format
- [ ] All columns editable
- [ ] Add Shot button adds row at end
- [ ] Right-click shows Insert Before/After options
- [ ] Delete shot shows confirmation for mid-section
- [ ] Row selection syncs with preview station selection
- [ ] Undo/redo works within dialog
- [ ] TypeScript compiles without errors
## Done summary
# fn-51-ctu.8 Integration Summary

## Changes Made
Integrated ShotTableEditor component into DmpSectionConfigDialog with full feature support:

1. **Insert Before/After via Context Menu**: Added `handleInsertBefore` and `handleInsertAfter` callbacks that are now passed to ShotTableEditor, enabling right-click insert options.

2. **Delete Confirmation for Mid-Section Shots**: Added `isMidSectionShot` check and confirmation dialog (`delete-shot-confirm-dialog`) that shows when deleting shots that are not first/last in the visible shot list.

3. **Row Selection Sync with Preview**: 
   - Added `selectedShotIndex` state
   - Wired `selectedRowIndex` and `onRowSelect` props to ShotTableEditor
   - Connected to SectionPreview's `selectedStationIndex` and `onStationClick` with proper index mapping (shot N → station N+1)

4. **Undo/Redo Within Dialog**:
   - Added `historyRef` to track per-section undo/redo history
   - Added `saveToHistory`, `handleUndo`, `handleRedo` functions
   - Debounced field edits (same field/row doesn't create multiple history entries)
   - Added Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y keyboard shortcuts
   - History limited to 50 entries per section

## Files Modified
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Verification
- TypeScript compiles without errors (`pnpm tsc --noEmit`)
- All 226 Playwright E2E tests pass
- All 72 Rust backend tests pass
## Evidence
- Commits:
- Tests: typescript, playwright, rust
- PRs: