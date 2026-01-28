// Command types for Tauri IPC

import type { ShotData, StationRef, ClosureStrategy, Coordinates } from './project';

export interface CommandResult {
  success: boolean;
  warnings: ValidationWarning[];
  error: string | null;
  /** ID of the created section (for CreateSection command) */
  section_id?: number;
  /** IDs of created sections (for Batch commands containing CreateSection) */
  section_ids?: number[];
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
  | { type: 'merge_stations'; station_a: StationRef; station_b: StationRef; closure_strategy: ClosureStrategy }
  | { type: 'move_section'; section_id: number; offset: Coordinates }
  | { type: 'set_zero_datum'; station_ref: StationRef; coordinates: { latitude: number; longitude: number; depth_reference: number } };

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
