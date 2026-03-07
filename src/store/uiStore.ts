import { create } from 'zustand';
import { invokeIpc } from '../utils/ipc';
import { trackAction } from '../utils/telemetry';
import type { Coordinates, SectionId, ShotId, StationRef, SectionData } from '../types/project';

export interface CommentTarget {
  type: 'station' | 'shot';
  stationRef?: StationRef;
  sectionId?: SectionId;
  shotId?: ShotId;
  screenPos: { x: number; y: number };
  currentComment: string;
}
import type { AppearanceConfig, PanelsConfig } from '../types/config';
import type { DisplaySettings } from '../types/loading';
import { DISPLAY_DEFAULTS } from './displaySelectors';

// Import tool utilities for internal use and re-export for convenience
import { NON_INTERACTIVE_TOOLS, isNonInteractiveTool } from '../utils/toolUtils';
import { getGroupForTool } from '../utils/toolGroups';
export { NON_INTERACTIVE_TOOLS, isNonInteractiveTool };

export type ResolvedTheme = 'dark' | 'light' | 'cave' | 'dracula' | 'one_dark' | 'solarized_light' | 'catppuccin_latte' | 'nord' | 'catppuccin_mocha';

export type ViewType = 'global' | 'single';
export type DmpImportWizardPhase = 'init' | 'suggesting' | 'manual_placing' | 'placing' | 'done';

export type DetailPanelTab = 'details' | 'warnings';

export type ToolType =
  | 'select'
  | 'pan'
  | 'zoom'
  | 'draw'
  | 'delete'
  | 'merge'
  | 'measure'
  | 'move_station'
  | 'move_segment'
  | 'move_shot'
  | 'comment'
  | 'move_comment';

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
/** Additional section to render alongside the primary placement section. */
export interface AdditionalPlacementSection {
  sectionData: SectionData;
  color: string;
  offsetX: number;  // meters relative to primary section station 0
  offsetY: number;
}

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
  /** Additional sections to render alongside primary (for segment placement) */
  additionalSections?: AdditionalPlacementSection[];
}

export interface Selection {
  type: 'station' | 'shot' | 'section';
  stationRef?: StationRef;
  sectionId?: SectionId;
  shotId?: ShotId;
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
  lastSubtoolByGroup: Record<string, ToolType>;
  setActiveTool: (tool: ToolType) => void;

  // Selection state
  selection: Selection | null;
  multiSelection: Selection[];
  setSelection: (selection: Selection | null) => void;
  addToSelection: (selection: Selection) => void;
  removeFromSelection: (selection: Selection) => void;
  toggleSelection: (selection: Selection) => void;
  clearSelection: () => void;
  clearSelectionByType: (type: 'station' | 'shot' | 'section') => void;
  filterSelection: (predicate: (s: Selection) => boolean) => void;
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
  requestFitToBounds: false | 'animate' | 'snap';
  triggerFitToBounds: (options?: { snap?: boolean }) => void;
  clearFitToBoundsRequest: () => void;
  requestZoomToSection: SectionId | null;
  triggerZoomToSection: (sectionId: SectionId) => void;
  clearZoomToSectionRequest: () => void;
  requestPanToShot: { sectionId: SectionId; shotId: ShotId } | null;
  triggerPanToShot: (sectionId: SectionId, shotId: ShotId) => void;
  clearPanToShotRequest: () => void;
  requestCenterOnStation: StationRef | null;
  triggerCenterOnStation: (ref: StationRef) => void;
  clearCenterOnStationRequest: () => void;
  requestCenterOnShot: { sectionId: SectionId; shotId: ShotId } | null;
  triggerCenterOnShot: (sectionId: SectionId, shotId: ShotId) => void;
  clearCenterOnShotRequest: () => void;

  // Display toggles
  showStations: boolean;
  showShots: boolean;
  showSectionNames: boolean;
  showStationLabels: boolean;
  showShotData: boolean;
  showReferenceShots: boolean;
  showZeroDatum: boolean;
  showGrid: boolean;
  showScaleBar: boolean;
  showSatellite: boolean;
  showDepthGradient: boolean;
  showStationComments: boolean;
  showShotComments: boolean;
  showDevStats: boolean;
  gridSpacing: number;
  toggleDisplay: (key: DisplayToggleKey) => void;
  setGridSpacing: (spacing: number) => void;
  loadDisplaySettings: () => Promise<void>;
  saveDisplaySetting: (key: DisplayToggleKey, value: boolean) => Promise<void>;
  resetDisplaySettings: () => void;
  /** Apply display settings from backend (merges with existing state using ??) */
  applyDisplaySettings: (settings: DisplaySettings) => void;

  // Hover state
  hoveredStation: StationRef | null;
  hoveredShot: { sectionId: SectionId; shotId: ShotId } | null;
  hoveredSectionId: SectionId | null;
  setHoveredStation: (ref: StationRef | null) => void;
  setHoveredShot: (shot: { sectionId: SectionId; shotId: ShotId } | null) => void;
  setHoveredSectionId: (sectionId: SectionId | null) => void;

  // Toast state (per-key throttling)
  toast: { message: string; key: string; timestamp: number } | null;
  lastToastByKey: Record<string, number>;
  showToast: (message: string, key: string) => void;
  clearToast: () => void;

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
  dmpImportWizardPhase: DmpImportWizardPhase | null;
  openDialog: (dialog: string, data?: Record<string, unknown>) => void;
  closeDialog: () => void;
  setDmpImportWizardPhase: (phase: DmpImportWizardPhase | null) => void;

  // Import flow context
  importContext: 'new-project' | 'existing-project' | null;
  setImportContext: (context: 'new-project' | 'existing-project' | null) => void;

  // Session surveyor memory (not persisted to config)
  lastUsedSurveyor: string;
  setLastUsedSurveyor: (surveyor: string) => void;

  // Placement mode state (for manual map placement of imported sections)
  placementMode: PlacementModeState | null;
  startPlacementMode: (
    sectionData: SectionData,
    alignStationIndex: number,
    onComplete?: (result: PlacementResult) => void,
    onCancel?: () => void,
    additionalSections?: AdditionalPlacementSection[],
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

  // Theme state
  resolvedTheme: ResolvedTheme;
  setResolvedTheme: (theme: ResolvedTheme) => void;
  /** Temporary theme override for live preview in Settings dialog */
  themePreview: AppearanceConfig | null;
  setThemePreview: (appearance: AppearanceConfig | null) => void;

  // Comment tool state
  commentTarget: CommentTarget | null;
  setCommentTarget: (target: CommentTarget | null) => void;
  clearCommentTarget: () => void;

  // Move comment tool state
  moveCommentSource: {
    type: 'station' | 'shot';
    stationRef?: StationRef;
    sectionId?: SectionId;
    shotId?: ShotId;
    comment: string;
    /** Screen position of the click that picked up the comment (for cursor tag) */
    screenPos?: { x: number; y: number };
  } | null;
  setMoveCommentSource: (source: UIStore['moveCommentSource']) => void;
  clearMoveCommentSource: () => void;

  // ARIA selection announcements for screen readers
  selectionAnnouncement: string;
  announceSelection: (message: string) => void;
}

export type DisplayToggleKey =
  | 'showStations'
  | 'showShots'
  | 'showSectionNames'
  | 'showStationLabels'
  | 'showShotData'
  | 'showReferenceShots'
  | 'showZeroDatum'
  | 'showGrid'
  | 'showScaleBar'
  | 'showSatellite'
  | 'showDepthGradient'
  | 'showStationComments'
  | 'showShotComments'
  | 'showDevStats';

export const useUIStore = create<UIStore>((set) => ({
  // View state
  view: 'global',
  setView: (view) => set({ view }),

  // Tool state
  activeTool: 'select',
  lastSubtoolByGroup: {},
  setActiveTool: (activeTool) =>
    set((state) => {
      trackAction(`tool.${activeTool}`);
      // Track last-used subtool per group
      const group = getGroupForTool(activeTool);
      const lastSubtoolByGroup = group
        ? { ...state.lastSubtoolByGroup, [group.id]: activeTool }
        : state.lastSubtoolByGroup;

      // Clear comment target when switching away from comment tool
      const clearComment = state.commentTarget !== null && activeTool !== 'comment'
        ? { commentTarget: null }
        : {};

      // Clear move comment source when switching away from move_comment tool
      // No backend restore needed — pickup doesn't mutate backend
      const clearMoveComment = state.moveCommentSource !== null && activeTool !== 'move_comment'
        ? { moveCommentSource: null }
        : {};

      // Clear hover state when switching to non-interactive tools (pan/zoom)
      // This ensures store consistency regardless of how hover was set
      // Use explicit null checks (not truthiness) because SectionId can be 0
      if (
        isNonInteractiveTool(activeTool) &&
        (state.hoveredStation !== null || state.hoveredShot !== null || state.hoveredSectionId !== null)
      ) {
        return { activeTool, lastSubtoolByGroup, hoveredStation: null, hoveredShot: null, hoveredSectionId: null, ...clearComment, ...clearMoveComment };
      }
      return { activeTool, lastSubtoolByGroup, ...clearComment, ...clearMoveComment };
    }),

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
  clearSelectionByType: (type) =>
    set((state) => {
      const filteredMulti = state.multiSelection.filter((s) => s.type !== type);
      // If current selection is being cleared, update to last remaining item
      const newSelection =
        state.selection?.type === type
          ? (filteredMulti[filteredMulti.length - 1] ?? null)
          : state.selection;
      return {
        selection: newSelection,
        multiSelection: filteredMulti,
      };
    }),
  filterSelection: (predicate) =>
    set((state) => {
      const filteredMulti = state.multiSelection.filter(predicate);
      // If current selection fails predicate, update to last remaining item
      const newSelection =
        state.selection && predicate(state.selection)
          ? state.selection
          : (filteredMulti[filteredMulti.length - 1] ?? null);
      return {
        selection: newSelection,
        multiSelection: filteredMulti,
      };
    }),
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
      await invokeIpc(
        'update_panel_sizes',
        {
          sectionsPanelWidth,
          detailPanelWidth,
          dataTableHeight,
        },
        { purpose: 'persist panel layout', fields: { sectionsPanelWidth, detailPanelWidth, dataTableHeight } }
      );
    } catch (e) {
      console.error('Failed to save panel sizes:', e);
    }
  },

  // Map state
  mapCenter: [0, 0],
  mapZoom: 15,
  setMapCenter: (mapCenter) => set({ mapCenter }),
  setMapZoom: (mapZoom) => set({ mapZoom }),
  requestFitToBounds: false as false | 'animate' | 'snap',
  triggerFitToBounds: (options?) => set({ requestFitToBounds: options?.snap ? 'snap' : 'animate' }),
  clearFitToBoundsRequest: () => set({ requestFitToBounds: false }),
  requestZoomToSection: null,
  triggerZoomToSection: (sectionId: SectionId) => set({ requestZoomToSection: sectionId }),
  clearZoomToSectionRequest: () => set({ requestZoomToSection: null }),
  requestPanToShot: null,
  triggerPanToShot: (sectionId: SectionId, shotId: ShotId) => set({ requestPanToShot: { sectionId, shotId } }),
  clearPanToShotRequest: () => set({ requestPanToShot: null }),
  requestCenterOnStation: null,
  triggerCenterOnStation: (ref: StationRef) => set({ requestCenterOnStation: ref }),
  clearCenterOnStationRequest: () => set({ requestCenterOnStation: null }),
  requestCenterOnShot: null,
  triggerCenterOnShot: (sectionId: SectionId, shotId: ShotId) => set({ requestCenterOnShot: { sectionId, shotId } }),
  clearCenterOnShotRequest: () => set({ requestCenterOnShot: null }),

  // Display toggles (initial values from DISPLAY_DEFAULTS - single source of truth)
  showStations: DISPLAY_DEFAULTS.showStations,
  showShots: DISPLAY_DEFAULTS.showShots,
  showSectionNames: DISPLAY_DEFAULTS.showSectionNames,
  showStationLabels: DISPLAY_DEFAULTS.showStationLabels,
  showShotData: DISPLAY_DEFAULTS.showShotData,
  showReferenceShots: DISPLAY_DEFAULTS.showReferenceShots,
  showZeroDatum: DISPLAY_DEFAULTS.showZeroDatum,
  showGrid: DISPLAY_DEFAULTS.showGrid,
  showScaleBar: DISPLAY_DEFAULTS.showScaleBar,
  showSatellite: DISPLAY_DEFAULTS.showSatellite,
  showDepthGradient: DISPLAY_DEFAULTS.showDepthGradient,
  showStationComments: DISPLAY_DEFAULTS.showStationComments,
  showShotComments: DISPLAY_DEFAULTS.showShotComments,
  showDevStats: DISPLAY_DEFAULTS.showDevStats,
  gridSpacing: DISPLAY_DEFAULTS.gridSpacing,
  toggleDisplay: (key) => {
    trackAction(`toggle.${key}`);
    const state = useUIStore.getState();
    const newValue = !state[key];
    set({ [key]: newValue });
    // Persist the setting asynchronously via the helper
    state.saveDisplaySetting(key, newValue);
  },
  setGridSpacing: (spacing) => {
    set({ gridSpacing: spacing });
    // Persist the spacing setting
    invokeIpc(
      'save_display_setting',
      { key: 'gridSpacing', value: String(spacing) },
      { purpose: 'persist display setting', fields: { key: 'gridSpacing' } }
    ).catch((e) => {
      console.warn('Failed to save grid spacing:', e);
    });
  },
  loadDisplaySettings: async () => {
    try {
      const settings = await invokeIpc<Record<string, string>>('load_display_settings', undefined, {
        purpose: 'load display settings for UI',
      });
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
      // Migration fallback: if we loaded some settings but showShots wasn't among them,
      // default it to true (older saved settings won't have this newer key)
      const hasLoadedSettings = Object.keys(displayState).length > 0 || gridSpacing !== undefined;
      if (hasLoadedSettings && displayState.showShots === undefined) {
        displayState.showShots = true;
      }
      if (hasLoadedSettings) {
        set({ ...displayState, ...(gridSpacing !== undefined ? { gridSpacing } : {}) });
      }
    } catch (e) {
      // No project open or other error - use defaults
      console.warn('Failed to load display settings:', e);
    }
  },
  saveDisplaySetting: async (key, value) => {
    try {
      await invokeIpc('save_display_setting', { key, value: String(value) }, {
        purpose: 'persist display setting',
        fields: { key: String(key) },
      });
    } catch (e) {
      console.warn('Failed to save display setting:', e);
    }
  },
  resetDisplaySettings: () => {
    // Reset all display toggles to their default values (from DISPLAY_DEFAULTS - single source of truth)
    set({
      showStations: DISPLAY_DEFAULTS.showStations,
      showShots: DISPLAY_DEFAULTS.showShots,
      showSectionNames: DISPLAY_DEFAULTS.showSectionNames,
      showStationLabels: DISPLAY_DEFAULTS.showStationLabels,
      showShotData: DISPLAY_DEFAULTS.showShotData,
      showReferenceShots: DISPLAY_DEFAULTS.showReferenceShots,
      showZeroDatum: DISPLAY_DEFAULTS.showZeroDatum,
      showGrid: DISPLAY_DEFAULTS.showGrid,
      showScaleBar: DISPLAY_DEFAULTS.showScaleBar,
      showSatellite: DISPLAY_DEFAULTS.showSatellite,
      showDepthGradient: DISPLAY_DEFAULTS.showDepthGradient,
  showStationComments: DISPLAY_DEFAULTS.showStationComments,
      showShotComments: DISPLAY_DEFAULTS.showShotComments,
      showDevStats: DISPLAY_DEFAULTS.showDevStats,
      gridSpacing: DISPLAY_DEFAULTS.gridSpacing,
    });
  },

  applyDisplaySettings: (settings: DisplaySettings) => {
    // Apply display settings from backend, merging with existing state.
    // Uses ?? to only apply fields that are defined, preserving current state for undefined fields.
    // EXACT 11 fields matching uiStore - NO showShots, NO colorBy (those aren't persisted).
    set((state) => ({
      showStations: settings.showStations ?? state.showStations,
      showSectionNames: settings.showSectionNames ?? state.showSectionNames,
      showStationLabels: settings.showStationLabels ?? state.showStationLabels,
      showShotData: settings.showShotData ?? state.showShotData,
      showReferenceShots: settings.showReferenceShots ?? state.showReferenceShots,
      showZeroDatum: settings.showZeroDatum ?? state.showZeroDatum,
      showGrid: settings.showGrid ?? state.showGrid,
      showScaleBar: settings.showScaleBar ?? state.showScaleBar,
      showSatellite: settings.showSatellite ?? state.showSatellite,
      showDepthGradient: settings.showDepthGradient ?? state.showDepthGradient,
      showStationComments: settings.showStationComments ?? state.showStationComments,
      gridSpacing: settings.gridSpacing ?? state.gridSpacing,
    }));
  },

  // Hover state
  hoveredStation: null,
  hoveredShot: null,
  hoveredSectionId: null,
  setHoveredStation: (hoveredStation) => set({ hoveredStation }),
  setHoveredShot: (hoveredShot) => set({ hoveredShot }),
  setHoveredSectionId: (hoveredSectionId) => set({ hoveredSectionId }),

  // Toast state (per-key throttling)
  toast: null,
  lastToastByKey: {},
  showToast: (message, key) => {
    const now = Date.now();
    const lastTime = useUIStore.getState().lastToastByKey[key] || 0;

    // Throttle: only show if no recent toast for this key (5 second cooldown)
    if (now - lastTime > 5000) {
      set({
        toast: { message, key, timestamp: now },
        lastToastByKey: { ...useUIStore.getState().lastToastByKey, [key]: now },
      });
      // Auto-clear after 3 seconds
      setTimeout(() => {
        const t = useUIStore.getState().toast;
        if (t && t.timestamp === now) {
          set({ toast: null });
        }
      }, 3000);
    }
  },
  clearToast: () => set({ toast: null }),

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
  dmpImportWizardPhase: null,
  openDialog: (activeDialog, dialogData = {}) => {
    trackAction(`dialog.${activeDialog}`);
    set({ activeDialog, dialogData, dmpImportWizardPhase: null });
  },
  closeDialog: () => set({ activeDialog: null, dialogData: {}, dmpImportWizardPhase: null }),
  setDmpImportWizardPhase: (dmpImportWizardPhase) => set({ dmpImportWizardPhase }),

  // Import flow context
  importContext: null,
  setImportContext: (importContext) => set({ importContext }),

  // Session surveyor memory (not persisted to config)
  lastUsedSurveyor: '',
  setLastUsedSurveyor: (lastUsedSurveyor) => set({ lastUsedSurveyor }),

  // Placement mode state
  placementMode: null,
  startPlacementMode: (sectionData, alignStationIndex, onComplete, onCancel, additionalSections) =>
    set({
      placementMode: {
        sectionData,
        alignStationIndex,
        cursorPosition: null,
        snappedToStation: null,
        ...(onComplete !== undefined && { onComplete }),
        ...(onCancel !== undefined && { onCancel }),
        ...(additionalSections !== undefined && { additionalSections }),
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

  // Theme state
  resolvedTheme: 'dark' as ResolvedTheme,
  setResolvedTheme: (resolvedTheme: ResolvedTheme) => set({ resolvedTheme }),
  themePreview: null,
  setThemePreview: (themePreview) => set({ themePreview }),

  // Comment tool state
  commentTarget: null,
  setCommentTarget: (commentTarget) => set({ commentTarget }),
  clearCommentTarget: () => set({ commentTarget: null }),

  // Move comment tool state
  moveCommentSource: null,
  setMoveCommentSource: (moveCommentSource) => set({ moveCommentSource }),
  clearMoveCommentSource: () => set({ moveCommentSource: null }),

  // ARIA selection announcements for screen readers
  selectionAnnouncement: '',
  announceSelection: (message) => set({ selectionAnnouncement: message }),
}));
