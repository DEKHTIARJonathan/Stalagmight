# fn-51-ctu.2 Create Shared SectionMetadataForm Component

## Description
Extract section metadata editing (name, surveyor, date, color, direction) into a reusable `SectionMetadataForm` component shared between EditSectionDialog and DmpSectionConfigDialog.

## Files to Create
- `src/components/common/SectionMetadataForm.tsx`

## Files to Modify
- `src/components/Dialogs/EditSectionDialog.tsx` (refactor to use SectionMetadataForm)

## Props Interface
```tsx
interface SectionMetadataFormProps {
  name: string;
  surveyor: string;
  date: string;
  color: string;
  direction?: 'in' | 'out';
  onNameChange: (value: string) => void;
  onSurveyorChange: (value: string) => void;
  onDateChange: (value: string) => void;
  onColorChange: (value: string) => void;
  onDirectionChange?: (value: 'in' | 'out') => void;
  showDirection?: boolean;
  disabled?: boolean;
}
```

## Layout
Horizontal grid: Name | Surveyor | Date | Color (picker + hex) | Direction (optional dropdown)

## Existing Tests to Modify
- `e2e-playwright/section-shot-editing.spec.ts`
- `e2e-playwright/import-dialog.spec.ts`
- `e2e/specs/import-section-dialog.spec.ts`

## References
- `tasks/urgent/task-02-shared-section-metadata-form.md`
## Acceptance
- [ ] SectionMetadataForm component created
- [ ] All fields editable and controlled
- [ ] Direction dropdown shown only when showDirection=true
- [ ] Color picker syncs with hex input
- [ ] EditSectionDialog refactored to use SectionMetadataForm
- [ ] TypeScript compiles without errors
- [ ] All existing tests pass
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
