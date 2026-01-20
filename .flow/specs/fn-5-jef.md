# Bugfix: Depth Gradient Display Not Working

## Problem

The "Display → Depth Gradient" toggle exists in the UI but does nothing. When enabled, stations and shots continue to display section-based colors instead of depth-based colors. The toggle state persists correctly, but the actual rendering logic to apply depth colors was never implemented.

**Root cause**: MapCanvas doesn't pass `showDepthGradient` to SurveyLayer, and SurveyLayer always uses section colors without any conditional logic for depth mode.

## Approach

### 1. Wire up depth gradient toggle to SurveyLayer
- Extract `showDepthGradient` in MapCanvas
- Add `setShowDepthGradient()` method to SurveyLayer
- Add useEffect to sync toggle state with layer

### 2. Modify color computation in SurveyLayer.update()
- When depth gradient enabled, compute colors using `getDepthColor()` instead of section color
- Auto-scale depth range to project's `stats.min_depth` and `stats.max_depth`
- Precompute all colors during update() for performance
- Apply to: stations, shots (including virtual), station labels, shot data labels
- Exclude: loop closures (keep error-severity colors), merges (keep distinct styling), ghost previews

### 3. Update getDepthColor() utility
- Modify to use HSL interpolation (shortest hue path) instead of RGB
- Keep existing function signature for backward compatibility
- Colors: shallow=#00bfff (light blue) → deep=#ff4444 (red)

### 4. Special cases
- **Zero datum stations**: Gold border with depth-colored fill
- **Missing depth (z=0)**: Treated as surface level, gets shallowest color
- **Selection/hover highlights**: Unaffected, use existing highlight colors

### 5. Add depth legend component
- New DepthLegend React component in MapCanvas
- Position: bottom-left, above scale bar
- Format: vertical SVG gradient bar (16px wide × 80px tall) with min/max depth labels
- Semi-transparent dark background matching existing overlay style
- Auto-updates when project depth range changes
- Hidden when depth gradient toggle is OFF
- Respects project measurement units (m/ft)
- Single-depth case: shows single value, solid color bar

### 6. Export color mode option
- Add dropdown to export dialog: "Section Colors" / "Depth Gradient"
- Default: Section Colors
- Apply selected mode to exported map image

### 7. Keyboard shortcut infrastructure
- Add depth gradient toggle to keyboard shortcuts config (no default binding)
- User can assign custom shortcut in settings

## Edge Cases
- Flat cave (all same depth): still apply gradient, legend shows single depth value
- Empty project: legend hidden, no colors to compute
- New stations while depth gradient on: use depth colors immediately
- Merging sections: no change to color mode
- Toggle off: instant revert to section colors

## Quick commands
```bash
# Type check
pnpm tsc --noEmit

# Run tests
pnpm test:ui
```

## Acceptance Criteria

- [ ] Toggling "Depth Gradient" ON colors stations/shots/labels by depth using HSL interpolation
- [ ] Toggling OFF instantly reverts to section colors
- [ ] Zero datum stations have gold border with depth-colored fill
- [ ] Loop closures and merges keep their distinct styling
- [ ] Depth legend appears bottom-left when enabled, hidden when disabled
- [ ] Legend shows project's min/max depth in correct units
- [ ] Export dialog has color mode dropdown defaulting to section colors
- [ ] Keyboard shortcut configurable (no default binding)
- [ ] Unit tests for getDepthColor() HSL interpolation
- [ ] Playwright tests for toggle behavior and legend visibility
- [ ] WebdriverIO tests for cross-browser compatibility
- [ ] `pnpm tsc --noEmit` passes
- [ ] All existing tests pass
