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
Updated SPEC.md with Section 6.3 documenting dropdown UI behavior (icons, timestamps, preview popup, index semantics), Section 8.2-8.5 documenting UndoEntry timestamp field and stack exposure commands, and Appendix A with dropdown keyboard shortcuts. Updated TESTING.md with comprehensive dropdown testing guidance including test identifiers, hover/keyboard patterns, and mock requirements.
## Evidence
- Commits: 9f686779dd0c7e76b7f5e6f68b13f9c8f2b9c3e4, db81b94a9a1e5b50812e2ed9457b8280391419fd
- Tests:
- PRs: