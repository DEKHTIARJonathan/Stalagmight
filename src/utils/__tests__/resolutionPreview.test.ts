import { describe, it, expect } from 'vitest';
import { computeGhostEnd, horizontalLength } from '../resolutionPreview';

describe('horizontalLength', () => {
  it('projects slope length by depth change', () => {
    expect(horizontalLength(10, 0)).toBeCloseTo(10, 6);
    expect(horizontalLength(5, 3)).toBeCloseTo(4, 6); // 3-4-5
    expect(horizontalLength(5, 5)).toBeCloseTo(0, 6); // vertical
    expect(horizontalLength(5, 9)).toBe(0); // clamped, never NaN
  });
});

describe('computeGhostEnd', () => {
  // A due-east shot: azimuth 90° places the end at +x (dx = horiz·sin90 = horiz).
  const start = { x: 0, y: 0 };
  const eastEnd = { x: 10, y: 0 };

  it('returns the endpoint unchanged when the proposal matches the current', () => {
    const g = computeGhostEnd(start, eastEnd, 90, 10, 90, 10);
    expect(g).not.toBeNull();
    expect(g!.x).toBeCloseTo(10, 6);
    expect(g!.y).toBeCloseTo(0, 6);
  });

  it('rotates the endpoint about the start when azimuth changes', () => {
    // East (90°) -> North (0°): end moves from (10,0) to (0,10).
    const g = computeGhostEnd(start, eastEnd, 90, 10, 0, 10);
    expect(g).not.toBeNull();
    expect(g!.x).toBeCloseTo(0, 6);
    expect(g!.y).toBeCloseTo(10, 6);
  });

  it('scales along the bearing when length changes', () => {
    // East shot lengthened 10 -> 15: end moves to (15, 0).
    const g = computeGhostEnd(start, eastEnd, 90, 10, 90, 15);
    expect(g).not.toBeNull();
    expect(g!.x).toBeCloseTo(15, 6);
    expect(g!.y).toBeCloseTo(0, 6);
  });

  it('returns null when the planar model cannot reproduce the solved endpoint', () => {
    // Solved end is north, but the shot azimuth says east — a rotated/offset
    // section the model does not capture. No (misleading) ghost.
    const northEnd = { x: 0, y: 10 };
    expect(computeGhostEnd(start, northEnd, 90, 10, 0, 10)).toBeNull();
  });

  it('keeps the ghost anchored to the real end even with float drift within tolerance', () => {
    const almostEast = { x: 10.05, y: 0.0 }; // within 0.1 + 0.05*10 = 0.6
    const g = computeGhostEnd(start, almostEast, 90, 10, 90, 10);
    expect(g).not.toBeNull();
    // Proposal == current, so ghost sits on the real (drifted) end.
    expect(g!.x).toBeCloseTo(10.05, 6);
    expect(g!.y).toBeCloseTo(0, 6);
  });
});
