# Task 11: Implement Import State Management with Undo/Redo

## Description

Implement the state management for the import flow including per-section state tracking, undo/redo within the dialog, and granular backend undo entries.

## Files to Create

- `src/hooks/useImportState.ts`

## Files to Modify

- `src/components/Dialogs/DmpSectionConfigDialog.tsx`
- `src/store/projectStore.ts` (if needed for granular undo)

## Implementation

### 1. Import State Hook

```tsx
interface ImportState {
  // Per-section configuration
  sectionConfigs: Map<number, SectionConfig>;
  // Current editing state
  currentSection: number;
  // Placed sections (created in backend)
  placedSections: Set<number>;
  // Undo/redo stacks (per section)
  undoStacks: Map<number, UndoEntry[]>;
  redoStacks: Map<number, UndoEntry[]>;
}

interface SectionConfig {
  name: string;
  surveyor: string | null;
  date: string | null;
  color: string;
  direction: 'in' | 'out';
  shots: EditableShot[];
  placement: PlacementConfig | null;
  originalShots: EditableShot[]; // For reset
}

interface UndoEntry {
  type: 'shotEdit' | 'shotAdd' | 'shotDelete' | 'metadataEdit' | 'placementChange';
  previousState: Partial<SectionConfig>;
  description: string;
}

function useImportState(dmpFile: DmpFile, selectionConfig: DmpSelectionConfig) {
  // Initialize state from DMP and selection
  const [state, dispatch] = useReducer(importReducer, initialState);

  // Actions
  const updateSectionField = (field: keyof SectionConfig, value: any) => {
    dispatch({ type: 'UPDATE_FIELD', field, value });
  };

  const updateShot = (shotIndex: number, field: keyof EditableShot, value: any) => {
    dispatch({ type: 'UPDATE_SHOT', shotIndex, field, value });
  };

  const addShot = (afterIndex?: number) => {
    dispatch({ type: 'ADD_SHOT', afterIndex });
  };

  const deleteShot = (index: number) => {
    dispatch({ type: 'DELETE_SHOT', index });
  };

  const setPlacement = (placement: PlacementConfig) => {
    dispatch({ type: 'SET_PLACEMENT', placement });
  };

  const undo = () => {
    dispatch({ type: 'UNDO' });
  };

  const redo = () => {
    dispatch({ type: 'REDO' });
  };

  const resetSection = () => {
    dispatch({ type: 'RESET_SECTION' });
  };

  const navigateToSection = (index: number) => {
    dispatch({ type: 'NAVIGATE', index });
  };

  return {
    state,
    updateSectionField,
    updateShot,
    addShot,
    deleteShot,
    setPlacement,
    undo,
    redo,
    resetSection,
    navigateToSection,
    canUndo: state.undoStacks.get(state.currentSection)?.length > 0,
    canRedo: state.redoStacks.get(state.currentSection)?.length > 0,
  };
}
```

### 2. Undo/Redo Behavior

Each edit creates an undo entry:
- `shotEdit`: stores previous shot values
- `shotAdd`: stores added shot for removal
- `shotDelete`: stores deleted shot for restoration
- `metadataEdit`: stores previous metadata values
- `placementChange`: stores previous placement config

Undo restores previous state for current section.
Redo re-applies the change.

### 3. Backend Granular Undo

When section is placed (created in backend):
- Each subsequent edit creates a separate backend undo entry
- `updateShot` call creates one entry
- `createShot` call creates one entry
- `deleteShot` call creates one entry
- User can undo individual changes even after placement

### 4. Reset Section

Reset restores:
- Shots to original DMP values
- Metadata to original DMP values
- Clears placement
- If section was placed, delete from backend

### 5. Navigation Auto-Save

When navigating to another section:
- Current section state auto-saved to sectionConfigs
- Undo/redo stacks preserved per section
- New section loaded (or initialized from DMP if first visit)

## Acceptance Criteria

- [ ] useImportState hook created with all actions
- [ ] Per-section state tracking works
- [ ] Undo reverses last edit for current section
- [ ] Redo re-applies undone change
- [ ] Undo/redo stacks preserved when navigating
- [ ] Backend creates granular undo entries after placement
- [ ] Reset Section restores original DMP data
- [ ] Reset Section deletes placed section from backend
- [ ] TypeScript compiles without errors

## Test Suggestions

### Unit Tests (Rust)
1. Test createSection creates undo entry
2. Test updateShot creates undo entry
3. Test deleteShot creates undo entry
4. Test undo reverses createSection

### Playwright Tests (3-10)
1. Test Ctrl+Z undoes shot edit
2. Test Ctrl+Shift+Z redoes shot edit
3. Test undo disabled when no history
4. Test redo disabled when no redo history
5. Test undo after adding shot removes it
6. Test undo after deleting shot restores it
7. Test navigating preserves undo stack
8. Test Reset Section restores original shots
9. Test Reset Section clears placement

### WebdriverIO Tests (3-10)
1. Test undo/redo with full app
2. Test backend undo after placement
3. Test Reset Section with placed section
4. Test multiple edits and undo chain

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
