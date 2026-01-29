## Description

Final wiring task: connect the DataTable context menu's Delete Shot action to the appropriate deletion flow based on shot position. Also integrate the enhanced ConfirmDialog (from Task 7) and ensure map context menu alignment (from Task 8) is consistent.

**Depends on:** Tasks 2 (DataTable context menu), 4 (delete-last-shot command), 5 (SplitSectionDialog), 7 (deletion cleanup + enhanced confirm), 8 (map context menu alignment)

## Files to Modify
- `src/components/common/ContextMenu.tsx` — Wire "Delete Shot" in `datatable-shot` branch to position-aware dialogs
- `src/components/Dialogs/ConfirmDialog.tsx` — Add `type === 'last-shot'` handling

## Implementation Details

### ContextMenu.tsx — `datatable-shot` Delete Shot action

Replace the placeholder Delete Shot action (from Task 2) with position-aware logic:
- `totalShots === 1` → open `confirm-delete` with `type: 'last-shot'`
- `!isFirst && !isLast` → open `split-section` dialog
- Otherwise (edge shot) → open `confirm-delete` with `type: 'shot'`

### ConfirmDialog.tsx — `type === 'last-shot'`

Add to the type union. Add `handleConfirm` branch that calls `deleteLastShotAndSection(sectionId, shotId)` from project store. Add title "Delete Shot & Section" and message "Deleting the last shot will remove the entire section. Continue?"

Get `deleteLastShotAndSection` from `useProjectStore`.

### Verify map context menu consistency

Task 8 implements the same position-aware Delete Shot logic for the map context menu. Both code paths must use identical logic. **Extract a shared helper function** to avoid duplication:

```typescript
function getDeleteShotDialog(
  sectionId: SectionId, shotId: ShotId,
  isFirst: boolean, isLast: boolean,
  totalShots: number, sectionName: string,
): { dialog: string; data: Record<string, unknown> }
```

Place this in a shared location (e.g., `src/utils/contextMenuHelpers.ts` or within `ContextMenu.tsx` as a module-level function). Both `datatable-shot` and `shot` branches should call this helper.

### Post-operation behavior
- After edge shot deletion: selection cleared (existing behavior from ConfirmDialog)
- After split: section A selected (handled by SplitSectionDialog in Task 5 — uses `uiStore.setSelection`, NOT `clearSelection`)
- After last-shot deletion: selection cleared, section removed

## Tests
- Playwright: right-click first shot in DataTable → Delete → simple confirm dialog → shot removed
- Playwright: right-click middle shot in DataTable → Delete → split dialog → two sections created
- Playwright: right-click only shot in section → Delete → "remove entire section" confirm → section gone
- Playwright: undo after each operation restores previous state
- Playwright: section deletion confirm dialog shows affected relationships (from Task 7)
- Playwright: map context menu Delete Shot uses same position-aware logic

## Acceptance
- [ ] Edge shot deletion opens simple confirm dialog
- [ ] Mid-section shot deletion opens SplitSectionDialog
- [ ] Last-shot deletion opens "remove section" confirm dialog
- [ ] ConfirmDialog handles `type === 'last-shot'` correctly
- [ ] Map and DataTable Delete Shot use identical position-aware logic (shared helper)
- [ ] All deletion paths have correct post-operation selection behavior
- [ ] Shared helper function avoids duplication
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes
