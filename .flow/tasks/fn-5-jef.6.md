# fn-5-jef.6 Add color mode dropdown to export dialog

## Description
**MOVED TO fn-11-6w4 (Export System Enhancement)**

This task has been migrated to a dedicated export epic. See:
- Epic: fn-11-6w4
- Task: fn-11-6w4.6 (Add color mode and preset selectors to ExportDialog)

The original requirement "Add color mode dropdown to export dialog" is now part of a comprehensive export enhancement that includes:
- Backend SVG/PDF/PNG generation with depth colors
- HSL interpolation with 5 color presets
- Depth legend support
- resvg PNG rasterization
- Progress indicator during export

## Original Note
This task was deferred because it required architectural decisions about the export system (backend SVG/PDF vs frontend capture). Those decisions have been made in fn-11-6w4:
- Backend generates all formats (PNG via resvg rasterization)
- Frontend preview uses TypeScript getDepthColor with preset colors from backend
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
- [x] MOVED - See fn-11-6w4.6 for implementation
## Done summary
Superseded by fn-11-6w4.6 in Export System Enhancement epic
## Evidence
- Commits:
- Tests:
- PRs: