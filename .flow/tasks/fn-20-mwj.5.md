# fn-20-mwj.5 Update ID format display in DataTable, DetailPanel, and Warnings

## Description
Update ID display format across DataTable, DetailPanel, and Warnings panel to use sectionId:shotPosition (1-indexed position) instead of internal database IDs.

**Size:** S
**Files:**
- `src/components/SingleSystemView/DataTable.tsx`
- `src/components/SingleSystemView/DetailPanel.tsx`
- `src/utils/formatters.ts` (import)

## Approach

1. **DataTable ID column** (lines 94):
   - Currently shows `shot.id` directly
   - Change to: `formatShotId(selectedSectionId, shots.indexOf(shot) + 1)`
   - Or pass index from render: the column can receive index in render function

2. **DetailPanel ShotDetail** (line 342):
   - Currently: `<DetailRow label="ID" value={section.id}:{shot.id} />`
   - Change to: `formatShotId(section.id, section.shots.indexOf(shot) + 1)`

3. **DetailPanel WarningsContent** (line 235):
   - Currently: `Shot {warning.shot_index + 1}`
   - Change to: `Shot {formatShotId(warning.section_id, warning.shot_index + 1)}`

## Key context

- Section ID: Use internal database ID as-is (not display position)
- Shot position: 1-indexed position within section (1st shot = 1)
- Virtual shots are included in position count

Current DetailPanel shot display at line 342:
```tsx
<DetailRow label="ID" value={`${section.id}:${shot.id}`} />
```
## Acceptance
- [ ] DataTable ID column shows sectionId:shotPosition format
- [ ] DetailPanel ShotDetail shows sectionId:shotPosition format
- [ ] Warnings panel shows sectionId:shotPosition format
- [ ] Shot position is 1-indexed (first shot = 1)
- [ ] Section ID uses internal database ID
- [ ] Format is consistent across all three locations
- [ ] Type check passes: `pnpm tsc --noEmit`
## Done summary
Updated ID display format to sectionId:shotPosition (1-indexed) across DataTable, DetailPanel ShotDetail, and Warnings panel using the shared formatShotId utility function.
## Evidence
- Commits: c070233b8aed3ad0c96e57b208e64ac486186547
- Tests: pnpm tsc --noEmit
- PRs: