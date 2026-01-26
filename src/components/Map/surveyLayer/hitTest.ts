import type { Map as MaplibreMap, MapMouseEvent, MapGeoJSONFeature } from 'maplibre-gl';

export function distanceToLineSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const A = px - x1;
  const B = py - y1;
  const C = x2 - x1;
  const D = y2 - y1;

  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  const param = lenSq !== 0 ? dot / lenSq : -1;

  let xx: number;
  let yy: number;
  if (param < 0) {
    xx = x1;
    yy = y1;
  } else if (param > 1) {
    xx = x2;
    yy = y2;
  } else {
    xx = x1 + param * C;
    yy = y1 + param * D;
  }

  return Math.sqrt((px - xx) ** 2 + (py - yy) ** 2);
}

export function resolveNearestStation(
  map: MaplibreMap,
  e: MapMouseEvent,
  features: MapGeoJSONFeature[]
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

  return nearest;
}

export function resolveNearestShot(
  map: MaplibreMap,
  e: MapMouseEvent,
  features: MapGeoJSONFeature[]
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

  return nearest;
}
