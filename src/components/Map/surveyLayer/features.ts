import type { GpsOrigin } from '../../../types/config';
import type {
  LoopClosure,
  Section,
  Station,
  StationMerge,
  StationRef,
} from '../../../types/project';
import { getDepthColor } from '../../../utils/colors';
import { metersToMapCoords } from '../../../utils/coordinates';

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
  mergeFeatures: GeoJSON.Feature[];
}

export interface SurveyFeatureSets {
  shotFeatures: GeoJSON.Feature[];
  shotLabelFeatures: GeoJSON.Feature[];
  stationFeatures: GeoJSON.Feature[];
  mergeFeatures: GeoJSON.Feature[];
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
  const mergeFeatures: GeoJSON.Feature[] = [];

  if (!data) {
    return { shotFeatures, stationFeatures, mergeFeatures };
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
    mergeFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: metersToMapCoords(data.mergeStation.x, data.mergeStation.y, gpsOrigin),
      },
      properties: {},
    });
  }

  return { shotFeatures, stationFeatures, mergeFeatures };
}

export function buildSurveyFeatures(
  sections: Section[],
  stations: Station[],
  stationMerges: StationMerge[] | undefined,
  loopClosures: LoopClosure[] | undefined,
  gpsOrigin: GpsOrigin | null,
  showDepthGradient: boolean,
  depthRange: DepthRange
): SurveyFeatureSets {
  const shotFeatures: GeoJSON.Feature[] = [];
  const shotLabelFeatures: GeoJSON.Feature[] = [];
  const stationFeatures: GeoJSON.Feature[] = [];
  const mergeFeatures: GeoJSON.Feature[] = [];
  const sectionLabelFeatures: GeoJSON.Feature[] = [];
  const stationLabelFeatures: GeoJSON.Feature[] = [];
  const loopClosureFeatures: GeoJSON.Feature[] = [];

  let globalShotIndex = 0;

  for (const section of sections) {
    const sectionStations = stations
      .filter((s) => s.station_ref.section_id === section.id)
      .sort((a, b) => a.station_ref.station_index - b.station_ref.station_index);

    for (let i = 0; i < section.shots.length; i++) {
      const shot = section.shots[i];
      const fromStation = sectionStations[i];
      const toStation = sectionStations[i + 1];

      if (fromStation && toStation && shot) {
        const avgDepth = (fromStation.coordinates.z + toStation.coordinates.z) / 2;
        const depthColor = showDepthGradient
          ? getDepthColor(avgDepth, '#00bfff', '#ff4444', depthRange.min, depthRange.max)
          : null;
        const shotColor = depthColor ?? section.color;

        const shotFeatureId = section.id * 100000 + shot.id;

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
            isVirtual: shot.is_virtual,
            length: shot.length,
            azimuth: shot.azimuth_in,
          },
        });

        const midX = (fromStation.coordinates.x + toStation.coordinates.x) / 2;
        const midY = (fromStation.coordinates.y + toStation.coordinates.y) / 2;
        const labelDepth = (fromStation.coordinates.z + toStation.coordinates.z) / 2;

        const label = `${shot.azimuth_in.toFixed(0)}° ${shot.length.toFixed(1)}m ${labelDepth.toFixed(1)}m`;

        const shotLabelDepthColor = showDepthGradient
          ? getDepthColor(avgDepth, '#00bfff', '#ff4444', depthRange.min, depthRange.max)
          : null;
        const shotLabelColor = shotLabelDepthColor ?? '#ffffff';

        shotLabelFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(midX, midY, gpsOrigin),
          },
          properties: {
            label,
            index: globalShotIndex,
            sectionId: section.id,
            shotId: shot.id,
            color: shotLabelColor,
          },
        });

        globalShotIndex++;
      }
    }
  }

  for (const station of stations) {
    const section = sections.find((s) => s.id === station.station_ref.section_id);
    const sectionColor = section?.color ?? '#ffffff';

    const isZeroDatum = station.is_zero_datum;
    const stationDepth = station.coordinates.z;

    let color: string;
    if (showDepthGradient) {
      color =
        getDepthColor(stationDepth, '#00bfff', '#ff4444', depthRange.min, depthRange.max) ??
        sectionColor;
    } else {
      color = isZeroDatum ? '#ffd700' : sectionColor;
    }

    const strokeColor = showDepthGradient && isZeroDatum ? '#ffd700' : '#000000';
    const featureId = station.station_ref.section_id * 100000 + station.station_ref.station_index;

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
      properties: {
        featureId,
        sectionId: station.station_ref.section_id,
        stationIndex: station.station_ref.station_index,
        isZeroDatum: station.is_zero_datum,
        isMerged: station.merged_with.length > 0,
        depth: station.coordinates.z,
        color,
        strokeColor,
      },
    });
  }

  const findStationCoords = (ref: StationRef) => {
    const station = stations.find(
      (s) =>
        s.station_ref.section_id === ref.section_id &&
        s.station_ref.station_index === ref.station_index
    );
    return station?.coordinates;
  };

  if (stationMerges && stationMerges.length > 0) {
    for (const merge of stationMerges) {
      const coordsA = findStationCoords(merge.station_a);
      const coordsB = findStationCoords(merge.station_b);

      if (coordsA && coordsB) {
        mergeFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              metersToMapCoords(coordsA.x, coordsA.y, gpsOrigin),
              metersToMapCoords(coordsB.x, coordsB.y, gpsOrigin),
            ],
          },
          properties: {
            stationA: `${merge.station_a.section_id}:${merge.station_a.station_index}`,
            stationB: `${merge.station_b.section_id}:${merge.station_b.station_index}`,
          },
        });
      }
    }
  }

  for (const section of sections) {
    const sectionStations = stations.filter((s) => s.station_ref.section_id === section.id);
    if (sectionStations.length > 0) {
      const firstStation = sectionStations.reduce((min, s) =>
        s.station_ref.station_index < min.station_ref.station_index ? s : min
      );
      sectionLabelFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: metersToMapCoords(
            firstStation.coordinates.x,
            firstStation.coordinates.y,
            gpsOrigin
          ),
        },
        properties: {
          name: section.name,
          color: section.color,
          sectionId: section.id,
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
          '#00bfff',
          '#ff4444',
          depthRange.min,
          depthRange.max
        )
      : null;
    const stationLabelColor = stationLabelDepthColor ?? '#ffffff';

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
      properties: {
        label: String(station.station_ref.station_index),
        stationIndex: station.station_ref.station_index,
        sectionId: station.station_ref.section_id,
        globalOrdinal,
        isFirstInSection,
        color: stationLabelColor,
      },
    });
  }

  if (loopClosures && loopClosures.length > 0) {
    const getErrorColor = (errorPct: number): string => {
      if (errorPct < 1) return '#22c55e';
      if (errorPct < 3) return '#eab308';
      if (errorPct < 5) return '#f97316';
      return '#ef4444';
    };

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
    shotLabelFeatures,
    stationFeatures,
    mergeFeatures,
    sectionLabelFeatures,
    stationLabelFeatures,
    loopClosureFeatures,
  };
}
