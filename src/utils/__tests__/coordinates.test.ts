import { describe, it, expect } from 'vitest';
import {
  metersToMapCoords,
  mapCoordsToMeters,
  gpsToXY,
  xyToGps,
  distance,
  horizontalDistance,
  getBounds,
  getBoundsFromStationCoords,
  calculateAzimuth,
  calculatePosition,
  formatCoordinate,
  formatGps,
} from '../coordinates';
import type { Coordinates, GpsCoordinates } from '../../types/project';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coord(x: number, y: number, z: number): Coordinates {
  return { x, y, z };
}

function gps(lat: number, lng: number, depth: number): GpsCoordinates {
  return { latitude: lat, longitude: lng, depth_reference: depth };
}

const EQUATOR_ORIGIN = { latitude: 0, longitude: 0 };

// ---------------------------------------------------------------------------
// metersToMapCoords / mapCoordsToMeters - no GPS origin (pseudo mode)
// ---------------------------------------------------------------------------

describe('metersToMapCoords (pseudo mode)', () => {
  it('converts origin to (0,0)', () => {
    const [lng, lat] = metersToMapCoords(0, 0);
    expect(lng).toBe(0);
    expect(lat).toBe(0);
  });

  it('converts 111320m east to ~1° longitude', () => {
    const [lng] = metersToMapCoords(111320, 0);
    expect(lng).toBeCloseTo(1.0, 3);
  });

  it('converts 111320m north to ~1° latitude', () => {
    const [, lat] = metersToMapCoords(0, 111320);
    expect(lat).toBeCloseTo(1.0, 3);
  });
});

describe('mapCoordsToMeters (pseudo mode)', () => {
  it('converts (0,0) to origin', () => {
    const { x, y } = mapCoordsToMeters(0, 0);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });

  it('round-trips with metersToMapCoords', () => {
    const [lng, lat] = metersToMapCoords(500, -300);
    const { x, y } = mapCoordsToMeters(lng, lat);
    expect(x).toBeCloseTo(500, 3);
    expect(y).toBeCloseTo(-300, 3);
  });
});

// ---------------------------------------------------------------------------
// metersToMapCoords / mapCoordsToMeters - with GPS origin
// ---------------------------------------------------------------------------

describe('metersToMapCoords (GPS mode)', () => {
  it('maps origin meters to origin GPS', () => {
    const origin = { latitude: 45, longitude: -90 };
    const [lng, lat] = metersToMapCoords(0, 0, origin);
    expect(lng).toBeCloseTo(-90, 3);
    expect(lat).toBeCloseTo(45, 3);
  });

  it('100m east from equator origin shifts longitude', () => {
    const [lng, lat] = metersToMapCoords(100, 0, EQUATOR_ORIGIN);
    // 100m east at equator is a small fraction of a degree
    expect(lng).toBeGreaterThan(0);
    expect(lng).toBeLessThan(0.01);
    expect(lat).toBeCloseTo(0, 3);
  });

  it('round-trips through mapCoordsToMeters', () => {
    const origin = { latitude: 30, longitude: 10 };
    const [lng, lat] = metersToMapCoords(250, -150, origin);
    const { x, y } = mapCoordsToMeters(lng, lat, origin);
    expect(x).toBeCloseTo(250, 0);
    expect(y).toBeCloseTo(-150, 0);
  });
});

// ---------------------------------------------------------------------------
// gpsToXY / xyToGps round-trip
// ---------------------------------------------------------------------------

describe('gpsToXY / xyToGps', () => {
  it('returns origin for same point', () => {
    const origin = gps(45, -90, 0);
    const xy = gpsToXY(origin, origin);
    expect(xy.x).toBeCloseTo(0, 1);
    expect(xy.y).toBeCloseTo(0, 1);
  });

  it('preserves depth_reference in z', () => {
    const point = gps(45, -90, 42);
    const origin = gps(45, -90, 0);
    const xy = gpsToXY(point, origin);
    expect(xy.z).toBe(42);
  });

  it('round-trips through xyToGps', () => {
    const origin = gps(10, 20, 0);
    const point = gps(10.001, 20.001, 5);
    const xy = gpsToXY(point, origin);
    const back = xyToGps(xy, origin);
    expect(back.latitude).toBeCloseTo(10.001, 3);
    expect(back.longitude).toBeCloseTo(20.001, 3);
    expect(back.depth_reference).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// distance
// ---------------------------------------------------------------------------

describe('distance', () => {
  it('returns 0 for same point', () => {
    expect(distance(coord(1, 2, 3), coord(1, 2, 3))).toBe(0);
  });

  it('calculates 3D Euclidean distance', () => {
    // 3-4-5 triangle in XY, then Z=0
    expect(distance(coord(0, 0, 0), coord(3, 4, 0))).toBeCloseTo(5, 10);
  });

  it('includes Z component', () => {
    // sqrt(1 + 1 + 1) = sqrt(3) ≈ 1.732
    expect(distance(coord(0, 0, 0), coord(1, 1, 1))).toBeCloseTo(Math.sqrt(3), 10);
  });

  it('handles negative coordinates', () => {
    expect(distance(coord(-5, -5, -5), coord(5, 5, 5))).toBeCloseTo(Math.sqrt(300), 5);
  });
});

// ---------------------------------------------------------------------------
// horizontalDistance
// ---------------------------------------------------------------------------

describe('horizontalDistance', () => {
  it('ignores Z component', () => {
    expect(horizontalDistance(coord(0, 0, 0), coord(3, 4, 100))).toBeCloseTo(5, 10);
  });

  it('returns 0 for same XY', () => {
    expect(horizontalDistance(coord(1, 2, 0), coord(1, 2, 99))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getBounds
// ---------------------------------------------------------------------------

describe('getBounds', () => {
  it('returns zeros for empty array', () => {
    const b = getBounds([]);
    expect(b).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 });
  });

  it('returns point for single coordinate', () => {
    const b = getBounds([coord(5, -3, 2)]);
    expect(b.minX).toBe(5);
    expect(b.maxX).toBe(5);
    expect(b.minY).toBe(-3);
    expect(b.maxY).toBe(-3);
    expect(b.minZ).toBe(2);
    expect(b.maxZ).toBe(2);
  });

  it('computes correct bounds for multiple coordinates', () => {
    const b = getBounds([
      coord(-10, 5, 0),
      coord(20, -15, 3),
      coord(0, 0, -1),
    ]);
    expect(b.minX).toBe(-10);
    expect(b.maxX).toBe(20);
    expect(b.minY).toBe(-15);
    expect(b.maxY).toBe(5);
    expect(b.minZ).toBe(-1);
    expect(b.maxZ).toBe(3);
  });
});

describe('getBoundsFromStationCoords', () => {
  it('returns zeros for an empty buffer (matches getBounds([]))', () => {
    expect(getBoundsFromStationCoords(new Float64Array(0))).toEqual(getBounds([]));
  });

  it('matches getBounds over the same coordinates without materializing objects', () => {
    const pts = [coord(-10, 5, 0), coord(20, -15, 3), coord(0, 0, -1)];
    const flat = new Float64Array(pts.flatMap((p) => [p.x, p.y, p.z]));
    expect(getBoundsFromStationCoords(flat)).toEqual(getBounds(pts));
  });

  it('handles a single station', () => {
    expect(getBoundsFromStationCoords(new Float64Array([5, -3, 2]))).toEqual(getBounds([coord(5, -3, 2)]));
  });
});

// ---------------------------------------------------------------------------
// calculateAzimuth
// ---------------------------------------------------------------------------

describe('calculateAzimuth', () => {
  it('north is 0°', () => {
    // Moving in +Y direction = north = 0°
    expect(calculateAzimuth(coord(0, 0, 0), coord(0, 10, 0))).toBeCloseTo(0, 5);
  });

  it('east is 90°', () => {
    expect(calculateAzimuth(coord(0, 0, 0), coord(10, 0, 0))).toBeCloseTo(90, 5);
  });

  it('south is 180°', () => {
    expect(calculateAzimuth(coord(0, 0, 0), coord(0, -10, 0))).toBeCloseTo(180, 5);
  });

  it('west is 270°', () => {
    expect(calculateAzimuth(coord(0, 0, 0), coord(-10, 0, 0))).toBeCloseTo(270, 5);
  });

  it('northeast is 45°', () => {
    expect(calculateAzimuth(coord(0, 0, 0), coord(10, 10, 0))).toBeCloseTo(45, 5);
  });

  it('result is always in [0, 360)', () => {
    const result = calculateAzimuth(coord(5, 5, 0), coord(0, 0, 0));
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(360);
  });
});

// ---------------------------------------------------------------------------
// calculatePosition
// ---------------------------------------------------------------------------

describe('calculatePosition', () => {
  it('north at 0° moves in +Y', () => {
    const pos = calculatePosition(coord(0, 0, 0), 0, 10, 0);
    expect(pos.x).toBeCloseTo(0, 5);
    expect(pos.y).toBeCloseTo(10, 5);
    expect(pos.z).toBe(0);
  });

  it('east at 90° moves in +X', () => {
    const pos = calculatePosition(coord(0, 0, 0), 90, 10, 0);
    expect(pos.x).toBeCloseTo(10, 5);
    expect(pos.y).toBeCloseTo(0, 5);
  });

  it('applies depth change to Z', () => {
    const pos = calculatePosition(coord(0, 0, 5), 0, 10, 3);
    expect(pos.z).toBe(8);
  });

  it('round-trips with calculateAzimuth', () => {
    const from = coord(10, 20, 0);
    const azimuth = 135;
    const dist = 15;
    const to = calculatePosition(from, azimuth, dist, 0);
    const backAzimuth = calculateAzimuth(from, to);
    expect(backAzimuth).toBeCloseTo(azimuth, 5);
  });

  it('starts from arbitrary position', () => {
    const pos = calculatePosition(coord(100, 200, 50), 0, 5, -2);
    expect(pos.x).toBeCloseTo(100, 5);
    expect(pos.y).toBeCloseTo(205, 5);
    expect(pos.z).toBe(48);
  });
});

// ---------------------------------------------------------------------------
// formatCoordinate / formatGps
// ---------------------------------------------------------------------------

describe('formatCoordinate', () => {
  it('formats with default precision', () => {
    const result = formatCoordinate(12.345);
    expect(result).toBe('12.3');
  });

  it('formats with custom precision', () => {
    const result = formatCoordinate(12.345, 2);
    expect(result).toBe('12.35');
  });
});

describe('formatGps', () => {
  it('formats lat/lng with default precision', () => {
    const result = formatGps(gps(45.123456, -90.654321, 0));
    expect(result).toBe('45.123456, -90.654321');
  });

  it('formats with custom precision', () => {
    const result = formatGps(gps(45.1, -90.2, 0), 2);
    expect(result).toBe('45.10, -90.20');
  });
});
