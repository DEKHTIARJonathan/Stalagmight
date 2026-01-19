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
import type { CommandResult, DmpFile, ExportImageOptions, ProjectWarning } from '../types/commands';

interface ProjectStore {
  // State
  project: Project | null;
  stations: Station[];
  stats: ProjectStats | null;
  warnings: ProjectWarning[];
  recentProjects: ProjectMetadata[];
  config: Config | null;
  isLoading: boolean;
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
  isDirty: boolean;

  // Actions
  loadConfig: () => Promise<void>;
  updateConfig: (config: Config) => Promise<CommandResult>;

  createProject: (name: string, location?: string) => Promise<CommandResult>;
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
  isLoading: false,
  error: null,
  canUndo: false,
  canRedo: false,
  isDirty: false,

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
      set({ config });
    }
    return result;
  },

  // Project operations
  createProject: async (name: string, location?: string) => {
    console.log('[projectStore] createProject called:', name);
    set({ isLoading: true, error: null });
    try {
      console.log('[projectStore] Invoking create_project...');
      const result = await invoke<CommandResult>('create_project', { name, location });
      console.log('[projectStore] create_project result:', result);
      if (result.success) {
        console.log('[projectStore] Calling refreshProjectState...');
        await get().refreshProjectState();
        console.log('[projectStore] refreshProjectState done');
        // Reset display settings to defaults for new project
        useUIStore.getState().resetDisplaySettings();
        set({ isDirty: false });
      } else {
        set({ error: result.error ?? 'Failed to create project' });
      }
      return result;
    } finally {
      set({ isLoading: false });
    }
  },

  openProject: async (path: string) => {
    console.log('[projectStore] openProject called with path:', path);
    set({ isLoading: true, error: null });
    try {
      const result = await invoke<CommandResult>('open_project', { path });
      console.log('[projectStore] open_project result:', result);
      if (result.success) {
        console.log('[projectStore] Calling refreshProjectState');
        await get().refreshProjectState();
        console.log('[projectStore] refreshProjectState complete, project:', get().project?.name);
        await get().loadRecentProjects();
        // Load display settings from the opened project
        await useUIStore.getState().loadDisplaySettings();
        // Fit map to show all stations
        useUIStore.getState().triggerFitToBounds();
        set({ isDirty: false });
      } else {
        console.error('[projectStore] open_project failed:', result.error);
        set({ error: result.error ?? 'Failed to open project' });
      }
      return result;
    } finally {
      set({ isLoading: false });
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
    const result = await invoke<CommandResult>('close_project');
    if (result.success) {
      set({ project: null, stations: [], stats: null, isDirty: false });
    }
    return result;
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
