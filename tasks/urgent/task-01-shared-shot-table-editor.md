# Task 01: Create Shared ShotTableEditor Component

## Description

Extract the shot table editing functionality from EditSectionDialog into a reusable ShotTableEditor component. This component will be shared between EditSectionDialog and the new DmpSectionConfigDialog (Step 2 of import).

## Files to Create

- `src/components/common/ShotTableEditor.tsx`

## Files to Modify

- `src/components/Dialogs/EditSectionDialog.tsx` (refactor to use ShotTableEditor)

## Implementation

### 1. Create ShotTableEditor Component

The new table should have these columns (in order):
- ID (row number, read-only)
- Length (editable)
- Azimuth (single column, average of in/out - editing sets both to same value)
- Depth In (editable)
- Depth Out (editable)
- L, R, U, D (editable)
- Comment (editable)
- Warnings (icon column, shows warning icon if azi in/out differ or pitch in/out differ)
- Actions (delete button)

### 2. Props Interface

```tsx
interface ShotTableEditorProps {
  shots: EditableShot[];
  onShotChange: (index: number, field: keyof EditableShot, value: number | string | boolean | null) => void;
  onAddShot: () => void;
  onDeleteShot: (index: number) => void;
  onInsertBefore?: (index: number) => void;
  onInsertAfter?: (index: number) => void;
  validationConfig?: ValidationConfig;
  readOnly?: boolean;
  showAddButton?: boolean;
  maxHeight?: string;
  selectedRowIndex?: number | null;
  onRowSelect?: (index: number) => void;
}
```

### 3. Azimuth Handling

When user edits the Azimuth column:
- Display: show average of azimuth_in and azimuth_out
- On change: set BOTH azimuth_in and azimuth_out to the entered value
- Warning: show warning icon if |azimuth_in - azimuth_out - 180| > threshold (from config)

### 4. Pitch Warning

- Pitch columns not shown in table
- Warning icon if |pitch_in - pitch_out| > threshold (from config)
- Tooltip shows details

### 5. Context Menu

Right-click on row shows:
- "Insert row before"
- "Insert row after"
- "Delete row"

### 6. Keyboard Navigation

- Tab moves between cells
- Enter confirms edit and moves to next row
- Escape cancels edit

## Acceptance Criteria

- [ ] ShotTableEditor component created with specified column layout
- [ ] Azimuth column shows average, edits set both in/out
- [ ] Warning column shows icons for azimuth/pitch discrepancies
- [ ] Thresholds read from validation config
- [ ] Right-click context menu with insert before/after/delete
- [ ] Single-cell copy/paste works (Ctrl+C/V)
- [ ] EditSectionDialog refactored to use ShotTableEditor
- [ ] TypeScript compiles without errors (`pnpm tsc --noEmit`)
- [ ] All existing tests pass

## Existing Tests to Modify

The following existing test files must be updated to account for changes made in this task:

### Playwright Tests
- `e2e-playwright/import-dialog.spec.ts` - Shot table tests need updating for new column layout (Azimuth as single column, Warnings column)
- `e2e-playwright/section-shot-editing.spec.ts` - EditSectionDialog tests need updating since it will use the new ShotTableEditor component

### WebdriverIO Tests
- `e2e/specs/import-dmp-dialog.spec.ts` - Shot table interaction tests need updating for new columns

### Mock Updates
- `e2e-playwright/mocks/tauri-ipc.ts` - No changes needed (uses existing shot data structure)

## Test Suggestions

### Unit Tests (Rust)
N/A - This is a frontend-only task.

### Playwright Tests (3-10)
1. Test azimuth column displays average of in/out values
2. Test editing azimuth sets both azimuth_in and azimuth_out
3. Test warning icon appears when azimuth in/out differ by more than threshold
4. Test warning icon appears when pitch in/out differ by more than threshold
5. Test right-click shows context menu with insert options
6. Test "Insert row before" adds row at correct position
7. Test "Insert row after" adds row at correct position
8. Test delete row removes the row
9. Test Tab key navigation between cells
10. Test Enter key confirms edit and advances row

### WebdriverIO Tests (3-10)
1. Test shot table renders with correct columns in EditSectionDialog
2. Test adding a new shot and editing azimuth value
3. Test deleting a shot via context menu
4. Test copy/paste of cell values
5. Test keyboard navigation through table

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
