# fn-14-3zg.1 Backend: Add timestamp to UndoEntry and stack exposure commands

## Description
Add timestamp field to UndoEntry struct and create new Tauri commands to expose the undo/redo stacks to the frontend. Ensure timestamps persist across app restarts using the existing sqlite executed_at column.

**Size:** M
**Files:**
- `src-tauri/src/core/undo.rs` - Add timestamp field to UndoEntry
- `src-tauri/src/commands/history.rs` - Add get_undo_stack, get_redo_stack commands
- `src-tauri/src/lib.rs` - Register new commands
- `src-tauri/src/persistence/sqlite.rs` - Hydrate timestamp from executed_at on load, store on save

## Approach

1. Add `timestamp: Option<DateTime<Utc>>` to UndoEntry struct at `undo.rs:23-29`
2. Update `push_with_data()` to capture `Utc::now()` at `undo.rs:131`
3. Create DTOs: `UndoHistoryItem`, `PreviewData`, `FieldChange` with serde(rename_all = "camelCase")
4. Add `get_undo_stack()` command that maps stack entries to DTOs with preview data inline
5. Add `get_redo_stack()` command similarly
6. Update `serialize_entry`/`deserialize_entry` to include timestamp
7. Update `load_undo_stack` to hydrate timestamp from `executed_at` column
8. Update `save_undo_stack` to store timestamp to `executed_at` column
9. Use `Option<String>` for timestamp in DTO - null for legacy entries without timestamps
10. Derive previewData per command type (see epic "Preview Data Derivation" table)

## Preview Data Derivation

| Command Type | previewData | Fields |
|--------------|-------------|--------|
| UpdateShot | Yes | length, azimuth_in, depth_in from PreviousValues |
| UpdateSectionMetadata | Yes | name, surveyor, date from PreviousValues |
| CreateSection | Partial | name from command |
| CreateShot | Partial | length, azimuth from command |
| DeleteSection | Yes | name, shot count from SectionSnapshot |
| DeleteShot | Partial | length, azimuth from ShotSnapshot |
| MergeStations | null | - |
| UnmergeStations | null | - |
| SetZeroDatum | Partial | coordinates from command |
| RemoveZeroDatum | null | - |
| MoveSection | null | - |
| MoveStation | null | - |
| Batch | Summary | "N operations" |

## Key Context

- chrono is already in Cargo.toml (line 26)
- Command::description() already exists at `command.rs:216-297`
- Follow Tauri command pattern from existing `can_undo`/`can_redo` at `history.rs:35-44`
- SQLite table already has `executed_at` column - use it for timestamp persistence
- Index 0 = most recent action (LIFO order)
- Preview data included inline in response (no separate endpoint)

## Acceptance
- [ ] UndoEntry has `timestamp: Option<DateTime<Utc>>` field
- [ ] push_with_data captures timestamp automatically
- [ ] get_undo_stack returns Vec<UndoHistoryItem> with index, description, timestamp (Option<String>), commandType, previewData
- [ ] get_redo_stack returns Vec<UndoHistoryItem> similarly
- [ ] Index 0 = most recent action in both stacks
- [ ] Legacy entries without timestamp show as null in DTO
- [ ] Timestamps persist across app restarts via executed_at column
- [ ] Preview data derived correctly per command type (see table above)
- [ ] Commands without meaningful diff return previewData: null
- [ ] Commands registered in lib.rs
- [ ] cargo test passes

## Done summary
Added timestamp tracking and stack introspection to the undo/redo system. New Tauri commands get_undo_stack and get_redo_stack return UndoHistoryItem DTOs with description, timestamp, commandType, and previewData fields for UI display.
## Evidence
- Commits: 38b4d4baede80d4dd2f7a94fb1a0d99aa4e51bee, 2b2469b7fd458a60255e0e2f9c5f6a0f0a77b796
- Tests: cargo test --manifest-path src-tauri/Cargo.toml, pnpm tsc --noEmit
- PRs: