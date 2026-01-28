# fn-45-n3z.1 Add closure ID and ClosureRef data structures

## Description

Add `id: u64` field to LoopClosure struct and create new ClosureRef struct. Update Station to include computed `closures_with` field. Handle legacy project migration by auto-assigning IDs on load. Update SQLite persistence to read/write closure IDs.

**Size:** M
**Files:**
- `src-tauri/src/models/station.rs` (LoopClosure, ClosureRef, Station, ConnectivityResult)
- `src-tauri/src/persistence/sqlite.rs` (closure ID persistence)
- `src/types/project.ts` (TypeScript interfaces)
- `src/types/commands.ts` (ConnectivityResult type)

## Approach

1. Add `id: u64` to `LoopClosure` struct at `station.rs:256-271`
   - Use `#[serde(default)]` for backward compatibility with legacy projects

2. Create `ClosureRef` struct in same file:
   - `closure_id: u64` - references LoopClosure.id
   - `station_ref: StationRef` - target station
   - `via_station: Option<StationRef>` - for transitive closures
   - `is_transitive: bool`

3. Add `closures_with: Vec<ClosureRef>` to `Station` struct at line 148
   - Use `#[serde(default, skip_serializing_if = "Vec::is_empty")]` - computed field, serialized when non-empty

4. Update `ConnectivityResult` struct in `station.rs`:
   - Add `can_merge: bool` - true if merge allowed
   - Add `reason: Option<String>` - explanation when merge not allowed
   - Keep `connected` field for backward compatibility

5. Update SQLite persistence in `persistence/sqlite.rs`:
   - In `load_loop_closures()`: add `id` to SELECT query
   - In `save_loop_closures()`: add `id` to INSERT query
   - Add migration check: if `id` column doesn't exist, ALTER TABLE ADD COLUMN

6. Add ID assignment during project load in `project.rs`:
   - Scan `loop_closures`, find any with id=0 (default)
   - Assign sequential IDs starting from `max(existing_ids) + 1`

7. Mirror types in TypeScript:
   - `src/types/project.ts`: Add `ClosureRef` interface, add `closures_with: ClosureRef[]` to Station
   - `src/types/commands.ts`: Update `ConnectivityResult` with `can_merge: boolean` and `reason: string | null`

## Key Context

- Follow pattern of `merged_with` field in Station (`station.rs:147`)
- Use `#[serde(default)]` for id field to handle legacy files without IDs
- TypeScript types must match Rust structs exactly (snake_case)
- SQLite persistence at `src-tauri/src/persistence/sqlite.rs`

## Acceptance

- [ ] LoopClosure has `id: u64` field with serde default
- [ ] ClosureRef struct exists with closure_id, station_ref, via_station, is_transitive
- [ ] Station has `closures_with: Vec<ClosureRef>` with skip_serializing_if (not skip_serializing)
- [ ] ConnectivityResult has can_merge and reason fields
- [ ] SQLite load_loop_closures reads id column
- [ ] SQLite save_loop_closures writes id column
- [ ] Legacy projects get IDs auto-assigned on load (id=0 → sequential assignment)
- [ ] TypeScript ClosureRef interface matches Rust struct
- [ ] TypeScript Station interface has closures_with field
- [ ] TypeScript ConnectivityResult has can_merge and reason fields
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm tsc --noEmit` passes
