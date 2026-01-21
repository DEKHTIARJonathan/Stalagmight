# Double-click section to zoom and focus on map

## Overview

Add ability to quickly navigate to a specific section on the map by double-clicking it in the Sections panel, using a keyboard shortcut, or via context menu. The map smoothly animates to show the section filling ~80% of the visible area (accounting for open side panels).

## Scope

**In scope:**
- Double-click handler on section items in SectionsPanel
- "Zoom to Section" context menu option
- Ctrl+G keyboard shortcut (global, focuses selected section)
- Configurable animation settings (enable/disable, duration, point zoom level)
- Panel-aware padding calculation
- Tooltip showing shortcut hint

**Out of scope:**
- Station/shot focus (future iteration)
- Animation cancellation via Escape key

## Approach

### State Management
Follow existing `requestFitToBounds` pattern in UIStore:
- Add `requestZoomToSection: SectionId | null`
- Add `triggerZoomToSection(sectionId)` / `clearZoomToSectionRequest()`
- MapCanvas watches state and calls new `fitToSection()` method
- **CRITICAL**: Always call `clearZoomToSectionRequest()` in MapCanvas after handling, regardless of whether zoom actually occurs (prevents stuck requests)

### Zoom Calculation
1. Filter stations by `section_id` to get section geometry
2. Calculate bounds via existing `getBounds()` utility
3. Convert to map coords via `metersToMapCoords(x, y, gpsOrigin)` - **must use gpsOrigin for satellite alignment**
4. Calculate padding from UIStore panel state:
   - Left: `sectionsPanelOpen ? sectionsPanelWidth : 0`
   - Right: `detailPanelOpen ? detailPanelWidth : 0`
   - Top/Bottom: 10% of visible height (ignore data table)
5. Call `map.stop()` then `map.fitBounds()` with padding and animation settings

### Edge Cases
- **Single station**: Center on station, zoom to `config.map.animation.point_zoom` (default 18)
- **Empty section**: Clear request and return early (no-op)
- **Rapid clicks**: `map.stop()` cancels previous animation before starting new one
- **No selection** (Ctrl+G): No-op

### Config Changes
Add to `MapConfig`:
```typescript
animation: {
  enabled: boolean;    // default: true
  duration: number;    // default: 300 (ms)
  point_zoom: number;  // default: 18
}
```

Requires updates to:
- `src-tauri/src/config/mod.rs` - Add struct with serde defaults
- `src-tauri/src/config/defaults.rs` - Add default values
- `src/types/config.ts` - Add TypeScript interface
- `src/types/config.ts` defaultConfig - Add default values

## Quick commands

```bash
# Type check
pnpm tsc --noEmit

# Run UI tests
pnpm test:ui

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
```

## Key Files

| File | Change |
|------|--------|
| `src/store/uiStore.ts:163` | Add `requestZoomToSection` state + actions |
| `src/components/Map/MapCanvas.tsx:1130` | Add `fitToSection()` method |
| `src/components/SingleSystemView/SectionsPanel.tsx:76` | Add `onDoubleClick` handler |
| `src/hooks/useKeyboardShortcuts.ts:131` | Add Ctrl+G handler |
| `src/components/common/ContextMenu.tsx:166` | Add "Zoom to Section" menu item |
| `src/types/config.ts:104` | Add `MapAnimationConfig` type + update defaultConfig |
| `src-tauri/src/config/mod.rs` | Add MapAnimationConfig struct |
| `src-tauri/src/config/defaults.rs` | Add animation defaults |

## Risks

- **MapLibre padding accumulation bug**: Call `map.setPadding({top:0,right:0,bottom:0,left:0})` before `fitBounds()` to avoid accumulated padding from previous `flyTo` calls
- **Double-click handling**: Use React's native `onDoubleClick` handler (not `event.detail === 2`) for cleaner separation from single-click

## Acceptance

- [ ] Double-clicking a section in Sections panel selects it and smoothly animates map to show section at ~80% of visible area
- [ ] "Zoom to Section" appears in section context menu and works identically
- [ ] Ctrl+G focuses the currently selected section (no-op if no selection)
- [ ] Padding calculation uses UIStore panel state (sectionsPanelOpen/Width, detailPanelOpen/Width)
- [ ] Animation respects config.map.animation.enabled and duration settings
- [ ] Single-station sections center and zoom to configured level (default 18)
- [ ] Empty sections (no stations) are handled gracefully - request cleared without action
- [ ] Rapid double-clicks cancel previous animation and start new one
- [ ] Tooltip "Double-click to zoom (Ctrl+G)" appears on section items
- [ ] gpsOrigin used in coordinate conversion for satellite alignment
