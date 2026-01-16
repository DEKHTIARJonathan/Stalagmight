# fn-3-m4h.3 Migrate confirmation dialogs to shared DialogWrapper

## Description
Migrate confirmation and simple dialogs to use the shared DialogWrapper.

## Files to Change

| File | Current Width | New size prop |
|------|--------------|---------------|
| ConfirmDialog.tsx | max-w-md | "md" |
| OverwriteConfirmDialog.tsx | max-w-md | "md" |
| UnsavedChangesDialog.tsx | max-w-md | "md" |
| ErrorDialog.tsx | max-w-md | "md" |
| MergeDialog.tsx | max-w-md | "md" |

## Migration Pattern

1. Import shared DialogWrapper: `import { DialogWrapper } from './DialogWrapper';`
2. Remove local DialogWrapper function
3. Replace usage with shared component
4. Set appropriate `size` prop
5. Add `data-testid` per CLAUDE.md conventions

```tsx
// Before (local DialogWrapper in file)
function DialogWrapper({ title, onClose, children }) { ... }

// After
import { DialogWrapper } from './DialogWrapper';

<DialogWrapper
  title="Confirm Action"
  onClose={closeDialog}
  size="md"
  data-testid="confirm-dialog"
>
  {/* existing content */}
</DialogWrapper>
```

## Notes

- These dialogs have no form state, so `isDirty` is not needed
- Preserve existing button order and styling
## Acceptance
- [ ] ConfirmDialog.tsx uses shared DialogWrapper with size="md"
- [ ] OverwriteConfirmDialog.tsx uses shared DialogWrapper with size="md"
- [ ] UnsavedChangesDialog.tsx uses shared DialogWrapper with size="md"
- [ ] ErrorDialog.tsx uses shared DialogWrapper with size="md"
- [ ] MergeDialog.tsx uses shared DialogWrapper with size="md"
- [ ] All dialogs have appropriate data-testid attributes
- [ ] Local DialogWrapper functions removed from these files
- [ ] TypeScript compiles without errors
- [ ] Playwright tests pass
## Done summary
Migrated ConfirmDialog, ErrorDialog, MergeDialog, OverwriteConfirmDialog, and UnsavedChangesDialog to use the shared DialogWrapper component with appropriate size props and data-testid attributes.
## Evidence
- Commits:
- Tests: pnpm tsc --noEmit
- PRs: