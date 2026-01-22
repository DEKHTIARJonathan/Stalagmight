# fn-20-mwj.8 Implement external selection to DataTable sync

## Description
Implement synchronization from external selection (Map, Sections Panel) to DataTable: auto-switch section dropdown, highlight row, scroll row into view.

**Size:** M
**Files:**
- `src/components/SingleSystemView/DataTable.tsx`

## Approach

1. **Watch external selection**:
   - Subscribe to `uiStore.selection` changes
   - When selection changes and is a shot or station, react accordingly

2. **Shot selection sync**:
   - If `selection.type === 'shot'` and `selection.sectionId !== selectedSectionId`:
     - Auto-switch dropdown to `selection.sectionId`
   - Set `scrollToKey` to the shot's ID to trigger scroll

3. **Station selection sync**:
   - If `selection.type === 'station'`:
     - Station N = end of shot N, so highlight shot where `station_index === N`
     - Auto-switch section if needed
     - Scroll to that shot row

4. **Section selection sync**:
   - If `selection.type === 'section'`:
     - Switch dropdown to that section
     - Clear any row highlight (no specific shot selected)

5. **Only sync if open**:
   - Check `dataTableOpen` before syncing
   - If closed, still update `selectedSectionId` for next open

6. **Section dropdown manual change**:
   - When user manually switches dropdown, clear selection and select the new section:
     - `setSelection({ type: 'section', sectionId: newSectionId })`

## Key context

Memory convention: "Concurrency guards at store level (not hook level) when multiple UI paths can trigger the same action"

Selection type at uiStore.ts:56-61:
```tsx
interface Selection {
  type: 'station' | 'shot' | 'section';
  stationRef?: StationRef;
  sectionId?: SectionId;
  shotId?: ShotId;
}
```

Use scrollIntoView({ block: 'nearest' }) for minimal scroll - only scrolls if row not visible.
## Acceptance
- [ ] Selecting shot on map switches DataTable to correct section
- [ ] Selecting shot on map highlights corresponding row
- [ ] Selecting shot on map scrolls row into view (minimal scroll)
- [ ] Selecting station highlights the shot that ends at that station
- [ ] Selecting section in Sections Panel switches DataTable dropdown
- [ ] Section selection clears row highlight
- [ ] Manual dropdown change selects the new section and clears shot selection
- [ ] Sync only happens when DataTable is open (no auto-expand)
- [ ] Type check passes: `pnpm tsc --noEmit`
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
