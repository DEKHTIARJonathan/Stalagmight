/**
 * The toast STACK model in uiStore: ordering, the visible-count cap, same-key
 * refresh, kind defaulting, and the exit/removal seam.
 *
 * The store deliberately runs no timers - the dwell/fade clock lives in
 * ToastStack, which is where hover/focus pausing is observable - so everything
 * here is synchronous and time-independent.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { useUIStore, MAX_VISIBLE_TOASTS } from '../uiStore';
import { MIN_VISIBLE_TOASTS } from '../../utils/toastCapacity';

const messages = () => useUIStore.getState().toasts.map((t) => t.message);
const live = () => useUIStore.getState().toasts.filter((t) => !t.leaving);

beforeEach(() => {
  useUIStore.setState({ toasts: [], toastCapacity: MAX_VISIBLE_TOASTS });
});

describe('toast stack - ordering', () => {
  it('appends newest last (the visual bottom of the stack)', () => {
    const { showToast } = useUIStore.getState();
    showToast('first', 'a');
    showToast('second', 'b');
    showToast('third', 'c');

    expect(messages()).toEqual(['first', 'second', 'third']);
  });

  it('gives every toast a distinct id', () => {
    const { showToast } = useUIStore.getState();
    showToast('one', 'a');
    showToast('two', 'b');

    const ids = useUIStore.getState().toasts.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('toast stack - the visible cap', () => {
  it(`keeps at most ${MAX_VISIBLE_TOASTS} live toasts`, () => {
    const { showToast } = useUIStore.getState();
    for (let i = 0; i < MAX_VISIBLE_TOASTS; i += 1) showToast(`m${i}`, `k${i}`);

    expect(live()).toHaveLength(MAX_VISIBLE_TOASTS);
  });

  it('evicts the OLDEST when one arrives past the cap', () => {
    const { showToast } = useUIStore.getState();
    for (let i = 0; i < MAX_VISIBLE_TOASTS; i += 1) showToast(`m${i}`, `k${i}`);
    showToast('overflow', 'k-overflow');

    expect(live().map((t) => t.message)).toEqual([
      ...Array.from({ length: MAX_VISIBLE_TOASTS - 1 }, (_, i) => `m${i + 1}`),
      'overflow',
    ]);
  });

  it('marks the evicted one leaving rather than dropping it, so it can animate out', () => {
    const { showToast } = useUIStore.getState();
    for (let i = 0; i < MAX_VISIBLE_TOASTS; i += 1) showToast(`m${i}`, `k${i}`);
    showToast('overflow', 'k-overflow');

    const evicted = useUIStore.getState().toasts.find((t) => t.message === 'm0');
    expect(evicted).toBeDefined();
    expect(evicted?.leaving).toBe(true);
  });

  it('never lets the array grow without bound when nothing reaps the leavers', () => {
    const { showToast } = useUIStore.getState();
    for (let i = 0; i < 50; i += 1) showToast(`m${i}`, `k${i}`);

    expect(useUIStore.getState().toasts.length).toBeLessThanOrEqual(MAX_VISIBLE_TOASTS + 4);
    expect(live()).toHaveLength(MAX_VISIBLE_TOASTS);
  });
});

describe('toast stack - the fitted capacity', () => {
  it('starts at the ceiling, so the store is sane with no stack mounted to measure', () => {
    expect(useUIStore.getState().toastCapacity).toBe(MAX_VISIBLE_TOASTS);
  });

  it.each([
    [-1, MIN_VISIBLE_TOASTS],
    [0, MIN_VISIBLE_TOASTS],
    [1, MIN_VISIBLE_TOASTS],
    [3, 3],
    [MAX_VISIBLE_TOASTS, MAX_VISIBLE_TOASTS],
    [99, MAX_VISIBLE_TOASTS],
  ])('clamps a reported capacity of %s to %s', (reported, expected) => {
    useUIStore.getState().setToastCapacity(reported);
    expect(useUIStore.getState().toastCapacity).toBe(expected);
  });

  it('honours the reported capacity on push', () => {
    const { showToast, setToastCapacity } = useUIStore.getState();
    setToastCapacity(2);
    for (let i = 0; i < 4; i += 1) showToast(`m${i}`, `k${i}`);

    expect(live().map((t) => t.message)).toEqual(['m2', 'm3']);
  });

  it('evicts immediately when the window shrinks, rather than hiding a live toast', () => {
    const { showToast, setToastCapacity } = useUIStore.getState();
    for (let i = 0; i < 5; i += 1) showToast(`m${i}`, `k${i}`);
    expect(live()).toHaveLength(5);

    setToastCapacity(2);

    expect(live().map((t) => t.message)).toEqual(['m3', 'm4']);
    // The evicted ones animate out rather than blinking away.
    expect(useUIStore.getState().toasts.filter((t) => t.leaving)).toHaveLength(3);
  });

  it('does not evict when the window grows', () => {
    const { showToast, setToastCapacity } = useUIStore.getState();
    setToastCapacity(2);
    showToast('a', 'a');
    showToast('b', 'b');

    setToastCapacity(5);

    expect(live().map((t) => t.message)).toEqual(['a', 'b']);
  });

  it('is a no-op when the number has not moved, so reporting it every frame is free', () => {
    const { showToast, setToastCapacity } = useUIStore.getState();
    showToast('a', 'a');
    const before = useUIStore.getState().toasts;

    setToastCapacity(MAX_VISIBLE_TOASTS);

    expect(useUIStore.getState().toasts).toBe(before);
  });
});

describe('toast stack - same-key de-duplication', () => {
  it('refreshes the existing toast instead of stacking a duplicate', () => {
    const { showToast } = useUIStore.getState();
    showToast('first wording', 'dup');
    showToast('second wording', 'dup');

    expect(messages()).toEqual(['second wording']);
  });

  it('keeps the same id (no remount) but bumps revision, which restarts the timer', () => {
    const { showToast } = useUIStore.getState();
    showToast('first', 'dup');
    const before = useUIStore.getState().toasts[0];
    showToast('second', 'dup');
    const after = useUIStore.getState().toasts[0];

    expect(after?.id).toBe(before?.id);
    expect(after?.revision).toBe((before?.revision ?? 0) + 1);
  });

  it('moves the refreshed toast to the newest slot', () => {
    const { showToast } = useUIStore.getState();
    showToast('old', 'dup');
    showToast('other', 'other');
    showToast('refreshed', 'dup');

    expect(messages()).toEqual(['other', 'refreshed']);
  });

  it('lets the newer kind win on refresh', () => {
    const { showToast } = useUIStore.getState();
    showToast('trying', 'dup', 'info');
    showToast('it failed', 'dup', 'error');

    expect(useUIStore.getState().toasts[0]?.kind).toBe('error');
  });

  it('does NOT refresh a toast that is already leaving - that one is on its way out', () => {
    const { showToast, dismissToast } = useUIStore.getState();
    showToast('first', 'dup');
    const id = useUIStore.getState().toasts[0]?.id ?? -1;
    dismissToast(id);

    showToast('second', 'dup');

    expect(messages()).toEqual(['first', 'second']);
    expect(live().map((t) => t.message)).toEqual(['second']);
  });

  it('different keys never merge', () => {
    const { showToast } = useUIStore.getState();
    showToast('same words', 'a');
    showToast('same words', 'b');

    expect(useUIStore.getState().toasts).toHaveLength(2);
  });
});

describe('toast stack - kinds', () => {
  it('defaults to info so pre-existing two-argument call sites are unchanged', () => {
    useUIStore.getState().showToast('neutral', 'k');
    expect(useUIStore.getState().toasts[0]?.kind).toBe('info');
  });

  it.each(['success', 'warning', 'error', 'info'] as const)('carries an explicit %s kind', (kind) => {
    useUIStore.getState().showToast('m', 'k', kind);
    expect(useUIStore.getState().toasts[0]?.kind).toBe(kind);
  });
});

describe('toast stack - removal', () => {
  it('dismissToast starts the exit without removing the toast yet', () => {
    const { showToast, dismissToast } = useUIStore.getState();
    showToast('a', 'a');
    showToast('b', 'b');
    const id = useUIStore.getState().toasts[0]?.id ?? -1;

    dismissToast(id);

    expect(useUIStore.getState().toasts).toHaveLength(2);
    expect(live().map((t) => t.message)).toEqual(['b']);
  });

  it('removeToast drops exactly one toast', () => {
    const { showToast, removeToast } = useUIStore.getState();
    showToast('a', 'a');
    showToast('b', 'b');
    showToast('c', 'c');
    const id = useUIStore.getState().toasts[1]?.id ?? -1;

    removeToast(id);

    expect(messages()).toEqual(['a', 'c']);
  });

  it('clearToast empties the stack', () => {
    const { showToast, clearToast } = useUIStore.getState();
    showToast('a', 'a');
    showToast('b', 'b');

    clearToast();

    expect(useUIStore.getState().toasts).toEqual([]);
  });
});
