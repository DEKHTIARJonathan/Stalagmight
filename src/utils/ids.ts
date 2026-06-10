// Shared stride for encoding section-scoped IDs into globally unique IDs.
// Keep in sync with the backend FEATURE_ID_STRIDE.
export const FEATURE_ID_STRIDE = 100000;

/**
 * Encode a section-scoped id (a shot id or a station index) into the globally
 * unique MapLibre feature id used as `promoteId: 'featureId'`. The ONE canonical
 * formula — used by both feature construction (`surveyLayer/features.ts`) and any
 * `setFeatureState` targeting (e.g. the distance gradient), so the two never drift.
 */
export function encodeFeatureId(sectionId: number, scopedId: number): number {
  return sectionId * FEATURE_ID_STRIDE + scopedId;
}
