import { create } from 'zustand';
import type { ExportImageOptions } from '../types/commands';

export type ExportType = 'data' | 'image';
export type DataFormat = 'csv' | 'json' | 'tml';

/**
 * Default image-export options. Mirrors the backend `ExportImageOptions::default`
 * (PNG / 300 DPI / threshold 2 / labels on) with colors off — coloring is
 * opt-in and raster-only (SVG stays monochrome).
 */
export const DEFAULT_IMAGE_OPTIONS: ExportImageOptions = {
  format: 'png',
  dpi: 300,
  branching_threshold: 2,
  show_penetration_labels: true,
  color_mode: 'none',
};

/**
 * Shared Export-mode UI state. Lets the inline `ExportControls` in the Export
 * workspace-mode panel and the large WYSIWYG preview in the map area read/write
 * the same options. The modal Export dialog keeps its OWN local state instead
 * (so it always opens on the data/CSV default its e2e suite asserts) — this
 * store is panel + center only.
 *
 * Defaults to the image type because Export mode is map-centric: entering it
 * should immediately show the map preview.
 */
interface ExportState {
  exportType: ExportType;
  dataFormat: DataFormat;
  imageOptions: ExportImageOptions;
  setExportType: (t: ExportType) => void;
  setDataFormat: (f: DataFormat) => void;
  setImageOptions: (o: ExportImageOptions) => void;
}

export const useExportStore = create<ExportState>((set) => ({
  exportType: 'image',
  dataFormat: 'csv',
  imageOptions: DEFAULT_IMAGE_OPTIONS,
  setExportType: (exportType) => set({ exportType }),
  setDataFormat: (dataFormat) => set({ dataFormat }),
  setImageOptions: (imageOptions) => set({ imageOptions }),
}));
