import { create } from 'zustand';
import type { SectionId, ShotId, StationRef } from '../types/project';

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
  clearSelection: () => void;

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
    set((state) => ({
      multiSelection: [...state.multiSelection, selection],
      selection: selection,
    })),
  removeFromSelection: (selection) =>
    set((state) => ({
      multiSelection: state.multiSelection.filter((s) => {
        if (s.type !== selection.type) return true;
        if (s.type === 'station' && selection.type === 'station') {
          return (
            s.stationRef?.section_id !== selection.stationRef?.section_id ||
            s.stationRef?.station_index !== selection.stationRef?.station_index
          );
        }
        if (s.type === 'shot' && selection.type === 'shot') {
          return s.sectionId !== selection.sectionId || s.shotId !== selection.shotId;
        }
        if (s.type === 'section' && selection.type === 'section') {
          return s.sectionId !== selection.sectionId;
        }
        return true;
      }),
    })),
  clearSelection: () => set({ selection: null, multiSelection: [] }),

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
