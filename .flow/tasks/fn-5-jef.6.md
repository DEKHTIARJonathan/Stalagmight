# fn-5-jef.6 Add color mode dropdown to export dialog

## Description
**DEFERRED TO SEPARATE EPIC**

This task requires architectural decisions about export system (backend SVG/PDF vs frontend capture).
See epic spec "Future Work" section.

Original requirement: Add color mode dropdown to export dialog
## Export Dialog Location
Find the existing export dialog/modal component and add a color mode selector.

## UI Addition

### Dropdown Element
```tsx
<label>Color Mode</label>
<select value={colorMode} onChange={e => setColorMode(e.target.value)}>
  <option value="section">Section Colors</option>
  <option value="depth">Depth Gradient</option>
</select>
```

### State
- Add `colorMode: 'section' | 'depth'` state
- Default: `'section'` (always, regardless of current display setting)

### Export Logic
When exporting:
1. Temporarily set `showDepthGradient` to match selected color mode
2. Capture map image
3. Restore original `showDepthGradient` setting

## Files to Modify
- Export dialog component (search for export modal/dialog)
- May need to pass colorMode to capture function

## Notes
- This affects PNG/image export
- PDF/SVG export should also respect this if applicable
- Don't persist the export color mode preference - always reset to 'section'
## Acceptance
- [ ] DEFERRED - see epic "Future Work" section
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
