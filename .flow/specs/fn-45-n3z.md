# Treat Closures as Merges for Graph Traversal and Display

## Overview

Currently, loop closures and station merges are treated as separate concepts in graph traversal. This epic unifies them: closures become zero-distance edges in the survey graph (like merges), automatically expand to include merged stations, and display in station details alongside merge relationships.

## Scope

**In scope:**
- Add `id: u64` to LoopClosure struct (auto-assigned, persisted in SQLite)
- Add `ClosureRef` struct and `closures_with: Vec<ClosureRef>` to Station
- Update graph traversal to treat closures as edges (get_connected_section_ids, calculate_path_length_between)
- New merge validation: zero datum check → loop check → merge vs closure decision
- "Loop Closures" section in DetailPanel with direct/transitive display
- Update SPEC.md documentation

**Out of scope:**
- Dedicated closure deletion UI (delete via station context menu, existing pattern)
- Performance optimization (measure first, optimize later)

## Approach

### Data Model Changes

1. **LoopClosure struct** (`station.rs:256-271`):
   - Add `id: u64` field with `#[serde(default)]`
   - On project load: scan `loop_closures`, find max ID, assign sequential IDs to any with id=0 (legacy migration)
   - Next ID derived from `max(existing_ids) + 1` (no stored counter needed)

2. **LoopClosure persistence** (`persistence/sqlite.rs`):
   - Update `load_loop_closures()` SELECT to include `id` column
   - Update `save_loop_closures()` INSERT to write `id` column
   - Add migration if `id` column doesn't exist (ALTER TABLE ADD COLUMN)

3. **New ClosureRef struct** (`station.rs`):
   ```rust
   pub struct ClosureRef {
       pub closure_id: u64,
       pub station_ref: StationRef,
       pub via_station: Option<StationRef>,
       pub is_transitive: bool,
   }
   ```

4. **Station struct** (`station.rs:136-148`):
   - Add `closures_with: Vec<ClosureRef>` field
   - Use `#[serde(default, skip_serializing_if = "Vec::is_empty")]` (computed, serialized to UI when non-empty)

### Graph Traversal Changes

5. **get_connected_section_ids()** (`project.rs:206-226`):
   - After iterating `station_merges`, also iterate `loop_closures`
   - Treat closure as bidirectional edge between `station_a.section_id` and `station_b.section_id`

6. **calculate_path_length_between()** (`project.rs:279-350`):
   - In merge-following block (lines 323-339), add parallel block for closures
   - Closures are zero-distance edges (don't add to `path_len`)

7. **are_stations_in_closure()** (`project.rs`):
   - New utility, pattern from `are_stations_merged()` (line 555-559)
   - Check `loop_closures` for pair match (either direction)

### Closure Computation

8. **compute_station_coordinates_with_progress()** (`project.rs:887-938`):
   - After existing merge Union-Find (lines 889-927), add closure expansion:
     - For each station, find closures where station or any merged equivalent is endpoint
     - Compute `closures_with` including transitive relationships (one level via merged stations)
   - Pattern: Use existing merge groups to expand closure endpoints

### Validation Logic

9. **Response contract** (`station.rs` types, `commands.ts`):
   - Update `ConnectivityResult` to add `can_merge: bool` and `reason: Option<String>`:
     ```rust
     pub struct ConnectivityResult {
         pub connected: bool,  // keep for backward compat
         pub can_merge: bool,  // new: true if merge allowed
         pub reason: Option<String>,  // new: why merge not allowed
         pub preview: Option<ClosurePreview>,
     }
     ```
   - Update TypeScript `ConnectivityResult` in `src/types/commands.ts` to match

10. **check_merge_connectivity_impl()** (`commands/station.rs`):
    - Change validation logic to set `can_merge` and `reason`:
      1. Check if both sections connected to zero datum → `can_merge: false, reason: "Both sections have fixed coordinates"`
      2. Check if only one has zero datum → `can_merge: true`
      3. Neither has zero datum → check loop existence:
         - Loop exists → `can_merge: false, reason: "Creates survey loop"`
         - No loop → `can_merge: true`
    - Keep `connected` field for backward compatibility

11. **Frontend merge flow** (`useMapTools.ts:84-134`):
    - Check `can_merge` (not `connected`) to decide dialog
    - When `can_merge: false`, open ClosureDialog with `reason` as subtitle
    - Silent redirect (no intermediate dialog)

12. **ClosureDialog.tsx**:
    - Add optional `reason?: string` prop
    - Render as subtitle below "Create Loop Closure" title when present
    - Style: `text-sm text-text-secondary`

### UI Changes

13. **DetailPanel.tsx** (`lines 383-403`):
    - Add "Loop Closures" section after "Merged with" section
    - Collapsible (default expanded), hidden when empty
    - Display format:
      - Direct: "Closure to B, C, D" (grouped by closure_id)
      - Transitive: "Transitive closure to X, Y (via A)" with `text-text-tertiary` class
      - Metrics: "Path: 15.2m | Error: 0.30m (1.97%)" below each group
    - Use `DetailLink` for navigation (same as merged station links)

14. **TypeScript types** (`project.ts`):
    - Add `ClosureRef` interface matching Rust
    - Add `closures_with: ClosureRef[]` to `Station` interface

## Key Context

### Files to Modify
- `src-tauri/src/models/station.rs` - LoopClosure, ClosureRef, Station structs, ConnectivityResult
- `src-tauri/src/models/project.rs` - traversal functions, closure computation
- `src-tauri/src/persistence/sqlite.rs` - LoopClosure id persistence
- `src-tauri/src/commands/station.rs` - validation logic
- `src/types/project.ts` - TypeScript interfaces
- `src/types/commands.ts` - ConnectivityResult type
- `src/components/SingleSystemView/DetailPanel.tsx` - UI display
- `src/components/Dialogs/ClosureDialog.tsx` - reason subtitle
- `src/hooks/useMapTools.ts` - merge-to-closure redirect (check can_merge)
- `docs/SPEC.md` - documentation updates

### Reusable Patterns
- Union-Find: `project.rs:887-927`
- BFS traversal: `project.rs:206-226`
- are_stations_merged: `project.rs:555-559`
- Merged stations display: `DetailPanel.tsx:383-403`
- DetailLink component: `src/components/common/DetailLink.tsx`

### Epic Dependencies
- **Overlap with fn-43-uvi**: Both modify `compute_station_coordinates_with_progress()`. fn-43 adds station_offsets (line ~873), fn-45 adds closures_with (after line 938). Different areas, but coordinate timing.

## Quick Commands

```bash
# Type check
pnpm tsc --noEmit

# Rust tests (includes closure tests)
cargo test --manifest-path src-tauri/Cargo.toml

# E2E tests
pnpm test:ui

# Dev server
./scripts/dev.sh
```

## Risks

1. **Performance**: Computing `closures_with` on every coordinate update. Mitigation: Defer optimization until measured.
2. **Merge conflict with fn-43-uvi**: Both touch `compute_station_coordinates_with_progress()`. Mitigation: Different code regions, coordinate completion order.

## Acceptance

### Backend
- [ ] LoopClosure has `id: u64` field, auto-assigned on load
- [ ] LoopClosure id persisted in SQLite (read/write in sqlite.rs)
- [ ] ClosureRef struct exists with closure_id, station_ref, via_station, is_transitive
- [ ] Station has `closures_with: Vec<ClosureRef>` (serialized when non-empty)
- [ ] get_connected_section_ids() treats closures as edges
- [ ] calculate_path_length_between() follows closures with zero distance
- [ ] are_stations_in_closure() utility exists
- [ ] closures_with computed during coordinate calculation
- [ ] ConnectivityResult has can_merge + reason fields (Rust and TypeScript)
- [ ] Merge validation checks zero datum → loops → returns can_merge + reason

### Frontend
- [ ] ClosureRef and closures_with in TypeScript types
- [ ] ConnectivityResult type updated with can_merge + reason
- [ ] "Loop Closures" section in DetailPanel (collapsible, hidden when empty)
- [ ] Direct closures grouped, transitive closures with "(via X)" muted
- [ ] Metrics displayed below each group
- [ ] DetailLink navigation works
- [ ] ClosureDialog shows reason subtitle when redirected from merge
- [ ] useMapTools checks can_merge (not connected) for dialog routing

### Tests
- [ ] Rust: Closure expands with existing merges
- [ ] Rust: New merge expands existing closure
- [ ] Rust: Zero datum validation determines merge vs closure
- [ ] Rust: Transitive closure computation correct
- [ ] E2E: Closure appears in station details with metrics
- [ ] E2E: Merge-to-closure redirect shows reason

### Documentation
- [ ] SPEC.md updated: data model, validation rules, DetailPanel UI
