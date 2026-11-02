/**
 * [#486] The store's `loading.loadingId` is a `bigint` (initialized `0n`, and
 * set to a real `bigint` by the result path via `BigInt(env.loading_id)`).
 * The Tauri `loading-progress` event, however, arrives as a plain JSON
 * number - the ts-rs `bigint` type on `LoadingProgress` only describes the
 * binary/IPC result path, not `listen<T>`'s JSON decode.
 *
 * The old code compared/stored that raw number directly
 * (`eventLoadingId !== currentState.loadingId`), so a numerically-equal id
 * failed the comparison (`2 !== 2n`) and every progress event after the
 * result-path write was discarded as "stale" - freezing the progress UI for
 * the rest of the load. This locks the fix: the event id is normalized to
 * bigint before it is compared against or written into the store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { LoadingProgress } from '../../types/ipc/LoadingProgress';

const listeners = vi.hoisted(
  () => [] as Array<(event: { payload: LoadingProgress }) => Promise<void> | void>
);
const unlisten = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, cb: (event: { payload: LoadingProgress }) => void) => {
    listeners.push(cb);
    return unlisten;
  }),
}));

import { useLoadingProgress } from '../useLoadingProgress';
import { useProjectStore } from '../../store/projectStore';

function Harness() {
  useLoadingProgress();
  return null;
}

function progressPayload(overrides: Partial<LoadingProgress>): LoadingProgress {
  return {
    loadingId: 0n,
    phase: 'loading_project_data',
    phaseIndex: 0,
    phaseCount: 1,
    current: null,
    total: null,
    overallPercent: 0,
    isIndeterminate: true,
    ...overrides,
  };
}

/** Fire a `loading-progress` event, mimicking Tauri's JSON decode (a plain number id). */
async function emitProgress(loadingId: number, overrides: Partial<LoadingProgress> = {}) {
  for (const cb of [...listeners]) {
    // Simulating the untyped JSON wire payload: a plain number, not a bigint.
    await cb({ payload: progressPayload({ loadingId: loadingId as unknown as bigint, ...overrides }) });
  }
}

beforeEach(() => {
  listeners.length = 0;
  unlisten.mockClear();
  useProjectStore.setState((s) => ({
    loading: {
      ...s.loading,
      isLoading: true,
      error: undefined,
      loadingId: 0n,
      clientOpId: 1,
      phase: undefined,
    },
  }));
});

describe('useLoadingProgress - event loadingId normalization (#486)', () => {
  it('accepts a JSON-number event id that numerically equals the store bigint id', async () => {
    useProjectStore.setState((s) => ({ loading: { ...s.loading, loadingId: 2n } }));
    render(<Harness />);
    await Promise.resolve();

    await emitProgress(2, { phaseIndex: 3, overallPercent: 42 });

    expect(useProjectStore.getState().loading.overallProgress).toBe(42);
    expect(useProjectStore.getState().loading.loadingId).toBe(2n);
  });

  it('rejects a genuinely stale event id, then accepts a matching one (positive control)', async () => {
    // Seed a known, non-default overallProgress so an unchanged value is
    // unambiguous - `.not.toBe(99)` alone would also pass if the listener
    // never registered at all. The second event is a positive control: it
    // proves the listener IS wired up and DOES apply a matching id, so the
    // first assertion's "unchanged" reading isn't a false negative.
    useProjectStore.setState((s) => ({
      loading: { ...s.loading, loadingId: 2n, overallProgress: 7 },
    }));
    render(<Harness />);
    await Promise.resolve();

    await emitProgress(1, { phaseIndex: 3, overallPercent: 99 });
    expect(useProjectStore.getState().loading.overallProgress).toBe(7);

    await emitProgress(2, { phaseIndex: 3, overallPercent: 99 });
    expect(useProjectStore.getState().loading.overallProgress).toBe(99);
  });

  it('stores the event loadingId as a bigint, not a JSON number', async () => {
    // Seed the store's OWN loadingId (rather than leaving it at the initial
    // 0n "awaiting handshake" state) so this exercises the equality branch
    // directly, not the module-global `lastSeenBackendLoadingId` tracker used
    // only while awaiting the first event - that counter is never reset
    // between tests in this file, so a 0n-seeded assertion would silently
    // depend on every earlier test's emitted ids staying below this one.
    useProjectStore.setState((s) => ({ loading: { ...s.loading, loadingId: 5n } }));
    render(<Harness />);
    await Promise.resolve();

    await emitProgress(5, { phaseIndex: 0 });

    expect(useProjectStore.getState().loading.loadingId).toBe(5n);
    expect(typeof useProjectStore.getState().loading.loadingId).toBe('bigint');
  });
});
