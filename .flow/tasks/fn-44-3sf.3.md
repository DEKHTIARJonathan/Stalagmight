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
- [ ] CreateLoopClosure audited - document if affected
- [ ] create_section_and_merge verified - IDs preserved via snapshot
- [ ] Batch command verified - IDs preserved via snapshot  
- [ ] Findings documented in commit message
- [ ] Epic spec updated with audit results
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
