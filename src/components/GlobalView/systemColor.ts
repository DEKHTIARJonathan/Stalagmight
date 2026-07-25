/**
 * Neutral, dependency-light home for the global view's per-system color and the
 * `SystemGeometry` shape. Extracted from GlobalSurveyLayer so the custom-render
 * buffer builder can reuse both without importing the full MapLibre-bound layer
 * (which would create an import cycle). GlobalSurveyLayer re-exports these, so
 * existing `from './GlobalSurveyLayer'` imports keep working unchanged.
 */
import type { ProjectMetadata } from '../../types/project';
import type { SurveyGeometry } from '../../types/survey';

/**
 * System geometry data with associated metadata for the global view.
 */
export interface SystemGeometry {
  /** Project metadata */
  metadata: ProjectMetadata;
  /** Survey geometry with GPS-transformed coordinates */
  geometry: SurveyGeometry;
}

/**
 * Generate a deterministic color for a system based on its file_path.
 * Uses HSL with hue derived from a hash of the path, saturation 70%, lightness 50%.
 */
export function generateSystemColor(filePath: string): string {
  // Simple hash function (djb2)
  let hash = 5381;
  for (let i = 0; i < filePath.length; i++) {
    hash = ((hash << 5) + hash) + filePath.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Map hash to hue (0-360)
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 70%, 50%)`;
}
