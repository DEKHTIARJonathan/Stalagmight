# fn-15-ygz.10 Update MetadataPanel for multi-selection aggregate stats

## Description

Update MetadataPanel to show aggregate statistics when multiple systems are selected.

**Size:** S
**Files:**
- `src/components/GlobalView/MetadataPanel.tsx` (multi-selection support, GPS filter fix)
- `src/components/GlobalView/GlobalView.tsx` (pass selected projects array)

## Approach

- Update GlobalView to pass `selectedProjects: ProjectMetadata[]` to MetadataPanel (currently passes single project)
- In MetadataPanel, detect `selectedProjects.length > 1`
- Calculate aggregate: sum of total_length, sum of station_count, count of systems
- Display as "N systems selected" with combined stats
- Keep single-selection display unchanged
- Show appropriate actions for multi-selection
- **GPS filter fix**: In `formatGps` function at line 88, remove sentinel check `(center[0] === 0 && center[1] === 0)` - just check `if (!center)` since backend now uses null for missing GPS

## Acceptance

- [ ] GlobalView passes selectedProjects array to MetadataPanel
- [ ] Single selection shows individual project stats (unchanged)
- [ ] Multi-selection shows "N systems selected" header
- [ ] Aggregate stats: combined length, station count
- [ ] Actions appropriate for multi-selection
- [ ] `formatGps` uses null check only (no sentinel check)

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
