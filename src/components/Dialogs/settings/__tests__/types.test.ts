import { describe, it, expect } from 'vitest';
import { isFieldChanged, getByPath } from '../types';

// ---------------------------------------------------------------------------
// isFieldChanged
// ---------------------------------------------------------------------------

describe('isFieldChanged', () => {
  it('returns false for empty changedFields set', () => {
    expect(isFieldChanged(new Set(), 'general.auto_save')).toBe(false);
  });

  it('returns true when path is in changedFields', () => {
    const changed = new Set(['general.auto_save', 'units.length']);
    expect(isFieldChanged(changed, 'general.auto_save')).toBe(true);
  });

  it('returns false when path is not in changedFields', () => {
    const changed = new Set(['general.auto_save']);
    expect(isFieldChanged(changed, 'units.length')).toBe(false);
  });

  it('returns true when any of multiple paths matches', () => {
    const changed = new Set(['units.length']);
    expect(isFieldChanged(changed, 'general.auto_save', 'units.length')).toBe(true);
  });

  it('returns false when none of multiple paths match', () => {
    const changed = new Set(['general.auto_save']);
    expect(isFieldChanged(changed, 'units.length', 'units.depth')).toBe(false);
  });

  it('handles exact string matching (no prefix matching)', () => {
    const changed = new Set(['general.auto_save']);
    expect(isFieldChanged(changed, 'general.auto')).toBe(false);
    expect(isFieldChanged(changed, 'general.auto_save_interval')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getByPath
// ---------------------------------------------------------------------------

describe('getByPath', () => {
  it('returns top-level value', () => {
    expect(getByPath({ a: 1 }, 'a')).toBe(1);
  });

  it('returns nested value with dot notation', () => {
    expect(getByPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns object at intermediate path', () => {
    const obj = { a: { b: 1 } };
    expect(getByPath(obj, 'a')).toEqual({ b: 1 });
  });

  it('returns undefined for nonexistent key', () => {
    expect(getByPath({ a: 1 }, 'b')).toBeUndefined();
  });

  it('returns undefined for nonexistent nested key', () => {
    expect(getByPath({ a: { b: 1 } }, 'a.c')).toBeUndefined();
  });

  it('returns undefined when traversing through null', () => {
    expect(getByPath({ a: null }, 'a.b')).toBeUndefined();
  });

  it('returns undefined when traversing through undefined', () => {
    expect(getByPath({ a: undefined }, 'a.b')).toBeUndefined();
  });

  it('returns undefined when traversing through a primitive', () => {
    expect(getByPath({ a: 'hello' }, 'a.b')).toBeUndefined();
    expect(getByPath({ a: 42 }, 'a.b')).toBeUndefined();
    expect(getByPath({ a: true }, 'a.b')).toBeUndefined();
  });

  it('returns undefined when root is null', () => {
    expect(getByPath(null, 'a')).toBeUndefined();
  });

  it('returns undefined when root is undefined', () => {
    expect(getByPath(undefined, 'a')).toBeUndefined();
  });

  it('handles deeply nested paths', () => {
    const obj = { a: { b: { c: { d: { e: 'deep' } } } } };
    expect(getByPath(obj, 'a.b.c.d.e')).toBe('deep');
  });

  it('returns null values correctly (does not confuse with missing)', () => {
    expect(getByPath({ a: { b: null } }, 'a.b')).toBeNull();
  });

  it('returns false and zero values correctly', () => {
    expect(getByPath({ a: false }, 'a')).toBe(false);
    expect(getByPath({ a: 0 }, 'a')).toBe(0);
    expect(getByPath({ a: '' }, 'a')).toBe('');
  });

  it('handles array values at the end of path', () => {
    expect(getByPath({ a: [1, 2, 3] }, 'a')).toEqual([1, 2, 3]);
  });
});
