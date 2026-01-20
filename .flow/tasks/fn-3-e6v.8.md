# fn-3-e6v.8 Add unit tests for display toggle state logic

## Description
Add unit tests for display toggle state logic.

## Files to Create

### `src/store/__tests__/uiStore.displayToggles.test.ts`

Test the Zustand store logic for display toggles.

## Test Cases

### Toggle State Tests
```typescript
describe('Display Toggle State', () => {
  it('showStations defaults to true', () => {
    const state = useUIStore.getState();
    expect(state.showStations).toBe(true);
  });

  it('showShots defaults to true', () => {
    const state = useUIStore.getState();
    expect(state.showShots).toBe(true);
  });

  it('toggleDisplay toggles showStations', () => {
    const { toggleDisplay } = useUIStore.getState();
    toggleDisplay('showStations');
    expect(useUIStore.getState().showStations).toBe(false);
    toggleDisplay('showStations');
    expect(useUIStore.getState().showStations).toBe(true);
  });
});
```

### Toggle Relationship Tests
```typescript
describe('Toggle Relationships', () => {
  it('showVirtualShots effective value is false when showShots is false', () => {
    // Test the computed/effective value logic
  });

  it('showShotData effective value is false when showShots is false', () => {
    // Similar test
  });

  it('dependent toggle states preserved when parent toggles off/on', () => {
    // Toggle showVirtualShots to false
    // Toggle showShots to false (disables virtual shots)
    // Toggle showShots to true
    // showVirtualShots should still be false (preserved)
  });
});
```

### Toast Throttling Tests
```typescript
describe('Toast Throttling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  it('first toast shows immediately', () => {
    const { showToast } = useUIStore.getState();
    showToast('Test message');
    expect(useUIStore.getState().toast?.message).toBe('Test message');
  });

  it('rapid toasts are throttled', () => {
    const { showToast } = useUIStore.getState();
    showToast('First');
    showToast('Second'); // Should be ignored
    expect(useUIStore.getState().toast?.message).toBe('First');
  });

  it('toast shows after 5 second cooldown', () => {
    const { showToast } = useUIStore.getState();
    showToast('First');
    jest.advanceTimersByTime(5001);
    showToast('Second');
    expect(useUIStore.getState().toast?.message).toBe('Second');
  });

  it('toast auto-clears after 3 seconds', () => {
    const { showToast } = useUIStore.getState();
    showToast('Test');
    expect(useUIStore.getState().toast).not.toBeNull();
    jest.advanceTimersByTime(3001);
    expect(useUIStore.getState().toast).toBeNull();
  });
});
```

## Notes

- Use `jest.useFakeTimers()` for toast timing tests
- Reset store state between tests with `useUIStore.setState(initialState)`
- May need to mock persistence layer
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
- [ ] Test file exists at `src/store/__tests__/uiStore.displayToggles.test.ts`
- [ ] Tests for `showStations` default value
- [ ] Tests for `showShots` default value
- [ ] Tests for `toggleDisplay` action
- [ ] Tests for dependent toggle relationships (Virtual Shots, Shot Data)
- [ ] Tests for toast throttle logic (5 second cooldown)
- [ ] Tests for toast auto-clear (3 seconds)
- [ ] Tests for selection clearing on toggle (if logic is in store)
- [ ] All unit tests pass: `pnpm test` or equivalent
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
