# fn-12-wb3.1 Add station index labels to SurveyLayer

## Description
## Overview
Add station index labels with zoom-dependent visibility.
## Files
- src/components/Map/SurveyLayer.tsx
- src/store/uiStore.ts
## Acceptance
- [ ] Index labels near dots
- [ ] Zoom-dependent
- [ ] Toggle works
- [ ] Tests pass
## Done summary
# Task fn-12-wb3.1: Add station index labels to SurveyLayer

## Summary
Implemented station index labels on the map with zoom-dependent visibility and a toggle in the Display menu.

## Changes Made

### 1. uiStore.ts
- Added `showStationLabels: boolean` to display toggles (defaults to `false`)
- Added to `DisplayToggleKey` type
- Added to `resetDisplaySettings()` defaults

### 2. SurveyLayer.tsx
- Added new source `survey-data-station-labels` for station label GeoJSON
- Added new symbol layer `survey-station-labels` with:
  - Zoom-dependent visibility filter (hidden at low zoom, progressive density at mid-zoom)
  - Text offset to position labels near station dots (top-right)
  - White text with black halo for contrast
- Added `setShowStationLabels(show: boolean)` method
- Updated `update()` to build and render station label features
- Updated `destroy()` to clean up new layer/source

### 3. MapCanvas.tsx
- Added `showStationLabels` from uiStore
- Added useEffect to sync `showStationLabels` with SurveyLayer

### 4. DisplayMenu.tsx
- Added "Station Labels" option to Map Elements group
- Connected to `showStationLabels` toggle

### 5. Tests
- Added Playwright test for station labels toggle visibility
## Evidence
- Commits:
- Tests:
- PRs: