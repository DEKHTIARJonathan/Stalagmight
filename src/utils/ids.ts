// Shared stride for encoding section-scoped IDs into globally unique IDs.
// Keep in sync with the backend FEATURE_ID_STRIDE.
export const FEATURE_ID_STRIDE = 100000;
// High-bit endpoint aliases cannot share the legacy section-scoped key space.
const WIDE_FEATURE_ID_BASE = 2 ** 48;
const WIDE_FEATURE_ID_STRIDE = 2 ** 32;

/**
 * Encode a section-scoped id (a shot id or a station index) into the globally
 * unique MapLibre feature id used as `promoteId: 'featureId'`. The ONE canonical
 * formula - used by both feature construction (`surveyLayer/features.ts`) and any
 * id-keyed lookup against those features, so the two never drift.
 */
export function encodeFeatureId(sectionId: number, scopedId: number): number {
  return scopedId >= 0x80000000
    ? WIDE_FEATURE_ID_BASE + sectionId * WIDE_FEATURE_ID_STRIDE + scopedId
    : sectionId * FEATURE_ID_STRIDE + scopedId;
}

/** Decode an opaque station feature key, including detached START endpoints. */
export function decodeStationFeatureId(fid: number): { sectionId: number; stationIndex: number } {
  if (fid >= WIDE_FEATURE_ID_BASE) {
    const value = fid - WIDE_FEATURE_ID_BASE;
    const sectionId = Math.floor(value / WIDE_FEATURE_ID_STRIDE);
    return { sectionId, stationIndex: value - sectionId * WIDE_FEATURE_ID_STRIDE };
  }
  const sectionId = Math.floor(fid / FEATURE_ID_STRIDE);
  return { sectionId, stationIndex: fid - sectionId * FEATURE_ID_STRIDE };
}

/**
 * Section id out of a `"sectionId:scopedId"` feature key (NaN if malformed).
 *
 * This is the ONLY supported way to recover a section id. Do NOT invert
 * {@link encodeFeatureId} with `Math.floor(fid / FEATURE_ID_STRIDE)`: that is
 * lossless only when the scoped id is section-local, which holds for a station
 * index but NOT for a shot id. The backend seeds `next_shot_id = section.id *
 * FEATURE_ID_STRIDE` (`src-tauri/src/models/section.rs`), so a shot id is
 * already section-encoded and its feature id is `2 * sectionId * STRIDE + seq`
 * - the floor divide yields `2 * sectionId` for every shot (#301, and #26
 * before it for the measured-path tint).
 */
export function sectionIdFromKey(key: string): number {
  const head = key.split(':')[0];
  // Digits only, so a malformed head fails closed to NaN instead of coercing to a
  // real section: `Number('')` and `Number(' ')` are both 0, and section 0 exists
  // (`next_section_id` starts at 0), so coercion would mean the WRONG section.
  return head !== undefined && /^\d+$/.test(head) ? Number(head) : NaN;
}
