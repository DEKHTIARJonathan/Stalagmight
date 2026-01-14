import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
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
import type { CommandResult, DmpFile, ExportImageOptions } from '../types/commands';

interface ProjectStore {
  // State
  project: Project | null;
  stations: Station[];
  stats: ProjectStats | null;
  recentProjects: ProjectMetadata[];
  config: Config | null;
  isLoading: boolean;
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;

  // Actions
  loadConfig: () => Promise<void>;
  updateConfig: (config: Config) => Promise<CommandResult>;

  createProject: (name: string, location?: string) => Promise<CommandResult>;
  openProject: (path: string) => Promise<CommandResult>;
  saveProject: (path?: string) => Promise<CommandResult>;
  closeProject: () => Promise<CommandResult>;
  refreshProjectState: () => Promise<void>;
  loadRecentProjects: () => Promise<void>;

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
  exportCsv: (path: string) => Promise<void>;
  exportJson: (path: string) => Promise<void>;
  exportImage: (path: string, options: ExportImageOptions) => Promise<void>;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  // Initial state
  project: null,
  stations: [],
  stats: null,
  recentProjects: [],
  config: null,
  isLoading: false,
  error: null,
  canUndo: false,
  canRedo: false,

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
    set({ isLoading: true, error: null });
    try {
      const result = await invoke<CommandResult>('create_project', { name, location });
      if (result.success) {
        await get().refreshProjectState();
      } else {
        set({ error: result.error ?? 'Failed to create project' });
      }
      return result;
    } finally {
      set({ isLoading: false });
    }
  },

  openProject: async (path: string) => {
    set({ isLoading: true, error: null });
    try {
      const result = await invoke<CommandResult>('open_project', { path });
      if (result.success) {
        await get().refreshProjectState();
        await get().loadRecentProjects();
      } else {
        set({ error: result.error ?? 'Failed to open project' });
      }
      return result;
    } finally {
      set({ isLoading: false });
    }
  },

  saveProject: async (path?: string) => {
    const result = await invoke<CommandResult>('save_project', { path });
    if (!result.success) {
      set({ error: result.error ?? 'Failed to save project' });
    }
    return result;
  },

  closeProject: async () => {
    const result = await invoke<CommandResult>('close_project');
    if (result.success) {
      set({ project: null, stations: [], stats: null });
    }
    return result;
  },

  refreshProjectState: async () => {
    try {
      const state = await invoke<ProjectState | null>('get_project_state');
      if (state) {
        set({
          project: state.project,
          stations: state.stations,
          stats: state.stats,
        });
      }
      await get().refreshUndoState();
    } catch (e) {
      console.error('Failed to refresh project state:', e);
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

  // Section operations
  createSection: async (data: SectionData) => {
    const result = await invoke<CommandResult>('create_section', {
      name: data.name,
      surveyor: data.surveyor,
      date: data.date,
      color: data.color,
      shots: data.shots,
    });
    if (result.success) {
      await get().refreshProjectState();
    }
    return result;
  },

  updateSection: async (sectionId: SectionId, updates: SectionUpdates) => {
    const result = await invoke<CommandResult>('update_section', { sectionId, updates });
    if (result.success) {
      await get().refreshProjectState();
    }
    return result;
  },

  deleteSection: async (sectionId: SectionId) => {
    const result = await invoke<CommandResult>('delete_section', { sectionId });
    if (result.success) {
      await get().refreshProjectState();
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
    }
    return result;
  },

  updateShot: async (sectionId: SectionId, shotId: ShotId, updates: ShotUpdates) => {
    const result = await invoke<CommandResult>('update_shot', { sectionId, shotId, updates });
    if (result.success) {
      await get().refreshProjectState();
    }
    return result;
  },

  deleteShot: async (sectionId: SectionId, shotId: ShotId) => {
    const result = await invoke<CommandResult>('delete_shot', { sectionId, shotId });
    if (result.success) {
      await get().refreshProjectState();
    }
    return result;
  },

  setShotVirtual: async (sectionId: SectionId, shotId: ShotId, isVirtual: boolean) => {
    const result = await invoke<CommandResult>('set_shot_virtual', { sectionId, shotId, isVirtual });
    if (result.success) {
      await get().refreshProjectState();
    }
    return result;
  },

  // Station operations
  mergeStations: async (stationA: StationRef, stationB: StationRef, closureStrategy: ClosureStrategy) => {
    const result = await invoke<CommandResult>('merge_stations', { stationA, stationB, closureStrategy });
    if (result.success) {
      await get().refreshProjectState();
    }
    return result;
  },

  unmergeStations: async (stationRef: StationRef) => {
    const result = await invoke<CommandResult>('unmerge_stations', { stationRef });
    if (result.success) {
      await get().refreshProjectState();
    }
    return result;
  },

  setZeroDatum: async (stationRef: StationRef, coordinates: GpsCoordinates) => {
    const result = await invoke<CommandResult>('set_zero_datum', { stationRef, coordinates });
    if (result.success) {
      await get().refreshProjectState();
    }
    return result;
  },

  removeZeroDatum: async (stationRef: StationRef) => {
    const result = await invoke<CommandResult>('remove_zero_datum', { stationRef });
    if (result.success) {
      await get().refreshProjectState();
    }
    return result;
  },

  moveSection: async (sectionId: SectionId, offset: Coordinates) => {
    const result = await invoke<CommandResult>('move_section', { sectionId, offset });
    if (result.success) {
      await get().refreshProjectState();
    }
    return result;
  },

  moveStation: async (stationRef: StationRef, newPosition: Coordinates) => {
    const result = await invoke<CommandResult>('move_station', { stationRef, newPosition });
    if (result.success) {
      await get().refreshProjectState();
    }
    return result;
  },

  // Undo/Redo
  undo: async () => {
    const result = await invoke<CommandResult>('undo');
    if (result.success) {
      await get().refreshProjectState();
    }
    return result;
  },

  redo: async () => {
    const result = await invoke<CommandResult>('redo');
    if (result.success) {
      await get().refreshProjectState();
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

  exportCsv: async (path: string) => {
    await invoke('export_csv', { path });
  },

  exportJson: async (path: string) => {
    await invoke('export_json', { path });
  },

  exportImage: async (path: string, options: ExportImageOptions) => {
    await invoke('export_image', { path, options });
  },
}));
