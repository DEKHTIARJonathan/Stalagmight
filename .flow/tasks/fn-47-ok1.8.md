## Description

Align the map context menu with DataTable: restrict shot insertion to first/last only, add station-based add options, add prepend mode to DrawShotDialog, and add position-aware Delete Shot (matching DataTable split behavior).

## Changes from Current Behavior

### Current (map context menu):
- **Shot context menu**: "Insert Shot After" on ANY shot → opens DrawShotDialog
- **Station context menu**: No add-shot option
- **Delete Shot**: Always opens simple confirm dialog (no split awareness)

### New behavior:
- **Shot context menu**: "Add Shot Before" on FIRST shot only, "Add Shot After" on LAST shot only → opens DrawShotDialog. Remove "Insert Shot After" from middle shots.
- **Station context menu**: "Add Shot Before" on station 0 (first), "Add Shot After" on last station → opens DrawShotDialog.
- **Delete Shot**: Position-aware (edge = simple confirm, mid = split dialog, last = remove section confirm). Matches DataTable.

## Files to Modify
- `src/components/common/ContextMenu.tsx` — Update `target.type === 'shot'` and `target.type === 'station'` branches
- `src/components/Dialogs/DrawShotDialog.tsx` — Add prepend mode (reversed azimuth) + allow length=0 + prefill geometry defaults

## Implementation Details

### ContextMenu.tsx — Shot branch
Replace current "Insert Shot After" with position-aware options. Compute `isFirst`, `isLast`, `totalShots` from the section's shot list. Show "Add Shot Before" only on first shot, "Add Shot After" only on last shot. Add position-aware Delete Shot (same 3-way logic as `datatable-shot` in Task 6).

**IMPORTANT**: Both "Add Shot Before" and "Add Shot After" actions must pass `allowZeroLength: true` in the dialog data, so DrawShotDialog doesn't block length=0:
```typescript
openDialog('draw-shot', {
    fromStation: { ... },
    prependMode: true,  // or false for append
    allowZeroLength: true,
});
```

### ContextMenu.tsx — Station branch
Add "Add Shot Before" for station 0 and "Add Shot After" for last station. Both pass `allowZeroLength: true`.

### DrawShotDialog.tsx — Prepend mode

Add `prependMode` support from `dialogData`.

**Azimuth reversal — single reversal on submit only**:
When `prependMode` is true:
1. The `fromStation` field is read-only (locked to station 0)
2. Default azimuth values are copied as-is from the first shot (the user sees the neighbor's azimuth in the form for reference)
3. On submit ONLY, reverse the azimuth (add 180° and normalize to 0-360):
   ```typescript
   const normalizeAngle = (a: number) => ((a % 360) + 360) % 360;
   const finalShot = {
       ...shotData,
       azimuth_in: prependMode ? normalizeAngle(shotData.azimuth_in + 180) : shotData.azimuth_in,
       azimuth_out: prependMode ? normalizeAngle(shotData.azimuth_out + 180) : shotData.azimuth_out,
   };
   ```
4. Use `createShot(sectionId, finalShot, undefined, firstShotId)` — pass `beforeShotId` to prepend
5. Dialog title: "Add Shot Before Section" (vs "Add Shot After Station X")

**There is exactly ONE reversal**: on submit. No pre-reversal in defaults, no double reversal.

### DrawShotDialog.tsx — Allow length=0 for add-row mode
Currently `validateForm()` at line ~63 blocks `length <= 0`. When `dialogData.allowZeroLength` is true, allow length >= 0:
```typescript
if (dialogData.allowZeroLength) {
    if (length === '' || isNaN(parseFloat(length)) || parseFloat(length) < 0) {
        setError('Length must be 0 or greater');
        return false;
    }
} else {
    if (!length || parseFloat(length) <= 0) {
        setError('Length must be greater than 0');
        return false;
    }
}
```

### DrawShotDialog.tsx — Default geometry from neighbor shot
Copy geometry from the neighbor shot for add-row defaults:
- **Prepend** (before first shot): copy from first shot — `azimuth_in`, `azimuth_out` (as-is, reversed only on submit), `pitch_in`, `pitch_out`, `depth_in`, `depth_out`. Length = 0.
- **Append** (after last shot): copy from last shot — `azimuth_in`, `azimuth_out`, `pitch_in`, `pitch_out`, `depth_in`, `depth_out`. Length = 0.
- Both modes: `temperature = null`, `marker_index = null`.

### Post-add selection
After successful `createShot`, use the `shot_id` from `CommandResult` (added in Task 1) to select the new shot:
```typescript
if (result.success && result.shot_id !== undefined) {
    uiStore.setSelection({ type: 'shot', sectionId, shotId: result.shot_id });
}
```

## Tests
- Playwright: Map right-click first shot → "Add Shot Before" visible, not "Insert Shot After"
- Playwright: Map right-click middle shot → no add options
- Playwright: Map right-click last shot → "Add Shot After" visible
- Playwright: Map right-click station 0 → "Add Shot Before" visible
- Playwright: Map right-click last station → "Add Shot After" visible
- Playwright: Map right-click middle station → no add options
- Playwright: Delete mid-shot from map context menu → split dialog opens
- Playwright: Add shot with length=0 succeeds
- Playwright: Prepend mode reverses azimuth exactly once on submit

## Acceptance
- [ ] Map shot context menu: "Add Shot Before" on first shot only, "Add Shot After" on last shot only
- [ ] Map station context menu: "Add Shot Before" on station 0, "Add Shot After" on last station
- [ ] "Insert Shot After" removed from middle shots/stations
- [ ] DrawShotDialog prepend mode: azimuth copied as-is for defaults, reversed ONCE on submit only
- [ ] DrawShotDialog allows length=0 when `allowZeroLength` is true (both add-before and add-after)
- [ ] Default geometry prefilled from neighbor shot: azimuth, pitch, depth (not temperature/marker_index)
- [ ] New shot selected after add (via `result.shot_id` + `uiStore.setSelection`)
- [ ] Map Delete Shot uses position-aware logic (split dialog for mid-section)
- [ ] `pnpm tsc --noEmit` passes

## Done summary
Aligned map context menu with DataTable: restricted shot add to first/last only, added station-based add options, implemented prepend mode in DrawShotDialog with azimuth reversal, position-aware Delete Shot (edge=simple confirm, mid=split dialog with name inputs, last=remove section), and prefilled length=0 for add-row mode.
## Evidence
- Commits: 100ac370f1f2c477a5a79ba139cd65c86fd352e2, 33648c8, 327aec5, 18014d5, 914d491, 2551e82
- Tests: pnpm tsc --noEmit, pnpm test:ui (592 passed), cargo test --manifest-path src-tauri/Cargo.toml (80 passed)
- PRs: