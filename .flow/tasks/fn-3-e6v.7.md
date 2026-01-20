# fn-3-e6v.7 Show snapped/origin stations during Draw/Merge/Measure

## Description
Show snapped/origin stations during Draw/Merge/Measure operations.

## Files to Modify
- `src/components/Map/SurveyLayer.tsx` (visual state updates)
- `src/hooks/useMapTools.ts` or tool handlers

## Implementation Details

### Snap Indicator Exception
When stations are hidden but user is using Draw/Merge/Measure tools:
- If cursor snaps to a station position, show the FULL station marker temporarily
- Not just the snap ring - the actual station circle becomes visible
- Use the snapped visual state (cyan #00ffcc, 7px radius, 4px stroke)

### Draw Tool Origin
When starting a Draw operation from an existing station:
- The origin station becomes visible for the duration of the draw
- Returns to hidden when draw completes or is canceled

### Implementation Approach
Modify the visual state update logic in `SurveyLayer.updateVisualState()`:
- Check if station is in snap/draw-origin state
- If so, override the hidden visibility for that specific station
- Use filter expressions to show specific stations while hiding others

Alternative approach:
- Maintain a "temporarily visible stations" set
- Union with snap/origin state
- Apply as exception to visibility rule

## Depends On
- Task 3: Base visibility must work first
## Acceptance
- [ ] Snapped station shows full marker during Draw/Merge/Measure (not just snap ring)
- [ ] Origin station in Draw mode is visible during the operation
- [ ] Temporary visibility uses correct visual state (snapped style)
- [ ] Station returns to hidden when operation completes
- [ ] Station returns to hidden when operation is canceled
- [ ] Only the specific snapped/origin station is shown, not all stations
- [ ] Works correctly when multiple stations are involved (e.g., merge with 2 stations)
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
