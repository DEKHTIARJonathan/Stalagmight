# Task 08: Integrate ShotTableEditor into Step 2 Dialog

## Description

Integrate the shared ShotTableEditor component into DmpSectionConfigDialog with the correct column layout (Azimuth as average, Warnings column) and full editing capabilities.

## Files to Modify

- `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Implementation

### 1. Shot Table Position

Located at bottom of main panel, takes remaining height:

```
┌─ Shot Data ─────────────────────────────────────────────────────────────┐
│ [+ Add Shot]                                                             │
│ ┌────┬────────┬─────────┬──────────┬──────────┬───┬───┬───┬───┬────────┐│
│ │ ID │ Length │ Azimuth │ Depth In │ Depth Out│ L │ R │ U │ D │ ⚠ │ ✕  ││
│ ├────┼────────┼─────────┼──────────┼──────────┼───┼───┼───┼───┼────────┤│
│ │ 1  │ 3.2    │ 45.0    │ 5.1      │ 5.8      │1.2│0.8│2.1│1.5│   │ ✕  ││
│ │ 2  │ 4.1    │ 52.3 ⚠ │ 5.8      │ 6.2      │1.0│1.1│1.8│1.2│ ⚠ │ ✕  ││
│ └────┴────────┴─────────┴──────────┴──────────┴───┴───┴───┴───┴────────┘│
└──────────────────────────────────────────────────────────────────────────┘
```

### 2. Convert DMP Shots to Editable Shots

```tsx
function dmpShotToEditable(shot: DmpShot, index: number): EditableShot {
  return {
    id: index,
    azimuth_in: shot.heading_in,
    azimuth_out: shot.heading_out,
    length: shot.length,
    depth_in: shot.depth_in,
    depth_out: shot.depth_out,
    pitch_in: shot.pitch_in || null,
    pitch_out: shot.pitch_out || null,
    left: shot.left || null,
    right: shot.right || null,
    up: shot.up || null,
    down: shot.down || null,
    comment: shot.comment || null,
    is_virtual: false,
  };
}
```

### 3. Shot State Management

```tsx
// Per-section shot state
const [sectionShots, setSectionShots] = useState<Map<number, EditableShot[]>>(new Map());

// Initialize from DMP when viewing section
useEffect(() => {
  if (!sectionShots.has(currentSectionIndex)) {
    const dmpSection = dmpFile.sections[currentSectionIndex];
    const standardShots = dmpSection.shots.filter(s => s.shot_type === 'Standard');
    const editableShots = standardShots.map(dmpShotToEditable);
    setSectionShots(prev => new Map(prev).set(currentSectionIndex, editableShots));
  }
}, [currentSectionIndex]);
```

### 4. Add Shot Behavior

New shots have empty/null values:
```tsx
const newShot: EditableShot = {
  id: -Date.now(), // temporary ID
  azimuth_in: 0,
  azimuth_out: 0,
  length: 0,
  depth_in: 0,
  depth_out: 0,
  pitch_in: null,
  pitch_out: null,
  left: null,
  right: null,
  up: null,
  down: null,
  comment: null,
  is_virtual: false,
  isNew: true,
};
```

### 5. Delete Confirmation

- Delete first/last shot: no confirmation
- Delete mid-section shot: confirm dialog "Deleting this shot will split the section. Continue?"

### 6. Row Selection

- Single row selection only
- Selected row highlighted
- Clicking station in preview selects corresponding row
- Clicking row updates station selection in preview

### 7. Undo/Redo within Dialog

- Ctrl+Z: undo last edit
- Ctrl+Shift+Z / Ctrl+Y: redo
- Undo stack per section

## Acceptance Criteria

- [ ] Shot table renders with correct columns
- [ ] DMP shots converted to editable format
- [ ] All columns editable
- [ ] Add Shot button adds row at end
- [ ] Right-click shows Insert Before/After options
- [ ] Delete shot shows confirmation for mid-section
- [ ] Row selection syncs with preview station selection
- [ ] Undo/redo works within dialog
- [ ] TypeScript compiles without errors

## Existing Tests to Modify

The following existing test files must be updated to account for changes made in this task:

### Playwright Tests
- `e2e-playwright/import-dialog.spec.ts` - Shot table tests need updating for Step 2 dialog integration (uses ShotTableEditor from Task 01)
- `e2e-playwright/section-shot-editing.spec.ts` - May need updates to verify consistent shot editing behavior across dialogs

### WebdriverIO Tests
- `e2e/specs/import-dmp-dialog.spec.ts` - Shot table editing tests need updating for Step 2 dialog

### Mock Updates
- `e2e-playwright/mocks/tauri-ipc.ts` - Add mock handlers for `updateShot`, `createShot`, `deleteShot` commands

## Test Suggestions

### Unit Tests (Rust)
N/A - Frontend-only task.

### Playwright Tests (3-10)
1. Test shot table displays DMP shots
2. Test editing length column
3. Test editing azimuth sets both in/out
4. Test Add Shot adds row at end
5. Test right-click Insert Before adds row correctly
6. Test right-click Insert After adds row correctly
7. Test delete mid-section shows confirmation
8. Test delete end shot no confirmation
9. Test Ctrl+Z undoes last edit
10. Test row selection highlights row

### WebdriverIO Tests (3-10)
1. Test shot table editing with full app
2. Test added shots appear after import
3. Test deleted shots don't appear after import
4. Test edited values persist after import
5. Test undo/redo in full dialog

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
