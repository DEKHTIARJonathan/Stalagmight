# Task 04: Create DmpSelectionDialog (Step 1 Dialog Shell)

## Description

Create the Step 1 dialog for DMP import. This dialog shows DMP file metadata, a list of sections with checkboxes, and default surveyor/date fields that apply to all sections.

## Files to Create

- `src/components/Dialogs/DmpSelectionDialog.tsx`

## Files to Modify

- `src/components/Dialogs/index.ts` (export new dialog)
- `src/store/uiStore.ts` (add new dialog type if needed)
- `src/App.tsx` (add dialog rendering)

## Implementation

### 1. Dialog Structure

```
┌─ Import DMP File (Step 1) ───────────────────────────────────────┐
│                                                                   │
│  File: survey.dmp                                                │
│  Version: 5 | Sections: 3 | Shots: 127 | Length: 234.5m         │
│  Date Range: 2024-01-10 to 2024-01-15 | Device: mNemo            │
│                                                                   │
│  ┌─ Default Values (apply to all) ─────────────────────────────┐ │
│  │ Surveyor: [________________]  Date Override: [__________]   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  [Select All] [Select None] [Invert]                             │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ ☑ │ Name │ Date       │ Direction │ Shots │                 ││
│  │ ☑ │ ABC  │ 2024-01-10 │ In        │ 45    │                 ││
│  │ ☑ │ DEF  │ 2024-01-12 │ Out       │ 52    │                 ││
│  │ ☐ │ GHI  │ 2024-01-15 │ In        │ 0     │ (empty, grayed) ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                   │
│  [Cancel]                              [Continue to Section Setup]│
└───────────────────────────────────────────────────────────────────┘
```

### 2. Props Interface

```tsx
interface DmpSelectionDialogProps {
  dmpFile: DmpFile;
  filePath: string;
  onCancel: () => void;
  onContinue: (config: DmpSelectionConfig) => void;
}

interface DmpSelectionConfig {
  selectedIndices: Set<number>;
  defaultSurveyor: string;
  defaultDate: string | null;
  sectionDirections: Map<number, 'in' | 'out'>;
}
```

### 3. Header Metadata

Display full DMP info:
- Filename
- DMP version
- Section count
- Total shots (Standard shots only)
- Total length
- Date range (min/max from sections)
- Device info (if available in DMP)

### 4. Default Values Section

- Default Surveyor: text input, remembered in session
- Date Override: optional, when set applies to all sections

### 5. Section Table

Table with columns (no editing, display only):
- Checkbox (selection)
- Name (from DMP)
- Date (from DMP)
- Direction (from DMP, display only in Step 1)
- Shots (count of Standard shots)

Empty sections (0 shots) shown grayed out and disabled.

### 6. Bulk Selection

- Select All: selects all non-empty sections
- Select None: deselects all
- Invert Selection: toggles each section

### 7. Continue Button

- Disabled if no sections selected
- Text: "Continue to Section Setup"
- Calls onContinue with DmpSelectionConfig

### 8. Cancel Behavior

- If user has changed default surveyor/date or selection: show confirmation
- Otherwise close immediately

## Acceptance Criteria

- [ ] Dialog renders with DMP metadata header
- [ ] Section table shows all sections with correct columns
- [ ] Empty sections are grayed out and disabled
- [ ] Bulk selection controls work (All, None, Invert)
- [ ] Default surveyor input works
- [ ] Default date override input works
- [ ] Continue button disabled when no sections selected
- [ ] Cancel shows confirmation if data changed
- [ ] TypeScript compiles without errors

## Test Suggestions

### Unit Tests (Rust)
N/A - Frontend-only task.

### Playwright Tests (3-10)
1. Test dialog renders with correct DMP metadata
2. Test section count shows correctly in header
3. Test total length calculated correctly
4. Test Select All button selects all non-empty sections
5. Test Select None deselects all sections
6. Test Invert Selection toggles selection
7. Test empty sections are disabled and grayed
8. Test Continue button disabled when nothing selected
9. Test default surveyor field is editable
10. Test Cancel shows confirmation when surveyor changed

### WebdriverIO Tests (3-10)
1. Test opening DMP file shows Step 1 dialog
2. Test selecting sections and clicking Continue
3. Test drag-drop DMP file opens Step 1 dialog
4. Test default surveyor remembered in session
5. Test Cancel closes dialog with confirmation

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
