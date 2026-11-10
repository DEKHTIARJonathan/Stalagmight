/**
 * #681: the orphan-placement dialog resolves the WHOLE repeat, whichever station
 * "Merge at" picks. `computeOverlapPairs` is the set it walks.
 *
 * INJECTION (tried): returning `.slice(0, -1)` of the pairs (dropping the repeated
 * shot past a mid-overlap merge station, the #681 symptom) reds every "whole
 * overlap" case below.
 */
import { describe, it, expect } from 'vitest';
import {
  computeActionableIds,
  computeMergeOptions,
  computeOverlapPairs,
  type OverlapParams,
} from '../overlapHelpers';

const pairs = (params: OverlapParams) =>
  computeOverlapPairs(params).map((p) => [p.orphanShotIndex, p.targetShotIndex]);

describe('computeOverlapPairs - whole overlap, paired with the existing shot (#681)', () => {
  it('Front + forward: new shots 0..n-1 repeat existing shots from the station on', () => {
    expect(pairs({ importStationIndex: 0, matchedShots: 2, existingStationIndex: 5, direction: 'forward' }))
      .toEqual([[0, 5], [1, 6]]);
  });

  it('Front + reverse: new shots run back down the existing section', () => {
    expect(pairs({ importStationIndex: 0, matchedShots: 2, existingStationIndex: 7, direction: 'reverse' }))
      .toEqual([[0, 6], [1, 5]]);
  });

  it('Back + forward: the last n new shots, in new-section order', () => {
    expect(pairs({ importStationIndex: 6, matchedShots: 2, existingStationIndex: 3, direction: 'forward' }))
      .toEqual([[4, 4], [5, 3]]);
  });

  it('Back + reverse: the last n new shots, in new-section order', () => {
    expect(pairs({ importStationIndex: 6, matchedShots: 2, existingStationIndex: 5, direction: 'reverse' }))
      .toEqual([[4, 3], [5, 4]]);
  });

  it('an overlap of one shot yields exactly that shot', () => {
    expect(pairs({ importStationIndex: 0, matchedShots: 1, existingStationIndex: 9, direction: 'forward' }))
      .toEqual([[0, 9]]);
    expect(pairs({ importStationIndex: 4, matchedShots: 1, existingStationIndex: 9, direction: 'reverse' }))
      .toEqual([[3, 8]]);
  });

  it('no overlap yields no pairs', () => {
    expect(pairs({ importStationIndex: 0, matchedShots: 0, existingStationIndex: 3, direction: 'forward' }))
      .toEqual([]);
  });

  const CASES: Array<[string, OverlapParams, number]> = [
    ['Front + forward', { importStationIndex: 0, matchedShots: 3, existingStationIndex: 4, direction: 'forward' }, 8],
    ['Front + reverse', { importStationIndex: 0, matchedShots: 3, existingStationIndex: 7, direction: 'reverse' }, 8],
    ['Back + forward', { importStationIndex: 8, matchedShots: 3, existingStationIndex: 2, direction: 'forward' }, 8],
    ['Back + reverse', { importStationIndex: 8, matchedShots: 3, existingStationIndex: 6, direction: 'reverse' }, 8],
  ];

  for (const [label, params, shotCount] of CASES) {
    it(`${label}: covers the whole overlap at every merge station, incl. both ends`, () => {
      const covered = new Set(computeOverlapPairs(params).map((p) => p.orphanShotIndex));
      expect(covered.size).toBe(params.matchedShots);

      const options = computeMergeOptions({ ...params, isPartial: false }, shotCount);
      expect(options.length).toBe(params.matchedShots + 1);
      for (const option of options) {
        // The trimming rule drops shots past the merge station; the pairs never do.
        const trimmed = computeActionableIds(params.importStationIndex, params.matchedShots, option.importStation);
        for (const id of trimmed) expect(covered.has(id)).toBe(true);
      }
      // Merging at the terminal station trims nothing - the #681 gap at its widest.
      const atTerminal = options.find((o) => o.offset === 0)!;
      expect(computeActionableIds(params.importStationIndex, params.matchedShots, atTerminal.importStation).size)
        .toBe(0);
    });
  }
});
