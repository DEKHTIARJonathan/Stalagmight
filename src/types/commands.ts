// Command and IPC payload types generated from Rust.

import type { ShotData, StationRef, Coordinates, GpsCoordinates, ClosureStrategy, ShotUpdates, SectionId, ShotId } from './project';

export type {
  CommandResult,
  IntegrityRepairResult,
  IntegrityCheckResult,
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
  CompassFile,
  CompassSurveySummary,
  WallsFile,
  WallsSurveySummary,
  ImportSectionConfig,
  ImportPlacement,
  SectionRelationships,
  StationPair,
  ClosurePair,
  ClosureUpdate,
  DeleteShotImpact,
  DeleteShotRangeImpact,
  RangeDeleteKind,
  ConnectivityResult,
  ClosurePreview,
  CommentHolder,
  UndoHistoryItem,
  PreviewData,
  FieldChange,
  ExportImageOptions,
  ImageFormat,
  DepthPreset,
  DepthPresetColors,
  ColorStop,
  GpxFile,
  GpxWaypoint,
  GpxTrack,
  GpxTrackSegment,
  GpxTrackPoint,
  GpxRoute,
  GpxRoutePoint,
  GpxSectionPlacement,
  MatchDirection,
  SuggestionConfidence,
  PlacementSuggestion,
  TargetType,
  CrossSectionSuggestion,
  ImportSectionForSuggestion,
  OrphanPlacementSuggestion,
  SegmentGeometry,
  SegmentSectionGeometry,
  // Collaboration mode
  CollabState,
  ShotBaselineEntry,
  CollabChangeSet,
  CollabFieldChange,
  AddedShot,
  EditedShot,
  RemovedShot,
  AddedSection,
  SectionMetaChange,
  CollabWarning,
  MatchQuality,
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
  | { type: 'set_zero_datum'; station_ref: StationRef; coordinates: GpsCoordinates }
  // Per-shot field edit — lets the data-table grid commit a multi-cell edit
  // (paste/fill) as one undo unit. Nested payload uses snake_case (it bypasses
  // Tauri's top-level camelCase conversion). ShotUpdates fields are all optional.
  | { type: 'update_shot'; section_id: SectionId; shot_id: ShotId; updates: ShotUpdates };
