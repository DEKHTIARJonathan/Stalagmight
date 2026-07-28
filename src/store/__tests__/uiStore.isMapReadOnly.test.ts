/**
 * Truth table for `isMapReadOnly` - the single predicate every "the survey map is
 * read-only right now" gate shares (toolbar controls, Delete/Import guards, the
 * mutating-tool reset). The load-bearing row is (Plan, measured): Plan/Export force
 * closureAdjusted, but that auto-reverts to measured on a no-closures project, so a
 * geometryMode-only check would wrongly report editable and leak mutations into the
 * read-only workspaces (#243, the #225 bug class).
 */
import { describe, it, expect } from 'vitest';
import { isMapReadOnly, showsClosureAdjustedNotice } from '../uiStore';

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

/**
 * Sibling truth table for the NOTICE, which is a narrower question than the gate
 * above: the map can be read-only without this badge earning its space.
 *
 * Both rules have been got wrong in opposite directions, so both are pinned here.
 * Survey-only is #299's call - Plan and Export are read-only workspaces outright,
 * so the badge announces nothing there. The `speleoReadOnly` complement stops it
 * being drawn on top of the SpeleoDB badge, which occupies the same corner.
 */
describe('showsClosureAdjustedNotice', () => {
  const base = {
    geometryMode: 'closureAdjusted',
    appMode: 'survey',
    placementMode: false,
    speleoReadOnly: false,
  } as const;

  it('shows in Survey when the closure view is the only thing blocking edits', () => {
    expect(showsClosureAdjustedNotice(base)).toBe(true);
  });

  it('is hidden on measured geometry - there is nothing to announce', () => {
    expect(showsClosureAdjustedNotice({ ...base, geometryMode: 'measured' })).toBe(false);
  });

  for (const appMode of ['plan', 'export'] as const) {
    it(`is hidden in ${appMode}, which is a read-only workspace outright (#299)`, () => {
      expect(showsClosureAdjustedNotice({ ...base, appMode })).toBe(false);
    });
  }

  it('defers to the SpeleoDB badge, which already explains the read-only state', () => {
    expect(showsClosureAdjustedNotice({ ...base, speleoReadOnly: true })).toBe(false);
  });

  it('is hidden while placing, where the corner belongs to the placement UI', () => {
    expect(showsClosureAdjustedNotice({ ...base, placementMode: true })).toBe(false);
  });
});
