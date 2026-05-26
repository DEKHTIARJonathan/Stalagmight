import type { GpsOrigin, DecimalPrecision } from '../../../types/config';
import type {
  LoopClosure,
  Section,
  Station,
  StationRef,
} from '../../../types/project';
import { getDepthColor, getErrorColor } from '../../../utils/colors';
import { metersToMapCoords } from '../../../utils/coordinates';
import { formatFixed } from '../../../i18n/format';
import type { MapThemeColors } from '../../../utils/themeColors';
import { FEATURE_ID_STRIDE } from '../../../utils/ids';

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

export function buildSurveyFeatures(
  sections: Section[],
  stations: Station[],
  loopClosures: LoopClosure[] | undefined,
  gpsOrigin: GpsOrigin | null,
  showDepthGradient: boolean,
  depthRange: DepthRange,
  themeColors: MapThemeColors,
  precision?: DecimalPrecision
): SurveyFeatureSets {
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

        const shotFeatureId = section.id * FEATURE_ID_STRIDE + shot.id;

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
    const featureId =
      station.station_ref.section_id * FEATURE_ID_STRIDE + station.station_ref.station_index;

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
