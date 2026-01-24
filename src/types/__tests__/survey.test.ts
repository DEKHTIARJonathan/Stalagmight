/**
 * Unit tests for survey geometry types and coordinate transforms.
 * Test vectors are loaded from the shared fixture file.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { metersToMapCoords } from '../survey';

// Load test vectors from shared fixture (single source of truth)
interface TestVector {
  name: string;
  description: string;
  origin: { lat: number; lng: number };
  input: { east: number; north: number };
  expected: { lng: number; lat: number };
  tolerance: number;
}

interface FixtureData {
  description: string;
  algorithm: Record<string, string | number>;
  test_vectors: TestVector[];
}

const fixturePath = join(__dirname, '../../../tests/fixtures/coordinate_transform_vectors.json');
const fixtureData: FixtureData = JSON.parse(readFileSync(fixturePath, 'utf-8'));
const testVectors = fixtureData.test_vectors;

describe('metersToMapCoords', () => {
  for (const vector of testVectors) {
    it(vector.description, () => {
      const [lng, lat] = metersToMapCoords(
        vector.input.east,
        vector.input.north,
        vector.origin.lat,
        vector.origin.lng
      );

      expect(lng).toBeCloseTo(vector.expected.lng, 9);
      expect(lat).toBeCloseTo(vector.expected.lat, 9);
    });
  }

  it('handles zero displacement', () => {
    const [lng, lat] = metersToMapCoords(0, 0, 45.0, -90.0);
    expect(lng).toBe(-90.0);
    expect(lat).toBe(45.0);
  });

  it('handles high latitude (70°N)', () => {
    // At 70°N, cos(70°) ≈ 0.342, so longitude degrees are much shorter
    const [lng, lat] = metersToMapCoords(1000, 0, 70.0, 0.0);

    // meters_per_deg_lng = 111320 * cos(70°) ≈ 38073
    // lng_delta = 1000 / 38073 ≈ 0.02626
    expect(lng).toBeCloseTo(0.02626, 4);
    expect(lat).toBe(70.0);
  });

  it('matches Rust algorithm exactly', () => {
    // This test validates the exact algorithm matches the Rust implementation
    const METERS_PER_DEGREE_LAT = 111320.0;
    const originLat = 45.0;
    const originLng = -90.0;
    const east = 1000.0;
    const north = 500.0;

    const originLatRad = (originLat * Math.PI) / 180;
    const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos(originLatRad);

    const expectedLat = originLat + north / METERS_PER_DEGREE_LAT;
    const expectedLng = originLng + east / metersPerDegreeLng;

    const [lng, lat] = metersToMapCoords(east, north, originLat, originLng);

    expect(lng).toBe(expectedLng);
    expect(lat).toBe(expectedLat);
  });

  it('fixture file contains expected test vectors', () => {
    // Verify the fixture has the expected structure and count
    expect(testVectors.length).toBeGreaterThanOrEqual(8);
    expect(testVectors[0]).toHaveProperty('name');
    expect(testVectors[0]).toHaveProperty('origin');
    expect(testVectors[0]).toHaveProperty('input');
    expect(testVectors[0]).toHaveProperty('expected');
  });
});
