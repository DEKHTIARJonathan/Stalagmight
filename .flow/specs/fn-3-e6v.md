# Display Toggle Visibility & Selection Behavior

## Problem

The "Display → Stations" toggle exists in the UI but does not actually hide station markers or prevent their selection. Users expect that hiding stations would:
1. Make station markers invisible
2. Prevent accidental selection of hidden stations
3. Disable station-specific tool operations

Additionally, a "Shots" toggle is needed to control shot line visibility, with proper interaction with the existing "Virtual Shots" toggle.

## Key Files

| File | Purpose | Key Lines |
|------|---------|-----------|
| `src/store/uiStore.ts` | Display toggle state, selection state | L143 (showStations), L216-226 (DisplayToggleKey), L279 (clearSelection), L349 (defaults) |
| `src/components/Map/SurveyLayer.tsx` | Layer visibility methods, layer IDs | L44-50 (layer IDs), L600-625 (visibility methods pattern) |
| `src/components/Map/MapCanvas.tsx` | Toggle sync hooks, snap logic | L517-528 (useEffect pattern), L103-115 (snap logic) |
| `src/components/SingleSystemView/DisplayMenu.tsx` | Toggle UI | L11-32 (displayOptions), L15 (showStations entry) |
| `src/hooks/useMapTools.ts` | Tool handlers | L75-183 (handleStationClick), L186-217 (handleShotClick) |
| `src/hooks/useKeyboardShortcuts.ts` | Keyboard shortcuts | L108 (Ctrl+A select all) |

## Approach

### Core Visibility Implementation

**Stations Toggle (`showStations`):**
- Add `setShowStations(visible: boolean)` method to `SurveyLayer` class (follow pattern at L600-625)
- Use MapLibre `setLayoutProperty(layerId, 'visibility', 'none')` to hide `survey-stations` layer
- Also hide related layers: `survey-merges`, `survey-loop-closures` (they reference stations)
- Sync toggle state from `MapCanvas.tsx` via useEffect hook (follow pattern at L517-528)

**New Shots Toggle (`showShots`):**
- Add `showShots: boolean` state to `uiStore.ts` (default: `true`, add to L143 area)
- Add to `DisplayToggleKey` type (L216-226)
- Add `setShowShots(visible: boolean)` method to `SurveyLayer` class
- Controls visibility of `survey-shots` layer (L44)

**Important**: MapLibre's `queryRenderedFeatures()` automatically returns empty for hidden layers, which naturally blocks click detection in handlers at SurveyLayer.tsx L407-437.

### Toggle Relationships

**When `showShots` is OFF:**
- Hide all shot lines (regular + virtual)
- Disable (gray out) "Virtual Shots" toggle in DisplayMenu
- Disable (gray out) "Shot Data" toggle in DisplayMenu
- Shot Data labels also immediately hide

**When `showShots` is ON:**
- Re-enable "Virtual Shots" and "Shot Data" toggles
- Restore their previous states (Zustand cascade pattern in `set()` callback)

**Station Labels**: Remain independently controllable (user decision from interview) - labels may float at positions even when markers are hidden.

### Selection Behavior

**When Stations Hidden:**
- Clear selected stations immediately via `clearSelection()` or filtered clear (L279)
- Disable station hover effects (`hoveredStation` should also clear)
- Block station selection - `queryRenderedFeatures` naturally returns empty
- Show throttled toast: "Enable 'Stations' in Display menu to interact with station markers"

**When Shots Hidden:**
- Clear selected shots immediately
- Clear `hoveredShot` state
- Block shot selection
- Similar throttled toast for shots

**Mixed selection**: Only clear the type being hidden; keep the other selected. Filter `multiSelection` array by type.

### Toast Notification System

**No toast system exists** - need to create one:
- Add `toast: { message: string; timestamp: number } | null` to uiStore
- Add `showToast(message: string)` action with throttle logic (5 second cooldown using timestamp comparison)
- Render toast in App layout (position: bottom-center, auto-dismiss after 3 seconds)
- Use unique throttle keys per message type

### Tool Behavior When Stations Hidden

| Tool | Behavior |
|------|----------|
| Select | Cannot select stations (queryRenderedFeatures returns empty) |
| Delete | Cannot delete stations; can delete selected shots |
| Merge | Disabled - show toast on attempt |
| Move Station | Disabled - show toast on attempt |
| Move Section | Still works (section-level operation) |
| Measure | Works for arbitrary points; snap indicators still work |
| Draw | Works; snap shows station temporarily |

### Snap Indicator Exception

**Key insight**: Snap logic at MapCanvas.tsx L103-115 iterates `stations` array directly, NOT through `queryRenderedFeatures`. This means snap WILL find hidden stations - this is intentional for usability.

When cursor snaps to a hidden station during Draw/Merge/Measure:
- Show the full station marker temporarily (not just snap ring)
- Use snapped visual state (cyan #00ffcc, 7px radius, 4px stroke)
- Origin station in Draw mode becomes visible during the operation
- Station returns to hidden when operation completes/cancels

### In-Progress Operation Handling

When visibility toggles change during an active operation:
- Cancel Draw operation (clear `drawFromStation`, pending points)
- Cancel Merge operation (clear `mergeStationA`, `mergeStationB`)
- Cancel Measure operation (clear `measureStart`, `measureEnd`)
- Cancel Placement mode if active
- Show toast: "Operation canceled - [stations/shots] hidden"
- Clear any temporary visual state

### Additional Layers to Hide

When stations hidden, also hide (they reference stations):
- `survey-merges` (L49) - dashed lines between merged stations
- `survey-loop-closures` (L50) - error indicators

Ghost layers (`survey-ghost-shots`, `survey-ghost-stations`) should also respect visibility during merge preview.

### Keyboard Shortcut Considerations

- `Ctrl+A` select all (L108 in useKeyboardShortcuts.ts): Should skip hidden elements or be blocked entirely when relevant elements hidden
- `Delete/Backspace`: Works on current selection (already validated)

### Persistence

- All display toggle states persist via `save_display_setting` IPC (L397-403 in uiStore)
- New `showShots` toggle should follow same pattern
- Toast state does NOT persist (ephemeral)

## Edge Cases

1. **Multi-section selection**: Clear all selected stations across all sections when hiding
2. **Mixed selection (stations + shots)**: Only clear the type being hidden
3. **Snap during hide**: Cancel snap state (`snappedStation: null`)
4. **Rapid toggle**: Toast throttle (5 second) prevents spam
5. **Toggle before map loaded**: Check `mapLoaded` state before calling layer methods
6. **Undo after visibility change**: Selection does NOT restore (state was explicitly cleared)
7. **Placement mode**: Cancel placement when visibility changes

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

- [ ] Stations toggle hides `survey-stations`, `survey-merges`, `survey-loop-closures` layers
- [ ] Hidden stations cannot be selected (queryRenderedFeatures returns empty)
- [ ] Hidden stations do not show hover effects
- [ ] Clicking hidden station area shows throttled toast (max once per 5 sec)
- [ ] Snap indicators work during Draw/Merge/Measure with hidden stations
- [ ] Snapped/origin stations become temporarily visible during tool operations
- [ ] Selection is cleared immediately when toggle turned off
- [ ] In-progress operations canceled with toast notification
- [ ] New "Shots" toggle controls `survey-shots` visibility
- [ ] "Virtual Shots" toggle disabled when "Shots" hidden
- [ ] "Shot Data" toggle disabled when "Shots" hidden
- [ ] Toggle states restore correctly when parent toggle re-enabled
- [ ] All toggle states persist across app restart
- [ ] Ctrl+A respects visibility (skips hidden elements)
- [ ] E2E tests cover visibility toggle behavior
- [ ] Unit tests cover state logic and toggle relationships

## Out of Scope

- Keyboard shortcuts for display toggles (separate epic)
- Station Labels auto-disable (user chose independent)
- Zero Datum toggle behavior (not discussed)

## References

- MapLibre visibility: `setLayoutProperty(layerId, 'visibility', 'none')`
- Zustand dependent state: cascade in `set()` callback
- Toast throttle: timestamp comparison with 5000ms threshold
