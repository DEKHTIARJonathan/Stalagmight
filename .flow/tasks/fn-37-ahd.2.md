# fn-37-ahd.2 Fix warning-click selection and add E2E tests

## Description

Investigate and fix the root cause of clicking a warning showing "Selection not found" instead of navigating to shot details. Add E2E Playwright tests verifying warning-click navigation works correctly, including a DMP import regression test.

**Size:** M
**Files:**
- `src-tauri/src/core/state/warnings.rs` — verify/fix `shot_id` stored in warnings matches actual `shot.id`
- `src/components/SingleSystemView/DetailPanel.tsx` — verify `onWarningClick` and `DetailsContent` lookup
- `tests/*.spec.ts` (new or existing) — E2E Playwright tests for warning click

## Approach

1. **Investigate root cause** — trace the warning click flow end-to-end:
   - `onWarningClick` at `DetailPanel.tsx:52-58` sets `selection = { type: 'shot', sectionId: warning.section_id, shotId: warning.shot_id }`
   - `DetailsContent` at `DetailPanel.tsx:130-157` looks up `section.shots.find(s => s.id === selection.shotId)`
   - `compute_project_warnings()` at `warnings.rs:68` stores `shot.id` in the warning
   - Shot IDs regenerated on DB load at `sqlite.rs:560-561` via formula `section_id * 100000 + seq`
   - Key question: when is `compute_project_warnings()` called relative to project load? If called before ID regeneration, IDs will mismatch

2. **Fix at root cause** — ensure `warning.shot_id` always matches the current `shot.id` in project state. Do NOT add fallback lookups in frontend.

3. **Verify warning click matches manual selection** — clicking a warning should trigger identical behavior to clicking a shot in the data table:
   - Details tab shows shot info
   - Data table highlights and scrolls to the row
   - Map canvas highlights the shot

4. **Add E2E Playwright tests:**
   - Test: click a warning → verify Details tab shows shot details (not "Selection not found")
   - Test: click a warning on a DMP-imported project → verify navigation works
   - Follow existing test patterns and `data-testid` selectors from `docs/TESTING.md`

## Key context

- Memory pitfall: "React useEffect reading derived state may see stale value during transitions — compute from source using the selection's own IDs" (from project memory, 2026-01-23)
- Memory pitfall: "Mock data must use correct runtime types (numeric IDs not strings)" (from project memory, 2026-01-28) — relevant for test fixtures
- The `ProjectWarning` struct at `src-tauri/src/models/warning.rs:15-23` has `section_id`, `shot_id`, and `shot_index` fields
- `formatShotId()` at `src/utils/formatters.ts:16-18` is the frontend formatting utility
- Existing warnings tab tests and data-testid patterns documented in `docs/TESTING.md`
## Acceptance
- [ ] Root cause of "Selection not found" identified and fixed at the source (Rust backend)
- [ ] `warning.shot_id` matches actual `shot.id` in project state for all code paths (new project, DMP import, DB reload)
- [ ] Clicking any warning selects the shot — Details tab shows shot info
- [ ] Warning click highlights shot in data table and scrolls to it
- [ ] Warning click highlights shot on map canvas
- [ ] E2E Playwright test: click warning → Details tab shows shot details
- [ ] E2E Playwright test: DMP import project → click warning → navigation works
- [ ] No frontend fallback lookups added (fix is at root cause)
- [ ] `pnpm test:ui` passes (all Playwright tests)
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
