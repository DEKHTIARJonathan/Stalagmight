/**
 * Unit tests for `pickUIKeys` (#430).
 *
 * The hot map selectors are `(s) => pickUIKeys(s, KEYS)` behind `useShallow`, so
 * two properties are load-bearing and neither is visible at the call site:
 *   - the result carries EXACTLY the requested keys. Any over-pick (a spread of
 *     the whole state, say) silently re-subscribes the component to every store
 *     key, which is the ~180-key shallow compare this helper exists to kill.
 *   - the result is a FRESH object every call. A cached/stable reference would
 *     make `useShallow` compare an object against itself, so subscribers would
 *     never see a change.
 */

import { describe, it, expect } from 'vitest';

import { pickUIKeys, type UIStoreState } from '../uiSelectKeys';

const state = {
  mapZoom: 15,
  activeTool: 'select',
  showShots: true,
  showStations: false,
} as unknown as UIStoreState;

describe('pickUIKeys', () => {
  it('returns exactly the requested keys with the state values', () => {
    const picked = pickUIKeys(state, ['activeTool', 'showShots'] as const);

    expect(picked).toEqual({ activeTool: 'select', showShots: true });
    // toEqual alone would pass on an over-pick of extra undefined-valued keys.
    expect(Object.keys(picked)).toEqual(['activeTool', 'showShots']);
  });

  it('returns an empty object for an empty key list', () => {
    expect(Object.keys(pickUIKeys(state, []))).toEqual([]);
  });

  it('returns a new object on every call, even for identical inputs', () => {
    const keys = ['activeTool', 'showShots'] as const;
    const first = pickUIKeys(state, keys);
    const second = pickUIKeys(state, keys);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
