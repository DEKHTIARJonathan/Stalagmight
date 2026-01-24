## Summary

Implemented external selection to DataTable sync with the following features:

1. **Shot selection sync**: When a shot is selected on the map, the DataTable automatically switches to the correct section dropdown and scrolls to highlight the corresponding row.

2. **Station selection sync**: When a station is selected on the map, the DataTable highlights the shot connected to that station:
   - Station 0 highlights shot 0 (the first shot starts at station 0)
   - Station N (N >= 1) highlights shot N-1 (shot N-1 ends at station N)

3. **Section selection sync**: When a section is selected in the Sections Panel, the DataTable dropdown switches to that section and clears any row highlight.

4. **Manual dropdown change**: When the user manually changes the section dropdown, it selects the new section (sets `type: 'section'` selection), which properly updates the rest of the UI.

5. **Scroll behavior**: Uses `scrollToKey` prop on EditableTable which triggers `scrollIntoView({ block: 'nearest' })` for minimal scrolling - only scrolls if the row is not already visible.

6. **Performance optimizations**:
   - Tracks previous selection in a ref to avoid reacting to section data changes (only reacts to actual selection changes)
   - Gates scroll/highlight work on `dataTableOpen` state - only performs scroll when table is visible
   - Uses a computed `highlightedShotId` memo to derive the correct shot to highlight from both shot and station selections

7. **No feedback loop issues**: The Select component with controlled value doesn't call onChange when value changes programmatically, only on user interaction, so no special feedback loop prevention needed.
