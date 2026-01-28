# fn-45-n3z.2 Update graph traversal to treat closures as edges

## Description

Update graph traversal functions to treat closures as zero-distance edges (identical to merges). Add `closures_with` computation during coordinate calculation. Add `are_stations_in_closure()` utility.

**Size:** M
**Files:**
- `src-tauri/src/models/project.rs` (traversal functions, closure computation)
- `src-tauri/src/models/project/tests.rs` (new tests)

## Approach

1. Update `get_connected_section_ids()` at `project.rs:206-226`:
   - After iterating `station_merges` (line 218-223), add block for `loop_closures`
   - Each closure is bidirectional edge: `station_a.section_id ↔ station_b.section_id`

2. Update `calculate_path_length_between()` at `project.rs:279-350`:
   - In merge-following block (lines 323-339), add parallel block for closures
   - Closures are zero-distance: push to queue without adding to `path_len`
   - Pattern: copy merge block structure, iterate `loop_closures` instead

3. Add `are_stations_in_closure()` utility:
   - Pattern from `are_stations_merged()` at line 555-559
   - Check `loop_closures` for pair match (either direction)

4. Add closure computation in `compute_station_coordinates_with_progress()` at line 938+:
   - After merge groups are computed (line 927), compute closure relationships
   - For each station, find closures where station OR any merged equivalent is endpoint
   - Build `closures_with` including transitive (one level via merge)
   - Use existing `groups` and `station_to_group` from merge Union-Find

5. Add Rust tests in `project/tests.rs`:
   - Test closure expands with existing merges
   - Test new merge expands existing closure
   - Test transitive closure computation

## Key Context

- BFS traversal uses `VecDeque` with `pop_front()` (FIFO order)
- Merges don't add to path_len (zero-distance) - closures same
- `closures_with` computation must happen AFTER merge groups computed
- Follow existing test patterns: `shot()` helper, project setup
## Acceptance
- [ ] get_connected_section_ids() iterates loop_closures as edges
- [ ] calculate_path_length_between() follows closures with zero distance
- [ ] are_stations_in_closure() utility function exists
- [ ] closures_with computed during compute_station_coordinates_with_progress()
- [ ] Direct closures have is_transitive=false, via_station=None
- [ ] Transitive closures (via merged stations) have is_transitive=true, via_station set
- [ ] Test: closure expands when stations already merged
- [ ] Test: new merge expands existing closure
- [ ] Test: transitive closure computation is correct
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
