import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from './uiStore';
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
import type { CommandResult, DmpFile, ExportImageOptions, ProjectWarning, BatchCommand } from '../types/commands';
import type { LoadProjectFullResult } from '../types/loading';

/**
 * Structured loading state for project load/create operations.
 * Tracks progress phases, current/total counts, and error states.
 */
export interface LoadingState {
  /** Unique ID for this load operation (increments on each load to detect stale events) */
  loadingId: number;
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
  isLoading: false,
  overallProgress: 0,
};

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
  /** Open a project using the legacy open_project command */
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

  createShot: (sectionId: SectionId, shot: ShotData, afterShotId?: ShotId) => Promise<CommandResult>;
  updateShot: (sectionId: SectionId, shotId: ShotId, updates: ShotUpdates) => Promise<CommandResult>;
  deleteShot: (sectionId: SectionId, shotId: ShotId) => Promise<CommandResult>;
  setShotVirtual: (sectionId: SectionId, shotId: ShotId, isVirtual: boolean) => Promise<CommandResult>;

  mergeStations: (stationA: StationRef, stationB: StationRef, strategy: ClosureStrategy) => Promise<CommandResult>;
  unmergeStations: (stationRef: StationRef) => Promise<CommandResult>;
  setZeroDatum: (stationRef: StationRef, coordinates: GpsCoordinates) => Promise<CommandResult>;
  removeZeroDatum: (stationRef: StationRef) => Promise<CommandResult>;
  moveSection: (sectionId: SectionId, offset: Coordinates) => Promise<CommandResult>;
  moveStation: (stationRef: StationRef, newPosition: Coordinates) => Promise<CommandResult>;

  undo: () => Promise<CommandResult>;
  redo: () => Promise<CommandResult>;
  refreshUndoState: () => Promise<void>;

  // Batch execution - groups multiple commands into a single undo/redo unit
  executeBatch: (commands: BatchCommand[]) => Promise<CommandResult>;

  importDmp: (path: string) => Promise<DmpFile>;
  calculateFileHash: (path: string) => Promise<string>;
  checkDuplicateImport: (hash: string) => Promise<boolean>;
  trackImportedFile: (hash: string) => Promise<void>;
  exportCsv: (path: string) => Promise<void>;
  exportJson: (path: string) => Promise<void>;
  exportImage: (path: string, options: ExportImageOptions) => Promise<void>;
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
    const result = await invoke<CommandResult>('update_config', { config });
    if (result.success) {
      // Re-fetch config to get backend-normalized values (e.g., zoom_step clamped to valid range)
      await get().loadConfig();
    }
    return result;
  },

  setConfig: (config: Config) => {
    set({ config });
  },

  // Loading state actions
  startLoading: (projectName: string, projectPath: string) => {
    const newId = get().loading.loadingId + 1;
    set({
      loading: {
        ...initialLoadingState,
        loadingId: newId,
        isLoading: true,
        projectName,
        projectPath,
        phase: 'opening_database',
        lastEventTime: Date.now(),
      },
    });
    return newId;
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
      loading: { ...initialLoadingState, loadingId: state.loading.loadingId },
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
    // ALWAYS cancel first - NO isLoading guard
    // cancel_loading is idempotent on backend
    await get().cancelLoading();

    const initialName = path.split('/').pop()?.replace(/\.(cvproj|cvchef)$/, '') ?? 'Project';
    const loadingId = get().startLoading(initialName, path);

    try {
      const result = await invoke<LoadProjectFullResult>('load_project_full', { path });

      // Check loadingId hasn't changed (cancelled/new load started)
      if (get().loading.loadingId !== loadingId) {
        return { success: false };
      }

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
      return { success: true };
    } catch (e) {
      const error = parseLoadError(e);

      // Handle ALREADY_OPEN specially - not an error, just switch view
      if (error.code === 'ALREADY_OPEN') {
        useUIStore.getState().setView('single');
        get().resetLoading();
        return { success: true };
      }

      // Only set error if this is still the current load operation
      if (get().loading.loadingId === loadingId) {
        get().setLoadingError(error.message, error.details);
      }
      return { success: false };
    }
  },

  // Project operations
  createProject: async (name: string, location?: string) => {
    console.log('[projectStore] createProject called:', name);
    // ALWAYS cancel first - NO isLoading guard
    await get().cancelLoading();

    const loadingId = get().startLoading(name, '');
    set({ error: null });

    try {
      console.log('[projectStore] Invoking create_project...');
      const result = await invoke<CommandResult>('create_project', { name, location });
      console.log('[projectStore] create_project result:', result);

      // Check loadingId hasn't changed
      if (get().loading.loadingId !== loadingId) {
        return { success: false, error: 'Cancelled', warnings: [] };
      }

      if (result.success) {
        console.log('[projectStore] Calling refreshProjectState...');
        await get().refreshProjectState();
        console.log('[projectStore] refreshProjectState done');
        // Reset display settings to defaults for new project
        useUIStore.getState().resetDisplaySettings();
        useUIStore.getState().setView('single');
        await get().loadRecentProjects();
        set({ isDirty: false });
        get().resetLoading();
      } else {
        get().setLoadingError(result.error ?? 'Failed to create project');
      }
      return result;
    } catch (e) {
      const error = parseLoadError(e);
      if (get().loading.loadingId === loadingId) {
        get().setLoadingError(error.message, error.details);
      }
      return { success: false, error: error.message, warnings: [] };
    }
  },

  openProject: async (path: string) => {
    console.log('[projectStore] openProject called with path:', path);
    // ALWAYS cancel first - NO isLoading guard
    await get().cancelLoading();

    const initialName = path.split('/').pop()?.replace(/\.(cvproj|cvchef)$/, '') ?? 'Project';
    const loadingId = get().startLoading(initialName, path);
    set({ error: null });

    try {
      const result = await invoke<CommandResult>('open_project', { path });
      console.log('[projectStore] open_project result:', result);

      // Check loadingId hasn't changed
      if (get().loading.loadingId !== loadingId) {
        return { success: false, error: 'Cancelled', warnings: [] };
      }

      if (result.success) {
        console.log('[projectStore] Calling refreshProjectState');
        await get().refreshProjectState();
        console.log('[projectStore] refreshProjectState complete, project:', get().project?.name);
        await get().loadRecentProjects();
        // Load display settings from the opened project
        await useUIStore.getState().loadDisplaySettings();
        // Fit map to show all stations
        useUIStore.getState().triggerFitToBounds();
        useUIStore.getState().setView('single');
        set({ isDirty: false });
        get().resetLoading();
      } else {
        console.error('[projectStore] open_project failed:', result.error);
        get().setLoadingError(result.error ?? 'Failed to open project');
      }
      return result;
    } catch (e) {
      const error = parseLoadError(e);
      if (get().loading.loadingId === loadingId) {
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
  createShot: async (sectionId: SectionId, shot: ShotData, afterShotId?: ShotId) => {
    const result = await invoke<CommandResult>('create_shot', {
      sectionId,
      shot,
      afterShotId,
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

  setShotVirtual: async (sectionId: SectionId, shotId: ShotId, isVirtual: boolean) => {
    const result = await invoke<CommandResult>('set_shot_virtual', { sectionId, shotId, isVirtual });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  // Station operations
  mergeStations: async (stationA: StationRef, stationB: StationRef, closureStrategy: ClosureStrategy) => {
    const result = await invoke<CommandResult>('merge_stations', { stationA, stationB, closureStrategy });
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

  setZeroDatum: async (stationRef: StationRef, coordinates: GpsCoordinates) => {
    const result = await invoke<CommandResult>('set_zero_datum', { stationRef, coordinates });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
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

  moveStation: async (stationRef: StationRef, newPosition: Coordinates) => {
    const result = await invoke<CommandResult>('move_station', { stationRef, newPosition });
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  // Undo/Redo
  undo: async () => {
    const result = await invoke<CommandResult>('undo');
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  },

  redo: async () => {
    const result = await invoke<CommandResult>('redo');
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
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
    console.log('[projectStore] executeBatch called with', commands.length, 'commands');
    const result = await invoke<CommandResult>('execute_batch', { commands });
    console.log('[projectStore] execute_batch result:', result);
    if (result.success) {
      console.log('[projectStore] Refreshing after batch execute...');
      await get().refreshProjectState();
      console.log('[projectStore] Refresh done after batch execute');
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
