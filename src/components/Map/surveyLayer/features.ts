import type { GpsOrigin, DecimalPrecision } from '../../../types/config';
import type {
  LoopClosure,
  Section,
  Station,
  StationRef,
} from '../../../types/project';
import {
  type SurveyData,
  type SectionMetadata,
  SHOT_FLAG_IS_REFERENCE,
  STATION_FLAG_IS_ZERO_DATUM,
} from '../../../types/survey-data';
import { getDepthColor, getErrorColor } from '../../../utils/colors';
import { metersToMapCoords } from '../../../utils/coordinates';
import { formatFixed } from '../../../i18n/format';
import type { MapThemeColors } from '../../../utils/themeColors';
import { encodeFeatureId } from '../../../utils/ids';

export type DepthRange = { min: number; max: number };

/**
 * Ghost section data for merge preview visualization.
 */
export interface GhostSectionData {
  /** Shot line coordinates (pairs of [from, to] positions in meters) */
  shots: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>;
  /** Station positions in meters */
  stations: Array<{ x: number; y: number }>;
  /** Section color */
  color: string;
  /** Merge station highlight position (the station being merged) */
  mergeStation?: { x: number; y: number };
}

export interface GhostFeatureSets {
  shotFeatures: GeoJSON.Feature[];
  stationFeatures: GeoJSON.Feature[];
  mergeStationFeatures: GeoJSON.Feature[];
}

export interface SurveyFeatureSets {
  shotFeatures: GeoJSON.Feature[];
  shotGradientFeatures: GeoJSON.Feature[];
  shotLabelFeatures: GeoJSON.Feature[];
  stationFeatures: GeoJSON.Feature[];
  sectionLabelFeatures: GeoJSON.Feature[];
  stationLabelFeatures: GeoJSON.Feature[];
  loopClosureFeatures: GeoJSON.Feature[];
}

export function normalizeDepthRange(depthRange: DepthRange): DepthRange {
  const minD = Number.isFinite(depthRange.min) ? depthRange.min : 0;
  const maxD = Number.isFinite(depthRange.max) ? depthRange.max : 50;
  return {
    min: Math.min(minD, maxD),
    max: Math.max(minD, maxD),
  };
}

export function buildGhostFeatures(
  data: GhostSectionData | null,
  gpsOrigin: GpsOrigin | null
): GhostFeatureSets {
  const shotFeatures: GeoJSON.Feature[] = [];
  const stationFeatures: GeoJSON.Feature[] = [];
  const mergeStationFeatures: GeoJSON.Feature[] = [];

  if (!data) {
    return { shotFeatures, stationFeatures, mergeStationFeatures };
  }

  for (const shot of data.shots) {
    shotFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          metersToMapCoords(shot.from.x, shot.from.y, gpsOrigin),
          metersToMapCoords(shot.to.x, shot.to.y, gpsOrigin),
        ],
      },
      properties: { color: data.color },
    });
  }

  for (const station of data.stations) {
    stationFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: metersToMapCoords(station.x, station.y, gpsOrigin),
      },
      properties: { color: data.color },
    });
  }

  if (data.mergeStation) {
    mergeStationFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: metersToMapCoords(data.mergeStation.x, data.mergeStation.y, gpsOrigin),
      },
      properties: {},
    });
  }

  return { shotFeatures, stationFeatures, mergeStationFeatures };
}

/**
 * Options for `buildSurveyFeatures`. Splitting these out keeps the
 * signature flat as new toggles are added.
 */
export interface BuildSurveyFeaturesOptions {
  /** Whether to materialize shot-label and station-label features.
   *  Both layers have `minzoom: 14` (so do their comment-overlay layers
   *  that share the same source), and at fit-to-bounds on a large cave
   *  the camera starts well below that. Skipping the ~160 k label
   *  features when they wouldn't render anyway saves ~100 MB main+worker
   *  on a 75 k-shot project. SurveyLayer rebuilds when the camera
   *  crosses the threshold. Defaults to `true` for callers that don't
   *  care (tests, etc.). */
  buildLabels?: boolean;
  /** Issue-severity coloring mode (#22). When true, shots and stations are
   *  colored by validation severity (green/yellow/red) instead of depth /
   *  section color. Mutually exclusive with `showDepthGradient` (the caller
   *  guarantees depth is off in this mode). */
  showIssueSeverity?: boolean;
  /** Per global shot/station severity (0=clear, 1=warning, 2=error), aligned
   *  to this `SurveyData`. Produced by `computeIssueSeverity`. Required when
   *  `showIssueSeverity` is true. */
  issueSeverity?: { shotSeverity: Uint8Array; stationSeverity: Uint8Array } | undefined;
}

/**
 * SoA-based feature builder. Same output as the legacy
 * `buildSurveyFeaturesLegacy` below but reads from the typed-array
 * `SurveyData` layout instead of iterating `Section.shots[]` /
 * `Station[]` objects. This is what `SurveyLayer.update()` and the
 * features worker call after Phase A.4.
 *
 * On a 75k-shot project the input no longer involves materialized JS
 * objects per shot/station — the worker receives ~10 transferable
 * typed-array buffers + a small `Map`/`SectionMetadata[]` envelope.
 */
export function buildSurveyFeatures(
  data: SurveyData,
  loopClosures: LoopClosure[] | undefined,
  gpsOrigin: GpsOrigin | null,
  showDepthGradient: boolean,
  depthRange: DepthRange,
  themeColors: MapThemeColors,
  precision?: DecimalPrecision,
  options: BuildSurveyFeaturesOptions = {}
): SurveyFeatureSets {
  const buildLabels = options.buildLabels ?? true;
  // Issue-severity coloring (#22). `sevShot`/`sevStation` are aligned to the
  // global shot/station indices iterated below. `sevColor` maps 2→red, 1→yellow,
  // else→green. The caller guarantees `showDepthGradient` is false in this mode.
  const showIssueSeverity = (options.showIssueSeverity ?? false) && !!options.issueSeverity;
  const sevShot = options.issueSeverity?.shotSeverity;
  const sevStation = options.issueSeverity?.stationSeverity;
  const sevColor = (s: number | undefined): string =>
    s === 2
      ? themeColors.severityError
      : s === 1
        ? themeColors.severityWarning
        : themeColors.severityClear;
  // Theme colors (resolved from CSS variables by the caller)
  const depthShallow = themeColors.depthShallow;
  const depthDeep = themeColors.depthDeep;
  const labelColor = themeColors.labelColor;
  const zeroDatum = themeColors.zeroDatum;
  const strokeColor = themeColors.strokeColor;
  const sectionDefault = themeColors.stationDefault;
  const shotFeatures: GeoJSON.Feature[] = [];
  const shotGradientFeatures: GeoJSON.Feature[] = [];
  const shotLabelFeatures: GeoJSON.Feature[] = [];
  const stationFeatures: GeoJSON.Feature[] = [];
  const sectionLabelFeatures: GeoJSON.Feature[] = [];
  const stationLabelFeatures: GeoJSON.Feature[] = [];
  const loopClosureFeatures: GeoJSON.Feature[] = [];

  // (sectionId, stationIndex) → global station index. Built once,
  // O(stationCount). Replaces the legacy `stationsBySection` sort.
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

  // sectionId → SectionMetadata. Built once, O(sections). The
  // station-features loop below runs ~stationCount times and was
  // previously calling `data.sections.find(...)` per iteration,
  // turning the build into O(stationCount × sectionCount). For the
  // 92.stalx fixture (89 k stations × 14 k sections) that was
  // ~1.3 G comparisons inside the MapLibre features worker — visible
  // as delayed first paint.
  const sectionMetaById = new Map<number, SectionMetadata>();
  for (const s of data.sections) sectionMetaById.set(s.id, s);

  /** Read station (x, y, z) from the SoA. Returns null if invalid global idx. */
  const stationXYZ = (gIdx: number): { x: number; y: number; z: number } => {
    const base = gIdx * 3;
    return {
      x: data.stationCoords[base]!,
      y: data.stationCoords[base + 1]!,
      z: data.stationCoords[base + 2]!,
    };
  };

  // Track stations that have at least one non-reference shot
  // (key: "sectionId:stationIndex").
  const stationsWithNonReferenceShot = new Set<string>();

  let globalShotOrdinal = 0; // for shot-label `index` property (matches legacy semantics)

  for (const section of data.sections) {
    const innerStationMap = stationLookup.get(section.id);
    if (!innerStationMap) continue;

    for (let i = 0; i < section.shotCount; i++) {
      const shotGlobalIdx = section.shotOffset + i;
      const fromGlobal = innerStationMap.get(i);
      const toGlobal = innerStationMap.get(i + 1);
      if (fromGlobal === undefined || toGlobal === undefined) continue;

      const shotId = data.shotIds[shotGlobalIdx]!;
      const isReference =
        (data.shotFlags[shotGlobalIdx]! & SHOT_FLAG_IS_REFERENCE) !== 0;
      const azimuth_in = data.shotAzimuthIn[shotGlobalIdx]!;
      const length = data.shotLength[shotGlobalIdx]!;
      const depth_in = data.shotDepthIn[shotGlobalIdx]!;
      const depth_out = data.shotDepthOut[shotGlobalIdx]!;

      if (!isReference) {
        stationsWithNonReferenceShot.add(`${section.id}:${i}`);
        stationsWithNonReferenceShot.add(`${section.id}:${i + 1}`);
      }

      const avgDepth = (depth_in + depth_out) / 2;
      const depthColor = showDepthGradient
        ? getDepthColor(avgDepth, depthShallow, depthDeep, depthRange.min, depthRange.max)
        : null;
      const shotColor = showIssueSeverity
        ? sevColor(sevShot![shotGlobalIdx]!)
        : (depthColor ?? section.color);
      const shotFeatureId = encodeFeatureId(section.id, shotId);

      const fromXYZ = stationXYZ(fromGlobal);
      const toXYZ = stationXYZ(toGlobal);

      shotFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            metersToMapCoords(fromXYZ.x, fromXYZ.y, gpsOrigin),
            metersToMapCoords(toXYZ.x, toXYZ.y, gpsOrigin),
          ],
        },
        properties: {
          featureId: shotFeatureId,
          sectionId: section.id,
          shotId,
          color: shotColor,
          isReference,
        },
      });

      if (showDepthGradient) {
        const segmentCount = Math.max(4, Math.min(12, Math.ceil(length / 2)));
        const dx = toXYZ.x - fromXYZ.x;
        const dy = toXYZ.y - fromXYZ.y;
        const depthDelta = depth_out - depth_in;

        for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
          const startT = segmentIndex / segmentCount;
          const endT = (segmentIndex + 1) / segmentCount;
          const midT = (startT + endT) / 2;

          const segmentDepth = depth_in + depthDelta * midT;
          const segmentColor =
            getDepthColor(segmentDepth, depthShallow, depthDeep, depthRange.min, depthRange.max) ??
            shotColor;

          shotGradientFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                metersToMapCoords(fromXYZ.x + dx * startT, fromXYZ.y + dy * startT, gpsOrigin),
                metersToMapCoords(fromXYZ.x + dx * endT, fromXYZ.y + dy * endT, gpsOrigin),
              ],
            },
            properties: {
              featureId: shotFeatureId,
              sectionId: section.id,
              shotId,
              segmentIndex,
              color: segmentColor,
              isReference,
            },
          });
        }
      }

      // Shot-label feature (zoom-gated; T3a)
      if (buildLabels) {
        const midX = (fromXYZ.x + toXYZ.x) / 2;
        const midY = (fromXYZ.y + toXYZ.y) / 2;
        const labelDepth = (fromXYZ.z + toXYZ.z) / 2;

        const label = `${formatFixed(azimuth_in, undefined, precision?.azimuth ?? 0)}° ${formatFixed(length, undefined, precision?.length ?? 1)}m ${formatFixed(labelDepth, undefined, precision?.depth ?? 1)}m`;

        const shotLabelDepthColor = showDepthGradient
          ? getDepthColor(avgDepth, depthShallow, depthDeep, depthRange.min, depthRange.max)
          : null;
        const shotLabelColor = shotLabelDepthColor ?? labelColor;
        const comment = data.shotComments.get(shotGlobalIdx);

        const shotLabelProps: Record<string, unknown> = {
          label,
          index: globalShotOrdinal,
          sectionId: section.id,
          shotId,
          color: shotLabelColor,
          isReference,
        };
        if (comment) shotLabelProps.comment = comment;
        shotLabelFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(midX, midY, gpsOrigin),
          },
          properties: shotLabelProps,
        });
      }

      globalShotOrdinal++;
    }
  }

  // ─── Station features (per-station circles) ────────────────────
  for (let g = 0; g < data.stationCount; g++) {
    const sectionId = data.stationSectionIds[g]!;
    const stationIndex = data.stationIndices[g]!;
    const section = sectionMetaById.get(sectionId);
    const sectionColor = section?.color ?? sectionDefault;
    const isZeroDatumStation = (data.stationFlags[g]! & STATION_FLAG_IS_ZERO_DATUM) !== 0;
    const xyz = stationXYZ(g);

    let color: string;
    if (showIssueSeverity) {
      // Severity fill overrides depth/section/zero-datum coloring; the
      // zero-datum size/stroke below is preserved.
      color = sevColor(sevStation![g]!);
    } else if (showDepthGradient) {
      color =
        getDepthColor(xyz.z, depthShallow, depthDeep, depthRange.min, depthRange.max) ??
        sectionColor;
    } else {
      color = isZeroDatumStation ? zeroDatum : sectionColor;
    }

    const featureStrokeColor = showDepthGradient && isZeroDatumStation ? zeroDatum : strokeColor;
    const featureId = encodeFeatureId(sectionId, stationIndex);

    stationFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: metersToMapCoords(xyz.x, xyz.y, gpsOrigin),
      },
      properties: {
        featureId,
        sectionId,
        stationIndex,
        isZeroDatum: isZeroDatumStation,
        color,
        strokeColor: featureStrokeColor,
        allShotsReference: !stationsWithNonReferenceShot.has(`${sectionId}:${stationIndex}`),
      },
    });
  }

  // ─── Section labels ────────────────────────────────────────────
  for (const section of data.sections) {
    const innerStationMap = stationLookup.get(section.id);
    if (!innerStationMap || innerStationMap.size === 0) continue;

    // Prefer the first non-reference station for label placement so it
    // doesn't float mid-air when reference shots are hidden.
    let anchorGlobalIdx: number | undefined;
    let anchorStationIdx = Infinity;
    let foundNonRef = false;
    for (const [stIdx, gIdx] of innerStationMap.entries()) {
      const hasNonRef = stationsWithNonReferenceShot.has(`${section.id}:${stIdx}`);
      // Once we see a non-reference station, only consider those.
      if (foundNonRef && !hasNonRef) continue;
      if (hasNonRef && !foundNonRef) {
        foundNonRef = true;
        anchorStationIdx = Infinity; // restart min search among non-ref
      }
      if (stIdx < anchorStationIdx) {
        anchorStationIdx = stIdx;
        anchorGlobalIdx = gIdx;
      }
    }
    if (anchorGlobalIdx === undefined) continue;

    const xyz = stationXYZ(anchorGlobalIdx);
    const allStationsReference = !foundNonRef;
    sectionLabelFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: metersToMapCoords(xyz.x, xyz.y, gpsOrigin),
      },
      properties: {
        name: section.name,
        color: section.color,
        sectionId: section.id,
        allStationsReference,
      },
    });
  }

  // ─── Station labels (zoom-gated; T3a) ─────────────────────────
  if (buildLabels) {
    // Per-section min station_index (== "is first in section" predicate)
    const sectionMinIndices = new Map<number, number>();
    for (let g = 0; g < data.stationCount; g++) {
      const sid = data.stationSectionIds[g]!;
      const idx = data.stationIndices[g]!;
      const cur = sectionMinIndices.get(sid);
      if (cur === undefined || idx < cur) sectionMinIndices.set(sid, idx);
    }

    for (let g = 0; g < data.stationCount; g++) {
      const sectionId = data.stationSectionIds[g]!;
      const stationIndex = data.stationIndices[g]!;
      const isFirstInSection = stationIndex === sectionMinIndices.get(sectionId);
      const xyz = stationXYZ(g);

      const stationLabelDepthColor = showDepthGradient
        ? getDepthColor(xyz.z, depthShallow, depthDeep, depthRange.min, depthRange.max)
        : null;
      const stationLabelColor = stationLabelDepthColor ?? labelColor;

      const stationLabelProps: Record<string, unknown> = {
        label: String(stationIndex),
        stationIndex,
        sectionId,
        globalOrdinal: g,
        isFirstInSection,
        color: stationLabelColor,
        allShotsReference: !stationsWithNonReferenceShot.has(`${sectionId}:${stationIndex}`),
      };
      const comment = data.stationComments.get(g);
      if (comment) stationLabelProps.comment = comment;
      stationLabelFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: metersToMapCoords(xyz.x, xyz.y, gpsOrigin),
        },
        properties: stationLabelProps,
      });
    }
  }

  // ─── Loop closures ────────────────────────────────────────────
  if (loopClosures && loopClosures.length > 0) {
    /** Look up station coords via (sectionId, stationIndex) — used by
     *  loop-closure endpoints that reference stations by ref. */
    const findStationXYZByRef = (ref: StationRef): { x: number; y: number; z: number } | undefined => {
      const gIdx = stationLookup.get(ref.section_id)?.get(ref.station_index);
      return gIdx === undefined ? undefined : stationXYZ(gIdx);
    };

    for (const closure of loopClosures) {
      const a = findStationXYZByRef(closure.station_a);
      const b = findStationXYZByRef(closure.station_b);
      if (a && b) {
        loopClosureFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              metersToMapCoords(a.x, a.y, gpsOrigin),
              metersToMapCoords(b.x, b.y, gpsOrigin),
            ],
          },
          properties: {
            stationA: `${closure.station_a.section_id}:${closure.station_a.station_index}`,
            stationB: `${closure.station_b.section_id}:${closure.station_b.station_index}`,
            sectionIdA: closure.station_a.section_id,
            sectionIdB: closure.station_b.section_id,
            errorPercentage: closure.error_percentage,
            misclosureDistance: closure.misclosure_distance,
            pathLength: closure.path_length,
            color: getErrorColor(closure.error_percentage),
          },
        });
      }
    }
  }

  return {
    shotFeatures,
    shotGradientFeatures,
    shotLabelFeatures,
    stationFeatures,
    sectionLabelFeatures,
    stationLabelFeatures,
    loopClosureFeatures,
  };
}

/**
 * Legacy `Section[]` / `Station[]` feature builder. Kept around for
 * the Phase-A migration window in case anyone still passes the old
 * shape; removed in Phase A.6 once verified.
 *
 * Do not use for new code — call the SoA-based `buildSurveyFeatures`
 * above. This function lives here purely as a reference / rollback.
 */
export function buildSurveyFeaturesLegacy(
  sections: Section[],
  stations: Station[],
  loopClosures: LoopClosure[] | undefined,
  gpsOrigin: GpsOrigin | null,
  showDepthGradient: boolean,
  depthRange: DepthRange,
  themeColors: MapThemeColors,
  precision?: DecimalPrecision,
  options: BuildSurveyFeaturesOptions = {}
): SurveyFeatureSets {
  const buildLabels = options.buildLabels ?? true;
  // Theme colors (resolved from CSS variables by the caller)
  const depthShallow = themeColors.depthShallow;
  const depthDeep = themeColors.depthDeep;
  const labelColor = themeColors.labelColor;
  const zeroDatum = themeColors.zeroDatum;
  const strokeColor = themeColors.strokeColor;
  const sectionDefault = themeColors.stationDefault;
  const shotFeatures: GeoJSON.Feature[] = [];
  const shotGradientFeatures: GeoJSON.Feature[] = [];
  const shotLabelFeatures: GeoJSON.Feature[] = [];
  const stationFeatures: GeoJSON.Feature[] = [];
  const sectionLabelFeatures: GeoJSON.Feature[] = [];
  const stationLabelFeatures: GeoJSON.Feature[] = [];
  const loopClosureFeatures: GeoJSON.Feature[] = [];

  // Pre-build lookup maps: O(n+m) instead of O(n*m) for .filter()/.find() in loops
  const stationsBySection = new Map<number, Station[]>();
  const sectionById = new Map<number, Section>();
  for (const station of stations) {
    const sid = station.station_ref.section_id;
    const arr = stationsBySection.get(sid);
    if (arr) arr.push(station);
    else stationsBySection.set(sid, [station]);
  }
  for (const section of sections) {
    sectionById.set(section.id, section);
  }

  let globalShotIndex = 0;
  // Track stations that have at least one non-reference shot (key: "sectionId:stationIndex")
  const stationsWithNonReferenceShot = new Set<string>();

  for (const section of sections) {
    const sectionStations = (stationsBySection.get(section.id) ?? [])
      .slice() // avoid mutating the cached array
      .sort((a, b) => a.station_ref.station_index - b.station_ref.station_index);

    for (let i = 0; i < section.shots.length; i++) {
      const shot = section.shots[i];
      const fromStation = sectionStations[i];
      const toStation = sectionStations[i + 1];

      if (fromStation && toStation && shot) {
        if (!shot.is_reference) {
          stationsWithNonReferenceShot.add(`${section.id}:${fromStation.station_ref.station_index}`);
          stationsWithNonReferenceShot.add(`${section.id}:${toStation.station_ref.station_index}`);
        }
        const avgDepth = (shot.depth_in + shot.depth_out) / 2;
        const depthColor = showDepthGradient
          ? getDepthColor(avgDepth, depthShallow, depthDeep, depthRange.min, depthRange.max)
          : null;
        const shotColor = depthColor ?? section.color;

        const shotFeatureId = encodeFeatureId(section.id, shot.id);

        // Slim shot feature: only properties actually read by paint/feature-state
        // expressions or by setFeatureState lookups elsewhere in this file.
        // Dropped: `fromColor`/`toColor` (gradient layer uses its own per-segment
        // colors), `length`, `azimuth` (hover tooltip looks these up from the
        // projectStore tree instead of off the feature). For 75k shots that
        // saves ~4 properties × ~16B = 4.8 MB main + 4.8 MB worker copy.
        shotFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              metersToMapCoords(fromStation.coordinates.x, fromStation.coordinates.y, gpsOrigin),
              metersToMapCoords(toStation.coordinates.x, toStation.coordinates.y, gpsOrigin),
            ],
          },
          properties: {
            featureId: shotFeatureId,
            sectionId: section.id,
            shotId: shot.id,
            color: shotColor,
            isReference: shot.is_reference,
          },
        });

        if (showDepthGradient) {
          const segmentCount = Math.max(4, Math.min(12, Math.ceil(shot.length / 2)));
          const fromX = fromStation.coordinates.x;
          const fromY = fromStation.coordinates.y;
          const toX = toStation.coordinates.x;
          const toY = toStation.coordinates.y;
          const dx = toX - fromX;
          const dy = toY - fromY;
          const depthDelta = shot.depth_out - shot.depth_in;

          for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
            const startT = segmentIndex / segmentCount;
            const endT = (segmentIndex + 1) / segmentCount;
            const midT = (startT + endT) / 2;

            const segmentDepth = shot.depth_in + depthDelta * midT;
            const segmentColor =
              getDepthColor(segmentDepth, depthShallow, depthDeep, depthRange.min, depthRange.max) ??
              shotColor;

            shotGradientFeatures.push({
              type: 'Feature',
              geometry: {
                type: 'LineString',
                coordinates: [
                  metersToMapCoords(fromX + dx * startT, fromY + dy * startT, gpsOrigin),
                  metersToMapCoords(fromX + dx * endT, fromY + dy * endT, gpsOrigin),
                ],
              },
              properties: {
                featureId: shotFeatureId,
                sectionId: section.id,
                shotId: shot.id,
                segmentIndex,
                color: segmentColor,
                isReference: shot.is_reference,
              },
            });
          }
        }

        // Shot-label feature: only built when buildLabels is true.
        // Both the shot-labels and shot-comments layers (which share the
        // same source) have minzoom 14, so at lower zooms these
        // features wouldn't paint anyway. SurveyLayer rebuilds when the
        // camera crosses the threshold.
        if (buildLabels) {
          const midX = (fromStation.coordinates.x + toStation.coordinates.x) / 2;
          const midY = (fromStation.coordinates.y + toStation.coordinates.y) / 2;
          const labelDepth = (fromStation.coordinates.z + toStation.coordinates.z) / 2;

          const label = `${formatFixed(shot.azimuth_in, undefined, precision?.azimuth ?? 0)}° ${formatFixed(shot.length, undefined, precision?.length ?? 1)}m ${formatFixed(labelDepth, undefined, precision?.depth ?? 1)}m`;

          const shotLabelDepthColor = showDepthGradient
            ? getDepthColor(avgDepth, depthShallow, depthDeep, depthRange.min, depthRange.max)
            : null;
          const shotLabelColor = shotLabelDepthColor ?? labelColor;

          // Only include `comment` when there actually is one. The comment
          // layer's filter is `['!=', ['get', 'comment'], null]` and treats
          // missing-key the same as null. JSC uses a smaller hidden class
          // for objects without the slot, which matters at 75k+ features.
          const shotLabelProps: Record<string, unknown> = {
            label,
            index: globalShotIndex,
            sectionId: section.id,
            shotId: shot.id,
            color: shotLabelColor,
            isReference: shot.is_reference,
          };
          if (shot.comment) shotLabelProps.comment = shot.comment;
          shotLabelFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: metersToMapCoords(midX, midY, gpsOrigin),
            },
            properties: shotLabelProps,
          });
        }

        globalShotIndex++;
      }
    }
  }

  for (const station of stations) {
    const section = sectionById.get(station.station_ref.section_id);
    const sectionColor = section?.color ?? sectionDefault;

    const isZeroDatum = station.is_zero_datum;
    const stationDepth = station.coordinates.z;

    let color: string;
    if (showDepthGradient) {
      color =
        getDepthColor(stationDepth, depthShallow, depthDeep, depthRange.min, depthRange.max) ??
        sectionColor;
    } else {
      color = isZeroDatum ? zeroDatum : sectionColor;
    }

    const featureStrokeColor = showDepthGradient && isZeroDatum ? zeroDatum : strokeColor;
    const featureId = encodeFeatureId(
      station.station_ref.section_id,
      station.station_ref.station_index,
    );

    stationFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: metersToMapCoords(
          station.coordinates.x,
          station.coordinates.y,
          gpsOrigin
        ),
      },
      // `isMerged` and `depth` were set but no paint expression / feature-state
      // / filter / overlay reads them. Drop them. For 89k station features at
      // ~16B per dropped property, ~3 MB main + ~3 MB worker.
      properties: {
        featureId,
        sectionId: station.station_ref.section_id,
        stationIndex: station.station_ref.station_index,
        isZeroDatum: station.is_zero_datum,
        color,
        strokeColor: featureStrokeColor,
        allShotsReference: !stationsWithNonReferenceShot.has(
          `${station.station_ref.section_id}:${station.station_ref.station_index}`
        ),
      },
    });
  }

  // Station lookup by composite key for O(1) closure coordinate resolution
  const stationByRef = new Map<string, Station>();
  for (const s of stations) {
    stationByRef.set(`${s.station_ref.section_id}:${s.station_ref.station_index}`, s);
  }
  const findStationCoords = (ref: StationRef) => {
    return stationByRef.get(`${ref.section_id}:${ref.station_index}`)?.coordinates;
  };

  for (const section of sections) {
    const sectionStations = stationsBySection.get(section.id);
    if (sectionStations && sectionStations.length > 0) {
      // Prefer the first non-reference station for label placement so it
      // doesn't float mid-air when reference shots are hidden.
      const nonReferenceStations = sectionStations.filter(s =>
        stationsWithNonReferenceShot.has(`${s.station_ref.section_id}:${s.station_ref.station_index}`)
      );
      const labelStations = nonReferenceStations.length > 0 ? nonReferenceStations : sectionStations;
      const anchorStation = labelStations.reduce((min, s) =>
        s.station_ref.station_index < min.station_ref.station_index ? s : min
      );
      const allStationsReference = nonReferenceStations.length === 0;
      sectionLabelFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: metersToMapCoords(
            anchorStation.coordinates.x,
            anchorStation.coordinates.y,
            gpsOrigin
          ),
        },
        properties: {
          name: section.name,
          color: section.color,
          sectionId: section.id,
          allStationsReference,
        },
      });
    }
  }

  // Station-label features. Same minzoom-14 gate as shot labels;
  // skip the entire block when buildLabels is false to save the
  // sectionMinIndices walk + ~89k feature allocations.
  if (buildLabels) {
    const sectionMinIndices = new Map<number, number>();
    for (const station of stations) {
      const sectionId = station.station_ref.section_id;
      const currentMin = sectionMinIndices.get(sectionId);
      if (currentMin === undefined || station.station_ref.station_index < currentMin) {
        sectionMinIndices.set(sectionId, station.station_ref.station_index);
      }
    }

    for (const [globalOrdinal, station] of stations.entries()) {
    const isFirstInSection =
      station.station_ref.station_index ===
      sectionMinIndices.get(station.station_ref.section_id);

    const stationLabelDepthColor = showDepthGradient
      ? getDepthColor(
          station.coordinates.z,
          depthShallow,
          depthDeep,
          depthRange.min,
          depthRange.max
        )
      : null;
    const stationLabelColor = stationLabelDepthColor ?? labelColor;

    // Same null-omission trick as shot labels. For 89k stations where the
    // overwhelming majority have no comment, the smaller hidden class
    // shape pays off in JSC's per-class slab allocator.
    const stationLabelProps: Record<string, unknown> = {
      label: String(station.station_ref.station_index),
      stationIndex: station.station_ref.station_index,
      sectionId: station.station_ref.section_id,
      globalOrdinal,
      isFirstInSection,
      color: stationLabelColor,
      allShotsReference: !stationsWithNonReferenceShot.has(
        `${station.station_ref.section_id}:${station.station_ref.station_index}`
      ),
    };
    if (station.comment) stationLabelProps.comment = station.comment;
    stationLabelFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: metersToMapCoords(
          station.coordinates.x,
          station.coordinates.y,
          gpsOrigin
        ),
      },
      properties: stationLabelProps,
    });
    }
  }

  if (loopClosures && loopClosures.length > 0) {
    for (const closure of loopClosures) {
      const coordsA = findStationCoords(closure.station_a);
      const coordsB = findStationCoords(closure.station_b);

      if (coordsA && coordsB) {
        loopClosureFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              metersToMapCoords(coordsA.x, coordsA.y, gpsOrigin),
              metersToMapCoords(coordsB.x, coordsB.y, gpsOrigin),
            ],
          },
          properties: {
            stationA: `${closure.station_a.section_id}:${closure.station_a.station_index}`,
            stationB: `${closure.station_b.section_id}:${closure.station_b.station_index}`,
            sectionIdA: closure.station_a.section_id,
            sectionIdB: closure.station_b.section_id,
            errorPercentage: closure.error_percentage,
            misclosureDistance: closure.misclosure_distance,
            pathLength: closure.path_length,
            color: getErrorColor(closure.error_percentage),
          },
        });
      }
    }
  }

  return {
    shotFeatures,
    shotGradientFeatures,
    shotLabelFeatures,
    stationFeatures,
    sectionLabelFeatures,
    stationLabelFeatures,
    loopClosureFeatures,
  };
}
