# fn-3-m4h.4 Migrate form dialogs to shared DialogWrapper

## Description
Migrate form dialogs (dialogs with user input) to use the shared DialogWrapper with isDirty support.

## Files to Change

| File | Current Width | New size prop | Has Form State |
|------|--------------|---------------|----------------|
| ImportDialog.tsx | max-w-2xl | "2xl" | Yes (shots, metadata) |
| DmpImportDialog.tsx | max-w-2xl | "2xl" | Yes (file path, name) |
| NewProjectDialog.tsx | max-w-md | "md" | Yes (name, location) |
| EditShotDialog.tsx | max-w-2xl | "2xl" | Yes (shot fields) |
| EditStationDialog.tsx | max-w-md | "md" | Yes (GPS coords) |
| DrawShotDialog.tsx | max-w-md | "md" | Yes (shot fields) |

## Migration Pattern

```tsx
import { DialogWrapper } from './DialogWrapper';

// Track form changes
const [formChanged, setFormChanged] = useState(false);

<DialogWrapper
  title="Edit Shot"
  onClose={closeDialog}
  size="2xl"
  isDirty={formChanged}  // Show confirmation if form has unsaved changes
  data-testid="edit-shot-dialog"
>
  {/* existing form content */}
</DialogWrapper>
```

## isDirty Implementation

Each dialog needs to track whether the user has made changes:

```tsx
// Simple approach: set dirty on any input change
const handleFieldChange = (value) => {
  setFormChanged(true);
  setFieldValue(value);
};

// Or compare to initial state
const isDirty = JSON.stringify(formState) !== JSON.stringify(initialState);
```

## Notes

- Preserve existing validation logic
- Preserve existing submit handlers
- Remove local DialogWrapper functions
## Acceptance
- [ ] ImportDialog.tsx uses shared DialogWrapper with size="2xl" and isDirty
- [ ] DmpImportDialog.tsx uses shared DialogWrapper with size="2xl" and isDirty
- [ ] NewProjectDialog.tsx uses shared DialogWrapper with size="md" and isDirty
- [ ] EditShotDialog.tsx uses shared DialogWrapper with size="2xl" and isDirty
- [ ] EditStationDialog.tsx uses shared DialogWrapper with size="md" and isDirty
- [ ] DrawShotDialog.tsx uses shared DialogWrapper with size="md" and isDirty
- [ ] All dialogs have appropriate data-testid attributes
- [ ] Dirty forms show confirmation dialog before Escape/backdrop close
- [ ] Clean forms close immediately on Escape
- [ ] Local DialogWrapper functions removed from these files
- [ ] TypeScript compiles without errors
- [ ] Playwright tests pass
## Done summary
Migrated form dialogs to use the shared DialogWrapper component: ImportDialog, DmpImportDialog, NewProjectDialog, EditShotDialog, EditStationDialog, and DrawShotDialog now all use the shared component with isDirty support and data-testid attributes.
## Evidence
- Commits:
- Tests: pnpm tsc --noEmit
- PRs: