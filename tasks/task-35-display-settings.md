# Task 35: Display Settings Tab

## Overview
Configure visual display options: preset color palettes, font size/family, station size, and line thickness.

## Priority
Medium - Phase B (Settings)

## Risk Level
Medium

## Dependencies
- Task 34: Settings dialog shell

## Files to Modify
- `src/components/Dialogs/settings/TabDisplay.tsx` - New file
- `src-tauri/src/config/mod.rs` - Add font_family field
- `src/types/config.ts` - Update TypeScript types

## Specifications

### Color Palettes
- Preset palettes only (no custom color picker):
  - Default (current colors)
  - Ocean (blues/teals)
  - Forest (greens/browns)
  - Desert (oranges/tans)
  - Colorblind-friendly
- Dropdown selector

### Font Settings
- Font family: System fonts only (dropdown)
  - Default system font
  - Monospace
  - Sans-serif
  - Serif
- Font size: Slider (10-24px, default 12)

### Size Settings
- Station size: Slider (2-12px, default 6)
- Line thickness: Slider (1-6px, default 2)

### Live Preview
- Changes reflect immediately on map
- No preview panel needed (see actual map)

### Config Schema Addition
```rust
pub struct DisplayConfig {
    // existing fields...
    pub font_family: String,  // NEW
}
```

### Reset Behavior
- Reset icon next to each setting
- "Reset Display Settings" button

## Acceptance Criteria
- [ ] Preset palettes selectable
- [ ] Font family dropdown works
- [ ] Font size slider works
- [ ] Station/line size sliders work
- [ ] Changes reflect immediately
- [ ] Settings persist to config file
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test config save with font_family field
2. Test config load with font_family field
3. Test default font_family value
4. Test all display config fields serialize/deserialize

### Playwright Tests (Mocked IPC)
1. Test color palette dropdown shows all presets
2. Test selecting palette updates preview
3. Test font family dropdown shows all options
4. Test font size slider changes value (10-24px range)
5. Test station size slider changes value (2-12px range)
6. Test line thickness slider changes value (1-6px range)
7. Test reset icon restores individual setting
8. Test "Reset Display Settings" restores all

### WebdriverIO Tests (Full App)
1. Test palette selection reflects on actual map
2. Test font changes apply to map labels
3. Test station/line sizes change on map
4. Test settings persist through app restart
5. Test settings written to config.toml

## Edge Cases
- Font not available on system
- Extreme slider values
