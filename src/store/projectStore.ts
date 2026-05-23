import { create } from 'zustand';
import { invokeIpc } from '../utils/ipc';
import { extractFilename } from '../utils/path';
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
  FrozenShotRef,
} from '../types/project';
import type { Config } from '../types/config';
import type { CommandResult, CommentHolder, ConnectivityResult, DmpFile, TmlFile, GpxFile, GpxSectionPlacement, ExportImageOptions, ProjectWarning, BatchCommand, UndoHistoryItem, ImportSectionConfig, PlacementSuggestion, CollabState, CollabChangeSet } from '../types/commands';
import type { LoadProjectFullResult, CreateProjectFullResult } from '../types/loading';

type ShotUpdatesPatch = Partial<ShotUpdates>;

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
  loadingId: bigint;
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
  loadingId: 0n,
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

interface CreateProjectOptions {
  savePath?: string;
  saveDirectory?: string;
  deferInitialSave?: boolean;
}

function emptyCommandResult(
  success: boolean,
  error?: string | null,
  warnings: CommandResult['warnings'] = []
): CommandResult {
  return {
    success,
    warnings,
    error: success ? null : (error ?? null),
    section_ids: [],
  };
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
  frozenShots: FrozenShotRef[];
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
  createProject: (name: string, projectLocation?: string, options?: CreateProjectOptions) => Promise<CommandResult>;
  /**
   * Open a project using the legacy open_project command (no progress events).
   * @deprecated Use loadProject() instead for progress UI support.
   */
  openProject: (path: string) => Promise<CommandResult>;
  saveProject: (path?: string) => Promise<CommandResult>;
  closeProject: () => Promise<CommandResult>;
  refreshProjectState: () => Promise<void>;
  /** Check if a shot (by section_id + shot index) is frozen */
  isShotFrozen: (sectionId: number, shotIndex: number) => boolean;
  refreshWarnings: () => Promise<void>;
  resolveWarning: (sectionId: number, shotId: number, warningCode: string, comment?: string) => Promise<void>;
  resolveAllWarnings: () => Promise<number>;
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
  updateShot: (sectionId: SectionId, shotId: ShotId, updates: ShotUpdatesPatch) => Promise<CommandResult>;
  deleteShot: (sectionId: SectionId, shotId: ShotId) => Promise<CommandResult>;
  deleteShotAndSplit: (sectionId: SectionId, shotId: ShotId, nameA: string, nameB: string) => Promise<CommandResult>;
  deleteLastShotAndSection: (sectionId: SectionId, shotId: ShotId) => Promise<CommandResult>;
  setShotReference: (sectionId: SectionId, shotId: ShotId, isReference: boolean) => Promise<CommandResult>;

  mergeStations: (stationA: StationRef, stationB: StationRef) => Promise<CommandResult>;
  unmergeStations: (stationRef: StationRef) => Promise<CommandResult>;
  unmergeStationPair: (stationA: StationRef, stationB: StationRef) => Promise<CommandResult>;
  checkMergeConnectivity: (stationA: StationRef, stationB: StationRef) => Promise<ConnectivityResult>;
  createLoopClosure: (stationA: StationRef, stationB: StationRef, closureStrategy: ClosureStrategy) => Promise<CommandResult>;
  removeLoopClosure: (closureId: bigint) => Promise<CommandResult>;
  adjustLoopClosures: (
    anchorStation: StationRef,
    method: ClosureStrategy
  ) => Promise<CommandResult>;
  updateStationComment: (stationRef: StationRef, comment: string | null) => Promise<CommandResult>;
  moveComment: (source: CommentHolder, target: CommentHolder, swap: boolean) => Promise<CommandResult>;
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
  parseTml: (path: string) => Promise<TmlFile>;
  executeTmlImport: (path: string, fileHash?: string | null, includeExcluded?: boolean, commentsOnStations?: boolean) => Promise<CommandResult>;
  // Collaboration mode
  setCollabEnabled: (enabled: boolean, siblingTmlRelative?: string | null) => Promise<CommandResult>;
  setCollabEnabledForPath: (path: string, enabled: boolean) => Promise<CommandResult>;
  getCollabState: () => Promise<CollabState | null>;
  detectCollabChanges: () => Promise<CollabChangeSet | null>;
  applyCollabChanges: () => Promise<CommandResult>;
  checkCollabSibling: () => Promise<string | null>;
  parseGpx: (path: string) => Promise<GpxFile>;
  executeGpxImport: (path: string, fileHash: string | null, importWaypoints: boolean, importTracks: boolean, importRoutes: boolean, sectionPlacements: GpxSectionPlacement[], depthInverted: boolean) => Promise<CommandResult>;
  calculateFileHash: (path: string) => Promise<string>;
  checkDuplicateImport: (hash: string) => Promise<boolean>;
  trackImportedFile: (hash: string) => Promise<void>;
  checkSectionHashes: (hashes: string[]) => Promise<boolean[]>;
  importSections: (sections: ImportSectionConfig[], fileHash?: string | null, sectionHashes?: string[] | null) => Promise<CommandResult>;
  suggestImportPlacement: (shots: ShotData[]) => Promise<PlacementSuggestion[]>;
  exportCsv: (path: string) => Promise<void>;
  exportJson: (path: string) => Promise<void>;
  exportTml: (path: string) => Promise<void>;
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

export const useProjectStore = create<ProjectStore>((set, get) => {
  /** Shared helper: invoke IPC command, refresh state on success, mark dirty. */
  const executeCommand = async (
    command: string,
    args: Record<string, unknown> | undefined,
    meta: { purpose: string; fields?: Record<string, unknown> }
  ): Promise<CommandResult> => {
    const result = await invokeIpc<CommandResult>(command, args, meta);
    if (result.success) {
      await get().refreshProjectState();
      set({ isDirty: true });
    }
    return result;
  };

  /** Shared helper for undo/redo operations: invoke, toast on failure, always refresh. */
  const executeUndoRedo = async (
    command: string,
    args: Record<string, unknown> | undefined,
    meta: { purpose: string; fields?: Record<string, unknown> },
    toastId: string,
    checkPartialFailure: boolean,
  ): Promise<CommandResult> => {
    let result: CommandResult;
    try {
      result = await invokeIpc<CommandResult>(command, args, meta);
      if (result.success) {
        set({ isDirty: true });
      } else {
        if (checkPartialFailure && isPartialMultiStepFailure(result.error)) {
          set({ isDirty: true });
        }
        useUIStore.getState().showToast(result.error ?? 'Unknown error', toastId);
      }
    } catch (e) {
      result = emptyCommandResult(false, String(e));
      useUIStore.getState().showToast(result.error ?? 'Unknown error', toastId);
    } finally {
      await get().refreshProjectState();
    }
    return result;
  };

  return {
  // Initial state
  project: null,
  stations: [],
  stats: null,
  frozenShots: [],
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
      const config = await invokeIpc<Config>('get_config', undefined, {
        purpose: 'load user configuration',
      });
      set({ config });
    } catch (e) {
      console.error('Failed to load config:', e);
    }
  },

  updateConfig: async (config: Config) => {
    try {
      // Rust command returns Result<(), String> - success returns nothing, error throws
      await invokeIpc('update_config', { config }, { purpose: 'persist user settings' });
      // Re-fetch config to get backend-normalized values (e.g., zoom_step clamped to valid range)
      await get().loadConfig();
      return emptyCommandResult(true, null);
    } catch (e) {
      return emptyCommandResult(false, String(e));
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
        loadingId: 0n, // Will be set from first progress event or result
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
      await invokeIpc('cancel_loading', undefined, {
        purpose: 'cancel project loading',
      });
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
    const initialName = extractFilename(path, /\.stalx$/i) || 'Project';
    const clientOpId = get().startLoading(initialName, path);

    try {
      const result = await invokeIpc<LoadProjectFullResult>(
        'load_project_full',
        { path },
        { purpose: 'load project for workspace', fields: { path } }
      );

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

      // Collaboration mode (non-blocking, best-effort):
      if (result.project.collab?.enabled) {
        // If the sibling .tml was edited externally (Ariane), detect the
        // changes and offer to reconcile them.
        void get()
          .detectCollabChanges()
          .then((cs) => {
            if (
              cs &&
              cs.shots_added.length +
                cs.shots_edited.length +
                cs.shots_removed.length +
                cs.sections_added.length +
                cs.section_meta_changed.length >
                0
            ) {
              useUIStore.getState().openDialog('collab-review', { changeSet: cs });
            }
          })
          .catch(() => {
            /* detection is best-effort; ignore errors */
          });
      } else {
        // Collaboration is off but a companion .tml exists next to the project:
        // warn that Ariane edits won't flow in and saves won't update it.
        void get()
          .checkCollabSibling()
          .then((siblingName) => {
            if (siblingName) {
              useUIStore
                .getState()
                .showToast(
                  `This project has an Ariane companion file (${siblingName}) but collaboration is off — it will not be updated when you save. Enable Ariane collaboration in Project details to keep them in sync.`,
                  'collab-sibling-warning'
                );
            }
          })
          .catch(() => {
            /* best-effort; ignore errors */
          });
      }

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

      // Handle CORRUPT - open recovery dialog instead of generic error
      if (error.code === 'CORRUPT' && error.details) {
        get().resetLoading();
        useUIStore.getState().openDialog('corruption-recovery', {
          corruptPath: error.details,
          errorMessage: error.message,
        });
        return { success: false };
      }

      // Only set error if this is still the current load operation
      if (get().loading.clientOpId === clientOpId) {
        get().setLoadingError(error.message, error.details);
      }
      return { success: false };
    }
  },

  // Project operations - uses consolidated create_project_full command
  createProject: async (name: string, projectLocation?: string, options?: CreateProjectOptions) => {
    // ALWAYS cancel first - NO isLoading guard
    await get().cancelLoading();

    const clientOpId = get().startLoading(name, '');

    try {
      const result = await invokeIpc<CreateProjectFullResult>(
        'create_project_full',
        {
          name,
          projectLocation,
          saveDirectory: options?.saveDirectory,
          savePath: options?.savePath,
          deferInitialSave: options?.deferInitialSave ?? !options?.savePath,
        },
        { purpose: 'create new project workspace', fields: { name } }
      );

      // Check clientOpId hasn't changed
      if (get().loading.clientOpId !== clientOpId) {
        return emptyCommandResult(false, 'Cancelled');
      }

      // Set backend loadingId from result for event correlation
      get().setLoadingProgress({ loadingId: result.loadingId });

      // Apply project state from result
      set({
        project: result.project,
        stations: [],
        stats: null,
        frozenShots: [],
        warnings: [],
        isDirty: false,
      });

      // Apply display settings from backend (defaults for new project)
      useUIStore.getState().applyDisplaySettings(result.displaySettings);
      useUIStore.getState().setView('single');
      await get().loadRecentProjects();
      get().resetLoading();

      return emptyCommandResult(true, null);
    } catch (e) {
      const error = parseLoadError(e);
      if (get().loading.clientOpId === clientOpId) {
        get().setLoadingError(error.message, error.details);
      }
      return emptyCommandResult(false, error.message);
    }
  },

  openProject: async (path: string) => {
    // ALWAYS cancel first - NO isLoading guard
    await get().cancelLoading();

    // Use cross-platform path splitting for project name extraction
    const initialName = extractFilename(path, /\.stalx$/i) || 'Project';
    const clientOpId = get().startLoading(initialName, path);

    try {
      const result = await invokeIpc<CommandResult>(
        'open_project',
        { path },
        { purpose: 'open project without progress UI', fields: { path } }
      );

      // Check clientOpId hasn't changed
      if (get().loading.clientOpId !== clientOpId) {
        return emptyCommandResult(false, 'Cancelled');
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
      return emptyCommandResult(false, error.message);
    }
  },

  saveProject: async (path?: string) => {
    const result = await invokeIpc<CommandResult>(
      'save_project',
      { path },
      { purpose: 'persist project changes', fields: { path } }
    );
    if (result.success) {
      // Update file_path if the backend returned it (first save / save-as)
      if (result.saved_path) {
        const project = get().project;
        if (project) {
          set({ project: { ...project, file_path: result.saved_path } });
        }
      }
      // Lightweight: just refresh undo/redo availability
      await get().refreshUndoState();
      set({ isDirty: false });
    } else {
      set({ error: result.error ?? 'Failed to save project' });
    }
    return result;
  },

  closeProject: async () => {
    // Guard against concurrent close operations (rapid Back clicks or double Discard)
    if (get().isClosing) {
      console.log('[projectStore] closeProject ignored - already closing');
      return emptyCommandResult(false, 'Already closing');
    }

    set({ isClosing: true });
    try {
      const result = await invokeIpc<CommandResult>('close_project', undefined, {
        purpose: 'close project and release resources',
      });
      if (result.success) {
        set({ project: null, stations: [], stats: null, frozenShots: [], isDirty: false });
      }
      return result;
    } finally {
      set({ isClosing: false });
    }
  },

  isShotFrozen: (sectionId: number, shotIndex: number) => {
    return get().frozenShots.some(
      (f) => f.section_id === sectionId && f.shot_index === shotIndex
    );
  },

  refreshProjectState: async () => {
    try {
      console.log('[projectStore] refreshProjectState: invoking get_project_state...');
      const state = await invokeIpc<ProjectState | null>('get_project_state', undefined, {
        purpose: 'refresh project state in UI',
      });
      console.log('[projectStore] refreshProjectState: got state, sections:', state?.project?.sections?.length);
      if (state) {
        set({
          project: state.project,
          stations: state.stations,
          stats: state.stats,
          frozenShots: state.frozen_shots,
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
      const warnings = await invokeIpc<ProjectWarning[]>('get_project_warnings', undefined, {
        purpose: 'refresh validation warnings',
      });
      set({ warnings });
    } catch (e) {
      console.error('Failed to refresh warnings:', e);
      set({ warnings: [] });
    }
  },

  resolveWarning: async (sectionId: number, shotId: number, warningCode: string, comment?: string) => {
    try {
      await invokeIpc(
        'resolve_warning',
        { sectionId, shotId, warningCode, comment },
        { purpose: 'acknowledge validation warning', fields: { sectionId, shotId, warningCode } }
      );
      await get().refreshWarnings();
    } catch (e) {
      console.error('Failed to resolve warning:', e);
    }
  },

  resolveAllWarnings: async () => {
    try {
      const count = await invokeIpc<number>(
        'resolve_all_warnings',
        {},
        { purpose: 'bulk acknowledge all validation warnings' }
      );
      await get().refreshWarnings();
      return count;
    } catch (e) {
      console.error('Failed to resolve all warnings:', e);
      return 0;
    }
  },

  unresolveWarning: async (sectionId: number, shotId: number, warningCode: string) => {
    try {
      await invokeIpc(
        'unresolve_warning',
        { sectionId, shotId, warningCode },
        { purpose: 'reopen validation warning', fields: { sectionId, shotId, warningCode } }
      );
      await get().refreshWarnings();
    } catch (e) {
      console.error('Failed to unresolve warning:', e);
    }
  },

  loadRecentProjects: async () => {
    try {
      const recent = await invokeIpc<ProjectMetadata[]>('list_recent_projects', undefined, {
        purpose: 'load recent projects list',
      });
      set({ recentProjects: recent });
    } catch (e) {
      console.error('Failed to load recent projects:', e);
    }
  },

  removeFromRecentProjects: async (path: string) => {
    try {
      const result = await invokeIpc<CommandResult>(
        'remove_from_recent_projects',
        { path },
        { purpose: 'update recent projects list', fields: { path } }
      );
      if (result.success) {
        // Refresh the list after removal
        await get().loadRecentProjects();
      }
      return result;
    } catch (e) {
      console.error('Failed to remove from recent projects:', e);
      return emptyCommandResult(false, String(e));
    }
  },

  // Section operations
  createSection: async (data: SectionData) => {
    return executeCommand(
      'create_section',
      {
        name: data.name,
        surveyor: data.surveyor,
        date: data.date,
        color: data.color,
        direction: data.direction,
        quality: data.quality,
        shots: data.shots,
      },
      {
        purpose: 'add section to project',
        fields: { name: data.name ?? 'unnamed', shot_count: data.shots?.length ?? 0 },
      }
    );
  },

  createSectionAndMerge: async (
    data: SectionData,
    importStationIndex: number,
    targetStation: StationRef,
    closureStrategy: ClosureStrategy
  ) => {
    return executeCommand(
      'create_section_and_merge',
      {
        name: data.name,
        surveyor: data.surveyor,
        date: data.date,
        color: data.color,
        direction: data.direction,
        quality: data.quality,
        shots: data.shots,
        importStationIndex,
        targetStation,
        closureStrategy,
      },
      {
        purpose: 'add section and merge stations',
        fields: { name: data.name ?? 'unnamed', shot_count: data.shots?.length ?? 0 },
      }
    );
  },

  updateSection: async (sectionId: SectionId, updates: SectionUpdates) => {
    return executeCommand(
      'update_section',
      { sectionId, updates },
      { purpose: 'update section metadata', fields: { sectionId } }
    );
  },

  deleteSection: async (sectionId: SectionId) => {
    return executeCommand(
      'delete_section',
      { sectionId },
      { purpose: 'remove section from project', fields: { sectionId } }
    );
  },

  // Shot operations
  createShot: async (sectionId: SectionId, shot: ShotData, afterShotId?: ShotId, beforeShotId?: ShotId) => {
    return executeCommand(
      'create_shot',
      {
        sectionId,
        shot,
        afterShotId: afterShotId ?? null,
        beforeShotId: beforeShotId ?? null,
      },
      {
        purpose: 'add shot to section',
        fields: { sectionId, afterShotId: afterShotId ?? null, beforeShotId: beforeShotId ?? null },
      }
    );
  },

  updateShot: async (sectionId: SectionId, shotId: ShotId, updates: ShotUpdatesPatch) => {
    return executeCommand(
      'update_shot',
      { sectionId, shotId, updates },
      { purpose: 'update shot measurements', fields: { sectionId, shotId } }
    );
  },

  deleteShot: async (sectionId: SectionId, shotId: ShotId) => {
    return executeCommand(
      'delete_shot',
      { sectionId, shotId },
      { purpose: 'delete shot from section', fields: { sectionId, shotId } }
    );
  },

  deleteShotAndSplit: async (sectionId: SectionId, shotId: ShotId, nameA: string, nameB: string) => {
    return executeCommand(
      'delete_shot_and_split',
      { sectionId, shotId, nameA, nameB },
      { purpose: 'delete shot and split section', fields: { sectionId, shotId } }
    );
  },

  deleteLastShotAndSection: async (sectionId: SectionId, shotId: ShotId) => {
    return executeCommand(
      'delete_last_shot_and_section',
      { sectionId, shotId },
      { purpose: 'remove single-shot section', fields: { sectionId, shotId } }
    );
  },

  setShotReference: async (sectionId: SectionId, shotId: ShotId, isReference: boolean) => {
    return executeCommand(
      'set_shot_reference',
      { sectionId, shotId, isReference },
      { purpose: 'toggle reference shot visibility', fields: { sectionId, shotId, isReference } }
    );
  },

  // Station operations
  mergeStations: async (stationA: StationRef, stationB: StationRef) => {
    return executeCommand(
      'merge_stations',
      { stationA, stationB },
      { purpose: 'connect survey sections', fields: { stationA, stationB } }
    );
  },

  unmergeStations: async (stationRef: StationRef) => {
    return executeCommand(
      'unmerge_stations',
      { stationRef },
      { purpose: 'disconnect merged stations', fields: { stationRef } }
    );
  },

  unmergeStationPair: async (stationA: StationRef, stationB: StationRef) => {
    return executeCommand(
      'unmerge_station_pair',
      { stationA, stationB },
      { purpose: 'disconnect selected merged station pair', fields: { stationA, stationB } }
    );
  },

  checkMergeConnectivity: async (stationA: StationRef, stationB: StationRef) => {
    return await invokeIpc<ConnectivityResult>(
      'check_merge_connectivity',
      { stationA, stationB },
      { purpose: 'check merge connectivity', fields: { stationA, stationB } }
    );
  },

  createLoopClosure: async (stationA: StationRef, stationB: StationRef, closureStrategy: ClosureStrategy) => {
    return executeCommand(
      'create_loop_closure',
      { stationA, stationB, closureStrategy },
      { purpose: 'add loop closure for accuracy', fields: { stationA, stationB, closureStrategy } }
    );
  },

  removeLoopClosure: async (closureId: bigint) => {
    return executeCommand(
      'remove_loop_closure',
      { closureId: Number(closureId) },
      { purpose: 'remove loop closure', fields: { closureId: closureId.toString() } }
    );
  },

  adjustLoopClosures: async (anchorStation: StationRef, method: ClosureStrategy) => {
    return executeCommand(
      'adjust_loop_closures',
      {
        anchorStation,
        method,
      },
      { purpose: 'reduce misclosure error', fields: { anchorStation, method } }
    );
  },

  updateStationComment: async (stationRef: StationRef, comment: string | null) => {
    return executeCommand(
      'set_station_comment',
      { stationRef, comment },
      { purpose: 'update station comment', fields: { stationRef } }
    );
  },

  moveComment: async (source: CommentHolder, target: CommentHolder, swap: boolean) => {
    return executeCommand(
      'move_comment',
      { source, target, swap },
      { purpose: swap ? 'swap comments' : 'move comment', fields: { source, target } }
    );
  },

  setZeroDatum: async (stationRef: StationRef, coordinates: GpsCoordinates, options?: { fitToBounds?: boolean }) => {
    // Detect first zero datum before the IPC call changes state
    const isFirstDatum = (get().project?.zero_datums.length ?? 0) === 0;
    const result = await executeCommand(
      'set_zero_datum',
      { stationRef, coordinates },
      { purpose: 'anchor survey to GPS coordinates', fields: { stationRef } }
    );
    if (result.success && options?.fitToBounds !== false) {
      // Snap (no animation) for first zero datum — the camera has no
      // meaningful prior position so animating from it is disorienting.
      useUIStore.getState().triggerFitToBounds(isFirstDatum ? { snap: true } : undefined);
    }
    return result;
  },

  removeZeroDatum: async (stationRef: StationRef) => {
    return executeCommand(
      'remove_zero_datum',
      { stationRef },
      { purpose: 'remove GPS anchor', fields: { stationRef } }
    );
  },

  moveSection: async (sectionId: SectionId, offset: Coordinates) => {
    return executeCommand(
      'move_section',
      { sectionId, offset },
      { purpose: 'reposition section for alignment', fields: { sectionId } }
    );
  },

  moveSegment: async (sectionId: SectionId, offset: Coordinates) => {
    return executeCommand(
      'move_segment',
      { sectionId, offset },
      { purpose: 'move connected segment', fields: { sectionId } }
    );
  },

  moveStation: async (stationRef: StationRef, offset: Coordinates) => {
    return executeCommand(
      'move_station',
      { stationRef, offset },
      { purpose: 'adjust station position', fields: { stationRef } }
    );
  },

  getConnectedSectionIds: async (sectionId: SectionId) => {
    return await invokeIpc<number[]>(
      'get_rigid_connected_section_ids',
      { sectionId },
      { purpose: 'query connected section ids', fields: { sectionId } }
    );
  },

  getAnchoredSectionIds: async () => {
    return await invokeIpc<number[]>(
      'get_anchored_section_ids',
      undefined,
      { purpose: 'query anchored section ids' }
    );
  },

  // Undo/Redo
  undo: async () =>
    executeUndoRedo('undo', undefined, { purpose: 'undo last action' }, 'undo-failed', false),

  redo: async () =>
    executeUndoRedo('redo', undefined, { purpose: 'redo last undone action' }, 'redo-failed', false),

  undoTo: async (index: number) =>
    executeUndoRedo('undo_to', { index }, { purpose: 'undo to history index', fields: { index } }, 'undo-failed', true),

  redoTo: async (index: number) =>
    executeUndoRedo('redo_to', { index }, { purpose: 'redo to history index', fields: { index } }, 'redo-failed', true),

  getUndoStack: async () => {
    return await invokeIpc<UndoHistoryItem[]>('get_undo_stack', undefined, {
      purpose: 'fetch undo history',
    });
  },

  getRedoStack: async () => {
    return await invokeIpc<UndoHistoryItem[]>('get_redo_stack', undefined, {
      purpose: 'fetch redo history',
    });
  },

  refreshUndoState: async () => {
    try {
      const [canUndo, canRedo] = await Promise.all([
        invokeIpc<boolean>('can_undo', undefined, { purpose: 'check undo availability' }),
        invokeIpc<boolean>('can_redo', undefined, { purpose: 'check redo availability' }),
      ]);
      set({ canUndo, canRedo });
    } catch (e) {
      console.error('Failed to refresh undo state:', e);
    }
  },

  // Batch execution - groups multiple commands into a single undo/redo unit
  executeBatch: async (commands: BatchCommand[]) => {
    return executeCommand(
      'execute_batch',
      { commands },
      { purpose: 'apply batch edits', fields: { command_count: commands.length } }
    );
  },

  // Import/Export
  importDmp: async (path: string) => {
    return await invokeIpc<DmpFile>('import_dmp', { path }, {
      purpose: 'parse DMP for import preview',
      fields: { path },
    });
  },

  parseTml: async (path: string) => {
    return await invokeIpc<TmlFile>('parse_tml', { path }, {
      purpose: 'parse TML for import preview',
      fields: { path },
    });
  },

  executeTmlImport: async (path: string, fileHash?: string | null, includeExcluded?: boolean, commentsOnStations?: boolean) => {
    return executeCommand(
      'execute_tml_import',
      {
        path,
        fileHash: fileHash ?? null,
        includeExcluded: includeExcluded ?? false,
        commentsOnStations: commentsOnStations ?? true,
      },
      { purpose: 'import Ariane TML/TMLU', fields: { path } }
    );
  },

  // Collaboration mode
  setCollabEnabled: async (enabled: boolean, siblingTmlRelative?: string | null) => {
    return executeCommand(
      'set_collab_enabled',
      { enabled, siblingTmlRelative: siblingTmlRelative ?? null },
      { purpose: 'toggle collaboration mode' }
    );
  },

  setCollabEnabledForPath: async (path: string, enabled: boolean) => {
    return executeCommand(
      'set_collab_enabled_for_path',
      { path, enabled },
      { purpose: 'toggle collaboration mode for a recent project', fields: { path } }
    );
  },

  getCollabState: async () => {
    return await invokeIpc<CollabState | null>('get_collab_state', undefined, {
      purpose: 'read collaboration state',
    });
  },

  detectCollabChanges: async () => {
    return await invokeIpc<CollabChangeSet | null>('detect_collab_changes', undefined, {
      purpose: 'detect collaborator .tml changes',
    });
  },

  applyCollabChanges: async () => {
    return executeCommand('apply_collab_changes', {}, {
      purpose: 'apply collaborator changes',
    });
  },

  checkCollabSibling: async () => {
    return await invokeIpc<string | null>('collab_sibling_when_disabled', undefined, {
      purpose: 'warn about an unsynced Ariane sibling file',
    });
  },

  parseGpx: async (path: string) => {
    return await invokeIpc<GpxFile>('parse_gpx', { path }, {
      purpose: 'parse GPX for import preview',
      fields: { path },
    });
  },

  executeGpxImport: async (path: string, fileHash: string | null, importWaypoints: boolean, importTracks: boolean, importRoutes: boolean, sectionPlacements: GpxSectionPlacement[], depthInverted: boolean) => {
    return executeCommand(
      'execute_gpx_import',
      {
        path,
        fileHash,
        importWaypoints,
        importTracks,
        importRoutes,
        sectionPlacements,
        depthInverted,
      },
      { purpose: 'import GPX file', fields: { path } }
    );
  },

  calculateFileHash: async (path: string) => {
    return await invokeIpc<string>('calculate_file_hash', { path }, {
      purpose: 'detect duplicate imports',
      fields: { path },
    });
  },

  checkDuplicateImport: async (hash: string) => {
    return await invokeIpc<boolean>('check_duplicate_import', { hash }, {
      purpose: 'detect duplicate imports',
      fields: { hash },
    });
  },

  trackImportedFile: async (hash: string) => {
    await invokeIpc('track_imported_file', { hash }, {
      purpose: 'track imported file hash',
      fields: { hash },
    });
  },

  checkSectionHashes: async (hashes: string[]) => {
    return await invokeIpc<boolean[]>('check_section_hashes', { hashes }, {
      purpose: 'detect duplicate section imports',
      fields: { count: hashes.length },
    });
  },

  importSections: async (sections: ImportSectionConfig[], fileHash?: string | null, sectionHashes?: string[] | null) => {
    return executeCommand(
      'import_sections',
      {
        sections,
        fileHash: fileHash ?? null,
        sectionHashes: sectionHashes ?? null,
      },
      { purpose: 'apply imported sections', fields: { section_count: sections.length } }
    );
  },

  suggestImportPlacement: async (shots: ShotData[]) => {
    return await invokeIpc<PlacementSuggestion[]>('suggest_import_placement', { shots }, {
      purpose: 'suggest placement from reference shot overlap',
    });
  },

  exportCsv: async (path: string) => {
    await invokeIpc('export_csv', { path }, {
      purpose: 'export project as CSV',
      fields: { path },
    });
  },

  exportJson: async (path: string) => {
    await invokeIpc('export_json', { path }, {
      purpose: 'export project as JSON',
      fields: { path },
    });
  },

  exportTml: async (path: string) => {
    await invokeIpc('export_tml', { path }, {
      purpose: 'export project as Ariane TML',
      fields: { path },
    });
  },

  exportImage: async (path: string, options: ExportImageOptions) => {
    await invokeIpc('export_image', { path, options }, {
      purpose: 'export map image',
      fields: { path, format: options.format },
    });
  },

  mergeProjects: async (sourcePaths: string[], outputPath: string, outputName: string, archiveOriginals: boolean) => {
    try {
      const result = await invokeIpc<CommandResult>(
        'merge_projects',
        {
          sourcePaths,
          outputPath,
          outputName,
          archiveOriginals,
        },
        {
          purpose: 'merge projects into single file',
          fields: { source_count: sourcePaths.length, outputPath },
        }
      );
      if (result.success) {
        // Refresh recent projects to reflect any changes (archived files removed, new file added)
        await get().loadRecentProjects();
      }
      return result;
    } catch (e) {
      console.error('Failed to merge projects:', e);
      return emptyCommandResult(false, String(e));
    }
  },
};
});
