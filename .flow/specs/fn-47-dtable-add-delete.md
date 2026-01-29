# Phase C: Data Table Add Row & Delete Row with Section Split

## Overview

Add context-menu-driven Add Row and Delete Row functionality to the DataTable component. Deleting a mid-section shot triggers section splitting with a user-naming dialog. All operations are undoable as single operations.

## User Decisions

- **Add Row**: Context menu only. "Add Shot Before" on first shot, "Add Shot After" on last shot.
- **Default values for new shot**: Copy azimuth + depth from neighboring shot, depth_in = neighbor's depth_out for continuity, length=0, no LRUD.
- **Delete Row**: Context menu only (right-click → "Delete Shot", danger-styled).
- **Edge shot deletion** (first/last): Simple confirmation, no split.
- **Mid-section shot deletion**: Opens SplitSectionDialog where user names both resulting sections (serves as confirmation).
- **Last remaining shot**: "This will remove the entire section. Continue?" confirmation → deletes shot + section.
- **Split metadata**: Both new sections inherit original's metadata (surveyor, date, comment, color, direction).
- **Undo**: Single Ctrl+Z for all deletion cases (including split).
- **Code reuse**: Keep DataTable and ShotTableEditor separate.

---

## Task 1: Add `prepend_shot` to Section model + expose in create_shot command

### What
Add ability to insert a shot before the first shot in a section. Currently only `add_shot` (append) and `insert_shot_after` exist.

### Files to modify
- `src-tauri/src/models/section.rs` — Add `prepend_shot(&mut self, data: ShotData) -> &Shot` method
- `src-tauri/src/models/project.rs` — Add `prepend_shot(section_id, data)` delegation
- `src-tauri/src/core/state/commands.rs` — Update `create_shot()` to accept `before_shot_id: Option<ShotId>` alongside existing `after_shot_id`
- `src-tauri/src/core/command.rs` — Add `before_shot_id: Option<ShotId>` field to `Command::CreateShot`
- `src-tauri/src/commands/shot.rs` — Update `create_shot` Tauri command to accept `before_shot_id` parameter
- `src-tauri/src/core/state/undo.rs` — Update undo data generation for `CreateShot` to handle `before_shot_id`

### Implementation details
- `Section::prepend_shot` inserts at position 0 in `self.shots` vec
- `create_shot` command: if `before_shot_id` is Some, find that shot's position and insert at that position (shifting it right)
- If both `after_shot_id` and `before_shot_id` are None, append to end (existing behavior)
- Undo: existing `CreatedShotSnapshot` pattern works — stores position for re-insertion

### Tests
- Rust unit test: `test_prepend_shot` — verify shot inserted at position 0
- Rust unit test: `test_create_shot_before` — verify insertion before a specific shot

---

## Task 2: Add context menu to DataTable rows

### What
Add right-click context menu to DataTable rows with position-dependent items for Add Shot and Delete Shot.

### Files to modify
- `src/components/common/Table.tsx` — Add `onRowContextMenu?: (item: T, index: number, event: React.MouseEvent) => void` prop to `EditableTableProps`. Wire it to `<tr onContextMenu=...>`.
- `src/components/SingleSystemView/DataTable.tsx` — Add `handleRowContextMenu` callback that calls `openDialog('datatable-context-menu', {...})`.
- `src/components/common/ContextMenu.tsx` — Extend `buildMenuItems()` to handle a new target type `datatable-shot` with position-aware menu items.
- `src/App.tsx` — No change needed (ContextMenu already renders for `context-menu` dialog).

### Menu items
For target type `datatable-shot`:
- First shot: "Add Shot Before" (calls `createShot` with `before_shot_id`)
- Last shot: "Add Shot After" (calls `createShot` appending)
- All shots: separator, then "Delete Shot" (danger, opens appropriate deletion flow)

### Implementation details
- `handleRowContextMenu(shot, index, event)`:
  - `event.preventDefault()`
  - Determine if shot is first (index === 0), last (index === shots.length - 1)
  - `openDialog('context-menu', { target: { type: 'datatable-shot', sectionId, shotId, isFirst, isLast, totalShots }, position: { x: event.clientX, y: event.clientY } })`
- In `ContextMenu.tsx buildMenuItems()`, add `target.type === 'datatable-shot'` branch
- Add shot action: builds default `ShotData` from neighbor, calls `createShot` store method, closes dialog
- Default shot values:
  - For "Add Before" (first shot): copy azimuth_in/out and depth_in/out from first shot, set length=0
  - For "Add After" (last shot): copy azimuth_in/out from last shot, depth_in = last shot's depth_out, depth_out = last shot's depth_out, length=0

### Tests
- Playwright: Right-click first shot → "Add Shot Before" visible
- Playwright: Right-click last shot → "Add Shot After" visible
- Playwright: Right-click middle shot → neither add option visible, only delete

---

## Task 3: Backend compound command for delete-shot-and-split-section

### What
New Rust compound command that deletes a mid-section shot and splits the section into two, with user-provided names. Uses `ProjectSnapshotPair` for single-undo.

### Files to modify
- `src-tauri/src/core/state/commands.rs` — Add `execute_delete_shot_and_split()` method following `execute_create_and_merge()` pattern
- `src-tauri/src/core/command.rs` — Add `Command::DeleteShotAndSplit` variant (or use `Command::Batch`)
- `src-tauri/src/commands/shot.rs` — Add `delete_shot_and_split` Tauri command
- `src-tauri/src/models/section.rs` — Add `split_at(shot_index) -> (Vec<Shot>, Vec<Shot>)` helper method
- `src/store/projectStore.ts` — Add `deleteShotAndSplit(sectionId, shotId, nameA, nameB)` method
- `src/types/commands.ts` — Update types if needed

### Implementation details
```
execute_delete_shot_and_split(section_id, shot_id, name_a, name_b):
  1. Lock project, take BEFORE snapshot (serde_json::to_string)
  2. Find section, find shot position
  3. Collect shots_before = shots[0..shot_pos], shots_after = shots[shot_pos+1..]
  4. Get original section metadata (surveyor, date, color, direction, comment)
  5. Rename original section to name_a, replace its shots with shots_before
  6. Create new section with name_b, same metadata, shots = shots_after
  7. If original section had offsets in project.section_offsets, copy to new section
  8. Take AFTER snapshot
  9. Push Command::Batch { DeleteShot + CreateSection } with UndoData::ProjectSnapshotPair
  10. Return success_with_section_id(new_section_id)
```

### Edge cases
- Shot at position 0 or last position: should NOT reach this code path (handled as edge shot deletion in frontend)
- Section with merges/closures referencing stations after split point: station references in merge graph need updating (station indices change in the new section). **This is critical** — need to remap any merges/closures that reference stations beyond the split point to reference the new section.

### Tests
- Rust unit test: split a 5-shot section at shot index 2 → section A has 2 shots, section B has 2 shots, deleted shot gone
- Rust unit test: verify both sections have original metadata
- Rust unit test: undo restores original section with all 5 shots
- Rust unit test: redo re-splits correctly

---

## Task 4: Backend compound command for delete-last-shot-and-section

### What
Compound command that deletes the last remaining shot in a section and removes the section entirely. Uses `ProjectSnapshotPair` for single-undo.

### Files to modify
- `src-tauri/src/core/state/commands.rs` — Add `execute_delete_last_shot_and_section()` method
- `src-tauri/src/commands/shot.rs` — Add `delete_last_shot_and_section` Tauri command
- `src/store/projectStore.ts` — Add `deleteLastShotAndSection(sectionId, shotId)` method

### Implementation details
```
execute_delete_last_shot_and_section(section_id, shot_id):
  1. Lock project, take BEFORE snapshot
  2. Remove shot from section
  3. Remove section (now empty)
  4. Clean up section_offsets, merge graph references
  5. Take AFTER snapshot
  6. Push Command::Batch with ProjectSnapshotPair
  7. Return success
```

### Tests
- Rust unit test: delete only shot in 1-shot section → section removed
- Rust unit test: undo restores section with its shot

---

## Task 5: SplitSectionDialog frontend component

### What
New dialog for mid-section shot deletion. Shows two text inputs for naming the resulting sections (pre-filled with `<original>-A` and `<original>-B`). Serves as both naming and confirmation dialog.

### Files to create
- `src/components/Dialogs/SplitSectionDialog.tsx`

### Files to modify
- `src/App.tsx` — Register `activeDialog === 'split-section'` → `<SplitSectionDialog />`

### Implementation details
- Props via `dialogData`: `sectionId`, `shotId`, `sectionName`
- State: `nameA` (default: `${sectionName}-A`), `nameB` (default: `${sectionName}-B`)
- Validation: both names required, both non-empty
- On confirm: calls `deleteShotAndSplit(sectionId, shotId, nameA, nameB)`, clears selection, closes dialog
- On cancel: closes dialog
- Layout:
  ```
  Title: "Split Section"
  Message: "Deleting this shot will split the section into two."

  [Label: "First section name"]  [Input: nameA]
  [Label: "Second section name"] [Input: nameB]

  [Cancel]  [Split & Delete (danger)]
  ```
- Uses `DialogWrapper` with `size="md"`
- data-testid: `split-section-dialog`, `split-name-a`, `split-name-b`, `split-confirm`

### Tests
- Playwright: mid-shot delete opens split dialog with pre-filled names
- Playwright: confirm creates two sections, original removed
- Playwright: cancel closes dialog, no changes

---

## Task 6: Wire deletion flows in ContextMenu + ConfirmDialog

### What
Connect the DataTable context menu's Delete Shot action to the appropriate deletion flow based on shot position.

### Files to modify
- `src/components/common/ContextMenu.tsx` — In `datatable-shot` menu items, "Delete Shot" action determines which dialog to open:
  - Mid-section (not first, not last, totalShots > 2): `openDialog('split-section', { sectionId, shotId, sectionName })`
  - Last remaining shot (totalShots === 1): `openDialog('confirm-delete', { type: 'last-shot', sectionId, shotId, message: 'This will remove the entire section. Continue?' })`
  - Edge shot (first or last, totalShots > 1): `openDialog('confirm-delete', { type: 'shot', sectionId, shotId })`
- `src/components/Dialogs/ConfirmDialog.tsx` — Add handling for `type === 'last-shot'`: calls `deleteLastShotAndSection(sectionId, shotId)`, clears selection

### Tests
- Playwright: right-click first shot → Delete → simple confirm dialog
- Playwright: right-click middle shot → Delete → split dialog
- Playwright: right-click only shot → Delete → "remove entire section" confirm

---

## Dependencies

```
Task 1 (prepend_shot backend) ──┐
                                ├── Task 2 (context menu frontend)
Task 3 (split command backend) ─┤
Task 4 (delete-last command) ───┤
                                ├── Task 5 (SplitSectionDialog)
                                └── Task 6 (wire deletion flows)
```

Tasks 1, 3, 4 can be done in parallel (backend only).
Task 2 depends on Task 1 (needs prepend_shot for "Add Before").
Tasks 5 and 6 depend on Tasks 3 and 4 (need backend commands).
Task 6 depends on Task 5 (needs SplitSectionDialog).

## Acceptance Criteria

1. Right-click first shot in DataTable → "Add Shot Before" → new shot prepended with neighbor defaults
2. Right-click last shot in DataTable → "Add Shot After" → new shot appended with neighbor defaults
3. Right-click middle shot → no Add options, only Delete
4. Delete edge shot → simple confirmation → shot removed
5. Delete mid-section shot → SplitSectionDialog → user names sections → split executed
6. Delete last shot → "remove section" confirmation → section removed
7. All operations undoable with single Ctrl+Z
8. All operations produce correct undo history entries
9. Map updates in real-time after each operation
