import { describe, it, expect } from 'vitest';
import { projectParamOnSegment, distanceToLineSegment } from '../hitTest';

describe('projectParamOnSegment (#26 shot-snap fractional position)', () => {
  it('returns 0 at the first endpoint', () => {
    expect(projectParamOnSegment(0, 0, 0, 0, 10, 0)).toBe(0);
  });

  it('returns 1 at the second endpoint', () => {
    expect(projectParamOnSegment(10, 0, 0, 0, 10, 0)).toBe(1);
  });

  it('returns 0.5 at the midpoint', () => {
    expect(projectParamOnSegment(5, 0, 0, 0, 10, 0)).toBeCloseTo(0.5);
  });

  it('clamps to 0 before the start', () => {
    expect(projectParamOnSegment(-5, 0, 0, 0, 10, 0)).toBe(0);
  });

  it('clamps to 1 past the end', () => {
    expect(projectParamOnSegment(20, 0, 0, 0, 10, 0)).toBe(1);
  });

  it('projects a perpendicular offset onto the segment', () => {
    expect(projectParamOnSegment(3, 5, 0, 0, 10, 0)).toBeCloseTo(0.3);
  });

  it('returns 0 for a zero-length segment', () => {
    expect(projectParamOnSegment(5, 5, 2, 2, 2, 2)).toBe(0);
  });
});

describe('distanceToLineSegment (behavior preserved after refactor)', () => {
  it('is 0 for a point on the segment', () => {
    expect(distanceToLineSegment(5, 0, 0, 0, 10, 0)).toBeCloseTo(0);
  });

  it('measures the perpendicular distance', () => {
    expect(distanceToLineSegment(5, 4, 0, 0, 10, 0)).toBeCloseTo(4);
  });

  it('clamps to the nearer endpoint past the end', () => {
    // (13,4) -> nearest is the end (10,0): sqrt(3^2 + 4^2) = 5
    expect(distanceToLineSegment(13, 4, 0, 0, 10, 0)).toBeCloseTo(5);
  });
});
