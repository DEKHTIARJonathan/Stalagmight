# fn-15-ygz.10 Update MetadataPanel for multi-selection aggregate stats

## Description

Update MetadataPanel to show aggregate statistics when multiple systems are selected.

**Size:** S
**Files:**
- `src/components/GlobalView/MetadataPanel.tsx` (multi-selection support)

## Approach

- Detect when `selectedProjectIds.length > 1`
- Calculate aggregate: total length (sum), total stations (sum), system count
- Display as "N systems selected" with combined stats
- Keep single-selection display unchanged
- Show "Open All" or individual open buttons based on selection count
- Use `ProjectMetadata.total_length` and `ProjectMetadata.station_count` (added by task 12)

## Acceptance

- [ ] Single selection shows individual project stats (unchanged)
- [ ] Multi-selection shows "N systems selected" header
- [ ] Aggregate stats: combined length, station count
- [ ] Actions appropriate for multi-selection

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
