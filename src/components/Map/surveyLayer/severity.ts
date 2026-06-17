/**
 * Issue-severity coloring for the map's "Issue severity" Display mode.
 *
 * Computes, per global shot index and per global station index, the highest
 * *unresolved* validation severity affecting that geometry:
 *
 *   0 = SEV_CLEAR    (green  — no unresolved issue)
 *   1 = SEV_WARNING  (yellow — only warnings)
 *   2 = SEV_ERROR    (red    — at least one error)
 *
 * A shot's severity comes directly from its unresolved `ProjectWarning`s. A
 * station takes the MAX severity of every shot touching it, then that severity
 * is propagated across the station's full merge group: `stationMergedWith` is
 * already transitive (union-find in the Rust backend, every member lists every
 * other member), so a single sweep per group is exact.
 *
 * Pure and worker-friendly: the two `Uint8Array`s structured-clone cheaply and
 * are aligned to the same global indices `buildSurveyFeatures` iterates.
 */
import type { SectionMetadata, SurveyData } from '../../../types/survey-data';
import type { ProjectWarning } from '../../../types/commands';

export const SEV_CLEAR = 0;
export const SEV_WARNING = 1;
export const SEV_ERROR = 2;

export interface IssueSeverity {
  /** Severity per GLOBAL shot index (length === data.shotCount). */
  shotSeverity: Uint8Array;
  /** Severity per GLOBAL station index (length === data.stationCount). */
  stationSeverity: Uint8Array;
}

export function computeIssueSeverity(
  data: SurveyData,
  warnings: ProjectWarning[],
): IssueSeverity {
  const shotSeverity = new Uint8Array(data.shotCount); // all 0 (clear)
  const stationSeverity = new Uint8Array(data.stationCount);

  if (warnings.length === 0 || data.shotCount === 0) {
    return { shotSeverity, stationSeverity };
  }

  // (1) Per-shot severity from unresolved warnings, keyed by (sectionId, shotId).
  //     Resolve to a global shot index via a per-section shotId→global map,
  //     built lazily so untouched sections cost nothing.
  const sectionById = new Map<number, SectionMetadata>();
  for (const s of data.sections) sectionById.set(s.id, s);

  const shotIdToGlobal = new Map<number, Map<number, number>>(); // sectionId → (shotId → globalIdx)
  const lookupShotGlobal = (sectionId: number, shotId: number): number | null => {
    let inner = shotIdToGlobal.get(sectionId);
    if (!inner) {
      const sec = sectionById.get(sectionId);
      if (!sec) return null;
      inner = new Map();
      for (let i = sec.shotOffset; i < sec.shotOffset + sec.shotCount; i++) {
        inner.set(data.shotIds[i]!, i);
      }
      shotIdToGlobal.set(sectionId, inner);
    }
    return inner.get(shotId) ?? null;
  };

  for (const w of warnings) {
    if (w.isResolved) continue; // only unresolved issues drive the color
    const sev = w.severity === 'error' ? SEV_ERROR : SEV_WARNING;
    const g = lookupShotGlobal(w.sectionId, w.shotId);
    if (g === null) continue; // warning for a shot not present in this SoA (stale)
    if (sev > shotSeverity[g]!) shotSeverity[g] = sev;
  }

  // (2) (sectionId, stationIndex) → global station index — mirrors features.ts.
  const stationLookup = new Map<number, Map<number, number>>();
  for (let g = 0; g < data.stationCount; g++) {
    const sid = data.stationSectionIds[g]!;
    const stIdx = data.stationIndices[g]!;
    let inner = stationLookup.get(sid);
    if (!inner) {
      inner = new Map();
      stationLookup.set(sid, inner);
    }
    inner.set(stIdx, g);
  }

  // (3) Max each flagged shot's severity into its from/to endpoint stations.
  //     Shot i within a section connects station_index i and i+1 (features.ts).
  for (const sec of data.sections) {
    const inner = stationLookup.get(sec.id);
    if (!inner) continue;
    for (let i = 0; i < sec.shotCount; i++) {
      const sev = shotSeverity[sec.shotOffset + i]!;
      if (sev === SEV_CLEAR) continue;
      const fromG = inner.get(i);
      const toG = inner.get(i + 1);
      if (fromG !== undefined && sev > stationSeverity[fromG]!) stationSeverity[fromG] = sev;
      if (toG !== undefined && sev > stationSeverity[toG]!) stationSeverity[toG] = sev;
    }
  }

  // (4) Propagate per-station severity across each station's transitive merge
  //     group. One sweep with a visited guard: collect the group's members,
  //     take the group max once, write it to all. A station with no shots and
  //     no flagged merge-partner stays 0 (green).
  const visited = new Uint8Array(data.stationCount);
  for (let g = 0; g < data.stationCount; g++) {
    if (visited[g]) continue;
    visited[g] = 1;
    const group = data.stationMergedWith.get(g);
    if (!group || group.length === 0) continue;

    const members = [g];
    for (const ref of group) {
      const mg = stationLookup.get(ref.section_id)?.get(ref.station_index);
      if (mg !== undefined) members.push(mg);
    }
    let groupMax = SEV_CLEAR;
    for (const mg of members) {
      if (stationSeverity[mg]! > groupMax) groupMax = stationSeverity[mg]!;
    }
    for (const mg of members) {
      stationSeverity[mg] = groupMax;
      visited[mg] = 1;
    }
  }

  return { shotSeverity, stationSeverity };
}
