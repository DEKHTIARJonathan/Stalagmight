// Command types for Tauri IPC

export interface CommandResult {
  success: boolean;
  warnings: ValidationWarning[];
  error: string | null;
}

export interface ValidationWarning {
  code: string;
  message: string;
  severity: 'warning' | 'error';
}

export interface ProjectWarning {
  section_id: number;
  shot_id: number;
  shot_index: number;
  code: string;
  message: string;
  severity: 'warning' | 'error';
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
}

// Export types
export type ImageFormat = 'png' | 'svg' | 'pdf';

export interface ExportImageOptions {
  format: ImageFormat;
  dpi: number;
  include_satellite: boolean;
  include_grid: boolean;
  include_labels: boolean;
  include_section_names: boolean;
  include_shot_data: boolean;
}
