## Description

New dialog component for mid-section shot deletion. Shows two text inputs for naming the resulting sections (pre-filled with `<original>-A` and `<original>-B`). Serves as both naming and confirmation dialog.

## Files to Create
- `src/components/Dialogs/SplitSectionDialog.tsx`

## Files to Modify
- `src/App.tsx` — Add `activeDialog === 'split-section'` rendering

## Implementation Details

### SplitSectionDialog component
Component signature and props:
- Reads `sectionId`, `shotId`, `sectionName` from `dialogData` (set by ContextMenu)
- Two controlled text inputs for section names, pre-filled with `<sectionName>-A` and `<sectionName>-B`
- Validation: both names required (non-empty after trim)
- Confirm button calls `deleteShotAndSplit(sectionId, shotId, nameA, nameB)` from project store
- On success: **select section A** (the original section ID) via `uiStore.setSelection({ type: 'section', sectionId })`, then close dialog
- On failure: display error message inline
- Cancel button closes dialog without side effects
- Loading state disables confirm button during async operation
- `data-testid` attributes: `split-section-dialog`, `split-name-a`, `split-name-b`, `split-confirm`

### Post-split selection (important)
The epic requires "DataTable selects section A (first half)" after split. Section A retains the original `sectionId`, so after successful `deleteShotAndSplit`:
```typescript
// After successful split
uiStore.setSelection({ type: 'section', sectionId: sectionId }); // section A keeps original ID
closeDialog();
```
Do NOT call `clearSelection()` — that contradicts the epic requirement.

### App.tsx registration
Add import and render alongside other dialogs:
```typescript
import SplitSectionDialog from './components/Dialogs/SplitSectionDialog';
// In render:
{activeDialog === 'split-section' && <SplitSectionDialog />}
```

### DialogWrapper isDirty
Pass `isDirty` to DialogWrapper if either name has been modified from defaults.

## Acceptance
- [ ] Dialog opens with pre-filled section names (-A, -B suffixes)
- [ ] Both name inputs are editable
- [ ] Validation: both names required (non-empty)
- [ ] Confirm calls `deleteShotAndSplit` and closes dialog
- [ ] **After split: section A is selected** (not cleared) via `uiStore.setSelection`
- [ ] Cancel closes dialog without changes
- [ ] Error state displayed on failure
- [ ] Loading state during split operation
- [ ] `data-testid` attributes: `split-section-dialog`, `split-name-a`, `split-name-b`, `split-confirm`
- [ ] `pnpm tsc --noEmit` passes
