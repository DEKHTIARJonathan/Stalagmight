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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
