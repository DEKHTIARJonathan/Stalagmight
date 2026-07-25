import { describe, it, expect } from 'vitest';
import { buildGhostRenderData, type GhostRenderContext } from '../dragGhostData';
import type { DragPreviewSet } from '../dragPreviewSource';

/**
 * Custom drag-ghost render-data builder (#mem drag latency): display-toggle
 * filtering + the grabbed-feature highlight pass. The highlight is emitted ONLY
 * for MOVING hovered/selected features - the exact set the stock interact-overlay
 * follow is suppressed for while the custom ghost is active (so there is no
 * lagging duplicate), which these tests pin from the ghost side.
 */

const STATION_A = '0:0';
const SHOT_A = '0:1';

const SET: DragPreviewSet = {
  features: [
    { emit: 'point', coords: [[0, 0]], movingEnd: 'uniform', properties: { kind: 'station', color: '#00ff00' } },
    { emit: 'line', coords: [[0, 0], [1, 0]], movingEnd: 'uniform', properties: { kind: 'shot', color: '#ff0000' } },
    { emit: 'line', coords: [[0, 0], [1, 1]], movingEnd: 'both', properties: { kind: 'closure', color: '#0000ff' } },
  ],
};

function stationFeature(): GeoJSON.Feature {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { color: '#00ff00', opacity: 1 } };
}
function shotFeature(width: number): GeoJSON.Feature {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0]] },
    properties: { color: '#ff0000', opacity: 1, width },
  };
}

function ctx(over: Partial<GhostRenderContext> = {}): GhostRenderContext {
  return {
    dpr: 1,
    themeColors: { grayLine: '#888888', selectHighlight: '#ffffff', hoverHighlight: '#ffff00' },
    overlay: null,
    shotsVisible: true,
    stationsVisible: true,
    selShotWidth: 3,
    hoverShotWidth: 4,
    selRadius: 5,
    hoverRadius: 6,
    hoveredShotId: null,
    selectedShotId: null,
    hoveredStationId: null,
    selectedStationId: null,
    movingEndForShot: () => undefined,
    isMovingStation: () => false,
    parseFid: () => null,
    isAnchored: () => false,
    isShotImmovable: () => false,
    isStationImmovable: () => false,
    shotFeature: (_id, w) => shotFeature(w),
    stationFeature: () => stationFeature(),
    ...over,
  };
}

describe('display-toggle filtering', () => {
  it('draws everything when both toggles are on (station + shot + closure)', () => {
    const { line, circle } = buildGhostRenderData(SET, ctx());
    expect(circle.stationCount).toBe(1);
    expect(line.segmentCount).toBe(2); // shot + closure
  });

  it('skips station discs when showStations is off', () => {
    const { circle } = buildGhostRenderData(SET, ctx({ stationsVisible: false }));
    expect(circle.stationCount).toBe(0);
  });

  it('skips shot capsules when showShots is off (closure follows the stations toggle)', () => {
    const { line } = buildGhostRenderData(SET, ctx({ shotsVisible: false }));
    // shot dropped; closure kept (stations still visible).
    expect(line.segmentCount).toBe(1);
  });

  it('a hidden kind also suppresses its grabbed highlight', () => {
    const { circle } = buildGhostRenderData(
      SET,
      ctx({ stationsVisible: false, hoveredStationId: STATION_A, isMovingStation: (id) => id === STATION_A }),
    );
    expect(circle.stationCount).toBe(0);
  });
});

describe('grabbed-feature highlight pass', () => {
  it('emits a hover station highlight (size + stroke mults) for a MOVING hovered station', () => {
    const { circle } = buildGhostRenderData(
      SET,
      ctx({ hoveredStationId: STATION_A, isMovingStation: (id) => id === STATION_A }),
    );
    expect(circle.stationCount).toBe(2); // base + highlight
    // Highlight (vertex 4): hover radius 6/5, hover stroke 4/2.5, hover color #ffff00.
    expect(circle.sizeMul[4]).toBeCloseTo(6 / 5);
    expect(circle.strokeMul[4]).toBeCloseTo(4 / 2.5);
    expect([circle.stroke[16], circle.stroke[17], circle.stroke[18]]).toEqual([255, 255, 0]);
  });

  it('emits a hover shot highlight (width mult) for a MOVING hovered shot', () => {
    const { line } = buildGhostRenderData(
      SET,
      ctx({ hoveredShotId: SHOT_A, movingEndForShot: (id) => (id === SHOT_A ? 'uniform' : undefined) }),
    );
    expect(line.segmentCount).toBe(3); // shot + closure + highlight
    expect(line.widthMul[8]).toBeCloseTo(4 / 3); // seg 2 (highlight) -> vertex 8
  });

  it('does NOT highlight a hovered feature that is NOT in the moving set (overlay keeps it)', () => {
    const { circle } = buildGhostRenderData(
      SET,
      ctx({ hoveredStationId: STATION_A, isMovingStation: () => false }),
    );
    expect(circle.stationCount).toBe(1); // base only, no highlight pass
  });

  it('does NOT highlight an anchored moving feature', () => {
    const { circle } = buildGhostRenderData(
      SET,
      ctx({
        hoveredStationId: STATION_A,
        isMovingStation: (id) => id === STATION_A,
        parseFid: () => 42,
        isAnchored: () => true,
      }),
    );
    expect(circle.stationCount).toBe(1);
  });

  it('hover wins over selection on the same station (one highlight, hover style)', () => {
    const { circle } = buildGhostRenderData(
      SET,
      ctx({
        hoveredStationId: STATION_A,
        selectedStationId: STATION_A,
        isMovingStation: (id) => id === STATION_A,
      }),
    );
    expect(circle.stationCount).toBe(2); // base + one highlight (not two)
    expect(circle.sizeMul[4]).toBeCloseTo(6 / 5); // hover size
  });
});
