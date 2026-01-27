# Fix Warning Display Format and Warning-Click Selection

## Problem

Two bugs in the warnings tab:

1. **Warning messages use ambiguous shot identifiers**: Messages say "Shot 1 azimuth in/out deviation..." using only the 1-based array index within a section. The app's naming convention is "sectionId:position" (e.g., "Shot 4:1"), which users expect to see.

2. **Clicking a warning shows "Selection not found"**: Clicking any warning switches to the Details tab but displays "Selection not found" instead of shot details. Manual shot selection from the data table works correctly, so the issue is specifically in how `onWarningClick` sets the selection (likely a mismatch between `warning.shot_id` and the actual `shot.id` in the project data).

Both bugs affect DMP-imported projects (confirmed). The data source is relevant because shot ID assignment during import may differ from what the warning system stores.

## Key Decisions

- **Fix location for message format**: Rust backend (`validation.rs`). Change `validate_shot()` to accept `section_id: SectionId` as a new parameter and format messages as "Shot {section_id}:{shot_index+1}".
- **Secondary line preserved**: Keep the existing secondary display line ("Section A • Shot 4:1") below each warning message for extra context.
- **Selection fix strategy**: Fix root cause — ensure `warning.shot_id` in the Rust backend matches the actual `shot.id` so the frontend lookup succeeds. Do NOT add fallback lookups.
- **Warning click behavior**: Should behave exactly like manual selection — the shot should be selected everywhere: Details tab shows shot info, data table highlights/scrolls to the row, and map canvas highlights the shot.
- **Message format**: "Shot X:Y" (sectionId:position) is sufficient. No need to include section name in the message since the secondary line already shows it.
- **Priority**: Normal (not blocking, but annoying).

## Edge Cases

- Section ID 0 and shot index 0: Ensure "Shot 0:1" formats correctly (section IDs start at 0).
- Warnings for resolved shots: If a shot is resolved/deleted after a warning was generated, the click should handle gracefully (not crash).
- Multiple warnings on same shot: Clicking any of them should select the same shot correctly.
- Projects with single section: "Shot 0:1" should still use the full format, not abbreviate.
- Empty sections: Sections with no shots should not generate warnings (existing behavior, but verify).
- DMP import specifically: Shot IDs may be assigned via `section_id * 100000 + sequence` in sqlite.rs — verify this matches what `compute_project_warnings()` stores.

## Testing Requirements

- **Rust unit tests**: Update existing validation tests (validation.rs:171-623) to assert message text contains "Shot X:Y" format.
- **E2E Playwright test**: Add test that clicks a warning in the warnings tab and verifies the Details tab shows shot details (not "Selection not found").
- **DMP import regression test**: Add test with DMP-imported project that verifies warning click navigates correctly.

## Acceptance

- [ ] All warning messages in Rust backend use "Shot {section_id}:{position}" format (e.g., "Shot 4:1")
- [ ] `validate_shot()` accepts `section_id` parameter and uses it in all message format strings
- [ ] Clicking any warning in the warnings tab selects the shot (Details tab shows shot info)
- [ ] Warning click highlights the shot in the data table and scrolls to it
- [ ] Warning click highlights the shot on the map canvas
- [ ] Rust unit tests assert correct message format
- [ ] E2E Playwright test verifies warning-click-to-details navigation
- [ ] DMP import regression test for warning click
- [ ] All existing tests pass (`pnpm tsc --noEmit`, `pnpm test:ui`, `cargo test`)
