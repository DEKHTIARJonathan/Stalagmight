# fn-19-mmx.4 Update merge_stations to propagate datum repositioning

## Description
Update `merge_stations()` to propagate datum repositioning when a section without a datum merges into a group that has one.

**Size:** M
**Files:** `src-tauri/src/models/project.rs`

## Approach

1. After merge completes, check if merged group now has a zero datum
2. If yes, recompute offsets for newly connected sections relative to the datum
3. Use same offset calculation logic as `set_zero_datum()`

Follow existing merge logic at `project.rs:333-443`.

## Key context

Current merge handles offset calculation to align stations at merge point. After merge, if the combined group has a datum, sections should be positioned relative to that datum. The newly merged section needs its offset adjusted.

**Note**: Undo of merge restoring section_offsets is out of scope for this epic (tracked separately).

## Acceptance
- [ ] Merge into datum group repositions merged sections
- [ ] Merged sections align to datum coordinate system
- [ ] Existing sections in datum group stay in place
- [ ] Works for both directions (A into B, B into A)
- [ ] Rust tests pass (cargo test)

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
