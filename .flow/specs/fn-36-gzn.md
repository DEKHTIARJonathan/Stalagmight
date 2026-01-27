# Bugfix: Station IDs should display 0-indexed

## Problem

Station IDs are displayed as 1-indexed throughout the UI. For example, the first station in section 4 shows as `4:1` instead of the correct `4:0`. The underlying data model (`station_index`) is 0-indexed, but the display code adds `+1` before rendering.

This is inconsistent with:
- The data model definition in SPEC.md (lines 259-262) which states `0:0` is the first station of section 0
- The station-model.md documentation which shows `0:0` as the first station
- User expectations for this application

## Key Decisions

1. **Scope: All station IDs everywhere** — Fix applies to all UI locations where station IDs are displayed, not just the Detail Panel
2. **Shots unchanged** — Shot IDs keep their current indexing convention; only station IDs change to 0-indexed display
3. **Section IDs unchanged** — Only the station index within a section changes; section IDs are not affected
4. **Format: always `sectionId:stationIndex`** — First station displays as `4:0`, not as `4` or any special format
5. **Create `formatStationId` utility** — Add a centralized utility function (like existing `formatShotId`) in `src/utils/formatters.ts`
6. **Use utility everywhere possible** — `formatStationId` should be used in all TypeScript code including map utilities, not just React components
7. **Exports excluded** — File exports (CSV, etc.) are not affected; they may have their own conventions
8. **ARIA labels updated** — Accessibility labels that include station IDs must also reflect 0-indexed values
9. **Map display updated** — Station IDs shown on the map (tooltips, labels, popups) must also be 0-indexed
10. **Spec and docs updated** — SPEC.md and related docs must be updated to match the new convention
11. **Tests updated together** — All affected Playwright e2e tests updated in the same change as the code fix
12. **Check Rust backend** — Verify the Rust backend doesn't format station IDs with +1; fix if it does

## Edge Cases

- Single-station sections: station_index=0 displays as `4:0` — no special handling
- Station with station_index=0 (first station): displays as `sectionId:0` consistently
- Merged stations from multiple sections: each station ref shows its own 0-indexed ID
- Map expressions (MapLibre): may format IDs via expressions rather than TypeScript — check if these also add +1

## Open Questions

- Are there any docs in `./docs/` beyond SPEC.md that reference station ID formatting and need updating? (Check during implementation)
- Does the Rust backend format station IDs anywhere, or is it purely a frontend display issue? (Check during implementation)

## Acceptance

- [ ] First station in any section displays as `sectionId:0` (not `sectionId:1`)
- [ ] All station ID displays across the app are 0-indexed (Detail Panel, map tooltips, linked station refs, section detail, shot detail)
- [ ] `formatStationId(sectionId, stationIndex)` utility exists in `src/utils/formatters.ts`
- [ ] `formatStationId` is used in all TypeScript code that formats station IDs
- [ ] ARIA labels use 0-indexed station IDs
- [ ] Shot ID display is NOT changed (only stations affected)
- [ ] SPEC.md updated: lines 620-623 and 693-699 reflect 0-indexed station display
- [ ] Any other docs referencing station ID format are updated
- [ ] All Playwright e2e tests pass with updated assertions
- [ ] Rust backend checked — if it formats station IDs, those are fixed too
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
