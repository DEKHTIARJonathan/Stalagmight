import { describe, it, expect } from 'vitest';
import { hasEligibleClosures, CLOSURE_ELIGIBLE_STRATEGIES } from '../closures';
import type { ClosureStrategy } from '../../types/ipc/ClosureStrategy';

const c = (strategy: ClosureStrategy) => ({ strategy });

describe('hasEligibleClosures', () => {
  it('is false for an empty list', () => {
    expect(hasEligibleClosures([])).toBe(false);
  });

  it('is true when a Batch or LeastSquaresWeighted closure is present', () => {
    expect(hasEligibleClosures([c('Batch')])).toBe(true);
    expect(hasEligibleClosures([c('LeastSquaresWeighted')])).toBe(true);
    expect(hasEligibleClosures([c('Move'), c('Batch')])).toBe(true);
  });

  it('is false when only ineligible (Move / deferred) closures are present', () => {
    expect(hasEligibleClosures([c('Move')])).toBe(false);
    expect(hasEligibleClosures([c('ProportionalByLength'), c('EqualDistribution')])).toBe(false);
  });

  it('eligible set mirrors the backend (Batch + LeastSquaresWeighted only)', () => {
    expect([...CLOSURE_ELIGIBLE_STRATEGIES].sort()).toEqual(['Batch', 'LeastSquaresWeighted']);
  });
});
