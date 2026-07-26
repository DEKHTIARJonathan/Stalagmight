import { describe, expect, it } from 'vitest';
import { encodeFeatureId, sectionIdFromKey, FEATURE_ID_STRIDE } from '../ids';

describe('sectionIdFromKey', () => {
  it('reads the section id out of a feature key', () => {
    expect(sectionIdFromKey('0:0')).toBe(0);
    expect(sectionIdFromKey('1:0')).toBe(1);
    expect(sectionIdFromKey('7:42')).toBe(7);
  });

  // The regression #301 turned on. A shot id is ALREADY section-encoded by the
  // backend (next_shot_id = section.id * FEATURE_ID_STRIDE), so a section-1
  // shot's key is "1:100000" and its feature id is 2 * FEATURE_ID_STRIDE.
  // Inverting encodeFeatureId then reports section 2 - the key does not.
  it('is correct for shot keys, where the floor-divide decode is not', () => {
    const sectionId = 1;
    const shotId = sectionId * FEATURE_ID_STRIDE; // first shot of section 1
    const key = `${sectionId}:${shotId}`;

    expect(sectionIdFromKey(key)).toBe(1);
    expect(Math.floor(encodeFeatureId(sectionId, shotId) / FEATURE_ID_STRIDE)).toBe(2);
  });

  it('agrees with the floor-divide decode for station keys, which are section-local', () => {
    const sectionId = 3;
    const stationIndex = 12;
    expect(sectionIdFromKey(`${sectionId}:${stationIndex}`)).toBe(sectionId);
    expect(Math.floor(encodeFeatureId(sectionId, stationIndex) / FEATURE_ID_STRIDE)).toBe(sectionId);
  });

  it('yields NaN for a malformed key so membership tests fail closed', () => {
    expect(sectionIdFromKey('abc:1')).toBeNaN();
    expect(sectionIdFromKey('')).toBeNaN();
    expect(new Set([0, 1]).has(sectionIdFromKey('abc:1'))).toBe(false);
  });
});
