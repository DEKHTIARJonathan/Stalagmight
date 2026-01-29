## Description

Add right-click context menu to DataTable rows with position-dependent items for Add Shot and Delete Shot.

**Interview clarifications:**
- Use DrawShotDialog (not immediate create) for add shot actions
- Select the new shot after adding (uses `result.shot_id` from Task 1's `CommandResult` extension)
- Copy geometry only (azimuth, depth, pitch) — not temperature/marker_index
- "Add Shot Before" uses prepend mode (reversed azimuth, fromStation=0)

## Files to Modify
- `src/components/common/Table.tsx` — Add `onRowContextMenu` prop to `EditableTableProps`
- `src/components/SingleSystemView/DataTable.tsx` — Add `handleRowContextMenu` callback
- `src/components/common/ContextMenu.tsx` — Add `datatable-shot` target type to `buildMenuItems()`

## Implementation Details

### EditableTable (`Table.tsx`)
Add `onRowContextMenu` prop to `EditableTableProps`:
```typescript
onRowContextMenu?: (item: T, index: number, event: React.MouseEvent) => void;
```
Wire to `<tr>` element's `onContextMenu` handler.

### DataTable (`DataTable.tsx`)
Add `handleRowContextMenu` callback that:
1. Prevents default context menu
2. Checks `selectedSection` exists
3. Computes `isFirst`, `isLast`, `totalShots`
4. Opens context menu dialog with target type `datatable-shot` and all position metadata

### ContextMenu (`ContextMenu.tsx`)
Extend target type union to include `datatable-shot`:
```typescript
| { type: 'datatable-shot'; sectionId: SectionId; shotId: ShotId; isFirst: boolean; isLast: boolean; totalShots: number; sectionName: string }
```

Add branch in `buildMenuItems()` for `target.type === 'datatable-shot'`:
- **"Add Shot Before"** (first shot only): opens DrawShotDialog with `prependMode: true, allowZeroLength: true`
- **"Add Shot After"** (last shot only): opens DrawShotDialog with `allowZeroLength: true`
- **Separator**
- **"Delete Shot"** (danger-styled, all rows): placeholder action that opens `confirm-delete` with `type: 'shot'`. Task 6 will replace this with position-aware logic.

**IMPORTANT**: Both add actions must pass `allowZeroLength: true` in dialog data so DrawShotDialog accepts length=0.

**Note:** The "Delete Shot" action is a placeholder here. Task 6 will update it with position-aware logic (split dialog for mid-section, last-shot confirm, etc.).

## Acceptance
- [ ] Right-click on DataTable row opens context menu at cursor position
- [ ] First shot shows "Add Shot Before" → opens DrawShotDialog in prepend mode with `allowZeroLength: true`
- [ ] Last shot shows "Add Shot After" → opens DrawShotDialog with `allowZeroLength: true`
- [ ] Middle shots show neither add option
- [ ] "Delete Shot" (danger) visible on all rows
- [ ] A shot that is both first AND last (1-shot section) shows both add options + delete
- [ ] `pnpm tsc --noEmit` passes
