# fn-44-3sf.3 Audit CreateLoopClosure and compound commands

## Description

Audit remaining creation commands and compound operations to verify ID preservation. Document findings.

**Size:** S
**Files:**
- `src-tauri/src/core/state/undo.rs` (read-only audit)
- `src-tauri/src/core/state/commands.rs` (read-only audit)

## Approach

<!-- Updated by plan-sync: fn-44-3sf.2 shifted line numbers in undo.rs due to CreatedShotSnapshot insertion -->
1. **Audit CreateLoopClosure** (undo.rs:325-341, commands.rs:72-76):
   - Verify if it has ID preservation issues
   - Uses `ClosureInfo` undo data, not InverseCommand
   - Closures reference stations, not IDs - likely not affected

2. **Verify create_section_and_merge** (commands.rs:125-248):
   - Already uses `ProjectSnapshotPair` (lines 226-229)
   - Snapshot approach should preserve IDs - verify with test

3. **Verify Batch command** (undo.rs:255-262):
   - Uses `ProjectSnapshot` for undo
   - Snapshot approach should preserve IDs

4. **Document findings** in commit message and epic spec

## Key context

- `ProjectSnapshotPair` stores full before/after project state
- Restoration from snapshot inherently preserves IDs
- No code changes expected - just verification and documentation
## Acceptance
- [x] CreateLoopClosure audited - document if affected
- [x] create_section_and_merge verified - IDs preserved via snapshot
- [x] Batch command verified - IDs preserved via snapshot
- [x] Findings documented in commit message
- [x] Epic spec updated with audit results
## Done summary
Audited CreateLoopClosure, create_section_and_merge, and Batch command for undo/redo ID preservation. CreateLoopClosure is not affected (identity is station pairs, not monotonic IDs). create_section_and_merge preserves IDs via ProjectSnapshotPair. Batch command preserves IDs on undo via ProjectSnapshot but redo currently fails (no Batch arm in execute_without_undo; pre-existing limitation documented). Updated epic spec with findings.
## Evidence
- Commits: 2bc7895, 41be5de
- Tests: cargo test --manifest-path src-tauri/Cargo.toml undo
- PRs:
