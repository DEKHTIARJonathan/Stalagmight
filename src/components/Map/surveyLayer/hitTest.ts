import type { Map as MaplibreMap, MapMouseEvent, MapGeoJSONFeature } from 'maplibre-gl';

/**
 * Parametric position of (px,py) projected onto the segment (x1,y1)-(x2,y2),
 * clamped to [0,1] (0 = first endpoint, 1 = second). A degenerate (zero-length)
 * segment returns 0. Used both for hit distance and to locate the fractional
 * point on a shot when the ruler snaps to a shot (#26).
 */
export function projectParamOnSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const C = x2 - x1;
  const D = y2 - y1;
  const lenSq = C * C + D * D;
  if (lenSq === 0) return 0;
  const t = ((px - x1) * C + (py - y1) * D) / lenSq;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function distanceToLineSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const t = projectParamOnSegment(px, py, x1, y1, x2, y2);
  const xx = x1 + t * (x2 - x1);
  const yy = y1 + t * (y2 - y1);
  return Math.sqrt((px - xx) ** 2 + (py - yy) ** 2);
}

export function resolveNearestStation(
  map: MaplibreMap,
  e: MapMouseEvent,
  features: MapGeoJSONFeature[],
  maxDistance?: number
): MapGeoJSONFeature | null {
  if (features.length === 0) return null;
  if (features.length === 1) return features[0]!;

  let nearest: MapGeoJSONFeature = features[0]!;
  let nearestDist = Infinity;

  for (const feature of features) {
    const geom = feature.geometry;
    if (geom.type === 'Point') {
      const coords = geom.coordinates as [number, number];
      const screenPos = map.project(coords);
      const dist = Math.sqrt(
        (screenPos.x - e.point.x) ** 2 + (screenPos.y - e.point.y) ** 2
      );
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = feature;
      }
    }
  }

  if (maxDistance !== undefined && nearestDist > maxDistance) {
    return null;
  }

  return nearest;
}

export function resolveNearestShot(
  map: MaplibreMap,
  e: MapMouseEvent,
  features: MapGeoJSONFeature[],
  maxDistance?: number
): MapGeoJSONFeature | null {
  if (features.length === 0) return null;
  if (features.length === 1) return features[0]!;

  let nearest: MapGeoJSONFeature = features[0]!;
  let nearestDist = Infinity;

  for (const feature of features) {
    const geom = feature.geometry;
    if (geom.type === 'LineString' && geom.coordinates.length >= 2) {
      for (let i = 0; i < geom.coordinates.length - 1; i++) {
        const coord1 = geom.coordinates[i] as [number, number] | undefined;
        const coord2 = geom.coordinates[i + 1] as [number, number] | undefined;
        if (!coord1 || !coord2) continue;

        const p1 = map.project(coord1);
        const p2 = map.project(coord2);

        const dist = distanceToLineSegment(
          e.point.x,
          e.point.y,
          p1.x,
          p1.y,
          p2.x,
          p2.y
        );

        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = feature;
        }
      }
    }
  }

  if (maxDistance !== undefined && nearestDist > maxDistance) {
    return null;
  }

  return nearest;
}
