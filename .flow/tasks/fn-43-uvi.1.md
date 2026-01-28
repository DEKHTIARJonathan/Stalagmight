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

- [x] MoveSection updates `project.section_offsets` HashMap
- [x] Multiple moves accumulate (don't overwrite)
- [x] project.touch() called to mark as modified
- [x] Undo via InverseCommand works correctly

## Done summary
Implemented MoveSection command to modify project.section_offsets HashMap with undo support. Replaced stub in commands.rs with actual implementation that accumulates offsets. Added MoveSection to execute_without_undo match in undo.rs for InverseCommand support. Enhanced tests for offset verification and undo/redo. Review: SHIP verdict (iteration 9).
## Evidence
- Commits: 841d7fe, bc281eb, f70cc30, f64441c
- Tests: cargo test --manifest-path src-tauri/Cargo.toml
- PRs: