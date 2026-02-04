import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from './uiStore';
import { useGlobalViewStore } from './globalViewStore';
import type {
  Project,
  ProjectState,
  ProjectMetadata,
  Station,
  ProjectStats,
  SectionData,
  SectionUpdates,
  ShotData,
  ShotUpdates,
  SectionId,
  ShotId,
  StationRef,
  GpsCoordinates,
  ClosureStrategy,
  Coordinates,
} from '../types/project';
import type { Config } from '../types/config';
import type { CommandResult, ConnectivityResult, DmpFile, ExportImageOptions, ProjectWarning, BatchCommand, UndoHistoryItem, ImportSectionConfig } from '../types/commands';
import type { LoadProjectFullResult, CreateProjectFullResult } from '../types/loading';

/**
 * Structured loading state for project load/create operations.
 * Tracks progress phases, current/total counts, and error states.
 */
export interface LoadingState {
  /**
   * Backend loading ID for filtering stale progress events.
   * Set from the first progress event or result.loadingId.
   * Value of 0 means "accept events until we learn the backend ID".
   */
  loadingId: number;
  /**
   * Client operation ID for race detection (local to frontend).
   * Incremented on each load start. Used to detect if a newer load started.
   */
  clientOpId: number;
  /** Whether a load operation is currently in progress */
  isLoading: boolean;
  /** Name of the project being loaded */
  projectName?: string | undefined;
  /** Path to the project file (for retry functionality) */
  projectPath?: string | undefined;
  /** Current phase enum value (snake_case from backend) */
  phase?: string | undefined;
  /** Index of current phase (0-based) */
  phaseIndex?: number | undefined;
  /** Total number of phases */
  phaseCount?: number | undefined;
  /** Current phase progress percentage (0-100), undefined for indeterminate */
  phaseProgress?: number | undefined;
  /** Current item count in phase */
  phaseCurrent?: number | undefined;
  /** Total items in phase */
  phaseTotal?: number | undefined;
  /** Overall loading progress percentage (0-100) */
  overallProgress: number;
  /** Error information if load failed */
  error?: { message: string; details?: string | undefined } | undefined;
  /** Timestamp of last event (for timeout detection) */
  lastEventTime?: number | undefined;
}

const initialLoadingState: LoadingState = {
  loadingId: 0,
  clientOpId: 0,
  isLoading: false,
  overallProgress: 0,
};

// Separate client operation ID for race detection (independent of backend loading ID)
let clientOpIdCounter = 0;

/**
 * Parsed error from Tauri backend.
 */
interface LoadError {
  code: string;
  message: string;
  details?: string | undefined;
}

/**
 * Parse error from Tauri backend.
 * Tauri may serialize errors as strings or objects.
 */
function parseLoadError(e: unknown): LoadError {
  // Tauri serializes errors as strings - try parsing as JSON
  if (typeof e === 'string') {
    try {
      return JSON.parse(e) as LoadError;
    } catch {
      return { code: 'UNKNOWN', message: e };
    }
  }
  // Already an object
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>;
    return {
      code: (obj.code as string) || 'UNKNOWN',
      message: (obj.message as string) || String(e),
      details: obj.details as string | undefined,
    };
  }
  return { code: 'UNKNOWN', message: String(e) };
}

interface ProjectStore {
  // State
  project: Project | null;
  stations: Station[];
  stats: ProjectStats | null;
  warnings: ProjectWarning[];
  recentProjects: ProjectMetadata[];
  config: Config | null;
  /** Structured loading state with progress tracking */
  loading: LoadingState;
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
  isDirty: boolean;
  /** Guard to prevent concurrent close operations (rapid Back clicks) */
  isClosing: boolean;

  // Actions
  loadConfig: () => Promise<void>;
  updateConfig: (config: Config) => Promise<CommandResult>;
  /** Update config state without persisting to disk */
  setConfig: (config: Config) => void;

  // Loading state actions
  /** Start a new loading operation, returns the loadingId */
  startLoading: (projectName: string, projectPath: string) => number;
  /** Update loading progress state */
  setLoadingProgress: (progress: Partial<LoadingState>) => void;
  /** Reset loading state to initial */
  resetLoading: () => void;
  /** Set loading error (keeps modal open) */
  setLoadingError: (message: string, details?: string) => void;
  /** Cancel any in-progress loading operation */
  cancelLoading: () => Promise<void>;

  /** Load a project using the consolidated load_project_full command */
  loadProject: (path: string) => Promise<{ success: boolean }>;
  /** Create a new project (legacy, still supported) */
  createProject: (name: string, location?: string) => Promise<CommandResult>;
  /**
   * Open a project using the legacy open_project command (no progress events).
   * @deprecated Use loadProject() instead for progress UI support.
   */
  openProject: (path: string) => Promise<CommandResult>;
  saveProject: (path?: string) => Promise<CommandResult>;
  closeProject: () => Promise<CommandResult>;
  refreshProjectState: () => Promise<void>;
  refreshWarnings: () => Promise<void>;
  resolveWarning: (sectionId: number, shotId: number, warningCode: string, comment?: string) => Promise<void>;
  unresolveWarning: (sectionId: number, shotId: number, warningCode: string) => Promise<void>;
  loadRecentProjects: () => Promise<void>;
  removeFromRecentProjects: (path: string) => Promise<CommandResult>;
  mergeProjects: (sourcePaths: string[], outputPath: string, outputName: string, archiveOriginals: boolean) => Promise<CommandResult>;

  createSection: (data: SectionData) => Promise<CommandResult>;
  createSectionAndMerge: (
    data: SectionData,
    importStationIndex: number,
    targetStation: StationRef,
    closureStrategy: ClosureStrategy
  ) => Promise<CommandResult>;
  updateSection: (sectionId: SectionId, updates: SectionUpdates) => Promise<CommandResult>;
  deleteSection: (sectionId: SectionId) => Promise<CommandResult>;

  createShot: (sectionId: SectionId, shot: ShotData, afterShotId?: ShotId, beforeShotId?: ShotId) => Promise<CommandResult>;
  updateShot: (sectionId: SectionId, shotId: ShotId, updates: ShotUpdates) => Promise<CommandResult>;
  deleteShot: (sectionId: SectionId, shotId: ShotId) => Promise<CommandResult>;
  deleteShotAndSplit: (sectionId: SectionId, shotId: ShotId, nameA: string, nameB: string) => Promise<CommandResult>;
  deleteLastShotAndSection: (sectionId: SectionId, shotId: ShotId) => Promise<CommandResult>;
  setShotVirtual: (sectionId: SectionId, shotId: ShotId, isVirtual: boolean) => Promise<CommandResult>;

  mergeStations: (stationA: StationRef, stationB: StationRef) => Promise<CommandResult>;
  unmergeStations: (stationRef: StationRef) => Promise<CommandResult>;
  checkMergeConnectivity: (stationA: StationRef, stationB: StationRef) => Promise<ConnectivityResult>;
  createLoopClosure: (stationA: StationRef, stationB: StationRef, closureStrategy: ClosureStrategy) => Promise<CommandResult>;
  adjustLoopClosures: (
    anchorStation: StationRef,
    method: ClosureStrategy,
    useStrategyFilter: boolean
  ) => Promise<CommandResult>;
  setZeroDatum: (stationRef: StationRef, coordinates: GpsCoordinates, options?: { fitToBounds?: boolean }) => Promise<CommandResult>;
  removeZeroDatum: (stationRef: StationRef) => Promise<CommandResult>;
  moveSection: (sectionId: SectionId, offset: Coordinates) => Promise<CommandResult>;
  moveSegment: (sectionId: SectionId, offset: Coordinates) => Promise<CommandResult>;
  moveStation: (stationRef: StationRef, newPosition: Coordinates) => Promise<CommandResult>;
  getConnectedSectionIds: (sectionId: SectionId) => Promise<number[]>;
  getAnchoredSectionIds: () => Promise<number[]>;

  undo: () => Promise<CommandResult>;
  redo: () => Promise<CommandResult>;
  undoTo: (index: number) => Promise<CommandResult>;
  redoTo: (index: number) => Promise<CommandResult>;
  getUndoStack: () => Promise<UndoHistoryItem[]>;
  getRedoStack: () => Promise<UndoHistoryItem[]>;
  refreshUndoState: () => Promise<void>;

  // Batch execution - groups multiple commands into a single undo/redo unit
  executeBatch: (commands: BatchCommand[]) => Promise<CommandResult>;

  importDmp: (path: string) => Promise<DmpFile>;
  calculateFileHash: (path: string) => Promise<string>;
  checkDuplicateImport: (hash: string) => Promise<boolean>;
  trackImportedFile: (hash: string) => Promise<void>;
  importSections: (sections: ImportSectionConfig[], fileHash?: string | null) => Promise<CommandResult>;
  exportCsv: (path: string) => Promise<void>;
  exportJson: (path: string) => Promise<void>;
  exportImage: (path: string, options: ExportImageOptions) => Promise<void>;
}

/**
 * Detect partial failure in multi-step undo/redo.
 * Backend returns "Undo failed at step N of M: reason" (or "Redo failed...")
 * when some steps succeeded before the failure. If step > 1, state was mutated.
 */
function isPartialMultiStepFailure(error: string | null): boolean {
  if (!error) return false;
  const match = error.match(/failed at step (\d+) of (\d+)/);
  if (!match || !match[1]) return false;
  return parseInt(match[1], 10) > 1;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  // Initial state
  project: null,
  stations: [],
  stats: null,
  warnings: [],
  recentProjects: [],
  config: null,
  loading: { ...initialLoadingState },
  error: null,
  canUndo: false,
  canRedo: false,
  isDirty: false,
  isClosing: false,

  // Config
  loadConfig: async () => {
    try {
      const config = await invoke<Config>('get_config');
      set({ config });
    } catch (e) {
      console.error('Failed to load config:', e);
    }
  },

  updateConfig: async (config: Config) => {
    try {
      // Rust command returns Result<(), String> - success returns nothing, error throws
      await invoke('update_config', { config });
      // Re-fetch config to get backend-normalized values (e.g., zoom_step clamped to valid range)
      await get().loadConfig();
      return { success: true, error: null, warnings: [] };
    } catch (e) {
      return { success: false, error: String(e), warnings: [] };
    }
  },

  setConfig: (config: Config) => {
    set({ config });
  },

  // Loading state actions
  startLoading: (projectName: string, projectPath: string) => {
    clientOpIdCounter += 1;
    const newClientOpId = clientOpIdCounter;
    set({
      loading: {
        ...initialLoadingState,
        loadingId: 0, // Will be set from first progress event or result
        clientOpId: newClientOpId,
        isLoading: true,
        projectName,
        projectPath,
        phase: 'opening_database',
        lastEventTime: Date.now(),
      },
      error: null, // Clear any stale error state
    });
    return newClientOpId;
  },

  setLoadingProgress: (progress: Partial<LoadingState>) =>
    set((state) => ({
      loading: {
        ...state.loading,
        ...progress,
        lastEventTime: Date.now(),
      },
    })),

  resetLoading: () =>
    set((state) => ({
      loading: { ...initialLoadingState, clientOpId: state.loading.clientOpId },
    })),

  setLoadingError: (message: string, details?: string) =>
    set((state) => ({
      loading: {
        ...state.loading,
        isLoading: true, // Keep modal open for error display
        error: { message, details },
      },
    })),

  cancelLoading: async () => {
    // Safe to call even when no load is active - backend is idempotent
    try {
      await invoke('cancel_loading');
    } catch {
      // Ignore errors - might be called when no load active
    }
    // Always reset loading state
    get().resetLoading();
  },

  // Load project using the consolidated load_project_full command
  loadProject: async (path: string) => {
    // Clear GlobalView geometry cache to cancel pending loads and free memory
    useGlobalViewStore.getState().clearGeometryCache();

    // ALWAYS cancel first - NO isLoading guard
    // cancel_loading is idempotent on backend
    await get().cancelLoading();

    // Use cross-platform path splitting for project name extraction
    const initialName = path.split(/[/\\]/).pop()?.replace(/\.(stalx)$/, '') ?? 'Project';
    const clientOpId = get().startLoading(initialName, path);

    try {
      const result = await invoke<LoadProjectFullResult>('load_project_full', { path });

      // Check clientOpId hasn't changed (cancelled/new load started)
      if (get().loading.clientOpId !== clientOpId) {
        return { success: false };
      }

      // Set backend loadingId from result for event correlation
      get().setLoadingProgress({ loadingId: result.loadingId });

      // Update loading title with actual project name from result
      if (result.project.name !== initialName) {
        get().setLoadingProgress({ projectName: result.project.name });
      }

      // Apply ALL state from single response
      set({
        project: result.project,
        stations: result.stations,
        stats: result.stats,
        warnings: result.warnings,
        isDirty: false,
      });

      // Apply display settings to UI store (merge, don't overwrite)
      useUIStore.getState().applyDisplaySettings(result.displaySettings);
      useUIStore.getState().triggerFitToBounds();
      useUIStore.getState().setView('single');

      // Update recent projects list
      await get().loadRecentProjects();

      get().resetLoading();
      await get().refreshUndoState();
      return { success: true };
    } catch (e) {
      const error = parseLoadError(e);

      // Handle ALREADY_OPEN specially - not an error, just switch view
      if (error.code === 'ALREADY_OPEN') {
        useUIStore.getState().setView('single');
        get().resetLoading();
        await get().refreshUndoState();
        return { success: true };
      }

      // Only set error if this is still the current load operation
      if (get().loading.clientOpId === clientOpId) {
        get().setLoadingError(error.message, error.details);
      }
      return { success: false };
    }
  },

  // Project operations - uses consolidated create_project_full command
  createProject: async (name: string, location?: string) => {
    // ALWAYS cancel first - NO isLoading guard
    await get().cancelLoading();

    const clientOpId = get().startLoading(name, '');

    try {
      const result = await invoke<CreateProjectFullResult>('create_project_full', { name, location });

      // Check clientOpId hasn't changed
      if (get().loading.clientOpId !== clientOpId) {
        return { success: false, error: 'Cancelled', warnings: [] };
      }

      // Set backend loadingId from result for event correlation
      get().setLoadingProgress({ loadingId: result.loadingId });

      // Apply project state from result
      set({
        project: result.project,
        stations: [],
        stats: null,
        warnings: [],
        isDirty: false,
      });

      // Apply display settings from backend (defaults for new project)
      useUIStore.getState().applyDisplaySettings(result.displaySettings);
      useUIStore.getState().setView('single');
      await get().loadRecentProjects();
      get().resetLoading();

      return { success: true, error: null, warnings: [] };
    } catch (e) {
      const error = parseLoadError(e);
      if (get().loading.clientOpId === clientOpId) {
        get().setLoadingError(error.message, error.details);
      }
      return { success: false, error: error.message, warnings: [] };
    }
  },

  openProject: async (path: string) => {
    // ALWAYS cancel first - NO isLoading guard
    await get().cancelLoading();

    // Use cross-platform path splitting for project name extraction
    const initialName = path.split(/[/\\]/).pop()?.replace(/\.(stalx)$/, '') ?? 'Project';
    const clientOpId = get().startLoading(initialName, path);

    try {
      const result = await invoke<CommandResult>('open_project', { path });

      // Check clientOpId hasn't changed
      if (get().loading.clientOpId !== clientOpId) {
        return { success: false, error: 'Cancelled', warnings: [] };
      }

      if (result.success) {
        await get().refreshProjectState();
        await get().loadRecentProjects();
        // Load display settings from the opened project
        await useUIStore.getState().loadDisplaySettings();
        // Fit map to show all stations
        useUIStore.getState().triggerFitToBounds();
        useUIStore.getState().setView('single');
        set({ isDirty: false });
        get().resetLoading();
      } else {
        get().setLoadingError(result.error ?? 'Failed to open project');
      }
      return result;
    } catch (e) {
      const error = parseLoadError(e);
      if (get().loading.clientOpId === clientOpId) {
        get().setLoadingError(error.message, error.details);
      }
      return { success: false, error: error.message, warnings: [] };
    }
  },

  saveProject: async (path?: string) => {
    console.log('[projectStore] saveProject called, current isDirty:', get().isDirty);
    const result = await invoke<CommandResult>('save_project', { path });
    console.log('[projectStore] save_project result:', result);
    if (result.success) {
      // Refresh project state to get updated file_path first
      console.log('[projectStore] Before refresh, isDirty:', get().isDirty);
      await get().refreshProjectState();
      console.log('[projectStore] After refresh, isDirty:', get().isDirty);
      // Set isDirty: false AFTER refresh completes to avoid race conditions
      set({ isDirty: false });
      console.log('[projectStore] After set false, isDirty:', get().isDirty);
    } else {
      set({ error: result.error ?? 'Failed to save project' });
    }
    return result;
  },

  closeProject: async () => {
    // Guard against concurrent close operations (rapid Back clicks or double Discard)
    if (get().isClosing) {
      console.log('[projectStore] closeProject ignored - already closing');
      return { success: false, error: 'Already closing', warnings: [] };
    }

    set({ isClosing: true });
    try {
      const result = await invoke<CommandResult>('close_project');
      if (result.success) {
        set({ project: null, stations: [], stats: null, isDirty: false });
      }
      return result;
    } finally {
      set({ isClosing: false });
    }
  },

  refreshProjectState: async () => {
    try {
      console.log('[projectStore] refreshProjectState: invoking get_project_state...');
      const state = await invoke<ProjectState | null>('get_project_state');
      console.log('[projectStore] refreshProjectState: got state, sections:', state?.project?.sections?.length);
      if (state) {
        set({
          project: state.project,
          stations: state.stations,
          stats: state.stats,
        });
      }
      console.log('[projectStore] refreshProjectState: calling refreshUndoState...');
      await get().refreshUndoState();
      // Also refresh warnings
      await get().refreshWarnings();
      console.log('[projectStore] refreshProjectState: done');
    } catch (e) {
      console.error('Failed to refresh project state:', e);
    }
  },

  refreshWarnings: async () => {
    try {
      const warnings = await invoke<ProjectWarning[]>('get_project_warnings');
      set({ warnings });
    } catch (e) {
      console.error('Failed to refresh warnings:', e);
      set({ warnings: [] });
    }
  },

  resolveWarning: async (sectionId: number, shotId: number, warningCode: string, comment?: string) => {
    try {
      await invoke('resolve_warning', { sectionId, shotId, warningCode, comment });
      await get().refreshWarnings();
    } catch (e) {
      console.error('Failed to resolve warning:', e);
    }
  },

  unresolveWarning: async (sectionId: number, shotId: number, warningCode: string) => {
    try {
      await invoke('unresolve_warning', { sectionId, shotId, warningCode });
      await get().refreshWarnings();
    } catch (e) {
      console.error('Failed to unresolve warning:', e);
    }
  },

  loadRecentProjects: async () => {
    try {
      const recent = await invoke<ProjectMetadata[]>('list_recent_projects');
      set({ recentProjects: recent });
    } catch (e) {
      console.error('Failed to load recent projects:', e);
    }
  },

  removeFromRecentProjects: async (path: string) => {
    try {
      const result = await invoke<CommandResult>('remove_from_recent_projects', { path });
      if (result.success) {
        // Refresh the list after removal
        await get().loadRecentProjects();
      }
      return result;
    } catch (e) {
      console.error('Failed to remove from recent projects:', e);
      return { success: false, error: String(e), warnings: [] };
    }
  },

  // Section operations
  createSection: async (data: SectionData) => {
    console.log('[projectStore] createSection called:', data.name, 'shots:', data.shots?.length);
    const result = await invoke<CommandResult>('create_section', {
      name: data.name,
      surveyor: data.surveyor,
      date: data.date,
      color: data.color,
      shots: data.shots,
    });
    console.log('[projectStore] create_section result:', result);
    if (result.success) {
      console.log('[projectStore] Refreshing after section create...');
      await get().refreshProjectState();
      console.log('[projectStore] Refresh done after section create');
      set({ isDirty: true });
    }
    return result;
  },

  createSectionAndMerge: async (
    data: SectionData,
    importStationIndex: number,
    targetStation: StationRef,
    closureStrategy: ClosureStrategy
  ) => {
    console.log('[projectStore] createSectionAndMerge called:', data.name, 'shots:', data.shots?.length);
    const result = await invoke<CommandResult>('create_section_and_merge', {
      name: data.name,
      surveyor: data.surveyor,
      date: data.date,
      color: data.color,
      direction: data.direction,
      shots: data.shots,
      importStationIndex,
      targetStation,
      closureStrategy,
    });
    console.log('[projectStore] create_section_and_merge result:', result);
    if (result.success) {
      console.log('[projectStore] Refreshing after section create and merge...');
      await get().refreshProjectState();
      console.log('[projectStore] Refresh done after section create and merge');
      set({ isDirty: true });
    }
    return result;
  },

  updateSection: async (sectionId: SectionId, updates: SectionUpdates) => {
    const result = await invoke<CommandResult>('update_section', { sectionId, updates });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  deleteSection: async (sectionId: SectionId) => {
    const result = await invoke<CommandResult>('delete_section', { sectionId });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  // Shot operations
  createShot: async (sectionId: SectionId, shot: ShotData, afterShotId?: ShotId, beforeShotId?: ShotId) => {
    const result = await invoke<CommandResult>('create_shot', {
      sectionId,
      shot,
      afterShotId: afterShotId ?? null,
      beforeShotId: beforeShotId ?? null,
    });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  updateShot: async (sectionId: SectionId, shotId: ShotId, updates: ShotUpdates) => {
    const result = await invoke<CommandResult>('update_shot', { sectionId, shotId, updates });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  deleteShot: async (sectionId: SectionId, shotId: ShotId) => {
    const result = await invoke<CommandResult>('delete_shot', { sectionId, shotId });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  deleteShotAndSplit: async (sectionId: SectionId, shotId: ShotId, nameA: string, nameB: string) => {
    const result = await invoke<CommandResult>('delete_shot_and_split', { sectionId, shotId, nameA, nameB });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  deleteLastShotAndSection: async (sectionId: SectionId, shotId: ShotId) => {
    const result = await invoke<CommandResult>('delete_last_shot_and_section', { sectionId, shotId });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  setShotVirtual: async (sectionId: SectionId, shotId: ShotId, isVirtual: boolean) => {
    const result = await invoke<CommandResult>('set_shot_virtual', { sectionId, shotId, isVirtual });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  // Station operations
  mergeStations: async (stationA: StationRef, stationB: StationRef) => {
    const result = await invoke<CommandResult>('merge_stations', { stationA, stationB });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  unmergeStations: async (stationRef: StationRef) => {
    const result = await invoke<CommandResult>('unmerge_stations', { stationRef });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  checkMergeConnectivity: async (stationA: StationRef, stationB: StationRef) => {
    return await invoke<ConnectivityResult>('check_merge_connectivity', { stationA, stationB });
  },

  createLoopClosure: async (stationA: StationRef, stationB: StationRef, closureStrategy: ClosureStrategy) => {
    const result = await invoke<CommandResult>('create_loop_closure', { stationA, stationB, closureStrategy });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  adjustLoopClosures: async (
    anchorStation: StationRef,
    method: ClosureStrategy,
    useStrategyFilter: boolean
  ) => {
    const result = await invoke<CommandResult>('adjust_loop_closures', {
      anchorStation,
      method,
      useStrategyFilter,
    });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  setZeroDatum: async (stationRef: StationRef, coordinates: GpsCoordinates, options?: { fitToBounds?: boolean }) => {
    const result = await invoke<CommandResult>('set_zero_datum', { stationRef, coordinates });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
      if (options?.fitToBounds !== false) {
        useUIStore.getState().triggerFitToBounds();
      }
    }
    return result;
  },

  removeZeroDatum: async (stationRef: StationRef) => {
    const result = await invoke<CommandResult>('remove_zero_datum', { stationRef });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  moveSection: async (sectionId: SectionId, offset: Coordinates) => {
    const result = await invoke<CommandResult>('move_section', { sectionId, offset });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  moveSegment: async (sectionId: SectionId, offset: Coordinates) => {
    const result = await invoke<CommandResult>('move_segment', { sectionId, offset });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  moveStation: async (stationRef: StationRef, offset: Coordinates) => {
    const result = await invoke<CommandResult>('move_station', { stationRef, offset });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  getConnectedSectionIds: async (sectionId: SectionId) => {
    return await invoke<number[]>('get_connected_section_ids', { sectionId });
  },

  getAnchoredSectionIds: async () => {
    return await invoke<number[]>('get_anchored_section_ids');
  },

  // Undo/Redo
  undo: async () => {
    let result: CommandResult;
    try {
      result = await invoke<CommandResult>('undo');
      if (result.success) {
        set({ isDirty: true });
      } else {
        useUIStore.getState().showToast(result.error ?? 'Unknown error', 'undo-failed');
      }
    } catch (e) {
      result = { success: false, warnings: [], error: String(e) };
      useUIStore.getState().showToast(result.error ?? 'Unknown error', 'undo-failed');
    } finally {
      await get().refreshProjectState();
    }
    return result;
  },

  redo: async () => {
    let result: CommandResult;
    try {
      result = await invoke<CommandResult>('redo');
      if (result.success) {
        set({ isDirty: true });
      } else {
        useUIStore.getState().showToast(result.error ?? 'Unknown error', 'redo-failed');
      }
    } catch (e) {
      result = { success: false, warnings: [], error: String(e) };
      useUIStore.getState().showToast(result.error ?? 'Unknown error', 'redo-failed');
    } finally {
      await get().refreshProjectState();
    }
    return result;
  },

  undoTo: async (index: number) => {
    let result: CommandResult;
    try {
      result = await invoke<CommandResult>('undo_to', { index });
      if (result.success) {
        set({ isDirty: true });
      } else {
        // Partial failure: some steps applied before failure, state was mutated
        if (isPartialMultiStepFailure(result.error)) {
          set({ isDirty: true });
        }
        useUIStore.getState().showToast(result.error ?? 'Unknown error', 'undo-failed');
      }
    } catch (e) {
      result = { success: false, warnings: [], error: String(e) };
      useUIStore.getState().showToast(result.error ?? 'Unknown error', 'undo-failed');
    } finally {
      await get().refreshProjectState();
    }
    return result;
  },

  redoTo: async (index: number) => {
    let result: CommandResult;
    try {
      result = await invoke<CommandResult>('redo_to', { index });
      if (result.success) {
        set({ isDirty: true });
      } else {
        // Partial failure: some steps applied before failure, state was mutated
        if (isPartialMultiStepFailure(result.error)) {
          set({ isDirty: true });
        }
        useUIStore.getState().showToast(result.error ?? 'Unknown error', 'redo-failed');
      }
    } catch (e) {
      result = { success: false, warnings: [], error: String(e) };
      useUIStore.getState().showToast(result.error ?? 'Unknown error', 'redo-failed');
    } finally {
      await get().refreshProjectState();
    }
    return result;
  },

  getUndoStack: async () => {
    return await invoke<UndoHistoryItem[]>('get_undo_stack');
  },

  getRedoStack: async () => {
    return await invoke<UndoHistoryItem[]>('get_redo_stack');
  },

  refreshUndoState: async () => {
    try {
      const [canUndo, canRedo] = await Promise.all([
        invoke<boolean>('can_undo'),
        invoke<boolean>('can_redo'),
      ]);
      set({ canUndo, canRedo });
    } catch (e) {
      console.error('Failed to refresh undo state:', e);
    }
  },

  // Batch execution - groups multiple commands into a single undo/redo unit
  executeBatch: async (commands: BatchCommand[]) => {
    const result = await invoke<CommandResult>('execute_batch', { commands });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  // Import/Export
  importDmp: async (path: string) => {
    return await invoke<DmpFile>('import_dmp', { path });
  },

  calculateFileHash: async (path: string) => {
    return await invoke<string>('calculate_file_hash', { path });
  },

  checkDuplicateImport: async (hash: string) => {
    return await invoke<boolean>('check_duplicate_import', { hash });
  },

  trackImportedFile: async (hash: string) => {
    await invoke('track_imported_file', { hash });
  },

  importSections: async (sections: ImportSectionConfig[], fileHash?: string | null) => {
    const result = await invoke<CommandResult>('import_sections', {
      sections,
      fileHash: fileHash ?? null,
    });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  exportCsv: async (path: string) => {
    await invoke('export_csv', { path });
  },

  exportJson: async (path: string) => {
    await invoke('export_json', { path });
  },

  exportImage: async (path: string, options: ExportImageOptions) => {
    await invoke('export_image', { path, options });
  },

  mergeProjects: async (sourcePaths: string[], outputPath: string, outputName: string, archiveOriginals: boolean) => {
    try {
      const result = await invoke<CommandResult>('merge_projects', {
        sourcePaths,
        outputPath,
        outputName,
        archiveOriginals,
      });
      if (result.success) {
        // Refresh recent projects to reflect any changes (archived files removed, new file added)
        await get().loadRecentProjects();
      }
      return result;
    } catch (e) {
      console.error('Failed to merge projects:', e);
      return { success: false, error: String(e), warnings: [] };
    }
  },
}));
