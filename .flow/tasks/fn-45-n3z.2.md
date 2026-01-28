# fn-45-n3z.2 Update graph traversal to treat closures as edges

## Description

Update graph traversal functions to treat closures as zero-distance edges (identical to merges). Add `closures_with` computation during coordinate calculation. Add `are_stations_in_closure()` utility.

**Size:** M
**Files:**
- `src-tauri/src/models/project.rs` (traversal functions, closure computation)
- `src-tauri/src/models/project/tests.rs` (new tests)

## Approach

<!-- Updated by plan-sync: fn-45-n3z.1 shifted line numbers and already implemented closures_with computation -->

1. Update `get_connected_section_ids()` at `project.rs:249-269`:
   - After iterating `station_merges` (lines 255-265), add block for `loop_closures`
   - Each closure is bidirectional edge: `station_a.section_id ↔ station_b.section_id`

2. Update `calculate_path_length_between()` at `project.rs:329-399`:
   - In merge-following block (lines 374-389), add parallel block for closures
   - Closures are zero-distance: push to queue without adding to `path_len`
   - Pattern: copy merge block structure, iterate `loop_closures` instead

3. Add `are_stations_in_closure()` utility:
   - Pattern from `are_stations_merged()` at line 615-619
   - Check `loop_closures` for pair match (either direction)

4. **ALREADY DONE** (implemented in fn-45-n3z.1): `closures_with` computation in `compute_station_coordinates_with_progress()` at lines 1018-1095. Uses `groups` and `station_to_group` from merge Union-Find (lines 965-1005). Populates direct and transitive ClosureRef entries for each station. No work needed here.

5. Add Rust tests in `project/tests.rs`:
   - Test closure expands with existing merges
   - Test new merge expands existing closure
   - Test transitive closure computation

## Key Context

- BFS traversal uses `VecDeque` with `pop_front()` (FIFO order)
- Merges don't add to path_len (zero-distance) - closures same
- `closures_with` computation already implemented (fn-45-n3z.1) at lines 1018-1095 after merge groups (lines 965-1005)
- Follow existing test patterns: `shot()` helper, project setup
- Project struct has `next_closure_id: u64` monotonic counter at line 48
## Acceptance
- [ ] get_connected_section_ids() iterates loop_closures as edges
- [ ] calculate_path_length_between() follows closures with zero distance
- [ ] are_stations_in_closure() utility function exists
- [x] closures_with computed during compute_station_coordinates_with_progress() (done in fn-45-n3z.1)
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
