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
