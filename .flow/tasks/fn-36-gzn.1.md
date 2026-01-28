# fn-36-gzn.1 Add formatStationId utility and fix DetailPanel 0-indexed display

## Description

Create a `formatStationId` utility and replace all 1-indexed station display logic in `DetailPanel.tsx` with 0-indexed display using the new utility. Update all related tests in the same change.

**Size:** M
**Files:**
- `src/utils/formatters.ts` — add `formatStationId(sectionId: number, stationIndex: number): string`
- `src/utils/__tests__/formatters.test.ts` — add unit tests for `formatStationId`
- `src/components/SingleSystemView/DetailPanel.tsx` — remove all `+ 1` for station display (~10 locations)
- `src/components/common/DetailLink.tsx` — update `StationOrShotTarget.position` JSDoc from 1-indexed to 0-indexed
- `src/components/common/__tests__/DetailLink.test.ts` — update position expectations
- `e2e-playwright/detail-panel-links.spec.ts` — update station ID assertions (~12 locations)
- `e2e-playwright/detail-link-hover.spec.ts` — update station ID assertions (~8 locations)

## Approach

- Follow the `formatShotId` pattern at `src/utils/formatters.ts` — same signature style, JSDoc with examples
- `formatStationId` takes `(sectionId: number, stationIndex: number)` and returns `"${sectionId}:${stationIndex}"` (0-indexed, no +1)
- In `DetailPanel.tsx`, replace every `stationIndex + 1` or `station_index + 1` pattern with `formatStationId(sectionId, stationIndex)` or just pass `stationIndex` directly where the formatter isn't appropriate (e.g., when only the index is needed)
- Update `DetailLink` `position` field: callers pass 0-indexed position instead of 1-indexed. This changes `data-testid` values from `station-4-1-link` to `station-4-0-link`

## Key context

**DetailPanel.tsx locations needing change (all `+ 1` patterns):**
- Line 265-266: `stationPosition = stationIndex + 1` — remove the `+ 1`
- Line 337: ARIA label uses `stationPosition` — will now be 0-indexed automatically
- Line 358: Station ID display `${sectionId}:${stationPosition}` — now 0-indexed
- Line 391-392: Merged station links `ref.station_index + 1` — remove `+ 1`
- Line 481-486: Shot detail start/end station positions `+ 1` — remove
- Line 585-586, 598-599: Start/end station detail links — pass 0-indexed position
- Line 674-679: Section detail `firstStationPosition = 1` → `0`, `lastStationPosition = lastStationIndex + 1` → `lastStationIndex`
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

**Test updates**: All e2e tests asserting station IDs like `${sectionId}:1` for the first station must change to `${sectionId}:0`. Test selectors using `station-X-1-link` must change to `station-X-0-link`.
## Acceptance
- [ ] `formatStationId(sectionId, stationIndex)` exists in `src/utils/formatters.ts` with JSDoc and examples
- [ ] Unit tests for `formatStationId` pass in `src/utils/__tests__/formatters.test.ts`
- [ ] All `+ 1` station display patterns removed from `DetailPanel.tsx`
- [ ] `formatStationId` used for all station ID formatting in DetailPanel
- [ ] First station in any section displays as `sectionId:0`
- [ ] ARIA labels use 0-indexed station IDs
- [ ] `DetailLink.tsx` position field documented as 0-indexed
- [ ] `DetailLink.test.ts` expectations updated
- [ ] `detail-panel-links.spec.ts` assertions updated to 0-indexed
- [ ] `detail-link-hover.spec.ts` assertions updated to 0-indexed
- [ ] Shot ID display is NOT changed (shots still use existing convention)
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
