# fn-14-3zg.8 Docs: Update SPEC.md and TESTING.md

## Description
Update project documentation to cover the new undo/redo dropdown feature.

**Size:** S
**Files:**
- `docs/SPEC.md` - Sections 6.2, 8, Appendix A
- `docs/TESTING.md` - Dropdown testing section

## Approach

1. SPEC.md Section 6.2 (UI Layout): Document dropdown behavior, icons, timestamps
2. SPEC.md Section 8 (Command System): Document timestamp field in UndoEntry
3. SPEC.md Appendix A: Add dropdown keyboard shortcuts (Arrow Down, arrows, Enter, Escape)
4. TESTING.md: Add section on testing dropdown UI components

## Key Context

- Follow existing SPEC.md format with ASCII diagrams
- Keyboard shortcut table format in Appendix A
- TESTING.md uses table-based organization
## Acceptance
- [ ] SPEC.md Section 6.2 documents dropdown UI behavior
- [ ] SPEC.md Section 8 documents timestamp field
- [ ] SPEC.md Appendix A lists dropdown keyboard shortcuts
- [ ] TESTING.md has dropdown testing guidance
- [ ] Documentation is accurate and matches implementation
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
