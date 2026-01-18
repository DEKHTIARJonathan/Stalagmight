# Task 16: Implement Session Surveyor Memory

## Description

Remember the last used surveyor name during the session (not persisted to config). Pre-fill the default surveyor field in Step 1 with the last used value.

## Files to Modify

- `src/store/uiStore.ts`
- `src/components/Dialogs/DmpSelectionDialog.tsx`

## Implementation

### 1. Add to UI Store

```tsx
// In uiStore.ts
interface UIState {
  // ... existing fields
  lastUsedSurveyor: string;
}

// Initial state
lastUsedSurveyor: '',

// Action
setLastUsedSurveyor: (surveyor: string) => set({ lastUsedSurveyor: surveyor }),
```

### 2. Pre-fill in Step 1 Dialog

```tsx
// In DmpSelectionDialog.tsx
const { lastUsedSurveyor, setLastUsedSurveyor } = useUIStore();

// Initialize default surveyor with last used value
const [defaultSurveyor, setDefaultSurveyor] = useState(lastUsedSurveyor);

// Update store when surveyor changes
const handleSurveyorChange = (value: string) => {
  setDefaultSurveyor(value);
  // Update store for next import
  setLastUsedSurveyor(value);
};
```

### 3. Clear on Session End

Session memory is automatically cleared when app restarts since it's in-memory state only.

### 4. Apply to All Sections

When "Continue to Section Setup" is clicked:
- Default surveyor value is passed to Step 2
- Step 2 pre-fills surveyor field for all sections

## Acceptance Criteria

- [ ] lastUsedSurveyor added to uiStore
- [ ] Default surveyor field pre-filled with last used value
- [ ] Changing surveyor updates the store
- [ ] Next import shows previously used surveyor
- [ ] Value cleared on app restart (session only)
- [ ] TypeScript compiles without errors

## Test Suggestions

### Unit Tests (Rust)
N/A - Frontend-only task.

### Playwright Tests (3-10)
1. Test default surveyor field empty on first import
2. Test entering surveyor saves to store
3. Test second import shows previous surveyor
4. Test clearing surveyor field clears store value

### WebdriverIO Tests (3-10)
1. Test surveyor remembered across multiple imports
2. Test surveyor not remembered after app restart
3. Test surveyor applied to all sections in Step 2

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
