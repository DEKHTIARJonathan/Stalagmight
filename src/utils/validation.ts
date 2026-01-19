/**
 * Shot validation utilities for the DMP Import Dialog.
 * Validates shots against configurable thresholds and returns validation issues.
 */

import type { DmpShot } from '../types/commands';
import { type ValidationConfig, defaultConfig } from '../types/config';

// Re-export ValidationConfig for convenience
export type { ValidationConfig };

/**
 * Default validation config from shared config.
 */
export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = defaultConfig.validation;

/**
 * Severity levels for validation issues.
 * - error: Blocks import
 * - warning: Can be bypassed with acknowledgement
 */
export type ValidationSeverity = 'error' | 'warning';

/**
 * A single validation issue for a shot.
 */
export interface ValidationIssue {
  /** The field with the issue (for cell highlighting) */
  field: 'length' | 'azimuth' | 'depth' | 'lrud' | 'general';
  /** Severity level */
  severity: ValidationSeverity;
  /** Human-readable message for tooltip */
  message: string;
}

/**
 * Maximum LRUD passage dimension (meters) - exceeding this is a warning.
 * Note: This is a preview-only warning not present in backend validation.
 * It catches unusually large passage dimensions that may indicate data entry errors.
 * The backend only validates that LRUD values are non-negative.
 */
const LRUD_MAX = 50.0;

/**
 * Check if azimuth in/out values differ from each other by more than the threshold.
 * Handles 0/360 degree wrap-around correctly.
 *
 * @param azimuthIn The incoming azimuth in degrees [0, 360)
 * @param azimuthOut The outgoing azimuth in degrees [0, 360)
 * @param threshold Maximum allowable difference between azimuth values
 * @returns true if the difference exceeds the threshold
 */
export function hasAzimuthDiscrepancy(
  azimuthIn: number,
  azimuthOut: number,
  threshold: number
): boolean {
  // Calculate the absolute difference
  let diff = Math.abs(azimuthIn - azimuthOut);
  // Normalize to [0, 180] range for wrap-around handling
  if (diff > 180) diff = 360 - diff;
  // Check if they differ by more than the threshold
  return diff > threshold;
}

/**
 * Check if pitch in/out values differ significantly.
 * Returns false if either value is null (no comparison possible).
 *
 * @param pitchIn The incoming pitch in degrees (or null)
 * @param pitchOut The outgoing pitch in degrees (or null)
 * @param threshold Maximum allowable difference between pitch values
 * @returns true if the difference exceeds the threshold
 */
export function hasPitchDiscrepancy(
  pitchIn: number | null,
  pitchOut: number | null,
  threshold: number
): boolean {
  if (pitchIn === null || pitchOut === null) return false;
  return Math.abs(pitchIn - pitchOut) > threshold;
}

/**
 * Validate a single shot and return all issues.
 *
 * @param shot The DMP shot to validate
 * @param sectionShots All shots in the section (for context like previous shot)
 * @param shotIndex The index of this shot in the section
 * @param config Validation thresholds
 * @returns Array of validation issues (empty if valid)
 */
export function validateShot(
  shot: DmpShot,
  _sectionShots: DmpShot[],
  _shotIndex: number,
  config: ValidationConfig = DEFAULT_VALIDATION_CONFIG
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Only validate Standard shots
  if (shot.shot_type !== 'Standard') {
    return issues;
  }

  // Missing required fields (error) - length is required for Standard shots
  // Check this first to avoid double-flagging with "too short" warning
  if (shot.length === 0 || !Number.isFinite(shot.length)) {
    issues.push({
      field: 'length',
      severity: 'error',
      message: 'Shot length is required for standard shots',
    });
    // Skip threshold warnings if length is invalid/missing
  } else {
    // Shot length too short (warning) - only if length is positive
    if (shot.length < config.warn_shot_length_min) {
      issues.push({
        field: 'length',
        severity: 'warning',
        message: `Shot length ${shot.length.toFixed(1)}m is below minimum ${config.warn_shot_length_min}m`,
      });
    }

    // Shot length too long (warning)
    if (shot.length > config.warn_shot_length_max) {
      issues.push({
        field: 'length',
        severity: 'warning',
        message: `Shot length ${shot.length.toFixed(1)}m exceeds maximum ${config.warn_shot_length_max}m`,
      });
    }
  }

  // Azimuth out of range [0, 360) (error) - matches backend validation.rs:79
  const azimuthIn = shot.heading_in ?? 0;
  const azimuthOut = shot.heading_out ?? 0;
  if (azimuthIn < 0 || azimuthIn >= 360) {
    issues.push({
      field: 'azimuth',
      severity: 'error',
      message: `Azimuth in ${azimuthIn.toFixed(1)}° is out of valid range [0, 360)`,
    });
  }
  if (azimuthOut < 0 || azimuthOut >= 360) {
    issues.push({
      field: 'azimuth',
      severity: 'error',
      message: `Azimuth out ${azimuthOut.toFixed(1)}° is out of valid range [0, 360)`,
    });
  }

  // Azimuth deviation (in/out should be ~180° apart) - matches backend validation.rs:103
  if (azimuthIn >= 0 && azimuthIn < 360 && azimuthOut >= 0 && azimuthOut < 360) {
    const expectedOut = (azimuthIn + 180) % 360;
    // Calculate deviation from expected 180° difference
    const deviation = Math.abs(((azimuthOut - expectedOut + 540) % 360) - 180);
    if (deviation > config.warn_azimuth_deviation_max) {
      issues.push({
        field: 'azimuth',
        severity: 'warning',
        message: `Azimuth in/out deviation ${deviation.toFixed(1)}° exceeds threshold ${config.warn_azimuth_deviation_max}°`,
      });
    }
  }

  // Depth change exceeds threshold (warning)
  const depthIn = shot.depth_in ?? 0;
  const depthOut = shot.depth_out ?? 0;
  const depthChange = Math.abs(depthOut - depthIn);
  if (depthChange > config.warn_depth_change_per_shot_max) {
    issues.push({
      field: 'depth',
      severity: 'warning',
      message: `Depth change ${depthChange.toFixed(1)}m exceeds maximum ${config.warn_depth_change_per_shot_max}m per shot`,
    });
  }

  // LRUD validation - matches backend validation.rs:119-157
  const lrudFields: Array<{ name: string; value: number | undefined }> = [
    { name: 'Left', value: shot.left },
    { name: 'Right', value: shot.right },
    { name: 'Up', value: shot.up },
    { name: 'Down', value: shot.down },
  ];

  for (const { name, value } of lrudFields) {
    if (value != null) {
      // Negative LRUD is an error (matches backend)
      if (value < 0) {
        issues.push({
          field: 'lrud',
          severity: 'error',
          message: `${name} distance ${value.toFixed(1)}m is negative`,
        });
      } else if (value > LRUD_MAX) {
        // Exceeds passage max is a warning
        issues.push({
          field: 'lrud',
          severity: 'warning',
          message: `${name} distance ${value.toFixed(1)}m exceeds maximum ${LRUD_MAX}m`,
        });
      }
    }
  }

  return issues;
}

/**
 * Validate all shots in a section and return issues keyed by shot index.
 *
 * @param shots All shots in the section
 * @param config Validation thresholds
 * @returns Map of shot index to array of validation issues
 */
export function validateSection(
  shots: DmpShot[],
  config: ValidationConfig = DEFAULT_VALIDATION_CONFIG
): Map<number, ValidationIssue[]> {
  const issuesByShot = new Map<number, ValidationIssue[]>();

  // Check for duplicate marker indices within the section
  // In DMP format, marker_index is a station number (0, 1, 2...) assigned during survey.
  // All values including 0 are valid station markers. null/undefined means no marker assigned.
  // Duplicate marker indices within a section indicate potential data entry errors.
  const markerCounts = new Map<number, number[]>();
  shots.forEach((shot, index) => {
    if (shot.shot_type === 'Standard' && shot.marker_index != null) {
      const indices = markerCounts.get(shot.marker_index) ?? [];
      indices.push(index);
      markerCounts.set(shot.marker_index, indices);
    }
  });

  // Add duplicate marker warnings
  for (const [marker, indices] of markerCounts) {
    if (indices.length > 1) {
      for (const index of indices) {
        const existing = issuesByShot.get(index) ?? [];
        existing.push({
          field: 'general',
          severity: 'warning',
          message: `Duplicate station marker index ${marker} found in section`,
        });
        issuesByShot.set(index, existing);
      }
    }
  }

  // Validate each shot individually
  shots.forEach((shot, index) => {
    const issues = validateShot(shot, shots, index, config);
    if (issues.length > 0) {
      const existing = issuesByShot.get(index) ?? [];
      issuesByShot.set(index, [...existing, ...issues]);
    }
  });

  return issuesByShot;
}

/**
 * Get the highest severity from a list of issues.
 *
 * @param issues Array of validation issues
 * @returns 'error' if any errors, 'warning' if only warnings, undefined if empty
 */
export function getHighestSeverity(issues: ValidationIssue[]): ValidationSeverity | undefined {
  if (issues.length === 0) return undefined;
  return issues.some((i) => i.severity === 'error') ? 'error' : 'warning';
}

/**
 * Count issues by severity across all sections.
 *
 * @param issuesBySectionAndShot Map of section index to shot index to issues
 * @returns Object with error and warning counts
 */
export function countIssues(
  issuesBySectionAndShot: Map<number, Map<number, ValidationIssue[]>>
): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;

  for (const shotIssues of issuesBySectionAndShot.values()) {
    for (const issues of shotIssues.values()) {
      for (const issue of issues) {
        if (issue.severity === 'error') {
          errors++;
        } else {
          warnings++;
        }
      }
    }
  }

  return { errors, warnings };
}

// ============================================================================
// Import-specific Error Types and Validation
// ============================================================================

/**
 * Error types specific to the Import Dialog.
 * These are blocking errors that prevent import.
 */
export type ImportErrorType = 'invalidData' | 'missingPlacement' | 'mergeConflict';

/**
 * An error for a section during import.
 */
export interface ImportError {
  type: ImportErrorType;
  sectionIndex: number;
  shotIndex?: number;
  field?: string;
  message: string;
}

/**
 * Errors for a single section.
 */
export interface SectionErrors {
  sectionIndex: number;
  errors: ImportError[];
}

/**
 * Validate editable shot data for import errors.
 * Only checks for blocking errors (not warnings).
 *
 * @param shot The editable shot to validate
 * @param shotIndex The index of this shot
 * @param sectionIndex The section this shot belongs to
 * @returns Array of import errors (empty if valid)
 */
export function validateEditableShot(
  shot: {
    length: number;
    azimuth_in: number;
    azimuth_out: number;
    isDeleted?: boolean;
  },
  shotIndex: number,
  sectionIndex: number
): ImportError[] {
  const errors: ImportError[] = [];

  // Skip deleted shots
  if (shot.isDeleted) {
    return errors;
  }

  // Length must be positive (zero or negative is an error)
  if (shot.length <= 0) {
    errors.push({
      type: 'invalidData',
      sectionIndex,
      shotIndex,
      field: 'length',
      message: 'Length must be greater than 0',
    });
  }

  // Azimuth in must be in range [0, 360)
  if (shot.azimuth_in < 0 || shot.azimuth_in >= 360) {
    errors.push({
      type: 'invalidData',
      sectionIndex,
      shotIndex,
      field: 'azimuth_in',
      message: `Azimuth in (${shot.azimuth_in.toFixed(1)}°) must be between 0 and 360`,
    });
  }

  // Azimuth out must be in range [0, 360)
  if (shot.azimuth_out < 0 || shot.azimuth_out >= 360) {
    errors.push({
      type: 'invalidData',
      sectionIndex,
      shotIndex,
      field: 'azimuth_out',
      message: `Azimuth out (${shot.azimuth_out.toFixed(1)}°) must be between 0 and 360`,
    });
  }

  return errors;
}

/**
 * Validate placement for a section.
 * Checks if section has been placed.
 *
 * @param isPlaced Whether the section has been placed
 * @param sectionIndex The section index
 * @returns ImportError if not placed, null otherwise
 */
export function validatePlacement(
  isPlaced: boolean,
  sectionIndex: number
): ImportError | null {
  if (!isPlaced) {
    return {
      type: 'missingPlacement',
      sectionIndex,
      message: 'Section must be placed before import',
    };
  }
  return null;
}

/**
 * Validate merge target exists.
 * For "fromExisting" placement, the target section must exist.
 *
 * @param placementType The type of placement
 * @param targetSectionId The target section ID for fromExisting placement
 * @param existingSectionIds Set of existing section IDs in the project
 * @param placedSectionIds Set of section IDs that have been placed in this import
 * @param sectionIndex The current section index
 * @returns ImportError if merge target doesn't exist, null otherwise
 */
export function validateMergeTarget(
  placementType: string,
  targetSectionId: number | undefined,
  existingSectionIds: Set<number>,
  placedSectionIds: Set<number>,
  sectionIndex: number
): ImportError | null {
  if (placementType !== 'fromExisting') {
    return null;
  }

  if (targetSectionId === undefined) {
    return {
      type: 'mergeConflict',
      sectionIndex,
      message: 'Target section for merge is not specified',
    };
  }

  // Check if target exists in project or in already-placed sections
  if (!existingSectionIds.has(targetSectionId) && !placedSectionIds.has(targetSectionId)) {
    return {
      type: 'mergeConflict',
      sectionIndex,
      message: 'Target section for merge does not exist',
    };
  }

  return null;
}
