# Task 20: Remove Old DmpImportDialog and Update References

## Description

Remove the old single-dialog DmpImportDialog and update all references to use the new two-step import flow.

## Files to Delete

- `src/components/Dialogs/DmpImportDialog.tsx`

## Files to Modify

- `src/components/Dialogs/index.ts`
- `src/App.tsx`
- `src/store/uiStore.ts`
- `src/hooks/useKeyboardShortcuts.ts`
- `e2e-playwright/import-dialog.spec.ts`

## Implementation

### 1. Update Dialog Exports

```tsx
// In src/components/Dialogs/index.ts
// Remove: export { default as DmpImportDialog } from './DmpImportDialog';
// Add:
export { default as DmpSelectionDialog } from './DmpSelectionDialog';
export { default as DmpSectionConfigDialog } from './DmpSectionConfigDialog';
```

### 2. Update App.tsx

Remove old DmpImportDialog rendering:

```tsx
// Remove:
// {activeDialog === 'dmp-import' && <DmpImportDialog />}

// The new dialogs are rendered based on importFlow state (from Task 14)
```

### 3. Update UI Store

```tsx
// Remove 'dmp-import' from ActiveDialog type if present
// Ensure new import flow state is properly typed
```

### 4. Update Keyboard Shortcuts

```tsx
// In useKeyboardShortcuts.ts
// Ctrl+I now triggers the new import flow (from Task 14)
// Remove any references to opening 'dmp-import' dialog directly
```

### 5. Update Tests

Update Playwright tests to use the new two-step dialog flow:

```tsx
// Old test:
// await page.locator('[data-testid="import-dmp-dialog"]').waitFor();

// New tests:
// Step 1 dialog
await page.locator('[data-testid="dmp-selection-dialog"]').waitFor();
// ... interact with Step 1

// Step 2 dialog
await page.locator('[data-testid="dmp-section-config-dialog"]').waitFor();
// ... interact with Step 2
```

### 6. Keep Utility Functions

Some utility functions from the old dialog may be useful - move to separate utils file if needed:
- `normalizeDmpValue`
- `formatPitch`
- `calculateStats`

```tsx
// Move to src/utils/dmpUtils.ts if not already extracted
```

### 7. Clean Up Unused Types

Remove any types that were specific to the old single-dialog flow.

## Acceptance Criteria

- [ ] Old DmpImportDialog.tsx deleted
- [ ] Dialog exports updated
- [ ] App.tsx no longer references old dialog
- [ ] UI store cleaned up
- [ ] Keyboard shortcuts use new flow
- [ ] Utility functions preserved if needed
- [ ] Playwright tests updated for new flow
- [ ] No TypeScript errors
- [ ] All tests pass with new dialog flow

## Test Suggestions

### Unit Tests (Rust)
N/A - Frontend-only task.

### Playwright Tests (3-10)
1. Test Ctrl+I opens Step 1 dialog
2. Test Step 1 Continue opens Step 2 dialog
3. Test completing full import flow
4. Test Cancel at Step 1 closes dialog
5. Test Cancel at Step 2 with confirmation
6. Test Back from Step 2 returns to Step 1
7. Test import from home screen
8. Test import from existing project

### WebdriverIO Tests (3-10)
1. Test full two-step import with real DMP file
2. Test all placement modes work
3. Test section editing in Step 2
4. Test import completes and sections appear
5. Test drag-drop triggers new flow

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
