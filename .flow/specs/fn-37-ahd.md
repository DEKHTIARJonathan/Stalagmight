# Fix Warning Display Format and Warning-Click Selection

## Overview

Two bugs in the warnings tab need fixing:
1. Warning messages use ambiguous shot identifiers ("Shot 1") instead of the app's "Shot sectionId:position" convention ("Shot 4:1")
2. Clicking a warning shows "Selection not found" instead of navigating to shot details

Both bugs are in the Rust backend with minor frontend investigation needed for bug 2.

## Scope

**In scope:**
- Add `section_id: SectionId` parameter to `Validator::validate_shot()` and update all ~12 message format strings
- Update `compute_project_warnings()` to pass `section_id` when calling `validate_shot()`
- Investigate and fix the root cause of warning click producing "Selection not found" (likely shot_id mismatch between `warning.shot_id` and actual `shot.id` after DB save/reload)
- Update all Rust unit tests for the new `validate_shot()` signature
- Add E2E Playwright tests for warning-click-to-details navigation
- Update SPEC.md Appendix B validation rules table with new message format

**Out of scope:**
- Warning resolution/unresolve flows (working correctly)
- Warning badge counts (working correctly)
- Performance optimization of warning computation

## Approach

**Bug 1 — Message format:**
- `validate_shot()` at `src-tauri/src/core/validation.rs:11` gains a `section_id: SectionId` parameter
- All format strings (~12 occurrences, lines 22-154) change from `"Shot {shot_index+1} ..."` to `"Shot {section_id}:{shot_index+1} ..."`
- `compute_project_warnings()` at `src-tauri/src/core/state/warnings.rs:62` passes `section.id` as the new argument
- Follow existing `formatShotId()` convention at `src/utils/formatters.ts:16-18`

**Bug 2 — Selection not found:**
- `onWarningClick` at `src/components/SingleSystemView/DetailPanel.tsx:52-58` sets `selection.shotId = warning.shot_id`
- `DetailsContent` at `DetailPanel.tsx:130-157` looks up shot via `section.shots.find(s => s.id === selection.shotId)`
- Root cause investigation: verify whether `warning.shot_id` (stored in `warnings.rs:68`) matches the actual `shot.id` after project reload from SQLite (IDs regenerated via formula `section_id * 100000 + seq` at `sqlite.rs:560-561`)
- If warnings are recomputed after load, IDs should match — investigate when `compute_project_warnings()` is called relative to project load
- Fix at the root cause (Rust backend), not with frontend fallbacks

## Risks

- **Validation test churn**: ~20 test functions in `validation.rs:171-623` all call `validate_shot()` — every call needs the new `section_id` parameter. Risk: missed call site. Mitigation: compiler will catch missing args.
- **Message format assertions**: Existing tests may assert exact message strings. Need to update all assertions to expect "Shot X:Y" format.
- **Shot ID mismatch root cause**: May be more subtle than expected. Could involve timing of warning computation vs project state changes.

## Quick commands

```bash
# Smoke tests
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tsc --noEmit
pnpm test:ui
```

## Acceptance

- [ ] All warning messages use "Shot {section_id}:{position}" format (e.g., "Shot 4:1")
- [ ] `validate_shot()` accepts `section_id` parameter and uses it in all message format strings
- [ ] Clicking any warning selects the shot (Details tab shows shot info, not "Selection not found")
- [ ] Warning click highlights shot in data table and scrolls to it
- [ ] Warning click highlights shot on map canvas
- [ ] Rust unit tests assert correct message format
- [ ] E2E Playwright test verifies warning-click-to-details navigation
- [ ] DMP import regression test for warning click
- [ ] SPEC.md Appendix B validation rules table updated
- [ ] All existing tests pass

## References

- `src-tauri/src/core/validation.rs:11-161` — `validate_shot()` function
- `src-tauri/src/core/state/warnings.rs:16-94` — `compute_project_warnings()`
- `src/components/SingleSystemView/DetailPanel.tsx:52-58` — `onWarningClick` handler
- `src/components/SingleSystemView/DetailPanel.tsx:130-157` — `DetailsContent` shot lookup
- `src-tauri/src/persistence/sqlite.rs:560-561` — Shot ID regeneration on DB load
- `src/utils/formatters.ts:16-18` — `formatShotId()` utility
- `src-tauri/src/models/warning.rs:15-23` — `ProjectWarning` struct
- `docs/SPEC.md:2628-2631` — Appendix B validation rules table
