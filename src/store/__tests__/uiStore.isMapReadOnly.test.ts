/**
 * Truth table for `isMapReadOnly` — the single predicate every "the survey map is
 * read-only right now" gate shares (toolbar controls, Delete/Import guards, the
 * mutating-tool reset). The load-bearing row is (Plan, measured): Plan/Export force
 * closureAdjusted, but that auto-reverts to measured on a no-closures project, so a
 * geometryMode-only check would wrongly report editable and leak mutations into the
 * read-only workspaces (#243, the #225 bug class).
 */
import { describe, it, expect } from 'vitest';
import { isMapReadOnly } from '../uiStore';

describe('isMapReadOnly', () => {
  it('is false ONLY in Survey + measured (the one editable state)', () => {
    expect(isMapReadOnly({ appMode: 'survey', geometryMode: 'measured' })).toBe(false);
  });

  it('is true in the closure-adjusted survey view', () => {
    expect(isMapReadOnly({ appMode: 'survey', geometryMode: 'closureAdjusted' })).toBe(true);
  });

  it('is true in Plan even when geometryMode fell back to measured (the trap)', () => {
    expect(isMapReadOnly({ appMode: 'plan', geometryMode: 'measured' })).toBe(true);
  });

  it('is true in Plan + closureAdjusted', () => {
    expect(isMapReadOnly({ appMode: 'plan', geometryMode: 'closureAdjusted' })).toBe(true);
  });

  it('is true in Export regardless of geometry', () => {
    expect(isMapReadOnly({ appMode: 'export', geometryMode: 'measured' })).toBe(true);
    expect(isMapReadOnly({ appMode: 'export', geometryMode: 'closureAdjusted' })).toBe(true);
  });
});
