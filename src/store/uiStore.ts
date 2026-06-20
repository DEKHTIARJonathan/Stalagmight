import { create } from 'zustand';
import { invokeIpc } from '../utils/ipc';
import { trackAction, checkDialogCancel, trackDialogComplete, trackDisplayState, setDwellState, advanceProjectSeq, trackNav, trackPanelToggle, trackSelect, trackSelectAdd, clearProjectActionSource } from '../utils/telemetry';
import type { Coordinates, DistanceField, PathShot, SectionId, ShotId, StationRef, SectionData } from '../types/project';

export interface CommentTarget {
  type: 'station' | 'shot';
  stationRef?: StationRef;
  sectionId?: SectionId;
  shotId?: ShotId;
  screenPos: { x: number; y: number };
  currentComment: string;
}
import type { AppearanceConfig, PanelsConfig, SyntacticHighlightingConfig, SyntacticHighlightLevel } from '../types/config';
import type { DisplaySettings } from '../types/loading';
import { DISPLAY_DEFAULTS } from './displaySelectors';

// Import tool utilities for internal use and re-export for convenience
import { NON_INTERACTIVE_TOOLS, isNonInteractiveTool } from '../utils/toolUtils';
import { getGroupForTool } from '../utils/toolGroups';
export { NON_INTERACTIVE_TOOLS, isNonInteractiveTool };

export type ResolvedTheme = 'dark' | 'light' | 'cave' | 'dracula' | 'one_dark' | 'solarized_light' | 'catppuccin_latte' | 'nord' | 'catppuccin_mocha';

export type ViewType = 'global' | 'single';

/**
 * Cave geometry display mode.
 * - `measured`: raw survey geometry (the source of truth).
 * - `closureAdjusted`: loop-closure-corrected geometry, derived non-destructively
 *   on the backend. This view is read-only — edits are made in `measured`.
 */
export type GeometryMode = 'measured' | 'closureAdjusted';

/** Geometry mode used before any saved preference exists (first run). */
export const GEOMETRY_MODE_DEFAULT: GeometryMode = 'measured';

export type DmpImportWizardPhase = 'init' | 'suggesting' | 'manual_placing' | 'placing' | 'done';

export type DetailPanelTab = 'details' | 'warnings';

/**
 * A transient "ghost" geometry overlay shown on the map (in survey meters),
 * used to preview a proposed edit before it is committed — e.g. as the user
 * tries different warning-resolution options (issue #57). Structurally matches
 * the map's GhostSectionData so MapCanvas can hand it straight to the survey
 * layer's setGhostSection.
 */
export interface GeometryPreview {
  shots: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>;
  stations: Array<{ x: number; y: number }>;
  color: string;
  mergeStation?: { x: number; y: number };
}

export type ToolType =
  | 'select'
  | 'pan'
  | 'zoom'
  | 'merge'
  | 'measure'
  | 'move_station'
  | 'move_segment'
  | 'move_shot'
  | 'comment'
  | 'move_comment';

/**
 * One endpoint of the ruler/measure tool (#26). A raw map `point` yields only the
 * direct (straight-line) distance; a `station` or `shotPoint` also enables the
 * along-cave-line distance + path tint. `coords` is the 3D position (meters) used
 * for the direct distance; for a `shotPoint` it's interpolated along the shot.
 */
export type MeasureEndpoint =
  | { kind: 'point'; x: number; y: number; z: number }
  | { kind: 'station'; section_id: SectionId; station_index: number; coords: Coordinates }
  | { kind: 'shotPoint'; section_id: SectionId; shot_id: ShotId; t: number; coords: Coordinates };

/** Resolved along-cave-line query result for the current measurement. */
export interface MeasureAlongLine {
  /** Shortest along-cave-line distance, or null when the endpoints are disconnected. */
  alongLine: number | null;
  /** Shots traversed on the path (for tinting). */
  pathShots: PathShot[];
  /** Stations traversed on the path (tinted alongside the shots). */
  pathStations: StationRef[];
}

/** Live shot-snap candidate while the measure tool hovers a shot (not a station).
 *  The on-shot 3D coords are derived from `t` at click time (geometry-mode aware). */
export interface MeasureSnapShot {
  section_id: SectionId;
  shot_id: ShotId;
  t: number;
}

/**
 * Full reset of all ruler/measure state — the single funnel spread by
 * `clearMeasure` and every other reset trigger (tool switch, dialog open,
 * geometry-mode change, project load…).
 */
const MEASURE_CLEARED = {
  measureStart: null,
  measureEnd: null,
  measureDirect: null,
  measureAlongLine: null,
  measureAlongLinePending: false,
  measureSnapShot: null,
};

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

  measureStart: MeasureEndpoint | null;
  measureEnd: MeasureEndpoint | null;
  /** Direct (3D straight-line) distance + depth diff between the two endpoints. */
  measureDirect: { distance: number; depthDiff: number } | null;
  /** Along-cave-line result (null = not computed / not applicable). */
  measureAlongLine: MeasureAlongLine | null;
  /** True while the along-line IPC query is in flight. */
  measureAlongLinePending: boolean;
  /** Live shot-snap candidate (when the measure cursor is over a shot, not a station). */
  measureSnapShot: MeasureSnapShot | null;
  setMeasureStart: (point: MeasureEndpoint | null) => void;
  setMeasureEnd: (point: MeasureEndpoint | null) => void;
  setMeasureDirect: (direct: { distance: number; depthDiff: number } | null) => void;
  setMeasureAlongLine: (result: MeasureAlongLine | null) => void;
  setMeasureAlongLinePending: (pending: boolean) => void;
  setMeasureSnapShot: (snap: MeasureSnapShot | null) => void;
  /** Reset every piece of measure state (endpoints, results, tint, snap). */
  clearMeasure: () => void;

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

  // Data-table fullscreen mode: the table overlays the whole window below the
  // toolbar. Session-only — never persisted, so the app always starts windowed.
  dataTableFullScreen: boolean;
  /** Raw sqlite table browsed read-only while fullscreen (null = the normal
   *  Sections-backed view). Only reachable from the fullscreen toolbar. */
  rawTableSelection: string | null;
  enterDataTableFullScreen: () => void;
  exitDataTableFullScreen: () => void;
  setRawTableSelection: (table: string | null) => void;

  // Section focus mode (#50): double-clicking a section collapses both side
  // panels and opens the data table so the screen is dedicated to one section.
  // Exiting restores the layout captured at entry.
  focusedSectionId: SectionId | null;
  enterSectionFocus: (sectionId: SectionId, dataTableHeight: number) => void;
  exitSectionFocus: () => void;
  /** While focused, follow the selected section so the heading tracks the table
   *  (does not re-snapshot layout or re-fit the map). */
  setFocusedSection: (sectionId: SectionId) => void;

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

  /** Transient ghost-geometry preview on the map (null = none). */
  geometryPreview: GeometryPreview | null;
  setGeometryPreview: (preview: GeometryPreview | null) => void;

  /** Request to open the Warnings tab and start resolving a shot's issue
   *  (e.g. clicking the warning indicator in the data table). */
  requestResolveWarning: { sectionId: SectionId; shotId: ShotId } | null;
  triggerResolveWarning: (sectionId: SectionId, shotId: ShotId) => void;
  clearResolveWarningRequest: () => void;

  /** Progressive zoom-in centered on a shot: each request recenters and zooms
   *  one step closer (used by the resolve view's zoom button, #57). */
  requestZoomToShot: { sectionId: SectionId; shotId: ShotId } | null;
  triggerZoomToShot: (sectionId: SectionId, shotId: ShotId) => void;
  clearZoomToShotRequest: () => void;

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

  // Distance-gradient overlay (#34). Runtime-only — deliberately NOT a
  // DisplayToggleKey: it's a transient analytical overlay (defaults to the
  // entrance each session), so it is never persisted via saveDisplaySetting.
  showDistanceGradient: boolean;
  /** Chosen origin station; `null` = the zero-datum entrance default. */
  distanceGradientOrigin: StationRef | null;
  /** Latest per-station distance field from the backend (null until fetched). */
  distanceField: DistanceField | null;
  /** Toggle the overlay; turning it off clears the origin + cached field. */
  toggleDistanceGradient: () => void;
  setDistanceGradientOrigin: (ref: StationRef | null) => void;
  setDistanceField: (field: DistanceField | null) => void;

  // Issue-severity coloring overlay (#22). Runtime-only — like
  // showDistanceGradient it is NOT a DisplayToggleKey and is never persisted
  // (off on every load; the Warnings-tab auto-switch drives it transiently).
  showIssueSeverity: boolean;
  /** Toggle issue-severity coloring (mutually exclusive with depth/distance). */
  toggleIssueSeverity: () => void;
  /** Set issue-severity coloring explicitly (used by the Warnings-tab
   *  auto-switch). Enabling turns off both gradients. */
  setIssueSeverity: (on: boolean) => void;

  // Geometry display mode (measured vs non-destructive closure-adjusted)
  geometryMode: GeometryMode;
  /** Switch the geometry display mode; persists across sessions (remember last used). */
  setGeometryMode: (mode: GeometryMode, source?: string) => void;

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

  // Syntactic highlighting state
  /** Resolved highlighting level, mirrored from config by useSyntacticHighlighting. */
  syntacticLevel: SyntacticHighlightLevel;
  setSyntacticLevel: (level: SyntacticHighlightLevel) => void;
  /** Temporary highlighting override for live preview in Settings dialog */
  syntacticHighlightPreview: SyntacticHighlightingConfig | null;
  setSyntacticHighlightPreview: (config: SyntacticHighlightingConfig | null) => void;

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

/**
 * Layout captured when entering section-focus mode (#50), restored on exit.
 * Module-level (not store state) since it's internal bookkeeping the UI never
 * reads. Re-focusing a different section while already focused keeps the
 * original snapshot, so exiting always returns to the pre-focus layout.
 */
let focusLayoutSnapshot:
  | {
      sectionsPanelOpen: boolean;
      detailPanelOpen: boolean;
      dataTableOpen: boolean;
      dataTableHeight: number;
    }
  | null = null;

export const useUIStore = create<UIStore>((set) => ({
  // View state
  view: 'global',
  setView: (view) => {
    // Section-focus mode (#50) is single-view, single-project scoped: drop it on
    // any view switch so a stale focus can't outlive the view or project that
    // opened it. No-op when not focused; restores the pre-focus panel layout.
    useUIStore.getState().exitSectionFocus();
    // Fullscreen table is single-view scoped too — a view switch can't strand it.
    useUIStore.getState().exitDataTableFullScreen();
    setDwellState(view === 'global' ? 'global-view' : `tool.${useUIStore.getState().activeTool}`);
    if (view === 'single') {
      void advanceProjectSeq();
      // A project open/create/import flow has landed — the entry-point source
      // has been consumed, so clear it to prevent bleed into a later open.
      clearProjectActionSource();
    }
    // Dev stats is a single-view developer overlay — the Display toggle that
    // controls it lives only in SingleSystemView, but <MemoryProbe/> is mounted
    // app-wide. Reset it on the way back to GlobalView so the probe (and its 2 s
    // memory-IPC poll) can't strand there with no in-view way to hide it.
    //
    // The ruler readout/tint now lives in this global store, but is a single-view,
    // map-only interaction — clear it on any view switch so it can't be resurrected
    // when MapCanvas remounts on return (#26, Codex).
    set(view === 'global'
      ? { view, showDevStats: DISPLAY_DEFAULTS.showDevStats, ...MEASURE_CLEARED }
      : { view, ...MEASURE_CLEARED });
  },

  // Tool state
  activeTool: 'select',
  lastSubtoolByGroup: {},
  setActiveTool: (activeTool) =>
    set((state) => {
      trackAction(`tool.${activeTool}`);
      if (!useUIStore.getState().activeDialog && !useUIStore.getState().placementMode) {
        setDwellState(`tool.${activeTool}`);
      }
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

      // Clear any active ruler measurement when switching to a different tool
      // (#26: "reset … selects a different tool"). The measure tool never holds
      // measure state while another tool is active.
      const clearMeasure = activeTool !== 'measure' &&
        (state.measureStart !== null || state.measureEnd !== null ||
         state.measureAlongLine !== null || state.measureSnapShot !== null)
        ? MEASURE_CLEARED
        : {};

      // Clear hover state when switching to non-interactive tools (pan/zoom)
      // This ensures store consistency regardless of how hover was set
      // Use explicit null checks (not truthiness) because SectionId can be 0
      if (
        isNonInteractiveTool(activeTool) &&
        (state.hoveredStation !== null || state.hoveredShot !== null || state.hoveredSectionId !== null)
      ) {
        return { activeTool, lastSubtoolByGroup, hoveredStation: null, hoveredShot: null, hoveredSectionId: null, ...clearComment, ...clearMoveComment, ...clearMeasure };
      }
      return { activeTool, lastSubtoolByGroup, ...clearComment, ...clearMoveComment, ...clearMeasure };
    }),

  // Selection state
  selection: null,
  multiSelection: [],
  setSelection: (selection) => {
    if (selection) trackSelect(selection.type);
    set({ selection, multiSelection: selection ? [selection] : [] });
  },
  addToSelection: (selection) =>
    set((state) => {
      // Don't add duplicates
      const exists = state.multiSelection.some((s) => selectionsEqual(s, selection));
      if (exists) return state;
      trackSelectAdd(selection.type);
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
  measureDirect: null,
  measureAlongLine: null,
  measureAlongLinePending: false,
  measureSnapShot: null,
  setMeasureStart: (measureStart) => set({ measureStart }),
  setMeasureEnd: (measureEnd) => set({ measureEnd }),
  setMeasureDirect: (measureDirect) => set({ measureDirect }),
  setMeasureAlongLine: (measureAlongLine) => set({ measureAlongLine, measureAlongLinePending: false }),
  setMeasureAlongLinePending: (measureAlongLinePending) => set({ measureAlongLinePending }),
  setMeasureSnapShot: (measureSnapShot) => set({ measureSnapShot }),
  clearMeasure: () => set({ ...MEASURE_CLEARED }),


  // Panel state
  sectionsPanelOpen: true,
  sectionsPanelWidth: 250,
  detailPanelOpen: true,
  detailPanelWidth: 300,
  detailPanelTab: 'details',
  dataTableOpen: false,
  dataTableHeight: 200,
  toggleSectionsPanel: () => {
    const opening = !useUIStore.getState().sectionsPanelOpen;
    trackPanelToggle('sections', opening);
    // Manually changing the layout drops section-focus mode (#50) so the toolbar
    // can't keep showing a focused-section name with the panels reopened. Keep
    // the user's new layout (no snapshot restore); discard the snapshot.
    focusLayoutSnapshot = null;
    set({ sectionsPanelOpen: opening, focusedSectionId: null });
  },
  toggleDetailPanel: () => {
    const opening = !useUIStore.getState().detailPanelOpen;
    trackPanelToggle('detail', opening);
    focusLayoutSnapshot = null;
    set({ detailPanelOpen: opening, focusedSectionId: null });
  },
  toggleDataTable: () => {
    const opening = !useUIStore.getState().dataTableOpen;
    trackPanelToggle('data-table', opening);
    focusLayoutSnapshot = null;
    set({ dataTableOpen: opening, focusedSectionId: null });
  },
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

  // Data-table fullscreen mode (session-only, never persisted)
  dataTableFullScreen: false,
  rawTableSelection: null,
  enterDataTableFullScreen: () => {
    // The overlay grows out of the docked table, so the table must be open.
    set({ dataTableFullScreen: true, dataTableOpen: true });
  },
  exitDataTableFullScreen: () => {
    if (!useUIStore.getState().dataTableFullScreen) return;
    // Leaving fullscreen also leaves the raw-data view: the picker that could
    // switch back to Sections only exists in the fullscreen toolbar.
    set({ dataTableFullScreen: false, rawTableSelection: null });
  },
  setRawTableSelection: (rawTableSelection) => set({ rawTableSelection }),

  // Section focus mode (#50)
  focusedSectionId: null,
  enterSectionFocus: (focusedSectionId, dataTableHeight) => {
    const s = useUIStore.getState();
    // Focus mode is an editable workspace for one section. The closure-adjusted
    // view (#70) is read-only, so entering focus leaves it and returns to the
    // measured geometry — guaranteeing the focused data table is editable.
    if (s.geometryMode !== 'measured') {
      s.setGeometryMode('measured', 'sections-panel');
    }
    // Snapshot the layout only on first entry; re-focusing another section
    // while already focused must not overwrite the pre-focus layout.
    if (s.focusedSectionId === null) {
      focusLayoutSnapshot = {
        sectionsPanelOpen: s.sectionsPanelOpen,
        detailPanelOpen: s.detailPanelOpen,
        dataTableOpen: s.dataTableOpen,
        dataTableHeight: s.dataTableHeight,
      };
    }
    // Set the focus height directly (not via savePanelSizes) so the temporary
    // focus layout is never persisted to the user's panel config. Only apply it
    // when the table opens from closed: a fresh ResizablePanel mount seeds its
    // (uncontrolled) size from this height. If the table is already open we leave
    // its height alone rather than force a remount that would reset DataTable
    // state (selection, scroll).
    set({
      focusedSectionId,
      sectionsPanelOpen: false,
      detailPanelOpen: false,
      dataTableOpen: true,
      ...(s.dataTableOpen ? {} : { dataTableHeight }),
    });
  },
  exitSectionFocus: () => {
    if (useUIStore.getState().focusedSectionId === null) return;
    const snap = focusLayoutSnapshot;
    focusLayoutSnapshot = null;
    // Restores the captured panel layout. The geometry switch to 'measured' on
    // entry is intentionally one-way (per the #50/#70 design resolution): exiting
    // leaves you in measured to keep editing, not back in the read-only view.
    set({ focusedSectionId: null, ...(snap ?? {}) });
  },
  setFocusedSection: (focusedSectionId) => {
    // Only meaningful while already focused (follow the selection). Guarded so it
    // can't enter focus without a layout snapshot.
    if (useUIStore.getState().focusedSectionId === null) return;
    set({ focusedSectionId });
  },

  // Map state
  mapCenter: [0, 0],
  mapZoom: 15,
  setMapCenter: (mapCenter) => set({ mapCenter }),
  setMapZoom: (mapZoom) => set({ mapZoom }),
  requestFitToBounds: false as false | 'animate' | 'snap',
  triggerFitToBounds: (options?) => {
    trackNav('fit-to-bounds');
    set({ requestFitToBounds: options?.snap ? 'snap' : 'animate' });
  },
  clearFitToBoundsRequest: () => set({ requestFitToBounds: false }),
  requestZoomToSection: null,
  triggerZoomToSection: (sectionId: SectionId) => {
    trackNav('zoom-to-section');
    set({ requestZoomToSection: sectionId });
  },
  clearZoomToSectionRequest: () => set({ requestZoomToSection: null }),
  requestPanToShot: null,
  triggerPanToShot: (sectionId: SectionId, shotId: ShotId) => {
    trackNav('pan-to-shot');
    set({ requestPanToShot: { sectionId, shotId } });
  },
  clearPanToShotRequest: () => set({ requestPanToShot: null }),
  requestCenterOnStation: null,
  triggerCenterOnStation: (ref: StationRef) => {
    trackNav('center-on-station');
    set({ requestCenterOnStation: ref });
  },
  clearCenterOnStationRequest: () => set({ requestCenterOnStation: null }),
  requestCenterOnShot: null,
  geometryPreview: null,
  setGeometryPreview: (geometryPreview) => set({ geometryPreview }),
  requestResolveWarning: null,
  triggerResolveWarning: (sectionId: SectionId, shotId: ShotId) => {
    // Make sure the resolve view will actually mount and be visible before
    // requesting it: section-focus and data-table fullscreen hide/cover the
    // detail panel, and the panel may simply be collapsed. WarningsContent only
    // consumes the request while mounted (detailPanelOpen && tab === 'warnings'),
    // so open the panel on the Warnings tab here. (Otherwise the click would be
    // a no-op and the request would sit stale and fire on a later tab switch.)
    const s = useUIStore.getState();
    if (s.focusedSectionId !== null) s.exitSectionFocus();
    if (s.dataTableFullScreen) s.exitDataTableFullScreen();
    set({ requestResolveWarning: { sectionId, shotId }, detailPanelOpen: true, detailPanelTab: 'warnings' });
  },
  clearResolveWarningRequest: () => set({ requestResolveWarning: null }),
  requestZoomToShot: null,
  triggerZoomToShot: (sectionId: SectionId, shotId: ShotId) =>
    set({ requestZoomToShot: { sectionId, shotId } }),
  clearZoomToShotRequest: () => set({ requestZoomToShot: null }),
  triggerCenterOnShot: (sectionId: SectionId, shotId: ShotId) => {
    trackNav('center-on-shot');
    set({ requestCenterOnShot: { sectionId, shotId } });
  },
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
  // Distance-gradient overlay (#34) — runtime-only state, never persisted.
  showDistanceGradient: false,
  distanceGradientOrigin: null,
  distanceField: null,
  toggleDistanceGradient: () => {
    const on = !useUIStore.getState().showDistanceGradient;
    // Distance and depth gradients are mutually exclusive — both paint the shots
    // layer, so enabling one suppresses the other (#34, Daniel's report of mixed
    // depth-colored shots + distance-colored stations). We flip only depth's
    // *runtime* flag, not its persisted setting, so distance acts as a transient
    // overlay and the depth preference returns next session (distance is always
    // off on load). Turning the overlay off clears the origin + cached field, so
    // re-enabling starts fresh at the entrance (zero-datum) default.
    set(
      on
        ? { showDistanceGradient: true, showDepthGradient: false, showIssueSeverity: false }
        : { showDistanceGradient: false, distanceGradientOrigin: null, distanceField: null }
    );
  },
  // Issue-severity coloring (#22) — runtime-only, never persisted.
  showIssueSeverity: false,
  toggleIssueSeverity: () => {
    const on = !useUIStore.getState().showIssueSeverity;
    // Mutually exclusive with both gradients — all three paint the shots/stations
    // layer. Flip depth's *runtime* flag only (don't persist), and clear the
    // distance overlay's origin/field like toggleDistanceGradient does.
    set(
      on
        ? {
            showIssueSeverity: true,
            showDepthGradient: false,
            showDistanceGradient: false,
            distanceGradientOrigin: null,
            distanceField: null,
          }
        : { showIssueSeverity: false }
    );
  },
  setIssueSeverity: (on) => {
    if (useUIStore.getState().showIssueSeverity === on) return;
    set(
      on
        ? {
            showIssueSeverity: true,
            showDepthGradient: false,
            showDistanceGradient: false,
            distanceGradientOrigin: null,
            distanceField: null,
          }
        : { showIssueSeverity: false }
    );
  },
  setDistanceGradientOrigin: (distanceGradientOrigin) =>
    // Clear the cached field so stale colors from the previous origin aren't shown
    // under the new origin's legend/marker while the new field is being fetched.
    set({ distanceGradientOrigin, distanceField: null }),
  setDistanceField: (distanceField) => set({ distanceField }),
  toggleDisplay: (key) => {
    trackAction(`toggle.${key}`);
    const state = useUIStore.getState();
    const newValue = !state[key];
    // Enabling the depth gradient turns off the (runtime-only) distance gradient
    // and issue-severity overlays — all three paint the shots layer (#34, #22).
    const exclusive =
      key === 'showDepthGradient' && newValue
        ? {
            showDistanceGradient: false,
            distanceGradientOrigin: null,
            distanceField: null,
            showIssueSeverity: false,
          }
        : {};
    set({ [key]: newValue, ...exclusive });
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
      let geometryMode: GeometryMode | undefined;
      for (const [key, value] of Object.entries(settings)) {
        if (key.startsWith('show')) {
          displayState[key as DisplayToggleKey] = value === 'true';
        } else if (key === 'gridSpacing') {
          const parsed = parseFloat(value);
          if (!isNaN(parsed) && parsed > 0) {
            gridSpacing = parsed;
          }
        } else if (key === 'geometryMode') {
          // "Remember last used": restore the persisted geometry mode, ignoring
          // any unrecognized value.
          if (value === 'measured' || value === 'closureAdjusted') {
            geometryMode = value;
          }
        }
      }
      // Migration fallback: if we loaded some settings but showShots wasn't among them,
      // default it to true (older saved settings won't have this newer key)
      const hasLoadedSettings =
        Object.keys(displayState).length > 0 || gridSpacing !== undefined || geometryMode !== undefined;
      if (hasLoadedSettings && displayState.showShots === undefined) {
        displayState.showShots = true;
      }
      // geometryMode is per-project ("remember last used"): restore the saved value
      // or reset to the measured default. Applied unconditionally so a project with
      // no saved preference (or no display settings at all) doesn't inherit the
      // previous project's mode.
      set({ geometryMode: geometryMode ?? GEOMETRY_MODE_DEFAULT });
      if (hasLoadedSettings) {
        set({
          ...displayState,
          ...(gridSpacing !== undefined ? { gridSpacing } : {}),
        });
        trackDisplayState(useUIStore.getState());
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
      geometryMode: GEOMETRY_MODE_DEFAULT,
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
      // Dev stats is a session-only developer overlay (memory probe + map dev
      // stats), not a persisted per-project preference and absent from the
      // backend payload. Reset it on every load so enabling it for one project
      // can't leak the overlay — and its 2 s memory-IPC poll — into the next.
      showDevStats: DISPLAY_DEFAULTS.showDevStats,
      // Issue-severity coloring is a runtime-only overlay (never persisted); reset
      // it on every load so a manual enable in one project doesn't leak the
      // traffic-light coloring into the next (issue #57 / Codex). The Warnings-tab
      // auto-switch re-derives it transiently via effectiveIssueSeverity.
      showIssueSeverity: false,
      // Restore the saved geometry mode ("remember last used"). The backend
      // defaults geometryMode to "measured" for projects with no saved
      // preference, so a load is authoritative and never inherits the previous
      // project's mode.
      geometryMode: settings.geometryMode === 'closureAdjusted' ? 'closureAdjusted' : GEOMETRY_MODE_DEFAULT,
    }));
    trackDisplayState(useUIStore.getState());
  },

  // Geometry display mode (measured vs non-destructive closure-adjusted)
  geometryMode: GEOMETRY_MODE_DEFAULT,
  setGeometryMode: (mode, source) => {
    if (useUIStore.getState().geometryMode === mode) return;
    trackAction('toggle.geometryMode', source);
    // Distances depend on the active geometry; a stale ruler readout would lie.
    set({ geometryMode: mode, ...MEASURE_CLEARED });
    // Persist for "remember last used" across sessions (string value, like gridSpacing).
    invokeIpc(
      'save_display_setting',
      { key: 'geometryMode', value: mode },
      { purpose: 'persist display setting', fields: { key: 'geometryMode' } }
    ).catch((e) => {
      console.warn('Failed to save geometry mode:', e);
    });
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
    const prev = useUIStore.getState().activeDialog;
    if (prev) {
      // Dialog chaining — previous dialog transitions, not cancelled
      trackDialogComplete(prev);
      checkDialogCancel(prev);
    }
    trackAction(`dialog.${activeDialog}`);
    setDwellState(`dialog.${activeDialog}`);
    // A ruler readout/tint shouldn't linger behind a dialog (#26 reset).
    set({ activeDialog, dialogData, dmpImportWizardPhase: null, ...MEASURE_CLEARED });
  },
  closeDialog: () => {
    const { activeDialog: dialogName, activeTool, placementMode } = useUIStore.getState();
    if (dialogName) checkDialogCancel(dialogName);
    setDwellState(placementMode ? 'placement' : `tool.${activeTool}`);
    set({ activeDialog: null, dialogData: {}, dmpImportWizardPhase: null });
  },
  setDmpImportWizardPhase: (dmpImportWizardPhase) => set({ dmpImportWizardPhase }),

  // Import flow context
  importContext: null,
  setImportContext: (importContext) => set({ importContext }),

  // Session surveyor memory (not persisted to config)
  lastUsedSurveyor: '',
  setLastUsedSurveyor: (lastUsedSurveyor) => set({ lastUsedSurveyor }),

  // Placement mode state
  placementMode: null,
  startPlacementMode: (sectionData, alignStationIndex, onComplete, onCancel, additionalSections) => {
    setDwellState('placement');
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
      // Placement and the ruler readout both occupy top-center (#26 reset).
      ...MEASURE_CLEARED,
    });
  },
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
  cancelPlacementMode: () => {
    setDwellState(`tool.${useUIStore.getState().activeTool}`);
    set({ placementMode: null });
  },
  confirmPlacement: (): PlacementModeState | null => {
    const currentPlacement = useUIStore.getState().placementMode;
    // Clear placement mode and return the state for the caller to use
    setDwellState(`tool.${useUIStore.getState().activeTool}`);
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

  // Syntactic highlighting state (opt-out default: full)
  syntacticLevel: 'full' as SyntacticHighlightLevel,
  setSyntacticLevel: (syntacticLevel) => set({ syntacticLevel }),
  syntacticHighlightPreview: null,
  setSyntacticHighlightPreview: (syntacticHighlightPreview) => set({ syntacticHighlightPreview }),

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
