# fn-3-e6v.8 Add unit tests for display toggle state logic

## Description
Add unit tests for display toggle state logic.

## Files to Create/Modify
- Create test file (e.g., `src/store/__tests__/uiStore.test.ts` or similar)

## Test Cases

### Toggle State Tests
1. `showStations` defaults to `true`
2. `showShots` defaults to `true`
3. Toggle state persists (mock persistence layer)
4. Toggle functions correctly update state

### Toggle Relationship Tests
1. When `showShots` is false, `showVirtualShots` effective value is false
2. When `showShots` is false, `showShotData` effective value is false
3. `showVirtualShots` state is preserved when `showShots` toggles off/on
4. `showShotData` state is preserved when `showShots` toggles off/on

### Selection Clearing Tests
1. Stations selection cleared when `showStations` toggled off
2. Shots selection cleared when `showShots` toggled off
3. Mixed selection only clears the type being hidden

### Toast Throttling Tests
1. First interaction shows toast immediately
2. Rapid interactions are throttled (mock timers)
3. Throttle resets after 5 seconds
4. Separate throttle for stations vs shots

## Depends On
- Task 5, 6: Behavior must be implemented to test
## Acceptance
- [ ] Unit tests exist for toggle default values
- [ ] Unit tests exist for toggle state updates
- [ ] Unit tests exist for toggle relationship logic (Virtual Shots disabled when Shots hidden)
- [ ] Unit tests exist for selection clearing on toggle
- [ ] Unit tests exist for toast throttling logic
- [ ] All unit tests pass
- [ ] Test coverage for new code is adequate
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
