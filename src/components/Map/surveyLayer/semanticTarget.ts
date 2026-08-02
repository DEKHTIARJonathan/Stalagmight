import { distanceToLineSegment, projectParamOnSegment } from './hitTest';

export type SemanticMapTarget =
  | { featureType: 'station'; sectionId: number; stationIndex: number }
  | { featureType: 'shot'; sectionId: number; shotId: number };

export interface SemanticMapGeometry {
  stations: Array<{ sectionId: number; stationIndex: number; lngLat: [number, number] }>;
  shots: Array<{ sectionId: number; shotId: number; from: [number, number]; to: [number, number] }>;
}

export type ResolvedSemanticMapTarget =
  | { type: 'station'; sectionId: number; stationIndex: number }
  | { type: 'shot'; sectionId: number; shotId: number; alongT: number };

export function resolveSemanticMapTarget(
  target: SemanticMapTarget,
  geometry: SemanticMapGeometry,
  project: (lngLat: [number, number]) => { x: number; y: number },
  point: { x: number; y: number },
  stationReach: number,
  shotReach: number,
): ResolvedSemanticMapTarget | null {
  if (target.featureType === 'station') {
    const station = geometry.stations.find(
      (item) => item.sectionId === target.sectionId && item.stationIndex === target.stationIndex,
    );
    if (!station) return null;
    const projected = project(station.lngLat);
    if (Math.hypot(projected.x - point.x, projected.y - point.y) > stationReach) return null;
    return { type: 'station', sectionId: target.sectionId, stationIndex: target.stationIndex };
  }

  const shot = geometry.shots.find(
    (item) => item.sectionId === target.sectionId && item.shotId === target.shotId,
  );
  if (!shot) return null;
  const from = project(shot.from);
  const to = project(shot.to);
  const distance = distanceToLineSegment(point.x, point.y, from.x, from.y, to.x, to.y);
  if (distance > shotReach) return null;
  return {
    type: 'shot',
    sectionId: target.sectionId,
    shotId: target.shotId,
    alongT: projectParamOnSegment(point.x, point.y, from.x, from.y, to.x, to.y),
  };
}
