# Task 13: Implement Navigation and Import Buttons

## Description

Implement the Previous/Next navigation buttons, the final Import button, and the Back to Selection button with all their behaviors and confirmations.

## Files to Modify

- `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Implementation

### 1. Button Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│ [Cancel] [← Back to Selection]              [Previous] [Next Section]   │
│                                       or    [Previous] [Import 3 Sections] │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2. Previous Button

```tsx
<Button
  onClick={handlePrevious}
  disabled={currentSectionIndex === 0}
>
  Previous
</Button>

const handlePrevious = () => {
  // Auto-save current section
  saveCurrentSection();
  // Navigate to previous
  navigateToSection(currentSectionIndex - 1);
};
```

### 3. Next Button (Dynamic Text)

```tsx
const isLastSection = currentSectionIndex === selectedSections.length - 1;
const allPlaced = placedSections.size === selectedSections.length;
const hasErrors = checkForErrors(currentSectionConfig);

<Button
  variant="primary"
  onClick={isLastSection ? handleImport : handleNext}
  disabled={isLastSection && (!allPlaced || hasErrors)}
>
  {isLastSection ? `Import ${selectedSections.length} Sections` : 'Next Section'}
</Button>
```

### 4. Next Section Handler

```tsx
const handleNext = () => {
  // Auto-save current section
  saveCurrentSection();
  // Navigate to next
  navigateToSection(currentSectionIndex + 1);
};
```

### 5. Import Handler

```tsx
const handleImport = async () => {
  // Check all sections placed
  if (placedSections.size !== selectedSections.length) {
    showError('All sections must be placed before import');
    return;
  }

  // Check for errors
  const errors = validateAllSections();
  if (errors.length > 0) {
    showError(`Cannot import: ${errors.length} sections have errors`);
    return;
  }

  // All sections already created in backend, just close dialog
  closeDialog();

  // Switch to single view and fit to bounds
  setView('single');
  triggerFitToBounds();
};
```

### 6. Back to Selection Button

```tsx
<Button onClick={handleBackToSelection}>
  ← Back to Selection
</Button>

const handleBackToSelection = async () => {
  // Always show confirmation since this undoes all placements
  const confirmed = await showConfirmDialog({
    title: 'Back to Section Selection',
    message: 'This will undo all section placements. Continue?',
  });

  if (!confirmed) return;

  // Delete all placed sections from backend
  for (const index of placedSections) {
    const sectionId = getSectionId(index);
    if (sectionId) {
      await deleteSection(sectionId);
    }
  }

  // Clear placed sections
  setPlacedSections(new Set());

  // Return to Step 1
  onBack();
};
```

### 7. Cancel Button

```tsx
<Button onClick={handleCancel}>
  Cancel
</Button>

const handleCancel = async () => {
  // Always confirm since work would be lost
  const confirmed = await showConfirmDialog({
    title: 'Cancel Import',
    message: 'Discard all import data? Placed sections will be removed.',
  });

  if (!confirmed) return;

  // Delete all placed sections from backend
  for (const index of placedSections) {
    const sectionId = getSectionId(index);
    if (sectionId) {
      await deleteSection(sectionId);
    }
  }

  // Close dialog
  onCancel();
};
```

### 8. Import Button Disabled State

Disabled when:
- Any section not placed
- Any section has blocking errors (invalid data, missing placement)

Show disabled reason as tooltip.

### 9. Keyboard Shortcuts

```tsx
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (isLastSection) {
          handleImport();
        } else {
          handleNext();
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (currentSectionIndex > 0) {
          handlePrevious();
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (!isLastSection) {
          handleNext();
        }
      }
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [currentSectionIndex, isLastSection]);
```

## Acceptance Criteria

- [ ] Previous button navigates to previous section
- [ ] Previous disabled on first section
- [ ] Next button navigates to next section
- [ ] Next changes to "Import X Sections" on last section
- [ ] Import button disabled if not all placed
- [ ] Import button disabled if errors exist
- [ ] Back to Selection confirms and undoes placements
- [ ] Cancel confirms and removes placed sections
- [ ] Ctrl+Enter triggers Next/Import
- [ ] Ctrl+Arrow navigates between sections
- [ ] TypeScript compiles without errors

## Existing Tests to Modify

The following existing test files must be updated to account for changes made in this task:

### Playwright Tests
- `e2e-playwright/import-dialog.spec.ts` - Navigation button tests need updating for new Previous/Next/Import flow
- `e2e-playwright/dmp-import.spec.ts` - Import completion tests need updating for new button behavior

### WebdriverIO Tests
- `e2e/specs/import-dmp-dialog.spec.ts` - Navigation and import button tests need updating
- `e2e/specs/keyboard-shortcuts.spec.ts` - Ctrl+Enter, Ctrl+Arrow shortcuts need updating for Step 2 dialog

### Mock Updates
- `e2e-playwright/mocks/tauri-ipc.ts` - No changes needed for navigation logic

## Test Suggestions

### Unit Tests (Rust)
N/A - Frontend-only task.

### Playwright Tests (3-10)
1. Test Previous button goes to previous section
2. Test Previous disabled on first section
3. Test Next button goes to next section
4. Test button text changes to "Import X" on last section
5. Test Import disabled when section not placed
6. Test Import disabled when errors exist
7. Test Back to Selection shows confirmation
8. Test Cancel shows confirmation
9. Test Ctrl+Enter triggers Next
10. Test Ctrl+ArrowRight navigates forward

### WebdriverIO Tests (3-10)
1. Test full navigation through sections
2. Test Import button completes import
3. Test Back to Selection returns to Step 1
4. Test Cancel aborts entire import
5. Test keyboard navigation with full app

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
