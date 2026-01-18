# fn-51-ctu.4 Create DmpSelectionDialog Shell (Step 1)

## Description
Create Step 1 dialog for DMP import showing DMP metadata, section list with checkboxes, and default surveyor/date fields.

## Files to Create
- `src/components/Dialogs/DmpSelectionDialog.tsx`

## Files to Modify
- `src/components/Dialogs/index.ts`
- `src/store/uiStore.ts`
- `src/App.tsx`

## Dialog Structure
- Header: File name, version, section count, total shots, total length, date range
- Default Values: Surveyor input, Date Override input
- Bulk Selection: Select All, Select None, Invert buttons
- Section Table: Checkbox | Name | Date | Direction | Shots (empty sections grayed/disabled)
- Footer: Cancel | Continue to Section Setup (disabled if none selected)

## Props Interface
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

## Existing Tests to Modify
- `e2e-playwright/import-dialog.spec.ts` - Replace `[data-testid="import-dmp-dialog"]` with `[data-testid="dmp-selection-dialog"]`
- `e2e-playwright/dmp-import.spec.ts`
- `e2e/specs/import-dmp-dialog.spec.ts`
- `e2e/specs/keyboard-shortcuts.spec.ts`

## References
- `tasks/urgent/task-04-dmp-selection-dialog-shell.md`
## Acceptance
- [ ] Dialog renders with DMP metadata header
- [ ] Section table shows all sections with correct columns
- [ ] Empty sections are grayed out and disabled
- [ ] Bulk selection controls work (All, None, Invert)
- [ ] Default surveyor input works
- [ ] Default date override input works
- [ ] Continue button disabled when no sections selected
- [ ] Cancel shows confirmation if data changed
- [ ] TypeScript compiles without errors
## Done summary
Created DmpSelectionDialog component (Step 1 of the two-step DMP import flow). The dialog displays DMP file metadata, a section table with checkboxes for selection, direction dropdowns, bulk selection controls (All/None/Invert), and default surveyor/date inputs. Empty sections are grayed out and disabled. Continue button is disabled when no sections are selected. Dialog integrates with App.tsx and exports DmpSelectionConfig interface for Step 2.
## Evidence
- Commits: 9ae8cf8cb665f5048043f6a3f728a7e3c0b6c2ec
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: