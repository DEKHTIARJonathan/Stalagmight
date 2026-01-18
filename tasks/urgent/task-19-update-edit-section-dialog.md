# Task 19: Update Edit Section Dialog to Use Shared Components

## Description

Refactor EditSectionDialog to use the new shared components (ShotTableEditor, SectionMetadataForm) and match the new column layout (Azimuth as average, Warnings column).

## Files to Modify

- `src/components/Dialogs/EditSectionDialog.tsx`

## Implementation

### 1. Import Shared Components

```tsx
import { ShotTableEditor } from '../common/ShotTableEditor';
import { SectionMetadataForm } from '../common/SectionMetadataForm';
```

### 2. Replace Metadata Section

Replace the inline metadata form with SectionMetadataForm:

```tsx
<SectionMetadataForm
  name={name}
  surveyor={surveyor}
  date={date}
  color={color}
  direction={direction}
  onNameChange={setName}
  onSurveyorChange={setSurveyor}
  onDateChange={setDate}
  onColorChange={setColor}
  onDirectionChange={setDirection}
  showDirection={true}
/>
```

### 3. Replace Shot Table

Replace the inline table with ShotTableEditor:

```tsx
<ShotTableEditor
  shots={shots}
  onShotChange={handleShotChange}
  onAddShot={handleAddShot}
  onDeleteShot={handleDeleteShot}
  onInsertBefore={handleInsertBefore}
  onInsertAfter={handleInsertAfter}
  validationConfig={validationConfig}
  showAddButton={true}
  maxHeight="max-h-64"
/>
```

### 4. Add Insert Before/After Handlers

```tsx
const handleInsertBefore = (index: number) => {
  const newShot = createEmptyShot();
  setShots(prev => [
    ...prev.slice(0, index),
    newShot,
    ...prev.slice(index),
  ]);
  setNextTempId(prev => prev - 1);
};

const handleInsertAfter = (index: number) => {
  const newShot = createEmptyShot();
  setShots(prev => [
    ...prev.slice(0, index + 1),
    newShot,
    ...prev.slice(index + 1),
  ]);
  setNextTempId(prev => prev - 1);
};
```

### 5. Update Column Layout

The shared ShotTableEditor now uses the new column layout:
- ID, Length, Azimuth (average), Depth In, Depth Out, L, R, U, D, Comment, Warnings, Actions

This replaces the old layout with separate Az In/Az Out columns.

### 6. Handle Azimuth Edit

When user edits Azimuth in the table:
- ShotTableEditor internally sets both azimuth_in and azimuth_out to the entered value
- This matches import dialog behavior

### 7. Add Direction Field

Add direction field to EditSectionDialog if not already present:
- Dropdown with "In" and "Out" options
- Saved with section metadata

## Acceptance Criteria

- [ ] EditSectionDialog uses SectionMetadataForm
- [ ] EditSectionDialog uses ShotTableEditor
- [ ] New column layout matches import dialog
- [ ] Azimuth edits set both in/out values
- [ ] Warnings column shows azimuth/pitch discrepancies
- [ ] Insert before/after works via context menu
- [ ] Direction field editable
- [ ] All existing functionality preserved
- [ ] TypeScript compiles without errors
- [ ] Existing tests pass

## Test Suggestions

### Unit Tests (Rust)
N/A - Frontend-only task.

### Playwright Tests (3-10)
1. Test EditSectionDialog opens with section data
2. Test name field editable
3. Test surveyor field editable
4. Test shot table displays with new columns
5. Test editing azimuth sets both in/out
6. Test warning icon appears for discrepancy
7. Test right-click insert before works
8. Test right-click insert after works
9. Test direction dropdown changes value
10. Test save persists all changes

### WebdriverIO Tests (3-10)
1. Test full edit section flow
2. Test editing shots and saving
3. Test adding shots via insert
4. Test direction change persists
5. Test warning display in real app

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
