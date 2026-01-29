# Phase C: Data Table Add Row & Delete Row with Section Split

## Overview

Add context-menu-driven Add Row and Delete Row functionality to the DataTable component and map context menu. Deleting a mid-section shot triggers section splitting with a user-naming dialog. Fix pre-existing section deletion cleanup bug. All operations are undoable as single operations.

## User Decisions (from interview)

### Add Row
- Context menu only (both DataTable and map). "Add Shot Before" on first shot/station, "Add Shot After" on last shot/station.
- Both DataTable and map use DrawShotDialog (not immediate create).
- DrawShotDialog pre-sets fromStation (locked, not changeable by user).
- Prepend mode: fromStation=0, azimuth reversed 180° before insertion. **Single reversal on submit only**: defaults show the neighbor's azimuth as-is, reversal (add 180° + normalize to 0-360) happens once when creating the shot.
- Default values: Copy geometry from neighbor shot — azimuth_in, azimuth_out, pitch_in, pitch_out, depth_in, depth_out. Temperature and marker_index stay None. Length=0. **DrawShotDialog must allow length=0 for add-row mode** (`allowZeroLength: true` in dialog data, set by both "Add Shot Before" and "Add Shot After" context menu actions).
- After adding: select the new shot in both DataTable and map. **Implementation**: `CommandResult` needs a `shot_id: Option<ShotId>` field (add to `command.rs:117`). `create_shot()` must populate it. Frontend uses `result.shot_id` to call `uiStore.setSelection({ type: 'shot', sectionId, shotId: result.shot_id })`.
- Map context menu: restrict "Insert Shot After" to first/last only (remove from middle shots). Add station-based options (station 0 → "Add Before", last station → "Add After").

### Delete Row
- Context menu only (right-click → "Delete Shot", danger-styled). Both DataTable and map.
- **Edge shot** (first/last, section has >1 shot): Simple confirmation, no split.
- **Mid-section shot**: Opens SplitSectionDialog where user names both resulting sections (serves as confirmation).
- **Last remaining shot**: "This will remove the entire section. Continue?" confirmation → deletes shot + section.
- **2-shot sections**: Both shots are edge shots, no special handling. Simple delete for either.
- Both DataTable and map context menus use identical position-aware deletion logic.

### Section Splitting
- Both new sections inherit original's metadata (surveyor, date, color, direction). **Note**: `Section`/`SectionData` do not have a `comment` field — do NOT attempt to copy `comment`. Only copy: name (as prefix for -A/-B), surveyor, date, color, direction.
- Full merge/closure/station_offset remapping during split (station indices shift for section B).
- Recalculate offset for section B (accumulated shot geometry, not just copy). **Use `Shot::average_azimuth()`** for offset computation to handle wraparound correctly — do NOT use naive `(azimuth_in + azimuth_out) / 2.0`.
- Post-split: DataTable selects section A (first half). **Implementation**: after `deleteShotAndSplit` resolves, call `uiStore.setSelection({ type: 'section', sectionId: originalSectionId })` since section A keeps the original ID.
- Single Ctrl+Z undo for all deletion cases (including split).

### Section Deletion Cleanup (bug fix)
- Fix pre-existing bug: section deletion now cleans up orphaned merges, closures, section_offsets, station_offsets.
- **Cleanup happens in ALL code paths**: the core `delete_section()` method calls `cleanup_section_references()` before `remove_section()`. This covers both the Tauri command path AND any internal/undo paths that go through `execute(Command::DeleteSection)`.
- Undo architecture: `generate_undo_data` for `DeleteSection` captures `ProjectSnapshotPair { before: <full project>, after: "" }`. After execution, `finalize_undo_data` fills in the `after` snapshot. This stays entirely within the standard `execute()` flow — no bypass needed.
- Enhanced ConfirmDialog lists affected relationships before deletion (informational only, no per-relationship control).
- New Tauri command `get_section_relationships` provides the data.

### Code Organization
- Keep DataTable and ShotTableEditor (import dialog) as separate components.
- Extract shared helper for position-aware delete logic to avoid duplication between DataTable and map menus.

---

## Tasks

| ID | Title | Priority | Depends On |
|----|-------|----------|------------|
| fn-47-ok1.1 | Add prepend_shot to Section model + expose in create_shot command | 1 | — |
| fn-47-ok1.3 | Backend compound command: delete-shot-and-split-section | 1 | — |
| fn-47-ok1.4 | Backend compound command: delete-last-shot-and-section | 1 | — |
| fn-47-ok1.7 | Section deletion cleanup + enhanced confirm dialog | 1 | — |
| fn-47-ok1.2 | Add context menu to DataTable rows | 2 | 1 |
| fn-47-ok1.8 | Map context menu alignment + prepend DrawShotDialog mode | 2 | 1 |
| fn-47-ok1.5 | SplitSectionDialog frontend component | 3 | 3 |
| fn-47-ok1.6 | Wire deletion flows in ContextMenu + ConfirmDialog | 4 | 2, 4, 5, 7, 8 |

## Dependencies

```
Task 1 (prepend backend) ──────────┬── Task 2 (DataTable context menu) ────┐
                                   └── Task 8 (Map context menu alignment) ─┤
Task 3 (split command) ────────────┬── Task 5 (SplitSectionDialog) ─────────┤
Task 4 (delete-last command) ──────┤                                        ├── Task 6 (wire flows)
Task 7 (deletion cleanup + dialog) ┘                                        │
                                   └────────────────────────────────────────┘
```

Tasks 1, 3, 4, 7 can be done in parallel (priority 1, no dependencies).
Tasks 2, 8 depend on Task 1 (priority 2).
Task 5 depends on Task 3 (priority 3).
Task 6 is the final integration task (priority 4, depends on 2, 4, 5, 7, 8).

## Acceptance Criteria

1. Right-click first shot in DataTable → "Add Shot Before" → DrawShotDialog in prepend mode → shot prepended
2. Right-click last shot in DataTable → "Add Shot After" → DrawShotDialog → shot appended
3. Right-click middle shot → no Add options, only Delete
4. Map context menu: same first/last restriction, station-based options, prepend mode
5. Delete edge shot → simple confirmation → shot removed
6. Delete mid-section shot → SplitSectionDialog → user names sections → split with full remapping
7. Delete last shot → "remove section" confirmation → section removed
8. Section deletion cleans up orphaned merges/closures/offsets in ALL code paths
9. Section deletion ConfirmDialog shows affected relationships
10. All operations undoable with single Ctrl+Z
11. Section B offset recalculated from accumulated shot geometry using `Shot::average_azimuth()`
12. New shot selected after add (via `CommandResult.shot_id` + `uiStore.setSelection`); section A selected after split
13. DrawShotDialog allows length=0 in add-row mode (both prepend and append, via `allowZeroLength` flag)
14. `CommandResult` extended with `shot_id: Option<ShotId>` field
15. Prepend mode: single azimuth reversal on submit only (defaults show neighbor azimuth as-is)
16. Default geometry copied from neighbor shot: azimuth, pitch, depth (not temperature/marker_index)
17. `cargo test`, `pnpm tsc --noEmit`, `pnpm test:ui` all pass
