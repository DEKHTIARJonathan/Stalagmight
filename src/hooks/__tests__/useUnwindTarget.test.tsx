/**
 * [#303] Stale-reply coverage for `useUnwindTarget`.
 *
 * The hook has TWO entry points into the same `GET /revisions/`: `resolve` (the 300ms
 * hover, which must know whether there is anything to show before it opens the panel)
 * and `refresh` (the panel itself, re-asking so a push or a lock change while it sits
 * open is noticed). Crossing the toolbar and then opening therefore leaves both in
 * flight, and the reply that lands LAST used to win - `target` and the 5s memo alike.
 *
 * Two guards, because they fail differently: a monotonic request id (a newer ask for the
 * SAME project supersedes the older one) and a project-identity capture (the app moved on
 * while the server was answering). Both must cover the memo write, not just the setState:
 * a wrong value cached there outlives its own reply for the whole TTL.
 *
 * `.tsx` is load-bearing - `vite.config.ts` routes only `*.test.tsx` to jsdom, and
 * `renderHook` needs it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'mock error',
}));

import { useUnwindTarget, type ChainTarget } from '../useUnwindTarget';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import type { SpeleoUnwindTarget } from '../../types/ipc.generated';

/** A reply the test lands by hand, so ordering is stated rather than timed. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const OLDER: SpeleoUnwindTarget = { hexsha: 'aaa111', is_current: false, discards_unpushed: false };
const NEWER: SpeleoUnwindTarget = { hexsha: 'bbb222', is_current: true, discards_unpushed: true };

const asBack = (raw: SpeleoUnwindTarget): ChainTarget => ({ direction: 'back', ...raw });

const project = (file_path: string) =>
  ({
    created_at: '2026-01-01T00:00:00Z',
    modified_at: '2026-01-01T00:00:00Z',
    file_path,
  }) as never;

beforeEach(() => {
  invokeIpcMock.mockReset();
  useProjectStore.setState({ project: project('/cave/a.stalx') });
  // Only a remote project has revisions to walk - otherwise `fetchTarget` never calls.
  useSpeleoStore.setState({ projectLinkKind: 'remote' });
});

/** `enabled: false` so the mount effect does not fire a fetch of its own: every request
 *  below is one the test issued, which is what makes the ordering assertions readable. */
const renderTarget = () => renderHook(() => useUnwindTarget(false));

describe('useUnwindTarget - overlapping lookups (#303)', () => {
  it('keeps the newest answer when an older request replies last', async () => {
    const first = deferred<SpeleoUnwindTarget | null>();
    const second = deferred<SpeleoUnwindTarget | null>();
    invokeIpcMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderTarget();

    // The hover starts one, opening the panel starts another - both in flight.
    let resolved: Promise<ChainTarget | null>;
    act(() => {
      resolved = result.current.resolve();
      void result.current.refresh();
    });
    expect(invokeIpcMock).toHaveBeenCalledTimes(2);

    // The NEWER request answers first, the older one straggles in behind it.
    await act(async () => {
      second.resolve(NEWER);
      first.resolve(OLDER);
      await Promise.resolve();
    });

    expect(result.current.target).toEqual(asBack(NEWER));
    // The straggler must not be handed back to its own caller either - it would open the
    // panel on a step that is no longer the one being offered.
    await expect(resolved!).resolves.toBeNull();

    // ...and the memo agrees: inside the TTL this answers without a third fetch, so a
    // guard that covered only `setTarget` would surface the older answer here.
    let memo: ChainTarget | null = null;
    await act(async () => {
      memo = await result.current.resolve();
    });
    expect(memo).toEqual(asBack(NEWER));
    expect(invokeIpcMock).toHaveBeenCalledTimes(2);
  });

  it('drops a reply for a project the app has since left', async () => {
    const pending = deferred<SpeleoUnwindTarget | null>();
    invokeIpcMock.mockReturnValueOnce(pending.promise);
    const { result } = renderTarget();

    let resolved: Promise<ChainTarget | null>;
    act(() => {
      resolved = result.current.resolve();
    });

    // The user closes this project and opens another while the server is answering.
    act(() => {
      useProjectStore.setState({ project: project('/cave/b.stalx') });
    });
    await act(async () => {
      pending.resolve(OLDER);
      await Promise.resolve();
    });

    expect(result.current.target).toBeNull();
    await expect(resolved!).resolves.toBeNull();

    // Nothing was memoised, so the next ask is a real fetch rather than five seconds of
    // the previous project's answer.
    invokeIpcMock.mockResolvedValueOnce(NEWER);
    let next: ChainTarget | null = null;
    await act(async () => {
      next = await result.current.resolve();
    });
    expect(invokeIpcMock).toHaveBeenCalledTimes(2);
    expect(next).toEqual(asBack(NEWER));
  });

  it('stores and memoises a reply that nothing superseded (control)', async () => {
    invokeIpcMock.mockResolvedValue(OLDER);
    const { result } = renderTarget();

    let first: ChainTarget | null = null;
    await act(async () => {
      first = await result.current.resolve();
    });
    expect(first).toEqual(asBack(OLDER));
    expect(result.current.target).toEqual(asBack(OLDER));

    // The TTL memo is intact: a second hover inside the window costs no request.
    await act(async () => {
      await result.current.resolve();
    });
    expect(invokeIpcMock).toHaveBeenCalledTimes(1);
  });
});
