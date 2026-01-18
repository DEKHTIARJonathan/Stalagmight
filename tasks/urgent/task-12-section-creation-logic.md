# Task 12: Implement Section Placement and Creation Logic

## Description

Implement the backend calls that create sections when placed. Each placement type (0,0, Zero Datum, From Existing, Manual) has specific creation logic.

## Files to Modify

- `src/components/Dialogs/DmpSectionConfigDialog.tsx`
- `src/store/projectStore.ts`

## Implementation

### 1. Place at 0,0

```tsx
async function placeAtOrigin(sectionConfig: SectionConfig): Promise<boolean> {
  const sectionData: SectionData = {
    name: sectionConfig.name,
    surveyor: sectionConfig.surveyor,
    date: sectionConfig.date,
    color: sectionConfig.color,
    direction: sectionConfig.direction,
    shots: sectionConfig.shots.map(shotToShotData),
  };

  const result = await createSection(sectionData);
  if (!result.success) {
    showError(result.error);
    return false;
  }

  return true;
}
```

### 2. Zero Datum Placement

```tsx
async function placeWithZeroDatum(
  sectionConfig: SectionConfig,
  coordinates: GpsCoordinates,
  stationIndex: number
): Promise<boolean> {
  // Create section first
  const result = await createSection(sectionData);
  if (!result.success) {
    showError(result.error);
    return false;
  }

  // Set zero datum on specified station
  const sectionId = result.sectionId;
  const zeroDatumResult = await setZeroDatum({
    section_id: sectionId,
    station_index: stationIndex,
  }, coordinates);

  if (!zeroDatumResult.success) {
    showError(zeroDatumResult.error);
    // Section was created but zero datum failed - still mark as placed
    return true;
  }

  return true;
}
```

### 3. From Existing Placement

```tsx
async function placeFromExisting(
  sectionConfig: SectionConfig,
  importStationIndex: number,
  targetRef: StationRef
): Promise<boolean> {
  // Create section first
  const result = await createSection(sectionData);
  if (!result.success) {
    showError(result.error);
    return false;
  }

  const sectionId = result.sectionId;

  // Merge stations
  const importRef: StationRef = {
    section_id: sectionId,
    station_index: importStationIndex,
  };

  const mergeResult = await mergeStations(importRef, targetRef, 'KeepRaw');
  if (!mergeResult.success) {
    showError(`Section created but merge failed: ${mergeResult.error}`);
    // Section was created but merge failed - still mark as placed
    return true;
  }

  return true;
}
```

### 4. Manual Placement

```tsx
async function placeManually(
  sectionConfig: SectionConfig,
  position: { x: number; y: number },
  alignStation: 'first' | 'last'
): Promise<boolean> {
  // Calculate offset based on align station
  const stationPositions = calculateStationPositions(sectionConfig.shots);
  const alignIndex = alignStation === 'first' ? 0 : stationPositions.length - 1;
  const alignPos = stationPositions[alignIndex];

  const offset = {
    x: position.x - alignPos.x,
    y: position.y - alignPos.y,
  };

  // Create section
  const result = await createSection(sectionData);
  if (!result.success) {
    showError(result.error);
    return false;
  }

  // Apply section offset
  const sectionId = result.sectionId;
  const offsetResult = await setSectionOffset(sectionId, offset);
  if (!offsetResult.success) {
    showError(`Section created but offset failed: ${offsetResult.error}`);
    return true;
  }

  return true;
}
```

### 5. Error Handling

When placement fails:
- Show error toast with message
- Stay in dialog (don't mark as placed)
- User can retry or change placement method

When partial failure (section created but subsequent operation failed):
- Show warning toast
- Mark section as placed (it exists in backend)
- User can edit placement later via Edit Section

### 6. Immediate Persistence

After placement, section exists in backend:
- Subsequent edits call `updateSection`, `updateShot`, `createShot`, `deleteShot`
- Each call happens immediately (not batched)
- Changes persist even if dialog is cancelled

## Acceptance Criteria

- [ ] Place at 0,0 creates section at origin
- [ ] Zero Datum creates section and sets coordinates
- [ ] From Existing creates section and merges stations
- [ ] Manual placement creates section with offset
- [ ] Error toast shown on failure
- [ ] Partial failures handled gracefully
- [ ] Subsequent edits persist immediately
- [ ] TypeScript compiles without errors

## Existing Tests to Modify

The following existing test files must be updated to account for changes made in this task:

### Playwright Tests
- `e2e-playwright/import-dialog.spec.ts` - Section creation tests need updating for immediate placement behavior
- `e2e-playwright/dmp-import.spec.ts` - Import flow tests need updating for section creation on placement

### WebdriverIO Tests
- `e2e/specs/import-dmp-dialog.spec.ts` - Section creation and persistence tests need updating

### Mock Updates
- `e2e-playwright/mocks/tauri-ipc.ts` - Ensure mock handlers for `createSection`, `setZeroDatum`, `mergeStations`, `setSectionOffset` return correct section IDs and handle errors

## Test Suggestions

### Unit Tests (Rust)
1. Test createSection command
2. Test setZeroDatum command
3. Test mergeStations command
4. Test setSectionOffset command
5. Test undo for each command type

### Playwright Tests (3-10)
1. Test Place at 0,0 creates section (mock IPC)
2. Test Zero Datum sends correct coordinates
3. Test From Existing sends merge command
4. Test error toast on failure
5. Test section marked as placed after success
6. Test edits after placement call updateShot

### WebdriverIO Tests (3-10)
1. Test full Place at 0,0 flow
2. Test Zero Datum with GPS coordinates
3. Test From Existing merge with existing section
4. Test Manual placement with map click
5. Test editing placed section persists

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
