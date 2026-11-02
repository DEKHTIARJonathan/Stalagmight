/**
 * The lost-WebGL-context watch (#576 D38-LOST): a loss the browser restores is
 * nothing to report (the layers come back by themselves); one that is not
 * restored within the grace period is reported once, and the report is taken
 * back when the context returns or the watch ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { CONTEXT_RESTORE_GRACE_MS, watchContextRestore } from '../useContextLossToast';

function fakeMap() {
  const handlers = new Map<string, Set<() => void>>();
  const map = {
    on: (ev: string, fn: () => void) => {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)!.add(fn);
    },
    off: (ev: string, fn: () => void) => handlers.get(ev)?.delete(fn),
  } as unknown as MaplibreMap;
  const fire = (ev: string) => [...(handlers.get(ev) ?? [])].forEach((fn) => fn());
  const count = () => [...handlers.values()].reduce((n, s) => n + s.size, 0);
  return { map, fire, count };
}

let fake: ReturnType<typeof fakeMap>;
let unrecovered: ReturnType<typeof vi.fn>;
let recovered: ReturnType<typeof vi.fn>;
let detach: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  fake = fakeMap();
  unrecovered = vi.fn();
  recovered = vi.fn();
  detach = watchContextRestore(fake.map, {
    graceMs: CONTEXT_RESTORE_GRACE_MS,
    onUnrecovered: unrecovered,
    onRecovered: recovered,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('watchContextRestore', () => {
  it('waits about five seconds before reporting a loss', () => {
    expect(CONTEXT_RESTORE_GRACE_MS).toBe(5000);
    fake.fire('webglcontextlost');
    vi.advanceTimersByTime(4999);
    expect(unrecovered).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(unrecovered).toHaveBeenCalledTimes(1);
  });

  it('reports nothing when the context comes back within the grace period', () => {
    fake.fire('webglcontextlost');
    vi.advanceTimersByTime(2000);
    fake.fire('webglcontextrestored');
    vi.advanceTimersByTime(10000);
    expect(unrecovered).not.toHaveBeenCalled();
    expect(recovered).not.toHaveBeenCalled();
  });

  it('takes the report back when the context returns late', () => {
    fake.fire('webglcontextlost');
    vi.advanceTimersByTime(5000);
    fake.fire('webglcontextrestored');
    expect(recovered).toHaveBeenCalledTimes(1);
    // And a second loss is reported again.
    fake.fire('webglcontextlost');
    vi.advanceTimersByTime(5000);
    expect(unrecovered).toHaveBeenCalledTimes(2);
  });

  it('a repeated loss event does not restart or double the report', () => {
    fake.fire('webglcontextlost');
    vi.advanceTimersByTime(3000);
    fake.fire('webglcontextlost');
    vi.advanceTimersByTime(2000);
    fake.fire('webglcontextlost');
    vi.advanceTimersByTime(10000);
    expect(unrecovered).toHaveBeenCalledTimes(1);
  });

  it('detach clears the timer, the listeners and a standing report (map rebuilt or left)', () => {
    fake.fire('webglcontextlost');
    vi.advanceTimersByTime(5000);
    detach();
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(fake.count()).toBe(0);
    fake.fire('webglcontextlost');
    vi.advanceTimersByTime(10000);
    expect(unrecovered).toHaveBeenCalledTimes(1);
  });
});
