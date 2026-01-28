# fn-43-uvi.1 Implement MoveSection command

## Description

Implement MoveSection to actually modify `project.section_offsets` HashMap.

### Changes Required

**File:** `src-tauri/src/core/state/commands.rs:581-602`

Replace the stub with:
```rust
if project.sections.iter().any(|s| s.id == section_id) {
    let current = project.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));
    let new_offset = (current.0 + offset.x, current.1 + offset.y);
    project.section_offsets.insert(section_id, new_offset);
    project.touch();
    tracing::info!(?section_id, ?offset, ?new_offset, "Section moved");
    CommandResult::success()
} else {
    CommandResult::failure("Section not found".to_string())
}
```

**Undo:** Already configured via InverseCommand at `undo.rs:242-248` - no changes needed.

## Acceptance

- [ ] MoveSection updates `project.section_offsets` HashMap
- [ ] Multiple moves accumulate (don't overwrite)
- [ ] project.touch() called to mark as modified
- [ ] Undo via InverseCommand works correctly

## Done summary
Implemented MoveSection command to actually modify project.section_offsets HashMap.

Changes:
- Replaced stub in src-tauri/src/core/state/commands.rs:581-602 that only logged Section move requested with actual implementation
- Now reads current offset (or defaults to (0.0, 0.0)), adds the delta, and inserts the new accumulated offset
- Calls project.touch() to mark the project as modified
- Undo already correctly configured via InverseCommand at undo.rs:242-248 (no changes needed)

All acceptance criteria met:
- MoveSection updates project.section_offsets HashMap
- Multiple moves accumulate (don't overwrite)
- project.touch() called to mark as modified
- Undo via InverseCommand works correctly (pre-existing, verified)
## Evidence
- Commits: 841d7fe
- Tests: All 728+80 Rust tests pass, TypeScript type check passes
- PRs: