/**
 * Formatting utilities for consistent display of survey data.
 */

/**
 * Format a shot ID for user display.
 *
 * @param sectionId - Section ID (1-indexed, from database)
 * @param shotPosition - Shot position within section (1-indexed)
 * @returns Formatted ID string in "sectionId:shotPosition" format
 *
 * @example
 * formatShotId(5, 3) // returns "5:3"
 * formatShotId(1, 1) // returns "1:1"
 */
export function formatShotId(sectionId: number, shotPosition: number): string {
  return `${sectionId}:${shotPosition}`;
}

/**
 * Format a station ID for user display.
 *
 * @param sectionId - Section ID (1-indexed, from database)
 * @param stationIndex - Station index within section (0-indexed)
 * @returns Formatted ID string in "sectionId:stationIndex" format
 *
 * @example
 * formatStationId(5, 0) // returns "5:0"
 * formatStationId(1, 3) // returns "1:3"
 */
export function formatStationId(sectionId: number, stationIndex: number): string {
  return `${sectionId}:${stationIndex}`;
}

/**
 * A station ID with its name, when it has one (e.g. the mNemo station number
 * a DMP import recorded). The name is not unique - mNemo restarts at 0 in
 * every section - so it is shown beside the positional ID, never instead of it.
 *
 * @example
 * formatStationIdWithName(5, 3, '17') // returns "5:3 · 17"
 * formatStationIdWithName(5, 3)       // returns "5:3"
 */
export function formatStationIdWithName(
  sectionId: number,
  stationIndex: number,
  name?: string | null,
): string {
  const id = formatStationId(sectionId, stationIndex);
  return name ? `${id} · ${name}` : id;
}
