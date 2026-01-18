# fn-51-ctu.1 Create Shared ShotTableEditor Component

## Description
Extract the shot table editing functionality from EditSectionDialog into a reusable `ShotTableEditor` component that will be shared between EditSectionDialog and DmpSectionConfigDialog.

## Files to Create
- `src/components/common/ShotTableEditor.tsx`

## Files to Modify
- `src/components/Dialogs/EditSectionDialog.tsx` (refactor to use ShotTableEditor)

## Implementation

### Column Layout
ID | Length | Azimuth | Depth In | Depth Out | L | R | U | D | Comment | Warnings | Actions

### Key Features
- Azimuth: Display average of in/out, edit sets BOTH values
- Warnings column: Icon if azi/pitch in/out differ by threshold
- Context menu: Right-click for insert before/after/delete
- Keyboard: Tab between cells, Enter confirms, Escape cancels

### Props Interface
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

## Existing Tests to Modify
- `e2e-playwright/import-dialog.spec.ts` - Shot table tests need updating for new column layout
- `e2e-playwright/section-shot-editing.spec.ts` - EditSectionDialog tests need updating
- `e2e/specs/import-dmp-dialog.spec.ts` - Shot table interaction tests

## References
- `tasks/urgent/task-01-shared-shot-table-editor.md` (full spec)
- `src/components/Dialogs/EditSectionDialog.tsx:1-486` (existing shot table)
## Acceptance
- [ ] ShotTableEditor component created with specified column layout
- [ ] Azimuth column shows average, edits set both in/out
- [ ] Warning column shows icons for azimuth/pitch discrepancies
- [ ] Thresholds read from validation config
- [ ] Right-click context menu with insert before/after/delete
- [ ] Single-cell copy/paste works (Ctrl+C/V)
- [ ] EditSectionDialog refactored to use ShotTableEditor
- [ ] TypeScript compiles without errors (`pnpm tsc --noEmit`)
- [ ] All existing tests pass
## Done summary
Created ShotTableEditor component with single Azimuth column (shows average, edits set both in/out), Warnings column for azimuth/pitch discrepancies, right-click context menu for insert/delete, and refactored EditSectionDialog to use the shared component.
## Evidence
- Commits: 46f0e0694275fa36d74fe7ab4547d552891521a0
- Tests: pnpm tsc --noEmit, pnpm test:ui, cd src-tauri && cargo test
- PRs: