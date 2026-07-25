import { describe, expect, it } from 'vitest';
import { buildGhostHighlights, type GhostHighlightHost } from '../dragGhostHighlight';

// A LineString shot feature (2 points) so shotPrim yields a primitive.
const shotFeature = (): GeoJSON.Feature => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
  properties: { opacity: 1 },
});
// A Point station feature so stationPrim yields a primitive.
const stationFeature = (): GeoJSON.Feature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [2, 2] },
  properties: { opacity: 1 },
});

function makeHost(over: Partial<GhostHighlightHost> = {}): GhostHighlightHost {
  return {
    hoveredShotId: null,
    selectedShotId: null,
    hoveredStationId: null,
    selectedStationId: null,
    shotsVisible: true,
    stationsVisible: true,
    selShotWidth: 3,
    hoverShotWidth: 4,
    selRadius: 5,
    hoverRadius: 6,
    hoverStroke: [255, 255, 255, 255],
    selStroke: [255, 255, 255, 255],
    movingEndForShot: () => undefined,
    isMovingStation: () => false,
    parseFid: () => 42,
    isAnchored: () => false,
    isShotImmovable: () => false,
    isStationImmovable: () => false,
    shotFeature,
    stationFeature,
    colorFromProps: () => [10, 20, 30, 255],
    ...over,
  };
}

describe('buildGhostHighlights selected-branch anchored/immovable guard', () => {
  it('highlights a moving selected shot/station that is not anchored or immovable', () => {
    const { shots, stations } = buildGhostHighlights(
      makeHost({
        selectedShotId: 'S1',
        selectedStationId: 'ST1',
        movingEndForShot: (id) => (id === 'S1' ? 'to' : undefined),
        isMovingStation: (id) => id === 'ST1',
      }),
    );
    expect(shots).toHaveLength(1);
    expect(stations).toHaveLength(1);
  });

  it('excludes an anchored selected shot even when it reports as moving', () => {
    const { shots } = buildGhostHighlights(
      makeHost({
        selectedShotId: 'S1',
        movingEndForShot: (id) => (id === 'S1' ? 'to' : undefined),
        isAnchored: () => true, // anchored: must be filtered like the hover branch
      }),
    );
    expect(shots).toHaveLength(0);
  });

  it('excludes an immovable selected shot even when it reports as moving', () => {
    const { shots } = buildGhostHighlights(
      makeHost({
        selectedShotId: 'S1',
        movingEndForShot: (id) => (id === 'S1' ? 'to' : undefined),
        isShotImmovable: () => true,
      }),
    );
    expect(shots).toHaveLength(0);
  });

  it('excludes an anchored/immovable selected station even when it reports as moving', () => {
    const anchored = buildGhostHighlights(
      makeHost({ selectedStationId: 'ST1', isMovingStation: () => true, isAnchored: () => true }),
    );
    expect(anchored.stations).toHaveLength(0);

    const immovable = buildGhostHighlights(
      makeHost({
        selectedStationId: 'ST1',
        isMovingStation: () => true,
        isStationImmovable: () => true,
      }),
    );
    expect(immovable.stations).toHaveLength(0);
  });
});
