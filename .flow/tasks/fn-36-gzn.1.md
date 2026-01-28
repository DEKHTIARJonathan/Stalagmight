## Description

Create a `formatStationId` utility and replace all 1-indexed station display logic in `DetailPanel.tsx` with 0-indexed display using the new utility. Update all related tests in the same change.

**Size:** M
**Files:**
- `src/utils/formatters.ts` — add `formatStationId(sectionId: number, stationIndex: number): string`
- `src/utils/__tests__/formatters.test.ts` — add unit tests for `formatStationId`
- `src/components/SingleSystemView/DetailPanel.tsx` — remove all `+ 1` for station display (~10 locations)
- `src/components/common/DetailLink.tsx` — update `StationOrShotTarget.position` JSDoc to clarify: stations are 0-indexed, shots are 1-indexed
- `src/components/common/__tests__/DetailLink.test.ts` — update station position expectations
- `e2e-playwright/detail-panel-links.spec.ts` — update station ID assertions (~12 locations)
- `e2e-playwright/detail-link-hover.spec.ts` — update station ID assertions (~8 locations)

## Approach

- Follow the `formatShotId` pattern at `src/utils/formatters.ts` — same signature style, JSDoc with examples
- `formatStationId` takes `(sectionId: number, stationIndex: number)` and returns `"${sectionId}:${stationIndex}"` (0-indexed, no +1)
- In `DetailPanel.tsx`, replace every `stationIndex + 1` or `station_index + 1` station display pattern with `formatStationId(sectionId, stationIndex)` or just pass `stationIndex` directly where only the index is needed
- Update `DetailLink.tsx` `StationOrShotTarget.position` JSDoc to clarify that stations pass 0-indexed positions while shots continue to pass 1-indexed positions. Do NOT change the field to say "0-indexed" generically — it must note both conventions.
- Station callers in DetailPanel pass 0-indexed positions (removing `+ 1`). Shot callers remain unchanged (still 1-indexed).
- This changes station `data-testid` values from e.g. `station-4-1-link` to `station-4-0-link`. Shot testids are unaffected.

## Key context

**DetailPanel.tsx locations needing change (station `+ 1` patterns only):**
- Line 265-266: `stationPosition = stationIndex + 1` — remove the `+ 1`
- Line 337: ARIA label uses `stationPosition` — will now be 0-indexed automatically
- Line 358: Station ID display `${sectionId}:${stationPosition}` — now 0-indexed
- Line 391-392: Merged station links `ref.station_index + 1` — remove `+ 1`
- Line 481-486: Shot detail start/end station positions `+ 1` — remove
- Line 585-586, 598-599: Start/end station detail links — pass 0-indexed position
- Line 674-679: Section detail `firstStationPosition = 1` to `0`, `lastStationPosition = lastStationIndex + 1` to `lastStationIndex`
- Line 797-798, 813-814, 826-827: Section endpoint links — pass 0-indexed position

**Already 0-indexed (verify, do NOT change):**
- EditStationDialog.tsx (line 152, 169)
- MergeDialog.tsx (lines 128, 137)
- DrawShotDialog.tsx (line 173)
- DmpSectionConfigDialog.tsx (lines 228, 248, 285)
- Map components (SurveyLayer.tsx, MapCanvas.tsx, features.ts)
- ExportPreview.tsx (line 413)
- Rust backend `format_station_ref_for_display` (project.rs line 555)

**Shot IDs are NOT changed** — `formatShotId` and shot `+ 1` patterns in DataTable.tsx remain as-is.

**Test updates**: All e2e tests asserting station IDs like `${sectionId}:1` for the first station must change to `${sectionId}:0`. Station test selectors using `station-X-1-link` must change to `station-X-0-link`. Shot test selectors remain unchanged.

## Acceptance

- [x] `formatStationId(sectionId, stationIndex)` exists in `src/utils/formatters.ts` with JSDoc and examples
- [x] Unit tests for `formatStationId` pass in `src/utils/__tests__/formatters.test.ts`
- [x] All `+ 1` station display patterns removed from `DetailPanel.tsx`
- [x] `formatStationId` used for all station ID formatting in DetailPanel
- [x] First station in any section displays as `sectionId:0`
- [x] ARIA labels use 0-indexed station IDs
- [x] `DetailLink.tsx` position JSDoc clarifies: stations 0-indexed, shots 1-indexed
- [x] `DetailLink.test.ts` station position expectations updated
- [x] `detail-panel-links.spec.ts` station assertions updated to 0-indexed
- [x] `detail-link-hover.spec.ts` station assertions updated to 0-indexed
- [x] Shot ID display is NOT changed (shots still use existing 1-indexed convention)
- [x] `pnpm tsc --noEmit` passes
- [x] `pnpm test:ui` passes
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` passes

## Done summary
Added formatStationId utility and switched to 0-indexed station display in DetailPanel. Updated all related tests.
## Evidence
- Commits:
- Tests:
- PRs: