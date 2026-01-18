import { useReducer, useCallback, useMemo } from 'react';
import type { DmpFile, DmpShot } from '../types/commands';
import type { GpsCoordinates, StationRef, Coordinates } from '../types/project';
import type { EditableShot } from '../components/common/ShotTableEditor';

/**
 * Configuration from Step 1 (DmpSelectionDialog).
 */
export interface DmpSelectionConfig {
  selectedIndices: Set<number>;
  sectionDirections: Map<number, 'in' | 'out'>;
  defaultSurveyor: string | null;
  defaultDate: string | null;
}

/**
 * Placement configuration for a section.
 */
export type PlacementConfig =
  | { type: 'origin' }
  | { type: 'zeroDatum'; coordinates: GpsCoordinates; stationIndex: number }
  | { type: 'fromExisting'; importStation: number; existingStation: StationRef }
  | { type: 'manual'; alignStation: 'first' | 'last'; position?: Coordinates; snappedToStation?: StationRef | null };

/**
 * Configuration for a single imported section.
 */
export interface SectionConfig {
  sectionIndex: number;
  name: string;
  surveyor: string | null;
  date: string | null;
  color: string;
  direction: 'in' | 'out';
  shots: EditableShot[];
  placement: PlacementConfig;
}

/**
 * Entry types for undo/redo operations.
 */
export type UndoEntryType =
  | 'shotEdit'
  | 'shotAdd'
  | 'shotDelete'
  | 'metadataEdit'
  | 'placementChange';

/**
 * Undo entry storing previous state for reversal.
 */
export interface UndoEntry {
  type: UndoEntryType;
  previousState: Partial<SectionConfig>;
  description: string;
}

/**
 * Complete import state.
 */
export interface ImportState {
  /** Per-section configuration */
  sectionConfigs: Map<number, SectionConfig>;
  /** Current section index (within the Map keys) */
  currentSectionIndex: number;
  /** Placed sections (user has explicitly set placement) */
  placedSections: Set<number>;
  /** Undo stacks per section */
  undoStacks: Map<number, UndoEntry[]>;
  /** Redo stacks per section */
  redoStacks: Map<number, UndoEntry[]>;
  /** Original section values for reset functionality */
  originalValues: Map<number, SectionConfig>;
}

/**
 * Action types for the import state reducer.
 */
type ImportAction =
  | { type: 'NAVIGATE'; sectionIndex: number }
  | { type: 'UPDATE_FIELD'; field: keyof SectionConfig; value: SectionConfig[keyof SectionConfig] }
  | { type: 'UPDATE_SHOT'; shotIndex: number; field: keyof EditableShot; value: EditableShot[keyof EditableShot] }
  | { type: 'ADD_SHOT' }
  | { type: 'DELETE_SHOT'; index: number }
  | { type: 'INSERT_SHOT_BEFORE'; index: number }
  | { type: 'INSERT_SHOT_AFTER'; index: number }
  | { type: 'SET_PLACEMENT'; placement: PlacementConfig }
  | { type: 'MARK_PLACED'; sectionIndex: number }
  | { type: 'UNMARK_PLACED'; sectionIndex: number }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'RESET_SECTION' }
  | { type: 'RESTORE_STATE'; sectionConfigs: Map<number, SectionConfig>; placedSections: Set<number>; currentSectionIndex: number };

/**
 * Default section colors for import.
 */
const SECTION_COLORS = [
  '#4ecdc4',
  '#ff6b6b',
  '#95a5a6',
  '#3498db',
  '#9b59b6',
  '#1abc9c',
  '#e67e22',
  '#f39c12',
];

const MAX_UNDO_HISTORY = 50;

/**
 * Convert DMP shots to EditableShots.
 */
function convertToEditableShots(shots: DmpShot[]): EditableShot[] {
  return shots
    .filter((shot) => shot.shot_type === 'Standard')
    .map((shot, index) => ({
      id: index,
      azimuth_in: shot.heading_in,
      azimuth_out: shot.heading_out,
      length: shot.length,
      depth_in: shot.depth_in,
      depth_out: shot.depth_out,
      pitch_in: shot.pitch_in,
      pitch_out: shot.pitch_out,
      left: shot.left || null,
      right: shot.right || null,
      up: shot.up || null,
      down: shot.down || null,
      comment: shot.comment || null,
      is_virtual: false,
    }));
}

/**
 * Deep copy a shots array.
 */
function deepCopyShots(shots: EditableShot[]): EditableShot[] {
  return shots.map((s) => ({ ...s }));
}

/**
 * Create a new blank shot.
 */
function createBlankShot(tempId: number): EditableShot {
  return {
    id: -tempId,
    azimuth_in: 0,
    azimuth_out: 180,
    length: 1,
    depth_in: 0,
    depth_out: 0,
    pitch_in: null,
    pitch_out: null,
    left: null,
    right: null,
    up: null,
    down: null,
    comment: null,
    is_virtual: false,
    isNew: true,
    tempId,
  };
}

/**
 * Save current section state to undo stack.
 */
function pushToUndoStack(
  state: ImportState,
  entryType: UndoEntryType,
  description: string,
  previousPartialState: Partial<SectionConfig>
): ImportState {
  const currentConfig = state.sectionConfigs.get(state.currentSectionIndex);
  if (!currentConfig) return state;

  const entry: UndoEntry = {
    type: entryType,
    previousState: previousPartialState,
    description,
  };

  const undoStack = state.undoStacks.get(state.currentSectionIndex) || [];
  const newUndoStack = [...undoStack, entry];

  // Limit undo stack size
  if (newUndoStack.length > MAX_UNDO_HISTORY) {
    newUndoStack.shift();
  }

  // Clear redo stack when new action is taken
  const newUndoStacks = new Map(state.undoStacks);
  newUndoStacks.set(state.currentSectionIndex, newUndoStack);

  const newRedoStacks = new Map(state.redoStacks);
  newRedoStacks.set(state.currentSectionIndex, []);

  return {
    ...state,
    undoStacks: newUndoStacks,
    redoStacks: newRedoStacks,
  };
}

/**
 * Import state reducer.
 */
function importReducer(state: ImportState, action: ImportAction): ImportState {
  const currentConfig = state.sectionConfigs.get(state.currentSectionIndex);

  switch (action.type) {
    case 'NAVIGATE': {
      return {
        ...state,
        currentSectionIndex: action.sectionIndex,
      };
    }

    case 'UPDATE_FIELD': {
      if (!currentConfig) return state;

      // Save to undo stack
      const previousPartial: Partial<SectionConfig> = {
        [action.field]: currentConfig[action.field],
      };
      let stateWithUndo = pushToUndoStack(state, 'metadataEdit', `Edit ${String(action.field)}`, previousPartial);

      // Update the config
      const newConfigs = new Map(stateWithUndo.sectionConfigs);
      newConfigs.set(state.currentSectionIndex, {
        ...currentConfig,
        [action.field]: action.value,
      });

      return {
        ...stateWithUndo,
        sectionConfigs: newConfigs,
      };
    }

    case 'UPDATE_SHOT': {
      if (!currentConfig) return state;

      const shot = currentConfig.shots[action.shotIndex];
      if (!shot) return state;

      // Save to undo stack (only store the changed shot's previous state)
      const previousPartial: Partial<SectionConfig> = {
        shots: deepCopyShots(currentConfig.shots),
      };
      let stateWithUndo = pushToUndoStack(state, 'shotEdit', `Edit shot ${action.shotIndex} ${String(action.field)}`, previousPartial);

      // Update the shot
      const newShots = [...currentConfig.shots];
      newShots[action.shotIndex] = {
        ...shot,
        [action.field]: action.value,
      };

      const newConfigs = new Map(stateWithUndo.sectionConfigs);
      newConfigs.set(state.currentSectionIndex, {
        ...currentConfig,
        shots: newShots,
      });

      return {
        ...stateWithUndo,
        sectionConfigs: newConfigs,
      };
    }

    case 'ADD_SHOT': {
      if (!currentConfig) return state;

      // Save to undo stack
      const previousPartial: Partial<SectionConfig> = {
        shots: deepCopyShots(currentConfig.shots),
      };
      let stateWithUndo = pushToUndoStack(state, 'shotAdd', 'Add shot', previousPartial);

      // Add new shot
      const newShot = createBlankShot(Date.now());
      const newShots = [...currentConfig.shots, newShot];

      const newConfigs = new Map(stateWithUndo.sectionConfigs);
      newConfigs.set(state.currentSectionIndex, {
        ...currentConfig,
        shots: newShots,
      });

      return {
        ...stateWithUndo,
        sectionConfigs: newConfigs,
      };
    }

    case 'DELETE_SHOT': {
      if (!currentConfig) return state;

      const shot = currentConfig.shots[action.index];
      if (!shot) return state;

      // Save to undo stack
      const previousPartial: Partial<SectionConfig> = {
        shots: deepCopyShots(currentConfig.shots),
      };
      let stateWithUndo = pushToUndoStack(state, 'shotDelete', `Delete shot ${action.index}`, previousPartial);

      // Mark shot as deleted
      const newShots = [...currentConfig.shots];
      newShots[action.index] = { ...shot, isDeleted: true };

      const newConfigs = new Map(stateWithUndo.sectionConfigs);
      newConfigs.set(state.currentSectionIndex, {
        ...currentConfig,
        shots: newShots,
      });

      return {
        ...stateWithUndo,
        sectionConfigs: newConfigs,
      };
    }

    case 'INSERT_SHOT_BEFORE': {
      if (!currentConfig) return state;

      // Save to undo stack
      const previousPartial: Partial<SectionConfig> = {
        shots: deepCopyShots(currentConfig.shots),
      };
      let stateWithUndo = pushToUndoStack(state, 'shotAdd', `Insert shot before ${action.index}`, previousPartial);

      // Insert new shot
      const newShot = createBlankShot(Date.now());
      const newShots = [...currentConfig.shots];
      newShots.splice(action.index, 0, newShot);

      const newConfigs = new Map(stateWithUndo.sectionConfigs);
      newConfigs.set(state.currentSectionIndex, {
        ...currentConfig,
        shots: newShots,
      });

      return {
        ...stateWithUndo,
        sectionConfigs: newConfigs,
      };
    }

    case 'INSERT_SHOT_AFTER': {
      if (!currentConfig) return state;

      // Save to undo stack
      const previousPartial: Partial<SectionConfig> = {
        shots: deepCopyShots(currentConfig.shots),
      };
      let stateWithUndo = pushToUndoStack(state, 'shotAdd', `Insert shot after ${action.index}`, previousPartial);

      // Insert new shot
      const newShot = createBlankShot(Date.now());
      const newShots = [...currentConfig.shots];
      newShots.splice(action.index + 1, 0, newShot);

      const newConfigs = new Map(stateWithUndo.sectionConfigs);
      newConfigs.set(state.currentSectionIndex, {
        ...currentConfig,
        shots: newShots,
      });

      return {
        ...stateWithUndo,
        sectionConfigs: newConfigs,
      };
    }

    case 'SET_PLACEMENT': {
      if (!currentConfig) return state;

      // Save to undo stack
      const previousPartial: Partial<SectionConfig> = {
        placement: currentConfig.placement,
      };
      let stateWithUndo = pushToUndoStack(state, 'placementChange', 'Change placement', previousPartial);

      // Update placement
      const newConfigs = new Map(stateWithUndo.sectionConfigs);
      newConfigs.set(state.currentSectionIndex, {
        ...currentConfig,
        placement: action.placement,
      });

      // Also mark as placed
      const newPlaced = new Set(stateWithUndo.placedSections);
      newPlaced.add(state.currentSectionIndex);

      return {
        ...stateWithUndo,
        sectionConfigs: newConfigs,
        placedSections: newPlaced,
      };
    }

    case 'MARK_PLACED': {
      const newPlaced = new Set(state.placedSections);
      newPlaced.add(action.sectionIndex);
      return {
        ...state,
        placedSections: newPlaced,
      };
    }

    case 'UNMARK_PLACED': {
      const newPlaced = new Set(state.placedSections);
      newPlaced.delete(action.sectionIndex);
      return {
        ...state,
        placedSections: newPlaced,
      };
    }

    case 'UNDO': {
      const undoStack = state.undoStacks.get(state.currentSectionIndex) || [];
      if (undoStack.length === 0 || !currentConfig) return state;

      // Pop from undo stack
      const entry = undoStack[undoStack.length - 1];
      if (!entry) return state;

      const newUndoStack = undoStack.slice(0, -1);

      // Push current state to redo stack
      const redoStack = state.redoStacks.get(state.currentSectionIndex) || [];
      const redoEntry: UndoEntry = {
        type: entry.type,
        previousState: {},
        description: entry.description,
      };

      // Build redo state from current config
      for (const key of Object.keys(entry.previousState) as (keyof SectionConfig)[]) {
        if (key === 'shots') {
          redoEntry.previousState.shots = deepCopyShots(currentConfig.shots);
        } else {
          // Copy the current value for this field
          (redoEntry.previousState as Record<string, unknown>)[key] = currentConfig[key];
        }
      }

      const newRedoStack = [...redoStack, redoEntry];

      // Restore previous state
      const restoredConfig = { ...currentConfig };
      for (const [key, value] of Object.entries(entry.previousState)) {
        if (key === 'shots') {
          restoredConfig.shots = deepCopyShots(value as EditableShot[]);
        } else {
          (restoredConfig as Record<string, unknown>)[key] = value;
        }
      }

      const newConfigs = new Map(state.sectionConfigs);
      newConfigs.set(state.currentSectionIndex, restoredConfig);

      const newUndoStacks = new Map(state.undoStacks);
      newUndoStacks.set(state.currentSectionIndex, newUndoStack);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(state.currentSectionIndex, newRedoStack);

      return {
        ...state,
        sectionConfigs: newConfigs,
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
      };
    }

    case 'REDO': {
      const redoStack = state.redoStacks.get(state.currentSectionIndex) || [];
      if (redoStack.length === 0 || !currentConfig) return state;

      // Pop from redo stack
      const entry = redoStack[redoStack.length - 1];
      if (!entry) return state;

      const newRedoStack = redoStack.slice(0, -1);

      // Push current state to undo stack
      const undoStack = state.undoStacks.get(state.currentSectionIndex) || [];
      const undoEntry: UndoEntry = {
        type: entry.type,
        previousState: {},
        description: entry.description,
      };

      // Build undo state from current config
      for (const key of Object.keys(entry.previousState) as (keyof SectionConfig)[]) {
        if (key === 'shots') {
          undoEntry.previousState.shots = deepCopyShots(currentConfig.shots);
        } else {
          (undoEntry.previousState as Record<string, unknown>)[key] = currentConfig[key];
        }
      }

      const newUndoStack = [...undoStack, undoEntry];

      // Restore redo state
      const restoredConfig = { ...currentConfig };
      for (const [key, value] of Object.entries(entry.previousState)) {
        if (key === 'shots') {
          restoredConfig.shots = deepCopyShots(value as EditableShot[]);
        } else {
          (restoredConfig as Record<string, unknown>)[key] = value;
        }
      }

      const newConfigs = new Map(state.sectionConfigs);
      newConfigs.set(state.currentSectionIndex, restoredConfig);

      const newUndoStacks = new Map(state.undoStacks);
      newUndoStacks.set(state.currentSectionIndex, newUndoStack);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(state.currentSectionIndex, newRedoStack);

      return {
        ...state,
        sectionConfigs: newConfigs,
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
      };
    }

    case 'RESET_SECTION': {
      const original = state.originalValues.get(state.currentSectionIndex);
      if (!original) return state;

      // Reset to original values (deep copy)
      const resetConfig: SectionConfig = {
        ...original,
        shots: deepCopyShots(original.shots),
        placement: { type: 'origin' },
      };

      const newConfigs = new Map(state.sectionConfigs);
      newConfigs.set(state.currentSectionIndex, resetConfig);

      // Remove from placed sections
      const newPlaced = new Set(state.placedSections);
      newPlaced.delete(state.currentSectionIndex);

      // Clear undo/redo stacks for this section
      const newUndoStacks = new Map(state.undoStacks);
      newUndoStacks.set(state.currentSectionIndex, []);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(state.currentSectionIndex, []);

      return {
        ...state,
        sectionConfigs: newConfigs,
        placedSections: newPlaced,
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
      };
    }

    case 'RESTORE_STATE': {
      return {
        ...state,
        sectionConfigs: action.sectionConfigs,
        placedSections: action.placedSections,
        currentSectionIndex: action.currentSectionIndex,
      };
    }

    default:
      return state;
  }
}

/**
 * Initialize import state from DMP file and selection config.
 */
function initializeState(
  dmpFile: DmpFile,
  selectionConfig: DmpSelectionConfig,
  savedState?: {
    sectionConfigs: Array<[number, SectionConfig]>;
    placedSections: number[];
    currentSectionIndex: number;
  }
): ImportState {
  const selectedIndices = Array.from(selectionConfig.selectedIndices).sort((a, b) => a - b);
  const firstSectionIndex = selectedIndices[0];

  // Build original values (these never change)
  const originalValues = new Map<number, SectionConfig>();
  selectedIndices.forEach((sectionIdx, arrayIdx) => {
    const section = dmpFile.sections[sectionIdx];
    if (!section) return;

    const dateStr = section.date?.split(/[T ]/)[0] ?? null;

    originalValues.set(sectionIdx, {
      sectionIndex: sectionIdx,
      name: section.name,
      surveyor: section.name || null, // Original surveyor from DMP
      date: dateStr,
      color: SECTION_COLORS[arrayIdx % SECTION_COLORS.length] ?? '#4ecdc4',
      direction: section.direction,
      shots: convertToEditableShots(section.shots),
      placement: { type: 'origin' },
    });
  });

  // If restoring from saved state
  if (savedState) {
    return {
      sectionConfigs: new Map(savedState.sectionConfigs),
      currentSectionIndex: savedState.currentSectionIndex,
      placedSections: new Set(savedState.placedSections),
      undoStacks: new Map(),
      redoStacks: new Map(),
      originalValues,
    };
  }

  // Build initial section configs
  const sectionConfigs = new Map<number, SectionConfig>();
  selectedIndices.forEach((sectionIdx, arrayIdx) => {
    const section = dmpFile.sections[sectionIdx];
    if (!section) return;

    const direction = selectionConfig.sectionDirections.get(sectionIdx) ?? section.direction;
    const surveyor = selectionConfig.defaultSurveyor || section.name || null;
    const dateStr = selectionConfig.defaultDate ?? section.date?.split(/[T ]/)[0] ?? null;

    sectionConfigs.set(sectionIdx, {
      sectionIndex: sectionIdx,
      name: section.name,
      surveyor,
      date: dateStr,
      color: SECTION_COLORS[arrayIdx % SECTION_COLORS.length] ?? '#4ecdc4',
      direction,
      shots: convertToEditableShots(section.shots),
      placement: { type: 'origin' },
    });
  });

  // First section defaults to placed at origin
  const placedSections = new Set<number>();
  if (firstSectionIndex !== undefined) {
    placedSections.add(firstSectionIndex);
  }

  return {
    sectionConfigs,
    currentSectionIndex: firstSectionIndex ?? 0,
    placedSections,
    undoStacks: new Map(),
    redoStacks: new Map(),
    originalValues,
  };
}

/**
 * Hook for managing import state with undo/redo functionality.
 * Provides per-section state tracking, undo/redo stacks, and reset functionality.
 */
export function useImportState(
  dmpFile: DmpFile,
  selectionConfig: DmpSelectionConfig,
  savedState?: {
    sectionConfigs: Array<[number, SectionConfig]>;
    placedSections: number[];
    currentSectionIndex: number;
  }
) {
  const [state, dispatch] = useReducer(
    importReducer,
    { dmpFile, selectionConfig, savedState },
    ({ dmpFile, selectionConfig, savedState }) => initializeState(dmpFile, selectionConfig, savedState)
  );

  // Get selected indices in order
  const selectedIndices = useMemo(() => {
    return Array.from(selectionConfig.selectedIndices).sort((a, b) => a - b);
  }, [selectionConfig.selectedIndices]);

  // Current array index (position in selectedIndices)
  const currentArrayIndex = useMemo(() => {
    return selectedIndices.indexOf(state.currentSectionIndex);
  }, [selectedIndices, state.currentSectionIndex]);

  // Current config
  const currentConfig = state.sectionConfigs.get(state.currentSectionIndex);

  // Can undo/redo for current section
  const canUndo = useMemo(() => {
    const stack = state.undoStacks.get(state.currentSectionIndex);
    return (stack?.length ?? 0) > 0;
  }, [state.undoStacks, state.currentSectionIndex]);

  const canRedo = useMemo(() => {
    const stack = state.redoStacks.get(state.currentSectionIndex);
    return (stack?.length ?? 0) > 0;
  }, [state.redoStacks, state.currentSectionIndex]);

  // Actions
  const navigateToSection = useCallback((sectionIndex: number) => {
    dispatch({ type: 'NAVIGATE', sectionIndex });
  }, []);

  const navigateToArrayIndex = useCallback((arrayIndex: number) => {
    const sectionIndex = selectedIndices[arrayIndex];
    if (sectionIndex !== undefined) {
      dispatch({ type: 'NAVIGATE', sectionIndex });
    }
  }, [selectedIndices]);

  const updateSectionField = useCallback(<K extends keyof SectionConfig>(
    field: K,
    value: SectionConfig[K]
  ) => {
    dispatch({ type: 'UPDATE_FIELD', field, value });
  }, []);

  const updateShot = useCallback((
    shotIndex: number,
    field: keyof EditableShot,
    value: EditableShot[keyof EditableShot]
  ) => {
    dispatch({ type: 'UPDATE_SHOT', shotIndex, field, value });
  }, []);

  const addShot = useCallback(() => {
    dispatch({ type: 'ADD_SHOT' });
  }, []);

  const deleteShot = useCallback((index: number) => {
    dispatch({ type: 'DELETE_SHOT', index });
  }, []);

  const insertShotBefore = useCallback((index: number) => {
    dispatch({ type: 'INSERT_SHOT_BEFORE', index });
  }, []);

  const insertShotAfter = useCallback((index: number) => {
    dispatch({ type: 'INSERT_SHOT_AFTER', index });
  }, []);

  const setPlacement = useCallback((placement: PlacementConfig) => {
    dispatch({ type: 'SET_PLACEMENT', placement });
  }, []);

  const markPlaced = useCallback((sectionIndex: number) => {
    dispatch({ type: 'MARK_PLACED', sectionIndex });
  }, []);

  const unmarkPlaced = useCallback((sectionIndex: number) => {
    dispatch({ type: 'UNMARK_PLACED', sectionIndex });
  }, []);

  const undo = useCallback(() => {
    dispatch({ type: 'UNDO' });
  }, []);

  const redo = useCallback(() => {
    dispatch({ type: 'REDO' });
  }, []);

  const resetSection = useCallback(() => {
    dispatch({ type: 'RESET_SECTION' });
  }, []);

  const restoreState = useCallback((
    sectionConfigs: Map<number, SectionConfig>,
    placedSections: Set<number>,
    currentSectionIndex: number
  ) => {
    dispatch({ type: 'RESTORE_STATE', sectionConfigs, placedSections, currentSectionIndex });
  }, []);

  // Serialization helpers for state persistence
  const serializeSectionConfigs = useCallback(() => {
    return Array.from(state.sectionConfigs.entries());
  }, [state.sectionConfigs]);

  const serializePlacedSections = useCallback(() => {
    return Array.from(state.placedSections);
  }, [state.placedSections]);

  // Get section status
  const getSectionStatus = useCallback((sectionIndex: number): 'placed' | 'not_placed' | 'errors' => {
    const config = state.sectionConfigs.get(sectionIndex);
    if (!config) return 'not_placed';

    const validShots = config.shots.filter((s) => !s.isDeleted);
    if (validShots.length === 0) return 'errors';

    if (state.placedSections.has(sectionIndex)) return 'placed';

    return 'not_placed';
  }, [state.sectionConfigs, state.placedSections]);

  // Get all configs for import
  const getAllConfigs = useCallback(() => {
    return Array.from(state.sectionConfigs.values()).map((config) => ({
      ...config,
      shots: config.shots.filter((s) => !s.isDeleted),
    }));
  }, [state.sectionConfigs]);

  return {
    // State
    state,
    currentConfig,
    currentSectionIndex: state.currentSectionIndex,
    currentArrayIndex,
    selectedIndices,
    sectionConfigs: state.sectionConfigs,
    placedSections: state.placedSections,
    canUndo,
    canRedo,

    // Navigation
    navigateToSection,
    navigateToArrayIndex,

    // Section field updates
    updateSectionField,

    // Shot operations
    updateShot,
    addShot,
    deleteShot,
    insertShotBefore,
    insertShotAfter,

    // Placement
    setPlacement,
    markPlaced,
    unmarkPlaced,

    // Undo/Redo
    undo,
    redo,

    // Reset
    resetSection,

    // State restoration
    restoreState,

    // Serialization
    serializeSectionConfigs,
    serializePlacedSections,

    // Status
    getSectionStatus,

    // Export
    getAllConfigs,
  };
}

export type UseImportStateReturn = ReturnType<typeof useImportState>;
