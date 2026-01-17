// Types matching Rust models

export type ShotId = number;
export type SectionId = number;

/** Survey direction - In = entering cave, Out = exiting */
export type SurveyDirection = 'in' | 'out';

export interface Shot {
  id: ShotId;
  azimuth_in: number;
  azimuth_out: number;
  length: number;
  depth_in: number;
  depth_out: number;
  pitch_in: number | null;
  pitch_out: number | null;
  left: number | null;
  right: number | null;
  up: number | null;
  down: number | null;
  comment: string | null;
  is_virtual: boolean;
  marker_index: number | null;
  temperature: number | null;
}

export interface ShotData {
  azimuth_in: number;
  azimuth_out: number;
  length: number;
  depth_in: number;
  depth_out: number;
  pitch_in?: number | null;
  pitch_out?: number | null;
  left?: number | null;
  right?: number | null;
  up?: number | null;
  down?: number | null;
  comment?: string | null;
  is_virtual?: boolean;
  marker_index?: number | null;
  temperature?: number | null;
}

export interface ShotUpdates {
  azimuth_in?: number;
  azimuth_out?: number;
  length?: number;
  depth_in?: number;
  depth_out?: number;
  pitch_in?: number | null;
  pitch_out?: number | null;
  left?: number | null;
  right?: number | null;
  up?: number | null;
  down?: number | null;
  comment?: string | null;
  is_virtual?: boolean;
  marker_index?: number | null;
  temperature?: number | null;
}

export interface Section {
  id: SectionId;
  name: string | null;
  surveyor: string | null;
  date: string | null;
  color: string;
  direction: SurveyDirection;
  shots: Shot[];
}

export interface SectionData {
  name?: string | null;
  surveyor?: string | null;
  date?: string | null;
  color: string;
  direction?: SurveyDirection;
  shots: ShotData[];
}

export interface SectionUpdates {
  name?: string | null;
  surveyor?: string | null;
  date?: string | null;
  color?: string;
  direction?: SurveyDirection;
}

export interface SectionStats {
  shot_count: number;
  total_length: number;
  min_depth: number;
  max_depth: number;
  virtual_shot_count: number;
}

export interface StationRef {
  section_id: SectionId;
  station_index: number;
}

export interface GpsCoordinates {
  latitude: number;
  longitude: number;
  depth_reference: number;
}

export interface GpsBounds {
  min_lat: number;
  max_lat: number;
  min_lng: number;
  max_lng: number;
}

export interface Coordinates {
  x: number;
  y: number;
  z: number;
}

export interface Station {
  station_ref: StationRef;
  coordinates: Coordinates;
  is_zero_datum: boolean;
  gps_coordinates: GpsCoordinates | null;
  merged_with: StationRef[];
}

export interface StationMerge {
  station_a: StationRef;
  station_b: StationRef;
  merged_at: string;
}

export interface LoopClosure {
  station_a: StationRef;
  station_b: StationRef;
  path_length: number;
  misclosure_distance: number;
  error_percentage: number;
  horizontal_misclosure: number;
  vertical_misclosure: number;
}

export interface ZeroDatum {
  station_ref: StationRef;
  gps: GpsCoordinates;
}

export type ClosureStrategy =
  | 'ProportionalByLength'
  | 'EqualDistribution'
  | 'KeepRaw'
  | 'ManualAdjustment';

export interface Project {
  name: string;
  location: string | null;
  created_at: string;
  modified_at: string;
  sections: Section[];
  station_merges: StationMerge[];
  zero_datums: ZeroDatum[];
  loop_closures: LoopClosure[];
  file_path: string | null;
}

export interface ProjectStats {
  section_count: number;
  shot_count: number;
  total_length: number;
  min_depth: number;
  max_depth: number;
  station_count: number;
  loop_count: number;
  penetration_distance: number;
}

export interface ProjectMetadata {
  name: string;
  location: string | null;
  file_path: string;
  modified_at: string;
  section_count: number;
  total_length: number;
  gps_center: [number, number] | null;
  gps_bounds: GpsBounds | null;
}

export interface ProjectState {
  project: Project;
  stations: Station[];
  stats: ProjectStats;
}
