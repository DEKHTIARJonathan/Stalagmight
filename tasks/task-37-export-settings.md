# Task 37: Export Defaults Tab

## Overview
Configure default export options including format, DPI, and include options. Support both built-in presets and custom user presets.

## Priority
Medium - Phase B (Settings)

## Risk Level
Low

## Dependencies
- Task 34: Settings dialog shell

## Files to Modify
- `src/components/Dialogs/settings/TabExport.tsx` - New file
- `src-tauri/src/config/mod.rs` - Add export default fields
- `src/types/config.ts` - Update TypeScript types

## Specifications

### Default Export Options
```typescript
interface ExportDefaults {
  format: 'csv' | 'json' | 'png' | 'svg';
  dpi: number;           // 72, 150, 300
  includeStatistics: boolean;
  includeMetadata: boolean;
  includeLRUD: boolean;
}
```

### Built-in Presets
- **Print**: PNG, 300 DPI, all includes
- **Web**: PNG, 72 DPI, no metadata
- **Archive**: JSON, all includes

### Custom Presets
- Save current settings as named preset
- Load preset to populate form
- Delete custom presets
- Presets stored in config file

### Preset Behavior
- Export dialog uses defaults from config
- Can override at export time
- Does NOT remember last-used options (uses defaults)

### UI Layout
- Format dropdown
- DPI dropdown (72, 150, 300)
- Checkbox group for includes
- Preset selector dropdown
- "Save as Preset" button

### Reset Behavior
- Reset icon next to each setting
- "Reset Export Defaults" button

## Acceptance Criteria
- [ ] Format selector works
- [ ] DPI selector works
- [ ] Include checkboxes work
- [ ] Built-in presets load correctly
- [ ] Custom presets can be created/deleted
- [ ] Export dialog uses configured defaults
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test config save with export default fields
2. Test config load with export default fields
3. Test custom presets stored in config
4. Test preset deletion from config

### Playwright Tests (Mocked IPC)
1. Test format dropdown shows all options (csv, json, png, svg)
2. Test DPI dropdown shows options (72, 150, 300)
3. Test include checkboxes toggle correctly
4. Test built-in preset "Print" loads correct values
5. Test built-in preset "Web" loads correct values
6. Test built-in preset "Archive" loads correct values
7. Test "Save as Preset" creates new preset
8. Test custom preset appears in dropdown
9. Test delete custom preset works
10. Test reset restores default values

### WebdriverIO Tests (Full App)
1. Test export dialog uses configured defaults
2. Test custom presets persist through restart
3. Test preset values actually applied to export
4. Test settings written to config file

## Edge Cases
- Preset name conflicts
- Deleting currently selected preset
- Invalid DPI values
