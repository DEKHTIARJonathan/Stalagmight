/**
 * [#486] `setLoadingProgress` is the single write path shared by
 * `createProject`'s JSON `invoke()` result (result.loadingId, declared
 * `bigint` by ts-rs but actually a plain JS number over the wire),
 * `useLoadingProgress`'s event handler, and the E2E `simulateLoadingProgress`
 * test hook (main.tsx). Only `useLoadingProgress` used to normalize its own
 * input before calling in - `createProject` wrote the raw JSON number
 * straight through the blind `...progress` spread, so a subsequent
 * `loading-progress` event with a numerically-equal id failed the store's
 * `bigint === bigint` staleness compare (`2 !== 2n`) and was dropped.
 *
 * This locks the fix at the boundary itself: `setLoadingProgress` coerces
 * any `loadingId` it is given to `bigint`, regardless of caller.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore } from '../projectStore';

beforeEach(() => {
  useProjectStore.setState((s) => ({
    loading: { ...s.loading, loadingId: 0n, overallProgress: 0 },
  }));
});

describe('projectStore.setLoadingProgress - loadingId normalization (#486)', () => {
  it('coerces a plain-number loadingId (as createProject receives from invoke()) to bigint', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- simulating the untyped JSON invoke() result
    useProjectStore.getState().setLoadingProgress({ loadingId: 3 as any });

    expect(useProjectStore.getState().loading.loadingId).toBe(3n);
    expect(typeof useProjectStore.getState().loading.loadingId).toBe('bigint');
  });

  it('leaves an already-bigint loadingId untouched', () => {
    useProjectStore.getState().setLoadingProgress({ loadingId: 3n });

    expect(useProjectStore.getState().loading.loadingId).toBe(3n);
  });

  it('a subsequent progress write with a numerically-equal id is treated as matching, not stale', () => {
    // This is the exact #486 sequence: the result path (a number in
    // practice) writes first, then a later progress write with the same
    // numeric id must read back as the identical bigint, not fail an
    // `===` compare a caller might run against it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- simulating the untyped JSON invoke() result
    useProjectStore.getState().setLoadingProgress({ loadingId: 3 as any });
    const afterResult = useProjectStore.getState().loading.loadingId;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- simulating a raw JSON event payload
    useProjectStore.getState().setLoadingProgress({ loadingId: 3 as any, overallProgress: 55 });

    expect(useProjectStore.getState().loading.loadingId).toBe(afterResult);
    expect(useProjectStore.getState().loading.overallProgress).toBe(55);
  });
});
