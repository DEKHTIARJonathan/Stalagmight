# Task 07: Add Placement Options Panel to Step 2 Dialog

## Description

Add the placement options panel to DmpSectionConfigDialog with four exclusive placement modes: Place at 0,0, Zero Datum, From Existing, and Manual Placement.

## Files to Modify

- `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Implementation

### 1. Placement Panel Layout

```
┌─ Placement ─────────────────────────────────────────────────────────────┐
│                                                                          │
│ ● Place at 0,0                                     [Place]               │
│   First station at origin                                                │
│                                                                          │
│ ○ Zero Datum                                                             │
│   GPS: [_________________________]  Format: DD (auto-detected)           │
│   Station: [First ▼] [All stations dropdown]       [Place]               │
│                                                                          │
│ ○ From Existing                                                          │
│   Connect: [This section station ▼] to [Section ▼] [Station ▼] [Place]  │
│                                                                          │
│ ○ Manual Placement                                                       │
│   Click on map to position section                 [Start Placement]     │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2. Placement Mode State

```tsx
type PlacementMode = 'origin' | 'zeroDatum' | 'fromExisting' | 'manual';

interface PlacementState {
  mode: PlacementMode;
  // Zero Datum fields
  gpsInput: string;
  gpsCoords: GpsCoordinates | null;
  gpsFormat: GpsFormat | null;
  gpsStation: number; // station index
  // From Existing fields
  importStation: number; // this section's station index
  targetSection: number | null; // existing section ID
  targetStation: number | null; // existing station index
}
```

### 3. Place at 0,0

- Simplest option
- "Place" button creates section with station 0 at (0,0)
- Section is created immediately in backend

### 4. Zero Datum

- GPS input with auto-detect (all formats: DD, DMS, DDM, UTM, Plus Codes, What3words)
- Format indicator shows detected format
- Station selector: dropdown of all stations (0 to shotCount)
- Three ways to select station:
  - Dropdown
  - Click in preview
  - Click row in shot table
- "Place" button creates section with GPS zero datum

### 5. From Existing

- "This section station" dropdown: all stations in current section
- "Section" dropdown: existing placed sections (pre-existing + placed in this import)
- "Station" dropdown: stations in selected existing section
- Preview shows merge visualization:
  - Current section + target section positioned correctly
  - Dotted line connecting the two stations
- "Place" button creates section and merge

### 6. Manual Placement

- "Start Placement" button hides dialog
- Map shows ghost outline of section
- Instruction overlay: "Click to place section. Press Esc or right-click to cancel."
- Click places section, dialog reappears
- Esc/right-click cancels, dialog reappears

### 7. Placement Persistence

When section is placed:
- Section created in backend immediately
- placedSections set updated
- Green checkmark appears in left panel
- User can still edit section (edits persist immediately)

## Acceptance Criteria

- [ ] All four placement modes render correctly
- [ ] Only one mode selectable at a time (radio buttons)
- [ ] Place at 0,0 works with Place button
- [ ] Zero Datum GPS input auto-detects format
- [ ] Zero Datum station selectable via dropdown, preview, or table
- [ ] From Existing shows section/station dropdowns
- [ ] From Existing preview shows merge visualization
- [ ] Manual Placement hides dialog and shows ghost outline
- [ ] Manual Placement cancellable with Esc/right-click
- [ ] Placed sections show checkmark in left panel
- [ ] TypeScript compiles without errors

## Test Suggestions

### Unit Tests (Rust)
1. Test GPS parsing for DD format
2. Test GPS parsing for DMS format
3. Test GPS parsing for UTM format
4. Test GPS parsing for Plus Codes
5. Test GPS parsing for What3words

### Playwright Tests (3-10)
1. Test Place at 0,0 creates section
2. Test Zero Datum shows GPS input
3. Test GPS format auto-detection indicator
4. Test station dropdown shows all stations
5. Test clicking preview selects station
6. Test From Existing section dropdown
7. Test From Existing station dropdown
8. Test Manual Placement hides dialog
9. Test Escape cancels manual placement
10. Test placed section shows checkmark

### WebdriverIO Tests (3-10)
1. Test Place at 0,0 with full app
2. Test Zero Datum with GPS coordinates
3. Test From Existing merge with existing section
4. Test Manual Placement with map click
5. Test placement persists after navigation

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
