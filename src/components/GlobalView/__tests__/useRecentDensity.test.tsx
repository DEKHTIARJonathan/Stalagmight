import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRecentDensity } from '../useRecentDensity';

// `.tsx` so this runs in the jsdom tier (renderHook needs a DOM + localStorage).
//
// #334 asked whether the recent-projects card-vs-list choice survives a restart.
// It does, via localStorage, but nothing pinned that at the unit level - only an
// e2e reload assertion - so the storage key and the rehydrate path were free to
// drift. These tests pin both.

const STORAGE_KEY = 'recentProjectsDensity';

describe('useRecentDensity', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to cards when nothing is stored', () => {
    const { result } = renderHook(() => useRecentDensity());
    expect(result.current[0]).toBe('cards');
  });

  it('writes the choice to localStorage so it outlives the session', () => {
    const { result } = renderHook(() => useRecentDensity());
    act(() => result.current[1]('table'));
    expect(result.current[0]).toBe('table');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('table');
  });

  it('rehydrates a stored choice on a fresh mount (the restart path)', () => {
    localStorage.setItem(STORAGE_KEY, 'table');
    const { result } = renderHook(() => useRecentDensity());
    expect(result.current[0]).toBe('table');
  });

  it('ignores a stored value that is not a known density', () => {
    localStorage.setItem(STORAGE_KEY, 'sideways');
    const { result } = renderHook(() => useRecentDensity());
    expect(result.current[0]).toBe('cards');
  });

  it('survives localStorage throwing rather than taking the view down', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('denied');
    };
    try {
      const { result } = renderHook(() => useRecentDensity());
      expect(result.current[0]).toBe('cards');
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
