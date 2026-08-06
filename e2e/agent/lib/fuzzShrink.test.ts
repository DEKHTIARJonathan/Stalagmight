/**
 * ddmin, tested against a MOCK replay.
 *
 * The real test costs a whole app cycle - seconds - so the algorithm has to be
 * provable without it. Every oracle below is a pure predicate over the candidate,
 * which makes the properties that matter (does it find the minimum, is the result
 * 1-minimal, is a DIFFERENT failure rejected, is the cache actually used, does
 * the budget stop it) checkable in milliseconds and independently of whether the
 * app is even built.
 */
import { describe, expect, it } from 'vitest';

import { ddmin, isOneMinimal, partition, type ShrinkVerdict } from './fuzzShrink';

/** An oracle that fails exactly when every member of `required` is present. */
function requires(required: readonly string[]): (candidate: string[]) => Promise<ShrinkVerdict> {
  return async (candidate) =>
    required.every((item) => candidate.includes(item)) ? 'preserved' : 'passed';
}

const ALPHABET = 'abcdefghijklmnop'.split('');

describe('ddmin', () => {
  it('reduces to the single step that carries the failure', async () => {
    const { minimal, stats } = await ddmin(ALPHABET, { test: requires(['h']) });
    expect(minimal).toEqual(['h']);
    expect(stats.preserved).toBeGreaterThan(0);
    expect(stats.tests).toBeLessThan(ALPHABET.length * ALPHABET.length);
  });

  it('finds a minimal PAIR when the failure needs two steps together', async () => {
    const { minimal } = await ddmin(ALPHABET, { test: requires(['c', 'm']) });
    expect(minimal.sort()).toEqual(['c', 'm']);
  });

  it('preserves the original order of the steps it keeps', async () => {
    const { minimal } = await ddmin(ALPHABET, { test: requires(['m', 'c']) });
    expect(minimal).toEqual(['c', 'm']);
  });

  it('returns a 1-minimal result: no single step can still be dropped', async () => {
    const test = requires(['b', 'i', 'o']);
    const { minimal } = await ddmin(ALPHABET, { test });
    expect(await isOneMinimal(minimal, test)).toBe(true);
  });

  it('leaves a trace alone when every step is load-bearing', async () => {
    const input = ['x', 'y', 'z'];
    const { minimal } = await ddmin(input, { test: requires(input) });
    expect(minimal).toEqual(input);
  });

  it('handles a single-step input without testing anything', async () => {
    let calls = 0;
    const { minimal, stats } = await ddmin(['only'], {
      test: async () => {
        calls += 1;
        return 'preserved';
      },
    });
    expect(minimal).toEqual(['only']);
    expect(calls).toBe(0);
    expect(stats.tests).toBe(0);
  });

  // The property the coordinator's brief calls out explicitly: a smaller trace
  // can hit a DIFFERENT bug, and ddmin must treat that as "does not preserve".
  it('REJECTS a smaller candidate that fails with a different signature', async () => {
    // Any candidate without 'h' still "fails", but as a different defect, so it
    // must never be adopted however much smaller it is.
    const test = async (candidate: string[]): Promise<ShrinkVerdict> =>
      candidate.includes('h') ? 'preserved' : candidate.length > 0 ? 'divergent' : 'passed';
    const { minimal, stats } = await ddmin(ALPHABET, { test });
    expect(minimal).toEqual(['h']);
    expect(stats.divergent).toBeGreaterThan(0);
  });

  it('never accepts a divergent candidate even when it is the only smaller one', async () => {
    const seen: string[][] = [];
    const test = async (candidate: string[]): Promise<ShrinkVerdict> => {
      seen.push([...candidate]);
      return 'divergent';
    };
    const input = ['p', 'q', 'r', 's'];
    const { minimal, stats } = await ddmin(input, { test });
    expect(minimal).toEqual(input);
    expect(stats.preserved).toBe(0);
    expect(seen.length).toBe(stats.tests);
  });

  it('serves repeated candidates from the cache instead of replaying them', async () => {
    // With two chunks, the complement of the first IS the second, which the
    // subset phase has already replayed. On a real trace that is one whole app
    // cycle saved, which is why the cache is not a micro-optimization.
    let calls = 0;
    const test = async (candidate: string[]): Promise<ShrinkVerdict> => {
      calls += 1;
      return candidate.includes('a') && candidate.includes('p') ? 'preserved' : 'passed';
    };
    const { stats } = await ddmin(ALPHABET, { test });
    expect(calls).toBe(stats.tests);
    expect(stats.cacheHits).toBeGreaterThan(0);
  });

  it('stops at maxTests and returns the best candidate found so far', async () => {
    const { minimal, stats } = await ddmin(ALPHABET, { test: requires(['h']), maxTests: 3 });
    expect(stats.tests).toBeLessThanOrEqual(3);
    expect(minimal.length).toBeLessThanOrEqual(ALPHABET.length);
    expect(minimal).toContain('h');
  });

  it('reports progress for every replay, with the running best size', async () => {
    const sizes: number[] = [];
    await ddmin(ALPHABET, {
      test: requires(['a', 'p']),
      onProgress: (info) => sizes.push(info.bestSize),
    });
    expect(sizes.length).toBeGreaterThan(0);
    // The best size never grows.
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1] as number);
    }
  });

  it('scales to a long trace with one culprit', async () => {
    const long = Array.from({ length: 200 }, (_, i) => `step-${i}`);
    const { minimal, stats } = await ddmin(long, { test: requires(['step-137']) });
    expect(minimal).toEqual(['step-137']);
    // Nowhere near the O(k^2) worst case for this shape.
    expect(stats.tests).toBeLessThan(200);
  });
});

describe('isOneMinimal', () => {
  it('is false when a step can still be dropped', async () => {
    expect(await isOneMinimal(['a', 'b'], requires(['a']))).toBe(false);
  });

  it('is true when every step is needed', async () => {
    expect(await isOneMinimal(['a', 'b'], requires(['a', 'b']))).toBe(true);
  });
});

describe('partition', () => {
  it('splits into the requested number of non-empty chunks', () => {
    expect(partition([1, 2, 3, 4, 5, 6], 3)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it('covers every element exactly once for an uneven split', () => {
    const chunks = partition([1, 2, 3, 4, 5], 3);
    expect(chunks.flat()).toEqual([1, 2, 3, 4, 5]);
  });

  it('drops empty chunks when count exceeds the length', () => {
    const chunks = partition([1, 2], 5);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
    expect(chunks.flat()).toEqual([1, 2]);
  });
});
