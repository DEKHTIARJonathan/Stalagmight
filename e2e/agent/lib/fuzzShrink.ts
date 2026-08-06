/**
 * ddmin over a recorded fuzz trace: given a failing list of moves, find a
 * 1-MINIMAL sublist that still fails the same way.
 *
 * ## The algorithm
 *
 * Zeller and Hildebrandt's delta debugging (`ddmin`), unmodified. Partition the
 * candidate into `n` chunks; if any single chunk still fails, recurse into it
 * with `n = 2`; otherwise if any chunk's COMPLEMENT still fails, drop that chunk
 * and continue with `n - 1`; otherwise double `n` and try again. Stop when `n`
 * reaches the candidate's length, at which point the complements are the
 * single-element removals - so termination IS the 1-minimality proof: no single
 * remaining step can be removed without losing the failure.
 *
 * Worst case is O(k^2) tests for a k-step trace, and a test here is a whole app
 * cycle, so the cache below is not an optimization detail - a shrink revisits the
 * same candidate often enough that it changes the wall clock materially.
 *
 * ## What a "test" means here, and why removal is sound
 *
 * The test is `replay(candidate)` -> "did it fail with the SAME signature". Two
 * properties make removing an arbitrary step well-defined rather than a guess:
 *
 *   1. THE REPLAYER SKIPS IMPOSSIBLE MOVES. Removing a mutation leaves the
 *      recorded `undo` steps around it pointing at depths that no longer exist.
 *      Rather than special-casing which kinds may be removed, the replayer treats
 *      a history move whose precondition is not met (undo at depth 0, redo at the
 *      top, a jump wider than the reach) as a NO-OP and counts it. Skipping
 *      asserts nothing, so it can never turn a failing run green by hiding
 *      something; it just makes every subsequence a runnable scenario.
 *   2. THE FINAL ROUNDTRIP IS REGENERATED, NEVER REPLAYED. A trace does not
 *      contain the closing unwind/rewind: the replayer always unwinds to depth 0
 *      and rewinds to the top at the end, whatever the trace is. So a shrink can
 *      never remove the walk that visits every depth in both directions, which is
 *      the part of the run most failures are actually observed in.
 *
 * Together those mean the search space is "every subsequence of the recorded
 * moves", with no per-kind rules to get wrong, and the closing roundtrip as a
 * floor under every candidate.
 *
 * ## Signature matching is the correctness condition
 *
 * A smaller trace can genuinely hit a DIFFERENT bug - these fuzzers reproduce
 * eleven of them. Accepting that as "still fails" would let a shrink wander off
 * the defect it was pointed at and report a minimal trace for something else. So
 * the test compares `FailureSignature`s (`fuzzTrace.ts`), and a mismatch counts
 * as "does not preserve the failure": the candidate is rejected exactly like a
 * passing one. `shrinkStats.divergent` counts how often that happened, because a
 * high count is worth knowing - it means the region being cut is load-bearing for
 * something else too.
 */

/** Outcome of replaying one candidate. */
export type ShrinkVerdict = 'preserved' | 'passed' | 'divergent';

export interface ShrinkStats {
  /** Candidates actually replayed (cache hits excluded). */
  tests: number;
  /** Candidates served from the cache. */
  cacheHits: number;
  /** Candidates that still failed the same way. */
  preserved: number;
  /** Candidates that passed, i.e. lost the failure. */
  passed: number;
  /** Candidates that failed DIFFERENTLY, and so were rejected. */
  divergent: number;
}

export interface ShrinkResult<T> {
  minimal: T[];
  stats: ShrinkStats;
}

export interface ShrinkOptions<T> {
  /** Replay a candidate and say whether it still fails the same way. */
  test(candidate: T[]): Promise<ShrinkVerdict>;
  /** Called after every test, for progress output. */
  onProgress?(info: {
    candidateSize: number;
    bestSize: number;
    verdict: ShrinkVerdict;
    stats: ShrinkStats;
  }): void;
  /**
   * Stop early after this many replays, keeping the best candidate found. 0 (the
   * default) means no limit. A budget makes the CLI usable against a trace whose
   * length would otherwise cost hours; the result is then "smallest found", not
   * "1-minimal", and the caller is told which.
   */
  maxTests?: number;
}

function key(indices: readonly number[]): string {
  return indices.join(',');
}

/**
 * ddmin. `input` must already be known to fail; that is not re-verified here
 * (the CLI does it once, up front, and needs the original signature anyway).
 */
export async function ddmin<T>(input: readonly T[], options: ShrinkOptions<T>): Promise<ShrinkResult<T>> {
  const stats: ShrinkStats = { tests: 0, cacheHits: 0, preserved: 0, passed: 0, divergent: 0 };
  const cache = new Map<string, ShrinkVerdict>();
  const maxTests = options.maxTests ?? 0;
  let exhausted = false;

  const run = async (indices: number[]): Promise<ShrinkVerdict> => {
    const cacheKey = key(indices);
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      stats.cacheHits += 1;
      return cached;
    }
    if (maxTests > 0 && stats.tests >= maxTests) {
      exhausted = true;
      return 'passed';
    }
    const verdict = await options.test(indices.map((index) => input[index] as T));
    stats.tests += 1;
    if (verdict === 'preserved') stats.preserved += 1;
    else if (verdict === 'passed') stats.passed += 1;
    else stats.divergent += 1;
    cache.set(cacheKey, verdict);
    options.onProgress?.({
      candidateSize: indices.length,
      bestSize: best.length,
      verdict,
      stats: { ...stats },
    });
    return verdict;
  };

  let best = input.map((_, index) => index);
  let granularity = 2;

  while (best.length >= 2 && !exhausted) {
    const chunks = partition(best, Math.min(granularity, best.length));

    // Reduce to a subset: one chunk on its own still fails.
    let advanced = false;
    for (const chunk of chunks) {
      if (chunk.length === 0 || chunk.length === best.length) continue;
      if ((await run(chunk)) === 'preserved') {
        best = chunk;
        granularity = 2;
        advanced = true;
        break;
      }
      if (exhausted) break;
    }
    if (advanced) continue;
    if (exhausted) break;

    // Reduce to a complement: everything except one chunk still fails.
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      const drop = new Set(chunk);
      const complement = best.filter((index) => !drop.has(index));
      if (complement.length === best.length || complement.length === 0) continue;
      if ((await run(complement)) === 'preserved') {
        best = complement;
        granularity = Math.max(granularity - 1, 2);
        advanced = true;
        break;
      }
      if (exhausted) break;
    }
    if (advanced) continue;
    if (exhausted) break;

    // Neither worked. Finer granularity, or stop: once the chunks are single
    // elements their complements ARE the single-step removals, so failing to
    // advance here is exactly 1-minimality.
    if (granularity >= best.length) break;
    granularity = Math.min(granularity * 2, best.length);
  }

  return { minimal: best.map((index) => input[index] as T), stats };
}

/** Split `items` into `count` near-equal contiguous chunks. */
export function partition<T>(items: readonly T[], count: number): T[][] {
  const chunks: T[][] = [];
  const size = items.length / count;
  for (let i = 0; i < count; i++) {
    const start = Math.round(i * size);
    const end = Math.round((i + 1) * size);
    chunks.push(items.slice(start, end));
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * True when no single element can be dropped without losing the failure.
 *
 * `ddmin` already guarantees this on normal termination; this is the independent
 * check, used by the unit tests and available to the CLI as a paranoid final
 * pass. It costs one replay per remaining step.
 */
export async function isOneMinimal<T>(
  candidate: readonly T[],
  test: (subset: T[]) => Promise<ShrinkVerdict>,
): Promise<boolean> {
  for (let i = 0; i < candidate.length; i++) {
    const without = candidate.filter((_, index) => index !== i);
    if ((await test(without)) === 'preserved') return false;
  }
  return true;
}
