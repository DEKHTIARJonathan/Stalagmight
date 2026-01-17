# fn-29-jzc.1 Add undo/redo unit tests

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Added 37 comprehensive unit tests for the UndoStack in undo.rs covering undo/redo stack operations, history limit enforcement, all UndoData variant types, serialization/deserialization for persistence, and complex undo/redo operation sequences.
## Evidence
- Commits: 81144fca8b07e850b6c0bd1747ba563246356e4e
- Tests: cargo test --lib core::undo::tests, cargo test
- PRs: