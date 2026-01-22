# fn-14-3zg.2 Backend: Multi-step undo_to and redo_to commands

## Description
Add undo_to and redo_to commands that execute multiple undo/redo operations to reach a specific history point.

**Size:** S
**Files:**
- `src-tauri/src/commands/history.rs` - Add undo_to, redo_to commands
- `src-tauri/src/core/state.rs` - Add methods to AppState
- `src-tauri/src/lib.rs` - Register new commands

## Approach

1. Add `undo_to(index: usize)` command that loops calling existing `undo()` logic
2. Add `redo_to(index: usize)` command similarly
3. **Bounds check first**: If `index >= stack.len()`, return failure CommandResult immediately
4. Index semantics: index 0 = most recent, so `undo_to(3)` undoes indices 0,1,2,3 (4 operations)
5. Return CommandResult with success/error
6. If any step fails, stop and return error (partial state is acceptable per spec)

## Key Context

- Existing `undo()` implementation at `state.rs:1736`
- Existing `redo()` implementation at `state.rs:1875`
- Index 0 = most recent (top of LIFO stack)
- `undo_to(N)` = execute (N+1) undos to include index N
- `redo_to(N)` = execute (N+1) redos to include index N
- Must validate index < stack.len() before starting loop

## Acceptance
- [ ] undo_to(index) returns error if index >= undo_stack.len()
- [ ] redo_to(index) returns error if index >= redo_stack.len()
- [ ] undo_to(index) executes (index + 1) undos to include the target index
- [ ] redo_to(index) executes (index + 1) redos to include the target index
- [ ] Index 0 = most recent action (LIFO order)
- [ ] Returns CommandResult with error if any step fails
- [ ] Commands registered in lib.rs
- [ ] cargo test passes

## Done summary
Added undo_to(index) and redo_to(index) Tauri commands that execute multiple undo/redo operations to reach a specific history point, with bounds validation and proper error handling.
## Evidence
- Commits: 0386b4dbd1811b6c4b965209fd4c80fdc5e3ac9b
- Tests: cargo test --manifest-path src-tauri/Cargo.toml
- PRs: