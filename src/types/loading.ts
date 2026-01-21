/**
 * Loading progress types for the consolidated load/create commands.
 * These types MUST match the Rust backend structs in core/loading.rs.
 */

import type { Project, Station, ProjectStats } from './project';
import type { ProjectWarning } from './commands';

/**
 * Display settings for project UI state.
 * MUST match uiStore display fields EXACTLY (11 fields, NO extras).
 * Backend stores these in the project database.
 */
export interface DisplaySettings {
  showStations: boolean;
  showSectionNames: boolean;
  showStationLabels: boolean;
  showShotData: boolean;
  showVirtualShots: boolean;
  showZeroDatum: boolean;
  showGrid: boolean;
  showScaleBar: boolean;
  showSatellite: boolean;
  showDepthGradient: boolean;
  gridSpacing: number;
}

/**
 * Result of load_project_full command.
 * Contains all data needed to display a loaded project.
 */
export interface LoadProjectFullResult {
  loadingId: number;
  project: Project;
  stations: Station[];
  stats: ProjectStats;
  warnings: ProjectWarning[];
  displaySettings: DisplaySettings;
}

/**
 * Result of create_project_full command.
 * Contains the newly created project and default display settings.
 */
export interface CreateProjectFullResult {
  loadingId: number;
  project: Project;
  displaySettings: DisplaySettings;
}

/**
 * Progress event payload from backend.
 * Emitted via Tauri events during load operations.
 */
export interface LoadingProgressPayload {
  loadingId: number;
  phase: string;
  phaseIndex: number;
  phaseCount: number;
  current: number | null;
  total: number | null;
  overallPercent: number;
  isIndeterminate: boolean;
}
