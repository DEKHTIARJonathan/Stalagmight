import { describe, it, expect } from 'vitest';
import {
  toXY,
  isBoxGeometry,
  padProbeBox,
  probePad,
  PROBE_EPSILON,
} from '../hitProbe';

describe('hitProbe.toXY', () => {
  it('reads an {x, y} point', () => {
    expect(toXY({ x: 3, y: 7 })).toEqual([3, 7]);
  });
  it('reads an [x, y] pair', () => {
    expect(toXY([3, 7])).toEqual([3, 7]);
  });
});

describe('hitProbe.isBoxGeometry', () => {
  it('treats an [x, y] point as NOT a box', () => {
    expect(isBoxGeometry([10, 20])).toBe(false);
  });
  it('treats an {x, y} point as NOT a box', () => {
    expect(isBoxGeometry({ x: 10, y: 20 })).toBe(false);
  });
  it('treats a two-corner [[x,y],[x,y]] as a box', () => {
    expect(isBoxGeometry([[1, 2], [3, 4]])).toBe(true);
  });
  it('treats a two-corner box of {x,y} points as a box', () => {
    expect(isBoxGeometry([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe(true);
  });
});

describe('hitProbe.padProbeBox', () => {
  it('pads a single {x,y} point symmetrically', () => {
    expect(padProbeBox({ x: 100, y: 50 }, 3)).toEqual([[97, 47], [103, 53]]);
  });
  it('pads a single [x,y] point symmetrically', () => {
    expect(padProbeBox([100, 50], 3)).toEqual([[97, 47], [103, 53]]);
  });
  it('expands a box outward on every side', () => {
    expect(padProbeBox([[10, 10], [30, 40]], 5)).toEqual([[5, 5], [35, 45]]);
  });
  it('normalizes unordered box corners before padding', () => {
    // maxX/minX and maxY/minY are recovered regardless of corner order.
    expect(padProbeBox([[30, 40], [10, 10]], 5)).toEqual([[5, 5], [35, 45]]);
  });
  it('handles zero padding (degenerate box at the point)', () => {
    expect(padProbeBox([100, 50], 0)).toEqual([[100, 50], [100, 50]]);
  });
});

describe('hitProbe.probePad', () => {
  it('restores the old axis reach: pad + visibleHalf === reach (+ epsilon)', () => {
    // Default shot config: hitbox line width 8 -> reach 4; visible line width 2
    // -> visibleHalf 1. pad = 4 - 1 = 3, plus the boundary epsilon.
    const reach = 4;
    const visibleHalf = 1;
    const pad = probePad(reach, visibleHalf);
    expect(pad).toBe(reach - visibleHalf + PROBE_EPSILON);
    // The padded box reaches at least `reach` px along each axis, so no
    // candidate within the old tolerance is ever lost.
    expect(pad + visibleHalf).toBeGreaterThanOrEqual(reach);
  });

  it('restores the station reach: radius-based reach', () => {
    // Default station config: hitbox radius 10 -> reach 10; visible radius 4.
    const reach = 10;
    const visibleHalf = 4;
    const pad = probePad(reach, visibleHalf);
    expect(pad).toBeCloseTo(6 + PROBE_EPSILON);
    expect(pad + visibleHalf).toBeGreaterThanOrEqual(reach);
  });

  it('clamps to >= 0 (+ epsilon) when the visible mark already exceeds the reach', () => {
    // A visible mark wider than the old hitbox must never shrink the box below
    // the probe point.
    const pad = probePad(2, 5);
    expect(pad).toBe(PROBE_EPSILON);
  });

  it('honors a custom epsilon', () => {
    expect(probePad(4, 1, 0)).toBe(3);
    expect(probePad(4, 1, 2)).toBe(5);
  });
});
