# Task 33: Closure Strategy Selector

## Overview
Add UI for choosing how to handle loop closure: "Keep raw data" (show gap) vs "Mark for distribution" (placeholder for v2). Show gap line when keeping raw data.

## Priority
High - Phase A (Loop Closure)

## Risk Level
High

## Dependencies
- Task 31: Loop detection
- Task 32: Closure error calculation

## Files to Modify
- `src/components/Dialogs/MergeDialog.tsx` - Add strategy selector
- `src/components/Map/SurveyLayer.tsx` - Render gap line
- `src-tauri/src/models/project.rs` - Store strategy choice

## Specifications

### Strategy Options
```typescript
type ClosureStrategy = 'keep_raw' | 'mark_for_distribution';
```

### Merge Dialog UI
- Radio buttons when loop detected:
  - "Keep raw data (show gap)" - default
  - "Mark for distribution (v2)"
- Strategy stored with loop closure record
- Cannot change after merge (requires unmerge + re-merge)

### Gap Line Rendering
- When strategy = 'keep_raw':
  - Show dashed line between merged stations
  - Always visible (not hover-only)
  - Color: warning color (yellow/orange)
  - Label: "Gap: 0.45m"

### Map Layer
```typescript
// Add to SurveyLayer.tsx
{loopClosures
  .filter(lc => lc.strategy === 'keep_raw')
  .map(lc => (
    <GapLine
      key={lc.id}
      stationA={lc.stationA}
      stationB={lc.stationB}
      distance={lc.misclosure_distance}
    />
  ))}
```

### LRUD Handling
- LRUD data left unchanged during any future distribution

## Acceptance Criteria
- [ ] Strategy selector visible when loop detected
- [ ] Strategy stored with loop closure
- [ ] Gap line renders for 'keep_raw' strategy
- [ ] Gap line always visible
- [ ] Cannot change strategy after merge
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test strategy storage in loop_closures table
2. Test strategy retrieval after save/load
3. Test strategy cannot be modified without unmerge
4. Test 'keep_raw' strategy stored correctly
5. Test 'mark_for_distribution' strategy stored correctly

### Playwright Tests (Mocked IPC)
1. Test strategy radio buttons appear when loop detected
2. Test 'keep_raw' is default selection
3. Test gap line renders on map for 'keep_raw' strategy
4. Test gap line shows correct distance label
5. Test gap line uses warning color (yellow/orange)
6. Test gap line is dashed style

### WebdriverIO Tests (Full App)
1. Test strategy persists through app restart
2. Test gap line renders with real merge data
3. Test changing strategy requires unmerge + re-merge workflow
4. Test multiple gap lines from multiple loops

## Edge Cases
- Very small gaps (< 1cm)
- Very large gaps (> 10m)
- Multiple gaps from multiple loops
