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
| `src/store/uiStore.ts` | Display toggle state, selection state | L143, L216-226, L279, L349, L397-403 |
| `src/components/Map/SurveyLayer.tsx` | Layer visibility, features | L44-50 (layer IDs), L600-625 (visibility methods), update() |
| `src/components/Map/MapCanvas.tsx` | Toggle sync, snap logic | L517-528 (useEffect pattern), L103-115 (snap) |
| `src/components/SingleSystemView/DisplayMenu.tsx` | Toggle UI (button rows) | L11-32 |
| `src/hooks/useMapTools.ts` | Tool handlers | L75-183 (station), L186-217 (shot) |
| `src/hooks/useKeyboardShortcuts.ts` | Keyboard shortcuts | L108 (Ctrl+A) |

## Approach

### Adding `showShots` Toggle - Complete Checklist

1. **`src/store/uiStore.ts`:**
   - Add `showShots: boolean` to UIState interface
   - Add `'showShots'` to `DisplayToggleKey` union
   - Add `showShots: true` to initial state
   - Verify persistence via `save_display_setting` (keys starting with `show` are persisted)
   - Verify load logic includes it

2. **`src/components/SingleSystemView/DisplayMenu.tsx`:**
   - Add entry to `displayOptions` array before "Virtual Shots"

3. **`src/components/Map/MapCanvas.tsx`:**
   - Destructure `showShots` and add useEffect sync

4. **Tests:**
   - Update Playwright IPC mocks that stub display settings to include `showShots`

### Core Visibility Implementation

**Stations Toggle**: Controls `survey-stations`, `survey-merges`, `survey-loop-closures`
**Shots Toggle**: Controls `survey-shots`
**Virtual Shots Toggle**: Uses FILTER on shots layer to exclude virtual shots

### Station Feature ID Format

**Existing structure**: Station features in `SurveyLayer.update()` use `station.station_ref` which is a unique identifier.

**Highlight layer filter** will use `station_ref` property (already exists):
```typescript
setHighlightedStations(stationRefs: string[]): void {
  if (!this.map) return;
  this.map.setFilter(this.stationsHighlightLayerId,
    stationRefs.length > 0
      ? ['in', ['get', 'station_ref'], ['literal', stationRefs]]
      : ['==', 'station_ref', '__none__']
  );
}
```

### DisplayMenu Disabled State (Using Existing Button Rows)

The current DisplayMenu uses **button rows**, not Checkbox components. Add disabled styling to existing pattern:

```typescript
// In DisplayMenu.tsx - add disabled check
const isDisabled = (option: DisplayOption) => 
  option.disabledWhen ? !toggleState[option.disabledWhen] : false;

// In button row:
<button
  onClick={() => !isDisabled(option) && toggleDisplay(option.key)}
  aria-disabled={isDisabled(option)}
  className={cn(
    "flex items-center gap-2 w-full px-3 py-2 text-sm",
    isDisabled(option) && "opacity-50 cursor-not-allowed"
  )}
>
  <Checkbox 
    checked={toggleState[option.key]} 
    disabled={isDisabled(option)}
  />
  <span>{option.label}</span>
</button>
```

### Tool Interaction Rules

**Clarification**: Snap to hidden stations IS ALLOWED for Draw/Measure (usability). But direct station targeting (Select, Delete, Merge, Move Station) is blocked.

| Tool | Allows snap to hidden? | Direct interaction blocked? |
|------|------------------------|----------------------------|
| Select | N/A | YES - guard blocks |
| Delete | N/A | YES - guard blocks |
| Merge | NO - both stations must be visible | YES - guard blocks |
| Move Station | N/A | YES - guard blocks |
| Move Section | N/A | NO - section-level operation |
| Measure | YES - snap shows highlight | NO - point-to-point works |
| Draw | YES - snap shows highlight | NO - line creation works |

**Guard placement**:
- `handleStationClick`: Block all station clicks when `!showStations`
- `handleShotClick`: Block all shot clicks when `!showShots`
- `handleEmptyClick` with snap: **ALLOW** snap for Draw/Measure (highlight layer shows station)
- Merge tool: Block if either target station would be hidden

### Virtual Shots Handling

When `showVirtualShots` toggled OFF:
1. Apply filter: `['!=', ['get', 'isVirtual'], true]`
2. Clear any selected/hovered **virtual** shot from store
3. Clear SurveyLayer internal `hoveredShotId` if it's a virtual shot

```typescript
// In uiStore toggleDisplay
if (key === 'showVirtualShots' && !newVal) {
  // Clear virtual shot selection/hover
  const current = get();
  if (current.selection?.type === 'shot') {
    // Check if it's virtual and clear if so
    // (requires checking shot data)
  }
}

// In MapCanvas useEffect
useEffect(() => {
  if (!showVirtualShots) {
    // Clear any virtual shot hover/selection
    // surveyLayerRef.current?.clearVirtualShotState();
  }
}, [showVirtualShots]);
```

### Selection and Interaction State Sync

**When visibility toggles flip, call `clearAllInteractionState()`:**

```typescript
// In MapCanvas
useEffect(() => {
  if (!showStations && surveyLayerRef.current) {
    surveyLayerRef.current.clearAllInteractionState();
    clearSelectionByType('station');
    // ... rest of cleanup
  }
}, [showStations]);

useEffect(() => {
  if (!showShots && surveyLayerRef.current) {
    surveyLayerRef.current.clearShotHover();
    clearSelectionByType('shot');
  }
}, [showShots]);
```

This ensures SurveyLayer internal IDs (`hoveredStationId`, `hoveredShotId`, `selectedStationId`, `selectedShotId`, `snappedStationId`) are all cleared, preventing stale visuals when layer is re-enabled.

### Toggle Cascade (In-Memory Only)

**When `showShots` OFF:**
- Store `_prevShowVirtualShots` and `_prevShowShotData` in-memory
- Set `showShotData = false`
- These `_prev*` values NOT persisted (not in `save_display_setting`)

**When `showShots` ON:**
- Restore from in-memory values

### Toast System

Per-key throttling with React Portal:
- State: `toast: { message, key, timestamp } | null`, `lastToastByKey: Record<string, number>`
- Portal to `document.body` with `z-index: 99999`
- 5 second throttle per key, 3 second auto-dismiss

### Highlight Layer

For snapped/origin stations during Draw/Measure:
- Separate `survey-stations-highlight` layer (always visible)
- Filter uses `station_ref` property (existing identifier)
- Called when `snappedStation`, `drawFromStation` etc. change

### Persistence & Testing

- `showShots` persists via existing `save_display_setting` mechanism (keys starting with `show`)
- `_prev*` values are in-memory only
- **Playwright mocks**: Update any IPC mocks for display settings to include `showShots`

## Edge Cases

1. **Multi-section selection**: `clearSelectionByType('station')` handles all
2. **Mixed selection**: Only clears the type being hidden
3. **Virtual shot selection**: Clear when `showVirtualShots` toggled off
4. **Snap during hide**: `clearAllInteractionState()` handles
5. **Stale SurveyLayer state**: `clearAllInteractionState()` syncs internal IDs
6. **Merge with hidden station**: Guard blocks merge tool when stations hidden

## Quick Commands

```bash
pnpm tsc --noEmit
pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml
```

## Acceptance Criteria

- [ ] `showShots` toggle added to all required locations
- [ ] Playwright IPC mocks updated for `showShots`
- [ ] Guards in `handleStationClick`/`handleShotClick` block when hidden
- [ ] Snap to hidden stations works for Draw/Measure (highlight shows)
- [ ] Merge tool blocked when stations hidden
- [ ] Highlight layer uses `station_ref` filter (existing property)
- [ ] DisplayMenu uses existing button-row pattern with disabled styling
- [ ] `showVirtualShots` toggle clears virtual shot selection/hover when off
- [ ] `clearAllInteractionState()` called when visibility toggles flip
- [ ] `_prev*` values are in-memory only (not persisted)
- [ ] Toast uses React Portal with z-index 99999
- [ ] E2E tests cover visibility toggle behavior
- [ ] Unit tests cover state logic

## Out of Scope

- Keyboard shortcuts for display toggles (separate epic)
- Station Labels auto-disable (user chose independent)
- Zero Datum toggle behavior (not discussed)
