// Command and IPC payload types generated from Rust.

import type { ShotData, StationRef, Coordinates, GpsCoordinates, ClosureStrategy } from './project';

export type {
  CommandResult,
  ValidationWarning,
  WarningSeverity,
  ProjectWarning,
  DmpFile,
  DmpSection,
  DmpShot,
  DmpDirection,
  DmpShotType,
  TmlFile,
  TmlSection,
  TmlShot,
  TmlShotType,
  TmlUnit,
  TmlGeoCoding,
  TmlClosure,
  ImportSectionConfig,
  ImportPlacement,
  SectionRelationships,
  StationPair,
  ClosurePair,
  ClosureUpdate,
  DeleteShotImpact,
  ConnectivityResult,
  ClosurePreview,
  UndoHistoryItem,
  PreviewData,
  FieldChange,
  ExportImageOptions,
  ImageFormat,
  ColorMode,
  DepthPreset,
  DepthPresetColors,
  ColorStop,
} from './ipc.generated';

// Batch command types for execute_batch IPC.
// These match the Rust Command enum variants.
export type BatchCommand =
  | { type: 'create_section'; name?: string; surveyor?: string; date?: string; color: string; direction?: 'in' | 'out'; shots: ShotData[] }
  | { type: 'create_loop_closure'; station_a: StationRef; station_b: StationRef; closure_strategy: ClosureStrategy }
  | { type: 'merge_stations'; station_a: StationRef; station_b: StationRef }
  | { type: 'move_section'; section_id: number; offset: Coordinates }
  | { type: 'move_segment'; section_id: number; offset: Coordinates }
  | { type: 'move_station'; station_ref: StationRef; offset: Coordinates }
  | { type: 'set_zero_datum'; station_ref: StationRef; coordinates: GpsCoordinates };
