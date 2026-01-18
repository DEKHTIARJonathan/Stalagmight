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
## Summary

Created a shared `SectionMetadataForm` component that encapsulates section metadata editing (name, surveyor, date, color, direction) into a reusable form. Refactored `EditSectionDialog` to use this component.

### Changes
- Created `src/components/common/SectionMetadataForm.tsx` with controlled props interface
- Refactored `EditSectionDialog.tsx` to use `SectionMetadataForm` instead of inline form fields
- Component supports optional direction dropdown via `showDirection` prop
- Color picker syncs with hex input
- All fields editable and controlled via callback props
- Includes data-testid attributes for E2E testing
## Evidence
- Commits:
- Tests: pnpm tsc --noEmit (passed), pnpm test:ui (226 tests passed), cargo test (72 tests passed)
- PRs: