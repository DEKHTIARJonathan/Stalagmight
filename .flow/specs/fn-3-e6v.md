# Display Toggle Visibility & Selection Behavior

## Problem

The "Display → Stations" toggle exists in the UI but does not actually hide station markers or prevent their selection. Users expect that hiding stations would:
1. Make station markers invisible
2. Prevent accidental selection of hidden stations
3. Disable station-specific tool operations

Additionally, a "Shots" toggle is needed to control shot line visibility, with proper interaction with the existing "Virtual Shots" toggle.

## Approach

### Core Visibility Implementation

**Stations Toggle (`showStations`):**
- Add `setShowStations(visible: boolean)` method to `SurveyLayer` class
- Use MapLibre layer visibility API to hide/show the `survey-stations` layer
- Sync toggle state from `MapCanvas.tsx` via useEffect hook (following pattern of other toggles)

**New Shots Toggle (`showShots`):**
- Add new `showShots: boolean` state to `uiStore.ts` (default: `true`)
- Add to `DisplayToggleKey` type and `DisplayMenu.tsx`
- Add `setShowShots(visible: boolean)` method to `SurveyLayer` class
- Controls visibility of the `survey-shots` layer (all shot lines including virtual)

**Toggle Relationships:**
- When `showShots` is OFF: 
  - Hide all shot lines (regular + virtual)
  - Disable (gray out) the "Virtual Shots" toggle in DisplayMenu
  - Disable (gray out) the "Shot Data" toggle in DisplayMenu
- When `showShots` is ON:
  - Re-enable "Virtual Shots" and "Shot Data" toggles
  - Restore their previous states

### Selection Behavior

**When Stations Hidden:**
- Clear any selected stations immediately when toggle is turned OFF
- Disable station hover effects (no blue highlight on hidden station positions)
- Block station selection in Selection mode
- Show throttled toast: "Enable 'Stations' in Display menu to interact with station markers" (max once per 5 seconds)

**When Shots Hidden:**
- Clear any selected shots immediately when toggle is turned OFF
- Disable shot hover effects
- Block shot selection in Selection mode
- Similar throttled toast for shots

**Shots remain independently selectable** when only Stations are hidden (and vice versa).

### Tool Behavior When Stations Hidden

| Tool | Behavior |
|------|----------|
| Select | Cannot select stations; can still select shots if visible |
| Delete | Cannot delete stations; can delete selected shots |
| Merge | Disabled (requires visible stations) |
| Move Station | Disabled (requires visible stations) |
| Move Section | Still works (selects by section, not individual station) |
| Measure | Works for arbitrary point-to-point; snap indicators still work |
| Draw | Works; snap indicators and origin station become temporarily visible |

**Snap Indicator Exception:**
- During Draw/Merge/Measure, when cursor snaps to a station:
  - Show the full station marker temporarily (not just snap ring)
  - Origin station in Draw mode becomes visible during the operation
- This ensures usability while maintaining the "hidden" state conceptually

### In-Progress Operation Handling

When user toggles visibility while an operation is in progress:
- Cancel the current operation (draw, merge, measure)
- Show toast: "Operation canceled - [stations/shots] hidden"
- Clear any temporary visual state

### Persistence

- All display toggle states persist across app restarts (already handled by uiStore persistence)
- The new `showShots` toggle should follow the same persistence pattern

### UI Changes

**DisplayMenu.tsx updates:**
- Add "Shots" toggle above "Virtual Shots"
- "Virtual Shots" becomes disabled (grayed out) when "Shots" is unchecked
- "Shot Data" becomes disabled when "Shots" is unchecked
- Visual indication: disabled toggles show reduced opacity, cursor changes to not-allowed

## Edge Cases

1. **Multi-section selection:** If stations in multiple sections are selected and user hides stations, clear all selected stations across all sections
2. **Mixed selection (stations + shots):** Only clear the type being hidden; keep the other selected
3. **Snap during hide:** If user is hovering and about to snap when they hide, cancel the snap state
4. **Rapid toggle:** Debounce toast notifications (5 second throttle) to prevent spam

## Quick Commands

```bash
# Run TypeScript check
pnpm tsc --noEmit

# Run E2E tests
pnpm test:ui

# Run Rust tests  
cargo test --manifest-path src-tauri/Cargo.toml
```

## Acceptance Criteria

- [ ] Stations toggle hides all station markers when unchecked
- [ ] Hidden stations cannot be selected in Selection mode
- [ ] Hidden stations do not show hover effects
- [ ] Clicking where a hidden station is shows throttled toast notification
- [ ] Snap indicators still work during Draw/Merge/Measure with hidden stations
- [ ] Snapped/origin stations become temporarily visible during tool operations
- [ ] Selection is cleared when toggle is turned off
- [ ] In-progress operations are canceled with notification when visibility changes
- [ ] New "Shots" toggle controls all shot line visibility
- [ ] "Virtual Shots" toggle is disabled when "Shots" is hidden
- [ ] "Shot Data" toggle is disabled when "Shots" is hidden
- [ ] Toggle states restore correctly when parent toggle re-enabled
- [ ] All toggle states persist across app restart
- [ ] E2E tests cover visibility toggle behavior
- [ ] Unit tests cover state logic and toggle relationships

## Out of Scope (Separate Epic)

- Keyboard shortcuts for display toggles (Settings → Keyboard Shortcuts)
- This will be a separate feature epic
