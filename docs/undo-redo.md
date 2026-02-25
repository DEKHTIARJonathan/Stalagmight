# Undo/Redo System

## Overview

Stalagmight uses a command-pattern undo/redo system. Every state-changing operation is a `Command` enum variant. When executed, the system captures enough data to reverse it (`UndoData`), then pushes both onto an undo stack. Undo pops from the undo stack and pushes to the redo stack; redo does the inverse. Any new command clears the redo stack (standard diverging-timeline semantics).

## Core Types

### UndoEntry

```rust
pub struct UndoEntry {
    pub command: Command,                    // The original command
    pub undo_data: UndoData,               // Data needed to reverse it
    pub timestamp: Option<DateTime<Utc>>,  // Set at push time
}
```

Entries are **moved** between stacks, never recreated. The same `UndoData` serves both undo and redo.

### UndoStack

Two `Vec<UndoEntry>` stacks (undo + redo) behind a `Mutex`, with a configurable `history_limit` (default 100, FIFO-trimmed on push). A separate `command_lock: Mutex<()>` on `AppState` serializes all execute/undo/redo calls to prevent interleaving.

## Two-Phase Undo Data Capture

Commands go through a two-phase capture during execution:

1. **`generate_undo_data()` — before execution**: Captures "before" state. For creates this returns `UndoData::None` since the ID doesn't exist yet. For updates it snapshots previous field values. For deletes it snapshots the entity.

2. **`finalize_undo_data()` — after execution**: Fills in data that only exists post-execution. For `CreateSection`/`CreateShot`, this captures the assigned ID and full snapshot. For `CreateLoopClosure`, this grabs the closure object from the project.

## UndoData Variants

| Variant | Used By | Undo | Redo |
|---------|---------|------|------|
| `InverseCommand` | SetShotReference, Move{Section,Station} | Execute the inverse command | Execute the original command |
| `PreviousValues` | UpdateShot, UpdateSectionMetadata | Parse JSON, apply old values | Execute the original command |
| `CreatedSectionSnapshot` | CreateSection | Delete the section | Restore from snapshot (preserves original ID) |
| `CreatedShotSnapshot` | CreateShot | Delete the shot | Restore from snapshot (preserves original ID) |
| `ShotSnapshot` | DeleteShot | Restore shot at exact position | Re-execute the delete |
| `MergeInfo` | MergeStations | Restore previous offsets + unmerge | Execute the original command |
| `UnmergeInfo` | UnmergeStations | Re-merge + restore removed closures | Re-execute the unmerge |
| `ClosureInfo` | CreateLoopClosure | Remove the closure | Push closure back (preserves ID) |
| `ZeroDatumInfo` | Set/RemoveZeroDatum | Restore GPS + offsets directly | Execute the original command |
| `SegmentMoveInfo` | MoveSegment | Restore section offsets directly | Reapply offset to affected sections |
| `ProjectSnapshotPair` | Batch, DeleteSection | Restore "before" JSON | Restore "after" JSON |
| `None` | Non-undoable commands | N/A | N/A |

### Why Some Undos Restore Directly Instead of Re-Executing

`ZeroDatumInfo` and `SegmentMoveInfo` store exact previous offsets and restore them directly rather than re-computing. This is critical: re-execution could produce different results if the connectivity graph changed between the original execution and the undo.

## Batch Commands

Batch operations (`Command::Batch { commands }`) are **atomic**:

- A pre-snapshot is taken before any sub-command runs
- Sub-commands execute via `execute_without_undo()` (no individual undo entries)
- A post-snapshot is taken after all succeed
- If any sub-command fails, the entire batch rolls back via the pre-snapshot
- The single `UndoEntry` uses `ProjectSnapshotPair` — undo restores "before", redo restores "after"
- The UI shows batch as one history item; the hover preview lists each sub-command

## Non-Undoable Commands

These are never pushed to the undo stack: `OpenProject`, `SaveProject`, `CloseProject`, `CreateProject`, `MergeProjects`.

## Shot ID Display Positions

Shot IDs are internal and opaque. After database reload they follow the formula `section_id * 100_000 + sequence_order` (0-indexed). Before first save they're plain sequential integers (0, 1, 2...).

The `shot_display_position(shot_id, section_id)` helper in `models/shot.rs` converts these to 1-indexed display positions for both formats. All user-facing text (command descriptions, preview data) uses this helper so "Update shot 13:5" means section 13, 5th shot — not the raw internal ID.

## Persistence

Undo and redo stacks are serialized to the SQLite database synchronously on project save and restored on project open.

- Each entry is stored as `(command_json, undo_data_json, timestamp_iso8601)`
- Only the last N entries are persisted (configurable limit)
- Persistence is synchronous to avoid race conditions with concurrent readers
- Serialization failures are logged but don't block the save
- Deserialization failures skip invalid entries and load whatever is valid
- On project close, stacks are cleared from memory (DB retains persisted entries)

## Lock Ordering

Strict ordering prevents deadlocks: `command_lock` → `undo_stack` → `project`. The `get_undo_stack()`/`get_redo_stack()` functions release the project lock before acquiring the undo_stack lock to avoid holding both simultaneously.

## History UI

### Dropdown (`UndoHistoryDropdown.tsx`)

- Opens on ~300ms hover over the undo/redo toolbar button
- Shows up to 5 items with icon, truncated description (40 chars), and relative timestamp
- **Click item**: jumps to that stack position (`undo_to`/`redo_to`) and closes
- **Click button while open**: performs single undo/redo, refreshes the list, stays open
- **Keyboard**: Arrow keys navigate, Enter selects, Escape closes
- Actions are queued and processed sequentially (`actionQueueRef`)

### Detail Preview Popup

Appears on item hover, positioned to the right of the dropdown (flips left if near viewport edge).

**Rendering patterns:**
- **Both old + new value**: `Field: old → new` (e.g., `Length: 10.00 → 15.50`)
- **New value only** (info display): `Field: value` (e.g., `Offset: 5.3m NNW`)
- **Old value only** (removed): `Field: ~~value~~` (strikethrough)
- **Batch sub-commands**: Description as gray header, details on indented line below

### Section Name Resolution

Section names in preview data are resolved at **display time**, not execution time. When you hover a "Merge stations" entry, it shows current section names, not the names at the time of the merge. This is intentional — the preview answers "what is this referring to now?" For historical names, only `ProjectSnapshotPair` data retains the state at execution time.

### Preview Data Generation (`history.rs`)

`derive_preview_data()` matches `(Command, UndoData)` pairs to extract meaningful field changes. Every command type produces preview data — the fallback arm returns the command description as an "Action" field so hover is never empty.

For `UpdateShot`, all changed fields are shown (up to 5): Length, Azimuth In/Out, Depth In/Out, Pitch In/Out, LRUD, Comment, Reference, Temperature. The previous values come from `PreviousValues.values_json`.

For batch commands, `derive_command_details()` extracts a compact detail string from each sub-command (without access to undo data, since the batch uses a single `ProjectSnapshotPair`).

## Key Files

| File | Contents |
|------|----------|
| `src-tauri/src/core/undo.rs` | `UndoStack`, `UndoEntry`, `UndoData` types |
| `src-tauri/src/core/state/undo.rs` | `undo()`, `redo()`, `undo_to()`, `redo_to()` implementation |
| `src-tauri/src/core/state/commands.rs` | `execute()`, `generate_undo_data()`, `finalize_undo_data()` |
| `src-tauri/src/core/command.rs` | `Command` enum and `description()` method |
| `src-tauri/src/commands/history.rs` | Tauri commands for stacks, `derive_preview_data()`, `entry_to_history_item()` |
| `src-tauri/src/core/state/project_io.rs` | Stack persistence (save/load to SQLite) |
| `src/components/SingleSystemView/UndoHistoryDropdown.tsx` | Frontend dropdown + preview popup |
| `src-tauri/src/models/shot.rs` | `shot_display_position()` helper |
