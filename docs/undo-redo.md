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

1. **`generate_undo_data()` - before execution**: Captures "before" state. For creates this returns `UndoData::None` since the ID doesn't exist yet. For updates it snapshots previous field values. For deletes it snapshots the entity.

2. **`finalize_undo_data()` - after execution**: Fills in data that only exists post-execution. For `CreateSection`/`CreateShot`, this captures the assigned ID and full snapshot. For `CreateLoopClosure`, this grabs the closure object from the project.

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
- The single `UndoEntry` uses `ProjectSnapshotPair` - undo restores "before", redo restores "after"
- The UI shows batch as one history item; the hover preview lists each sub-command

## Non-Undoable Commands

These are never pushed to the undo stack: `OpenProject`, `SaveProject`, `CloseProject`, `CreateProject`, `MergeProjects`.

## Shot ID Display Positions

Shot IDs are internal and opaque. After database reload they follow the formula `section_id * 100_000 + sequence_order` (0-indexed). Before first save they're plain sequential integers (0, 1, 2...).

The `shot_display_position(shot_id, section_id)` helper in `models/shot.rs` converts these to 1-indexed display positions for both formats. All user-facing text (command descriptions, preview data) uses this helper so "Update shot 13:5" means section 13, 5th shot - not the raw internal ID.

## Persistence

Undo and redo stacks are serialized to the SQLite database synchronously on project save and restored on project open.

- Each entry is stored as `(command_json, undo_data_json, timestamp_iso8601)`
- Only the last N entries are persisted (configurable limit), except in the hybrid mode below
- Persistence is synchronous to avoid race conditions with concurrent readers
- Serialization failures are logged but don't block the save
- Deserialization failures skip invalid entries and load whatever is valid
- On project close, stacks are cleared from memory (DB retains persisted entries)
- Files written before schema v7 get their persisted stacks dropped on open: pre-v7 builds serialized untouched nullable `ShotUpdates` fields as explicit `null`s, which the v7 `double_option` semantics would replay as "clear the field" (see `UNDO_FORMAT_SAFE_VERSION` / `drop_legacy_undo_history` in `persistence/sqlite.rs`)

### Incremental writes (#303)

A save writes only what CHANGED. Each entry has a stable id (`head_dropped + position`,
stored in the existing `sequence` column, so the on-disk shape is unchanged); a save
upserts the ids at or after the first one whose content differs and deletes whatever falls
outside the surviving range. Ids survive both mutations a stack sees - a tail append moves
nothing, and a front eviction bumps `head_dropped` by exactly the number removed.

This is what makes a deep stack affordable. The old shape was `DELETE FROM undo_stack` +
re-INSERT + re-gzip of every entry on every save, including the 30s autosave: fine for a
20-entry window, seconds of compression for a byte-budgeted one, since a delete-heavy
session's whole-project snapshots are megabytes each.

A save to a different file (Save As, the first save of a deferred project, a re-open) or a
load forces one full rewrite - the ids in memory cannot be assumed to line up with rows
this bookkeeping has never seen, and a load also filters and trims.

## Hybrid mode for SpeleoDB projects (#303)

A SpeleoDB-linked project is a binary `.stalx` committed to a git repo, so what its undo
stack holds at push time is what every commit stores forever. Two policies, resolved by
`AppState::undo_policy` from `speleo_link.undo_mode` (per project, rides to the server) then
`SpeleoDbConfig.undo_mode` (the application default):

| | `Full` (default) | `Disabled` | Local project |
|---|---|---|---|
| In-memory depth | byte budget | `undo_history_limit` | `undo_history_limit` |
| Persisted depth | byte budget | `undo_persist_limit` | `undo_persist_limit` |
| Rides in the push | yes (undo only) | no | n/a |

**The byte budget** (`UNDO_BYTE_BUDGET_BYTES`, 32 MiB of serialized JSON ~= 2.5 MB per
commit) replaces the entry-count window rather than joining it. Count is the wrong unit
here: `Delete shot`, `Delete section`, `Reverse section` and every `Batch` store a
`ProjectSnapshotPair` - two whole-project JSON snapshots, about 4.2 MB on a 5,000-shot
project - so a fixed 100 entries is anywhere from kilobytes to half a gigabyte. The budget
buys roughly 32,000 ordinary entries, or ~8 whole-project snapshot pairs on a 5,000-shot
project, or ~2 on a 20,000-shot one. The newest entry is always kept even if it alone
exceeds the budget. Trims log once with a count.

Because every save rewrites the persisted stack, the budget also bounds the worst-case save
(~0.3 s of gzip at the measured throughput, which a 30 s autosave absorbs). Raising it
deepens snapshot-heavy history and slows every save in proportion. For scale: the old fixed
window persisted 20 entries with NO size cap, which on a 20,000-shot project is ~336 MB of
JSON per save - so this is much cheaper in the worst case and vastly deeper in the common
one, at the price of shallower history for repeated whole-survey operations on very large
projects.

**Redo is never uploaded**, in any mode. A redo branch replays FORWARD onto a state the
server has now committed past, so it is the stale-replay hazard with none of the undo
side's value.

### When the stack is cleared

| Event | Effect | Why |
|---|---|---|
| Confirmed push | entries with `timestamp <= push_start` dropped; redo cleared | they are in the commit now, so keeping them would duplicate them in the next one. Bounded by push-start because an edit recorded after the snapshot keeps its dirty bit, so its history has to survive with it |
| Any server `.stalx` becoming the local cache file | undo/redo tables emptied in the downloaded FILE | `InheritedUndo::Drop` at the `replace_cache_stalx*` chokepoint - pull, fast-forward and revision swap all funnel there |
| Lock acquired over a copy that equals git (`UpToDate` + clean) | in-memory stacks cleared | the history describes already-committed operations. The clean check is what lets lock, edit, unlock-without-pushing, re-lock keep the user's own history |
| Force-edit | in-memory stacks cleared | no lock and no reconcile, so the equals-git fence cannot be evaluated; that session already carries the unmergeable warning |

Clearing on adopt happens in the FILE, not in memory: the load path reads those tables into
the live stack, so a memory-only clear would leave the history on disk for the next open.

The reason it is cleared at all is #194 b3 - an adopting collaborator pressing Ctrl-Z would
replay the pusher's command, with its prior-state payload, against a tree they have not
looked at. Shipping the history relaxes the strip that used to prevent that, so the guard
moves to these rules plus the one explicit route below.

### Unwind: undoing past a commit

`sync::unwind_target` walks BASE first, then first-parents:

1. After a push the working copy IS the new commit and its history was just cleared
   locally, so the FIRST Unwind loads that same commit. Content does not move; the undo
   list refills with the operations the user just pushed.
2. Undo through those and the copy sits at the parent's state, so the next Unwind loads the
   parent, and so on back to the root.

Merges take `parent_ids[0]`. The chain ends at the root and at SpeleoDB's own creation
commit, where the affordance is hidden rather than offered as a step that cannot be taken.

The position lives in `speleo_undo_chain` - a single-row, local-only table, stripped from
every push snapshot. BASE cannot double as it: a restore stamps BASE at the server TIP so
a later push lands forward, which is what we want and also what stops BASE describing where
the walk is. It is on disk so an Unwind interrupted by a restart resumes, and is cleared by
a confirmed push, a lock acquisition, a fast-forward, and a plain View / Restore.

Mechanically it is `speleodb_restore_revision` with `keep_undo_history: true`, so it reuses
the whole swap path. What the flavour adds is `speleodb_guard_unwind`, enforced in the
backend: the in-memory undo stack must be EMPTY (that is what makes "the copy equals a
commit" true), and any dirt must be a previous Unwind's own doing, proven by the chain
pointer - which is what makes the `discard_local` waiver safe from the second step onwards.
Real un-pushed work with no pointer is refused.

The frontend offers it as one entry pinned below the undo history list, and clicking it
opens a confirmation rather than acting. Undo / Ctrl+Z on an empty stack still do nothing.

## Lock Ordering

`command_lock` is always outermost. Below it, the mutation paths avoid holding two
of `undo_stack` / `project` / `database` at once at all - `undo()`/`redo()` pop the
entry and drop the `undo_stack` guard before touching the project, and
`get_undo_stack()`/`get_redo_stack()` release the project lock before acquiring
`undo_stack`.

Where more than one IS held, `project` is the outermost of the three and nothing in
the crate holds an `undo_stack` or `database` guard across a `project.lock()`. Two
places rely on that: `save_project` (holds its `project` guard while it writes the
DB and persists both stacks) and the close teardown
`close_open_project_locked`, whose caller `delete_project` has to decide *whether*
to close and then close under one `project` acquisition - splitting them let a
concurrent load install a different project between the check and the teardown.

One lock sits OUTSIDE even that: `speleodb_lock_ops`
(`core/state/speleodb_session.rs`), which serializes every SpeleoDB **lock
operation** against every other and is deliberately held across network calls.
Start Editing takes it before its first read (generation, link, token, holder)
and holds it through the commit; so do the reclaim-checked releases, the status
poll's inherited-lock gate reopen, and logout - each of which can invalidate a
fact another one of them is mid-way through acting on. Nothing holding `project` / `database` / `undo_stack` may
block on it - its users decide under `project`, drop that guard, and only then
take it. The SpeleoDB session generation (`speleodb_session_generation`) is
likewise only ever bumped while holding `project`; see the module doc in
`speleodb_session.rs` for the rules.

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

Section names in preview data are resolved at **display time**, not execution time. When you hover a "Merge stations" entry, it shows current section names, not the names at the time of the merge. This is intentional - the preview answers "what is this referring to now?" For historical names, only `ProjectSnapshotPair` data retains the state at execution time.

### Preview Data Generation (`history.rs`)

`derive_preview_data()` matches `(Command, UndoData)` pairs to extract meaningful field changes. Every command type produces preview data - the fallback arm returns the command description as an "Action" field so hover is never empty.

For `UpdateShot`, all changed fields are shown (up to 5): Length, Azimuth In/Out, Depth In/Out, Pitch In/Out, LRUD, Comment, Reference, Temperature. The previous values come from `PreviousValues.values_json`.

For batch commands, `derive_command_details()` extracts a compact detail string from each sub-command (without access to undo data, since the batch uses a single `ProjectSnapshotPair`).

## Key Files

| File | Contents |
|------|----------|
| `src-tauri/src/core/undo.rs` | `UndoStack`, `UndoEntry`, `UndoData` types, `DepthLimit` + the byte budget, the persist plan |
| `src-tauri/src/core/state/undo.rs` | `undo()`, `redo()`, `undo_to()`, `redo_to()` implementation |
| `src-tauri/src/core/state/undo_policy.rs` | `undo_policy()` (the Full/Disabled resolver), `speleodb_set_undo_mode` |
| `src-tauri/src/models/undo_mode.rs` | `UndoMode`, `UndoPolicy` |
| `src-tauri/src/speleodb/sync.rs` | `unwind_target` - the BASE-then-first-parents chain |
| `src-tauri/src/core/state/speleodb_cache.rs` | `InheritedUndo` and the drop-on-adopt chokepoint |
| `src/components/Dialogs/SpeleoUnwindDialog.tsx` | The Unwind confirmation |
| `src/components/Dialogs/settings/SpeleoUndoModeControl.tsx` | The per-project Full/Disabled control |
| `src-tauri/src/core/state/commands.rs` | `execute()`, `generate_undo_data()`, `finalize_undo_data()` |
| `src-tauri/src/core/command.rs` | `Command` enum and `description()` method |
| `src-tauri/src/commands/history.rs` | Tauri commands for stacks, `derive_preview_data()`, `entry_to_history_item()` |
| `src-tauri/src/core/state/project_io.rs` | Stack persistence (save/load to SQLite) |
| `src/components/SingleSystemView/UndoHistoryDropdown.tsx` | Frontend dropdown + preview popup |
| `src-tauri/src/models/shot.rs` | `shot_display_position()` helper |
