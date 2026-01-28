# Bugfix: Station IDs should display 0-indexed

## Overview

Station IDs are displayed as 1-indexed throughout the Detail Panel UI. The first station in section 4 shows as `4:1` instead of the correct `4:0`. The data model uses 0-indexed `station_index`, but `DetailPanel.tsx` adds `+ 1` before rendering.

**Scope**: Only `DetailPanel.tsx` needs code changes. Many other components (dialogs, map layers, export preview) already display 0-indexed station IDs correctly. The Rust backend's `format_station_ref_for_display` is already 0-indexed.

## Approach

1. Create a `formatStationId(sectionId, stationIndex)` utility in `src/utils/formatters.ts` (following the existing `formatShotId` pattern)
2. Remove all `+ 1` station display logic in `DetailPanel.tsx` and use the new utility
3. Update `DetailLink` position documentation from 1-indexed to 0-indexed
4. Update all e2e and unit test assertions to expect 0-indexed values
5. Update SPEC.md and TESTING.md documentation

## Affected files

**Code changes:**
- `src/utils/formatters.ts` — add `formatStationId`
- `src/components/SingleSystemView/DetailPanel.tsx` — remove `+ 1` at ~10 locations
- `src/components/common/DetailLink.tsx` — update JSDoc for `position` field

**Test changes:**
- `src/utils/__tests__/formatters.test.ts` — add `formatStationId` tests
- `src/components/common/__tests__/DetailLink.test.ts` — update position expectations
- `e2e-playwright/detail-panel-links.spec.ts` — update station ID assertions (~12 locations)
- `e2e-playwright/detail-link-hover.spec.ts` — update station ID assertions (~8 locations)

**Doc changes:**
- `docs/SPEC.md` — lines 490-496, 549-556, 901-902
- `docs/TESTING.md` — lines 932-933

**No changes needed (already 0-indexed):**
- EditStationDialog.tsx, MergeDialog.tsx, DrawShotDialog.tsx, DmpSectionConfigDialog.tsx
- SurveyLayer.tsx, MapCanvas.tsx, features.ts, ExportPreview.tsx
- Rust backend (`format_station_ref_for_display`)

## Risks

- **Many scattered assertions**: E2e tests have 20+ station ID assertions that must all be updated consistently
- **data-testid values**: `DetailLink.generateTestId()` uses `position` field directly. After change, testids like `station-4-1-link` become `station-4-0-link`, requiring all test selectors to update

## Quick commands

```bash
pnpm tsc --noEmit
pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml
```

## Acceptance

- [ ] First station in any section displays as `sectionId:0` (not `sectionId:1`)
- [ ] All station ID displays in Detail Panel are 0-indexed
- [ ] `formatStationId(sectionId, stationIndex)` utility exists in `src/utils/formatters.ts`
- [ ] `formatStationId` is used in DetailPanel.tsx for all station ID formatting
- [ ] ARIA labels use 0-indexed station IDs
- [ ] Shot ID display is NOT changed
- [ ] SPEC.md and TESTING.md updated
- [ ] All Playwright e2e tests pass
- [ ] `pnpm tsc --noEmit` passes
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
