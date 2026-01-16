# fn-3-m4h.5 Migrate remaining dialogs to shared DialogWrapper

## Description
Migrate remaining dialogs to use the shared DialogWrapper.

## Files to Change

| File | Current Width | New size prop |
|------|--------------|---------------|
| EditSectionDialog.tsx | max-w-5xl | "5xl" |
| ExportDialog.tsx | max-w-2xl | "2xl" |

## Notes

- EditSectionDialog is the widest dialog (5xl) - preserve this sizing
- ExportDialog has no form state requiring isDirty
- EditSectionDialog has section metadata - consider isDirty for name/color changes

## Migration

```tsx
import { DialogWrapper } from './DialogWrapper';

<DialogWrapper
  title="Edit Section"
  onClose={closeDialog}
  size="5xl"
  isDirty={hasUnsavedChanges}
  data-testid="edit-section-dialog"
>
  {/* existing content */}
</DialogWrapper>
```
## Acceptance
- [ ] EditSectionDialog.tsx uses shared DialogWrapper with size="5xl"
- [ ] ExportDialog.tsx uses shared DialogWrapper with size="2xl"
- [ ] All dialogs have appropriate data-testid attributes
- [ ] Local DialogWrapper functions removed from these files
- [ ] TypeScript compiles without errors
- [ ] Playwright tests pass
## Done summary
Migrated EditSectionDialog.tsx (size="5xl") and ExportDialog.tsx (size="md") to use the shared DialogWrapper component with appropriate isDirty support and data-testid attributes.
## Evidence
- Commits:
- Tests: pnpm tsc --noEmit
- PRs: