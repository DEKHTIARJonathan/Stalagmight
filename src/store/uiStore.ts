import { create } from 'zustand';
import type { Coordinates, SectionId, ShotId, StationRef } from '../types/project';

export type ViewType = 'global' | 'single';

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
  dataTableOpen: boolean;
  dataTableHeight: number;
  toggleSectionsPanel: () => void;
  toggleDetailPanel: () => void;
  toggleDataTable: () => void;
  setSectionsPanelWidth: (width: number) => void;
  setDetailPanelWidth: (width: number) => void;
  setDataTableHeight: (height: number) => void;

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
  showShotData: boolean;
  showVirtualShots: boolean;
  showZeroDatum: boolean;
  showGrid: boolean;
  showScaleBar: boolean;
  showSatellite: boolean;
  showDepthGradient: boolean;
  toggleDisplay: (key: DisplayToggleKey) => void;

  // Hover state
  hoveredStation: StationRef | null;
  hoveredShot: { sectionId: SectionId; shotId: ShotId } | null;
  setHoveredStation: (ref: StationRef | null) => void;
  setHoveredShot: (shot: { sectionId: SectionId; shotId: ShotId } | null) => void;

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
}

type DisplayToggleKey =
  | 'showStations'
  | 'showSectionNames'
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
  dataTableOpen: false,
  dataTableHeight: 200,
  toggleSectionsPanel: () => set((state) => ({ sectionsPanelOpen: !state.sectionsPanelOpen })),
  toggleDetailPanel: () => set((state) => ({ detailPanelOpen: !state.detailPanelOpen })),
  toggleDataTable: () => set((state) => ({ dataTableOpen: !state.dataTableOpen })),
  setSectionsPanelWidth: (sectionsPanelWidth) => set({ sectionsPanelWidth }),
  setDetailPanelWidth: (detailPanelWidth) => set({ detailPanelWidth }),
  setDataTableHeight: (dataTableHeight) => set({ dataTableHeight }),

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
  showShotData: false,
  showVirtualShots: true,
  showZeroDatum: true,
  showGrid: false,
  showScaleBar: true,
  showSatellite: false,
  showDepthGradient: false,
  toggleDisplay: (key) => set((state) => ({ [key]: !state[key] })),

  // Hover state
  hoveredStation: null,
  hoveredShot: null,
  setHoveredStation: (hoveredStation) => set({ hoveredStation }),
  setHoveredShot: (hoveredShot) => set({ hoveredShot }),

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
}));
