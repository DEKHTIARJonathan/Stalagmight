// Command types for Tauri IPC

import type { ShotData, StationRef, Coordinates } from './project';

export interface CommandResult {
  success: boolean;
  warnings: ValidationWarning[];
  error: string | null;
  /** ID of the created section (for CreateSection command) */
  section_id?: number;
  /** IDs of created sections (for Batch commands containing CreateSection) */
  section_ids?: number[];
  /** ID of the created shot (for CreateShot command) */
  shot_id?: number;
}

export interface ValidationWarning {
  code: string;
  message: string;
  severity: 'warning' | 'error';
}

export interface ProjectWarning {
  sectionId: number;
  shotId: number;
  shotIndex: number;
  code: string;
  message: string;
  severity: 'warning' | 'error';
  isResolved: boolean;
}

// DMP import types
export interface DmpFile {
  version: number;
  sections: DmpSection[];
}

export interface DmpSection {
  name: string;
  direction: 'in' | 'out';
  date: string;
  shots: DmpShot[];
}

export interface DmpShot {
  shot_type: 'Standard' | 'CsA' | 'CsB' | 'EndOfSurvey';
  heading_in: number;
  heading_out: number;
  length: number;
  depth_in: number;
  depth_out: number;
  pitch_in: number;
  pitch_out: number;
  left: number;
  right: number;
  up: number;
  down: number;
  temperature: number;
  hour: number;
  minute: number;
  second: number;
  marker_index: number;
  comment?: string;
}

// Batch command types for execute_batch IPC
// These match the Rust Command enum variants

export type BatchCommand =
  | { type: 'create_section'; name?: string; surveyor?: string; date?: string; color: string; direction?: 'in' | 'out'; shots: ShotData[] }
  | { type: 'merge_stations'; station_a: StationRef; station_b: StationRef }
  | { type: 'move_section'; section_id: number; offset: Coordinates }
  | { type: 'move_segment'; section_id: number; offset: Coordinates }
  | { type: 'move_station'; station_ref: StationRef; offset: Coordinates }
  | { type: 'set_zero_datum'; station_ref: StationRef; coordinates: { latitude: number; longitude: number; depth_reference: number } };

// Section relationships (for section deletion dialog)
export interface SectionRelationships {
  merges: { station_a: StationRef; station_b: StationRef; merged_at: string }[];
  closures: { id: number; station_a: StationRef; station_b: StationRef; path_length: number; misclosure_distance: number; error_percentage: number; horizontal_misclosure: number; vertical_misclosure: number }[];
  has_section_offset: boolean;
  station_offset_count: number;
  zero_datum_count: number;
}

// Station connectivity check result
export interface ConnectivityResult {
  connected: boolean;
  preview: ClosurePreview | null;
  can_merge: boolean;
  reason: string | null;
}

export interface ClosurePreview {
  path_length: number;
  misclosure_distance: number;
  error_percentage: number;
  horizontal_misclosure: number;
  vertical_misclosure: number;
}

// Undo history types (match backend UndoHistoryItem)
export interface FieldChange {
  field: string;
  oldValue: string;
  newValue: string;
}

export interface PreviewData {
  changes: FieldChange[];
  additionalChanges: number;
}

export interface UndoHistoryItem {
  index: number;
  description: string;
  timestamp: string | null;
  commandType: string;
  previewData: PreviewData | null;
}

// Export types
export type ImageFormat = 'png' | 'svg' | 'pdf';
export type ColorMode = 'section' | 'depth';
export type DepthPreset = 'thermal' | 'ocean' | 'terrain' | 'grayscale' | 'accessible';

export interface ExportImageOptions {
  format: ImageFormat;
  dpi: number;
  include_satellite: boolean;
  include_grid: boolean;
  include_labels: boolean;
  include_section_names: boolean;
  include_shot_data: boolean;
  color_mode: ColorMode;
  depth_preset: DepthPreset;
  include_legend: boolean;
  depth_unit: string;
  decimal_precision: number;
}
