// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { watchDevicePixelRatio } from '../dprWatcher';

interface FakeMql {
  media: string;
  listeners: Set<() => void>;
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
  fire: () => void;
}

function installFakeMatchMedia(): FakeMql[] {
  const created: FakeMql[] = [];
  vi.stubGlobal('matchMedia', (media: string) => {
    const listeners = new Set<() => void>();
    const mql: FakeMql = {
      media,
      listeners,
      addEventListener: (_t, cb) => listeners.add(cb),
      removeEventListener: (_t, cb) => listeners.delete(cb),
      fire: () => [...listeners].forEach((cb) => cb()),
    };
    created.push(mql);
    return mql as unknown as MediaQueryList;
  });
  return created;
}

afterEach(() => vi.unstubAllGlobals());

describe('watchDevicePixelRatio', () => {
  it('fires onChange on each DPR change and re-arms, until disposed', () => {
    const created = installFakeMatchMedia();
    const onChange = vi.fn();
    const dispose = watchDevicePixelRatio(onChange);

    // Armed once against the current dpr.
    expect(created).toHaveLength(1);
    expect(created[0]!.media).toMatch(/resolution:.*dppx/);

    // A change fires onChange and re-arms a fresh listener.
    created[0]!.fire();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(2);

    created[1]!.fire();
    expect(onChange).toHaveBeenCalledTimes(2);

    // After dispose, further changes are ignored.
    dispose();
    created[created.length - 1]!.fire();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does not leak the old listener when re-arming', () => {
    const created = installFakeMatchMedia();
    watchDevicePixelRatio(vi.fn());
    created[0]!.fire();
    expect(created[0]!.listeners.size).toBe(0); // old one removed on re-arm
    expect(created[1]!.listeners.size).toBe(1);
  });

  it('is a safe no-op when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    const onChange = vi.fn();
    const dispose = watchDevicePixelRatio(onChange);
    dispose();
    expect(onChange).not.toHaveBeenCalled();
  });
});
