# Saving

## Overview

Stalagmight uses an atomic save strategy with a SQLite `.stalx` database file. Saves are triggered manually (Ctrl+S), automatically via a frontend debounced timer, or by the first import into a new project whose initial save was deferred (`finalize_deferred_import` in `src-tauri/src/commands/import.rs`; a failure there degrades to a successful import carrying a warning, never a hard failure, so the imported data stays in memory under the close-guard). The save pipeline is optimized to return quickly by deferring non-critical work to background threads and avoiding unnecessary recomputation.

## Save Pipeline

### Backend (`save_project` in `project_io.rs`)

```
1. Lock project, resolve save path, ensure .stalx extension
2. Load display settings from current database or in-memory cache
3. Write project data to temp file (file.stalx.tmp)
4. Copy display settings to temp database
5. Close temp database, atomically rename to final path
6. Reopen database at final path
7. Persist undo/redo stacks synchronously to the database
8. Update project.file_path and database handle
9. Collaboration mode only: write the sibling .tml (best-effort)
10. Update recent projects list in config
11. Return CommandResult with saved_path
```

Steps 1-6 are the critical path for data safety. Step 7 persists undo/redo stacks synchronously to avoid race conditions with concurrent readers.

Step 9 runs only when collab mode is enabled, and an auto-save skips it unless `CollabState.write_tml_on_autosave` is set, so the file Ariane has open doesn't churn every 30 seconds. `write_collab_sibling` exports the sibling `.tml` and refreshes the stored baseline; a failed `.tml` write never fails the `.stalx` save - the result stays successful and carries a `COLLAB_SIBLING_WRITE_FAILED` warning, because a green checkmark would otherwise hide the fact that the collaborator's copy is now stale. See [Collaboration](collaboration.md).

### Frontend (`saveProject` in `projectStore.ts`)

```
1. invoke('save_project', { path })
2. If saved_path in result, update project.file_path in store
3. refreshUndoState() - lightweight, just fetches can_undo/can_redo booleans
4. Set isDirty: false
```

The frontend does **not** call `refreshProjectState()` after save. Save doesn't change any computed data (stations, stats, warnings), so recomputing everything would be wasted work. The only state that changes is `file_path` (on first save or save-as), which the backend returns via `CommandResult.saved_path`.

## Atomic Save (Temp File + Rename)

All saves use a temp file with atomic rename to prevent data loss on crash or power failure:

1. Write to `file.stalx.tmp` (new SQLite database)
2. On success: `rename(file.stalx.tmp, file.stalx)` - atomic on POSIX, nearly atomic on Windows
3. On failure: delete `file.stalx.tmp`, original file untouched

If a leftover `.stalx.tmp` file exists from a previous failed save, it is removed before starting.

## Auto-Save

Auto-save is handled entirely in the frontend via the `useAutoSave` hook (`src/hooks/useAutoSave.ts`). There is no per-command auto-save in the backend.

### How It Works

1. The hook subscribes to `isDirty` changes in the project store
2. When `isDirty` becomes true (any modifying command), a debounce timer starts
3. Each subsequent change resets the timer
4. When the timer fires, `saveProject()` is called
5. On success, `isDirty` is set to false, which cancels the timer and briefly shows "Saved"

### Guards

Auto-save only fires when all of these are true:
- `config.general.auto_save` is enabled
- The project has a `file_path` (has been saved at least once)
- `isDirty` is true
- No save is already in progress

### Configuration

```toml
[general]
auto_save = true                    # Enable/disable auto-save
auto_save_interval_seconds = 30     # Debounce delay in seconds
```

### Status Indicator

The `useAutoSave` hook exposes an `AutoSaveState` with:
- `status`: `'idle'` | `'pending'` | `'saving'` | `'saved'` | `'error'`
- `countdown`: seconds remaining until auto-save fires
- `cancelPending()`: cancel the current pending auto-save

A manual Ctrl+S while a timer is pending cancels the auto-save timer (since `isDirty` goes false).

## Undo/Redo Persistence

Undo and redo stacks are persisted to the SQLite database synchronously on each save, using the same database connection.

### Flow

1. While the undo stack lock is held, entries are collected and serialized
2. Entries are written to the database synchronously (no background thread)
3. Errors are logged via `tracing::warn` but don't affect the save result

### Details

- Only the last N entries are persisted (configurable via `general.undo_persist_limit`, default 20)
- Each entry is stored as `(command_json, undo_data_json, timestamp_iso8601)`
- Serialization uses gzip compression
- On project open, persisted stacks are restored from the database
- See [Undo/Redo](undo-redo.md) for the full undo system documentation

## CommandResult.saved_path

The `save_project` backend command returns the save path as a string in `CommandResult.saved_path`. This allows the frontend to update `project.file_path` without a full state refresh.

- Present on successful saves (regular save and save-as)
- Absent (`None`/`undefined`) on all other command results
- Serialized with `#[serde(skip_serializing_if = "Option::is_none")]` to keep other results compact

## Key Files

| File | Purpose |
|------|---------|
| `src-tauri/src/core/state/project_io.rs` | Backend `save_project`, `open_project`, atomic save logic |
| `src-tauri/src/core/command.rs` | `CommandResult` with `saved_path` field |
| `src/store/projectStore.ts` | Frontend `saveProject()` action |
| `src/hooks/useAutoSave.ts` | Debounced auto-save hook |
| `src-tauri/src/persistence/sqlite.rs` | SQLite database operations |
| `docs/undo-redo.md` | Undo/redo stack persistence details |
| `docs/collaboration.md` | Sibling `.tml` write, baseline, reconcile |
| `docs/configuration.md` | Auto-save config options |
