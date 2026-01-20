import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Coordinates, SectionId, ShotId, StationRef, SectionData } from '../types/project';
import type { PanelsConfig } from '../types/config';

export type ViewType = 'global' | 'single';

export type DetailPanelTab = 'details' | 'warnings';

export type ToolType =
  | 'select'
  | 'pan'
  | 'zoom'
  | 'draw'
  | 'delete'
  | 'merge'
  | 'measure'
  | 'move_section'
  | 'move_station';

/**
 * Placement result returned when placement mode completes.
 */
export interface PlacementResult {
  /** Final cursor position in map coordinates (meters) */
  position: Coordinates;
  /** If snapped to an existing station, its reference */
  snappedToStation: StationRef | null;
}

/**
 * Placement mode state for manually placing a newly imported section on the map.
 * The section preview follows the cursor until the user clicks to confirm placement.
 */
export interface PlacementModeState {
  /** The section data to be created (not yet in the project) */
  sectionData: SectionData;
  /** Which station index of the new section aligns to cursor (0 = first, N = last) */
  alignStationIndex: number;
  /** Current cursor position in map coordinates (meters) */
  cursorPosition: Coordinates | null;
  /** Snapped station reference (if cursor is near an existing station) */
  snappedToStation: StationRef | null;
  /** Callback when placement is confirmed */
  onComplete?: (result: PlacementResult) => void;
  /** Callback when placement is canceled */
  onCancel?: () => void;
}

export interface Selection {
  type: 'station' | 'shot' | 'section';
  stationRef?: StationRef;
  sectionId?: SectionId;
  shotId?: ShotId;
}

/**
 * Spring-loaded key state for temporary tool switching.
 * When a spring-loaded key is held, the tool switches temporarily.
 * On release, if held > threshold, restores previous state; if tapped, keeps new tool.
 */
export interface SpringLoadedState {
  /** The tool that was active before spring-loaded activation */
  previousTool: ToolType;
  /** The tool we switched to (e.g., 'zoom') */
  targetTool: ToolType;
  /** Saved merge station A (restored on hold release) */
  mergeStationA: StationRef | null;
  /** Saved measure start point (restored on hold release) */
  measureStart: StationRef | Coordinates | null;
  /** Saved measure end point (restored on hold release) */
  measureEnd: StationRef | Coordinates | null;
  /** Saved draw from station (restored on hold release) */
  drawFromStation: StationRef | null;
  /** Timestamp when spring-loaded was activated (for tap vs hold detection) */
  activatedAt: number;
}

// Helper to compare selections
export function selectionsEqual(a: Selection, b: Selection): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'station' && b.type === 'station') {
    return (
      a.stationRef?.section_id === b.stationRef?.section_id &&
      a.stationRef?.station_index === b.stationRef?.station_index
    );
  }
  if (a.type === 'shot' && b.type === 'shot') {
    return a.sectionId === b.sectionId && a.shotId === b.shotId;
  }
  if (a.type === 'section' && b.type === 'section') {
    return a.sectionId === b.sectionId;
  }
  return false;
}

interface UIStore {
  // View state
  view: ViewType;
  setView: (view: ViewType) => void;

  // Tool state
  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;

  // Selection state
  selection: Selection | null;
  multiSelection: Selection[];
  setSelection: (selection: Selection | null) => void;
  addToSelection: (selection: Selection) => void;
  removeFromSelection: (selection: Selection) => void;
  toggleSelection: (selection: Selection) => void;
  clearSelection: () => void;
  selectAll: (selections: Selection[]) => void;
  isSelected: (selection: Selection) => boolean;

  // Tool-specific state
  mergeStationA: StationRef | null;
  mergeStationB: StationRef | null;
  setMergeStationA: (ref: StationRef | null) => void;
  setMergeStationB: (ref: StationRef | null) => void;
  clearMergeStations: () => void;

  measureStart: StationRef | Coordinates | null;
  measureEnd: StationRef | Coordinates | null;
  setMeasureStart: (point: StationRef | Coordinates | null) => void;
  setMeasureEnd: (point: StationRef | Coordinates | null) => void;
  clearMeasure: () => void;

  drawFromStation: StationRef | null;
  setDrawFromStation: (ref: StationRef | null) => void;

  // Panel state
  sectionsPanelOpen: boolean;
  sectionsPanelWidth: number;
  detailPanelOpen: boolean;
  detailPanelWidth: number;
  detailPanelTab: DetailPanelTab;
  dataTableOpen: boolean;
  dataTableHeight: number;
  toggleSectionsPanel: () => void;
  toggleDetailPanel: () => void;
  toggleDataTable: () => void;
  setDetailPanelTab: (tab: DetailPanelTab) => void;
  setSectionsPanelWidth: (width: number) => void;
  setDetailPanelWidth: (width: number) => void;
  setDataTableHeight: (height: number) => void;
  initPanelSizes: (panels: PanelsConfig) => void;
  savePanelSizes: (
    sectionsPanelWidth?: number,
    detailPanelWidth?: number,
    dataTableHeight?: number
  ) => Promise<void>;

  // Map state
  mapCenter: [number, number];
  mapZoom: number;
  setMapCenter: (center: [number, number]) => void;
  setMapZoom: (zoom: number) => void;
  requestFitToBounds: boolean;
  triggerFitToBounds: () => void;
  clearFitToBoundsRequest: () => void;

  // Display toggles
  showStations: boolean;
  showSectionNames: boolean;
  showStationLabels: boolean;
  showShotData: boolean;
  showVirtualShots: boolean;
  showZeroDatum: boolean;
  showGrid: boolean;
  showScaleBar: boolean;
  showSatellite: boolean;
  showDepthGradient: boolean;
  gridSpacing: number;
  toggleDisplay: (key: DisplayToggleKey) => void;
  setGridSpacing: (spacing: number) => void;
  loadDisplaySettings: () => Promise<void>;
  saveDisplaySetting: (key: DisplayToggleKey, value: boolean) => Promise<void>;
  resetDisplaySettings: () => void;

  // Hover state
  hoveredStation: StationRef | null;
  hoveredShot: { sectionId: SectionId; shotId: ShotId } | null;
  setHoveredStation: (ref: StationRef | null) => void;
  setHoveredShot: (shot: { sectionId: SectionId; shotId: ShotId } | null) => void;

  // Snap state
  snappedStation: StationRef | null;
  setSnappedStation: (ref: StationRef | null) => void;

  // Drag state
  isDragging: boolean;
  dragStart: [number, number] | null;
  dragCurrent: [number, number] | null;
  setDragState: (isDragging: boolean, start?: [number, number], current?: [number, number]) => void;

  // Dialog state
  activeDialog: string | null;
  dialogData: Record<string, unknown>;
  openDialog: (dialog: string, data?: Record<string, unknown>) => void;
  closeDialog: () => void;

  // Import flow context
  importContext: 'new-project' | 'existing-project' | null;
  setImportContext: (context: 'new-project' | 'existing-project' | null) => void;

  // Track imported DMP file paths for duplicate detection (session-based)
  importedDmpPaths: Set<string>;
  addImportedDmpPath: (path: string) => void;
  hasImportedDmpPath: (path: string) => boolean;
  clearImportedDmpPaths: () => void;

  // Session surveyor memory (not persisted to config)
  lastUsedSurveyor: string;
  setLastUsedSurveyor: (surveyor: string) => void;

  // Placement mode state (for manual map placement of imported sections)
  placementMode: PlacementModeState | null;
  startPlacementMode: (
    sectionData: SectionData,
    alignStationIndex: number,
    onComplete?: (result: PlacementResult) => void,
    onCancel?: () => void
  ) => void;
  updatePlacementCursor: (position: Coordinates | null) => void;
  updatePlacementSnap: (stationRef: StationRef | null) => void;
  cancelPlacementMode: () => void;
  confirmPlacement: () => PlacementModeState | null;

  // Map viewport center in project coordinates (x, y in meters)
  // Used for "Place at center of screen" in import dialog
  mapViewportCenterProject: { x: number; y: number } | null;
  setMapViewportCenterProject: (center: { x: number; y: number } | null) => void;
  getMapViewportCenter: () => { x: number; y: number };

  // Spring-loaded key state (for temporary tool switching)
  springLoadedState: SpringLoadedState | null;
  activateSpringLoaded: (targetTool: ToolType) => void;
  deactivateSpringLoaded: () => void;
  cancelSpringLoaded: () => void;
}

export type DisplayToggleKey =
  | 'showStations'
  | 'showSectionNames'
  | 'showStationLabels'
  | 'showShotData'
  | 'showVirtualShots'
  | 'showZeroDatum'
  | 'showGrid'
  | 'showScaleBar'
  | 'showSatellite'
  | 'showDepthGradient';

export const useUIStore = create<UIStore>((set) => ({
  // View state
  view: 'global',
  setView: (view) => set({ view }),

  // Tool state
  activeTool: 'select',
  setActiveTool: (activeTool) => set({ activeTool }),

  // Selection state
  selection: null,
  multiSelection: [],
  setSelection: (selection) => set({ selection, multiSelection: selection ? [selection] : [] }),
  addToSelection: (selection) =>
    set((state) => {
      // Don't add duplicates
      const exists = state.multiSelection.some((s) => selectionsEqual(s, selection));
      if (exists) return state;
      return {
        multiSelection: [...state.multiSelection, selection],
        selection: selection,
      };
    }),
  removeFromSelection: (selection) =>
    set((state) => {
      const newMulti = state.multiSelection.filter((s) => !selectionsEqual(s, selection));
      const lastItem = newMulti[newMulti.length - 1];
      const newSelection: Selection | null = lastItem !== undefined ? lastItem : null;
      return {
        multiSelection: newMulti,
        selection: newSelection,
      };
    }),
  toggleSelection: (selection) =>
    set((state) => {
      const exists = state.multiSelection.some((s) => selectionsEqual(s, selection));
      if (exists) {
        const newMulti = state.multiSelection.filter((s) => !selectionsEqual(s, selection));
        const lastItem = newMulti[newMulti.length - 1];
        const newSelection: Selection | null = lastItem !== undefined ? lastItem : null;
        return {
          multiSelection: newMulti,
          selection: newSelection,
        };
      } else {
        return {
          multiSelection: [...state.multiSelection, selection],
          selection: selection,
        };
      }
    }),
  clearSelection: () => set({ selection: null, multiSelection: [] }),
  selectAll: (selections: Selection[]) =>
    set({
      multiSelection: selections,
      selection: selections[selections.length - 1] ?? null,
    }),
  isSelected: (selection: Selection): boolean => {
    // Note: This will get the latest state at call time
    return useUIStore.getState().multiSelection.some((s: Selection) => selectionsEqual(s, selection));
  },

  // Tool-specific state
  mergeStationA: null,
  mergeStationB: null,
  setMergeStationA: (mergeStationA) => set({ mergeStationA }),
  setMergeStationB: (mergeStationB) => set({ mergeStationB }),
  clearMergeStations: () => set({ mergeStationA: null, mergeStationB: null }),

  measureStart: null,
  measureEnd: null,
  setMeasureStart: (measureStart) => set({ measureStart }),
  setMeasureEnd: (measureEnd) => set({ measureEnd }),
  clearMeasure: () => set({ measureStart: null, measureEnd: null }),

  drawFromStation: null,
  setDrawFromStation: (drawFromStation) => set({ drawFromStation }),

  // Panel state
  sectionsPanelOpen: true,
  sectionsPanelWidth: 250,
  detailPanelOpen: true,
  detailPanelWidth: 300,
  detailPanelTab: 'details',
  dataTableOpen: false,
  dataTableHeight: 200,
  toggleSectionsPanel: () => set((state) => ({ sectionsPanelOpen: !state.sectionsPanelOpen })),
  toggleDetailPanel: () => set((state) => ({ detailPanelOpen: !state.detailPanelOpen })),
  toggleDataTable: () => set((state) => ({ dataTableOpen: !state.dataTableOpen })),
  setDetailPanelTab: (detailPanelTab) => set({ detailPanelTab }),
  setSectionsPanelWidth: (sectionsPanelWidth) => set({ sectionsPanelWidth }),
  setDetailPanelWidth: (detailPanelWidth) => set({ detailPanelWidth }),
  setDataTableHeight: (dataTableHeight) => set({ dataTableHeight }),
  initPanelSizes: (panels: PanelsConfig) =>
    set({
      sectionsPanelWidth: panels.sections_panel_width,
      detailPanelWidth: panels.detail_panel_width,
      dataTableHeight: panels.data_table_height,
    }),
  savePanelSizes: async (sectionsPanelWidth, detailPanelWidth, dataTableHeight) => {
    try {
      await invoke('update_panel_sizes', {
        sectionsPanelWidth,
        detailPanelWidth,
        dataTableHeight,
      });
    } catch (e) {
      console.error('Failed to save panel sizes:', e);
    }
  },

  // Map state
  mapCenter: [0, 0],
  mapZoom: 15,
  setMapCenter: (mapCenter) => set({ mapCenter }),
  setMapZoom: (mapZoom) => set({ mapZoom }),
  requestFitToBounds: false,
  triggerFitToBounds: () => set({ requestFitToBounds: true }),
  clearFitToBoundsRequest: () => set({ requestFitToBounds: false }),

  // Display toggles
  showStations: true,
  showSectionNames: true,
  showStationLabels: false,
  showShotData: false,
  showVirtualShots: true,
  showZeroDatum: true,
  showGrid: false,
  showScaleBar: true,
  showSatellite: false,
  showDepthGradient: false,
  gridSpacing: 10,
  toggleDisplay: (key) => {
    const state = useUIStore.getState();
    const newValue = !state[key];
    set({ [key]: newValue });
    // Persist the setting asynchronously via the helper
    state.saveDisplaySetting(key, newValue);
  },
  setGridSpacing: (spacing) => {
    set({ gridSpacing: spacing });
    // Persist the spacing setting
    invoke('save_display_setting', { key: 'gridSpacing', value: String(spacing) }).catch((e) => {
      console.warn('Failed to save grid spacing:', e);
    });
  },
  loadDisplaySettings: async () => {
    try {
      const settings = await invoke<Record<string, string>>('load_display_settings');
      const displayState: Partial<Record<DisplayToggleKey, boolean>> = {};
      let gridSpacing: number | undefined;
      for (const [key, value] of Object.entries(settings)) {
        if (key.startsWith('show')) {
          displayState[key as DisplayToggleKey] = value === 'true';
        } else if (key === 'gridSpacing') {
          const parsed = parseFloat(value);
          if (!isNaN(parsed) && parsed > 0) {
            gridSpacing = parsed;
          }
        }
      }
      if (Object.keys(displayState).length > 0 || gridSpacing !== undefined) {
        set({ ...displayState, ...(gridSpacing !== undefined ? { gridSpacing } : {}) });
      }
    } catch (e) {
      // No project open or other error - use defaults
      console.warn('Failed to load display settings:', e);
    }
  },
  saveDisplaySetting: async (key, value) => {
    try {
      await invoke('save_display_setting', { key, value: String(value) });
    } catch (e) {
      console.warn('Failed to save display setting:', e);
    }
  },
  resetDisplaySettings: () => {
    // Reset all display toggles to their default values
    set({
      showStations: true,
      showSectionNames: true,
      showStationLabels: false,
      showShotData: false,
      showVirtualShots: true,
      showZeroDatum: true,
      showGrid: false,
      showScaleBar: true,
      showSatellite: false,
      showDepthGradient: false,
      gridSpacing: 10,
    });
  },

  // Hover state
  hoveredStation: null,
  hoveredShot: null,
  setHoveredStation: (hoveredStation) => set({ hoveredStation }),
  setHoveredShot: (hoveredShot) => set({ hoveredShot }),

  // Snap state
  snappedStation: null,
  setSnappedStation: (snappedStation) => set({ snappedStation }),

  // Drag state
  isDragging: false,
  dragStart: null,
  dragCurrent: null,
  setDragState: (isDragging, start, current) =>
    set({
      isDragging,
      dragStart: start ?? null,
      dragCurrent: current ?? null,
    }),

  // Dialog state
  activeDialog: null,
  dialogData: {},
  openDialog: (activeDialog, dialogData = {}) => set({ activeDialog, dialogData }),
  closeDialog: () => set({ activeDialog: null, dialogData: {} }),

  // Import flow context
  importContext: null,
  setImportContext: (importContext) => set({ importContext }),

  // Track imported DMP file paths for duplicate detection (session-based)
  importedDmpPaths: new Set<string>(),
  addImportedDmpPath: (path) =>
    set((state) => {
      const newSet = new Set(state.importedDmpPaths);
      newSet.add(path);
      return { importedDmpPaths: newSet };
    }),
  hasImportedDmpPath: (path): boolean => {
    return useUIStore.getState().importedDmpPaths.has(path);
  },
  clearImportedDmpPaths: () => set({ importedDmpPaths: new Set<string>() }),

  // Session surveyor memory (not persisted to config)
  lastUsedSurveyor: '',
  setLastUsedSurveyor: (lastUsedSurveyor) => set({ lastUsedSurveyor }),

  // Placement mode state
  placementMode: null,
  startPlacementMode: (sectionData, alignStationIndex, onComplete, onCancel) =>
    set({
      placementMode: {
        sectionData,
        alignStationIndex,
        cursorPosition: null,
        snappedToStation: null,
        ...(onComplete !== undefined && { onComplete }),
        ...(onCancel !== undefined && { onCancel }),
      },
    }),
  updatePlacementCursor: (position) =>
    set((state) =>
      state.placementMode
        ? {
            placementMode: {
              ...state.placementMode,
              cursorPosition: position,
            },
          }
        : state
    ),
  updatePlacementSnap: (stationRef) =>
    set((state) =>
      state.placementMode
        ? {
            placementMode: {
              ...state.placementMode,
              snappedToStation: stationRef,
            },
          }
        : state
    ),
  cancelPlacementMode: () => set({ placementMode: null }),
  confirmPlacement: (): PlacementModeState | null => {
    const currentPlacement = useUIStore.getState().placementMode;
    // Clear placement mode and return the state for the caller to use
    set({ placementMode: null });
    return currentPlacement;
  },

  // Map viewport center in project coordinates
  mapViewportCenterProject: null,
  setMapViewportCenterProject: (center) => set({ mapViewportCenterProject: center }),
  getMapViewportCenter: (): { x: number; y: number } => {
    // Return stored viewport center, or default to origin (0, 0)
    const center = useUIStore.getState().mapViewportCenterProject;
    return center ?? { x: 0, y: 0 };
  },

  // Spring-loaded key state
  springLoadedState: null,

  activateSpringLoaded: (targetTool: ToolType) =>
    set((state) => {
      // Don't activate if already in target tool
      if (state.activeTool === targetTool) return state;
      // Don't activate if already spring-loaded
      if (state.springLoadedState) return state;

      return {
        springLoadedState: {
          previousTool: state.activeTool,
          targetTool: targetTool,
          mergeStationA: state.mergeStationA,
          measureStart: state.measureStart,
          measureEnd: state.measureEnd,
          drawFromStation: state.drawFromStation,
          activatedAt: Date.now(),
        },
        activeTool: targetTool,
      };
    }),

  deactivateSpringLoaded: () =>
    set((state) => {
      if (!state.springLoadedState) return state;

      // Only restore if still on the target tool (user didn't manually switch away)
      if (state.activeTool !== state.springLoadedState.targetTool) {
        return { springLoadedState: null };
      }

      const elapsed = Date.now() - state.springLoadedState.activatedAt;
      const HOLD_THRESHOLD_MS = 200;

      if (elapsed > HOLD_THRESHOLD_MS) {
        // Held long enough - restore previous tool and state
        return {
          activeTool: state.springLoadedState.previousTool,
          mergeStationA: state.springLoadedState.mergeStationA,
          measureStart: state.springLoadedState.measureStart,
          measureEnd: state.springLoadedState.measureEnd,
          drawFromStation: state.springLoadedState.drawFromStation,
          springLoadedState: null,
        };
      } else {
        // Tap - keep new tool, just clear spring state
        return { springLoadedState: null };
      }
    }),

  cancelSpringLoaded: () =>
    set((state) => {
      if (!state.springLoadedState) return state;

      // Only restore if still on the target tool (user didn't manually switch away)
      // This mirrors the guard in deactivateSpringLoaded
      if (state.activeTool !== state.springLoadedState.targetTool) {
        return { springLoadedState: null };
      }

      // Force restore previous tool and state (used on blur/unmount to prevent stuck state)
      // Skip threshold check - always restore when canceling
      return {
        activeTool: state.springLoadedState.previousTool,
        mergeStationA: state.springLoadedState.mergeStationA,
        measureStart: state.springLoadedState.measureStart,
        measureEnd: state.springLoadedState.measureEnd,
        drawFromStation: state.springLoadedState.drawFromStation,
        springLoadedState: null,
      };
    }),
}));
