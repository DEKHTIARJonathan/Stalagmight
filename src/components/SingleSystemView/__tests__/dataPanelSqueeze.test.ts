import { describe, expect, it } from 'vitest';

import { computeDataPanelLayout, type DataPanelSqueezeOpts } from '../sidePanelSqueeze';
import { MAP_MIN_HEIGHT, PANEL_SIZE_BOUNDS } from '../layoutConstants';

/**
 * #260 on the VERTICAL axis. The original fix clamped only the widths, but
 * `dataTableHeight` has the identical shape: persisted in pixels up to 500, against
 * a Main box that shrinks with the native webview UI zoom, and a `flex-shrink-0`
 * Dock spacer that beats the `flex-1` map wrapper outright.
 *
 * At the 250% zoom this work targets Main is only ~330 CSS px tall - less than a
 * 500px panel - so the map collapsed to 0px, both side opener bars got height-0
 * overlays, and the Data tab was clipped above Main's top, leaving no way to close
 * the panel again without zooming back out.
 */

/** The measured case: half-screen window at 250% webview zoom. */
const MEASURED_MAIN_HEIGHT = 330;
const USER_HEIGHT = 500;
const MIN = PANEL_SIZE_BOUNDS['data-table'].min;

function opts(overrides: Partial<DataPanelSqueezeOpts>): DataPanelSqueezeOpts {
  return {
    viewportHeight: MEASURED_MAIN_HEIGHT,
    height: USER_HEIGHT,
    min: MIN,
    mapMinHeight: MAP_MIN_HEIGHT,
    pinnedOpen: true,
    ...overrides,
  };
}

describe('computeDataPanelLayout (#260, vertical)', () => {
  it('leaves a height the viewport can afford untouched', () => {
    expect(computeDataPanelLayout(opts({ viewportHeight: 900 }))).toEqual({
      height: USER_HEIGHT,
      collapsed: false,
    });
  });

  it('keeps the map floor at the measured 250%-zoom height', () => {
    // 330 - 200 = 130, which still clears the 100px resize minimum, so the panel
    // shrinks rather than collapsing - and the map keeps exactly its floor.
    const r = computeDataPanelLayout(opts({}));
    expect(r.collapsed).toBe(false);
    expect(r.height).toBe(MEASURED_MAIN_HEIGHT - MAP_MIN_HEIGHT);
    expect(MEASURED_MAIN_HEIGHT - r.height).toBeGreaterThanOrEqual(MAP_MIN_HEIGHT);
  });

  it('never renders below the resize minimum - it collapses instead', () => {
    // Below min + mapMinHeight there is no height that is both usable and leaves a
    // map, so the honest outcome is the opener bar rather than an unreadable stub.
    const r = computeDataPanelLayout(opts({ viewportHeight: MIN + MAP_MIN_HEIGHT - 1 }));
    expect(r.collapsed).toBe(true);
    // The user's own value is reported unchanged, so it returns when the viewport does.
    expect(r.height).toBe(USER_HEIGHT);
  });

  it('collapses at the exact boundary and not one pixel above it', () => {
    expect(computeDataPanelLayout(opts({ viewportHeight: MIN + MAP_MIN_HEIGHT })).collapsed).toBe(
      false,
    );
    expect(
      computeDataPanelLayout(opts({ viewportHeight: MIN + MAP_MIN_HEIGHT - 1 })).collapsed,
    ).toBe(true);
  });

  it('is monotonically non-increasing as the viewport shrinks', () => {
    // The horizontal ladder had a bug where a panel rendered WIDER at a smaller
    // viewport; pin the same property here.
    let previous = Infinity;
    for (const viewportHeight of [900, 700, 500, 400, 330, 305, 250, 120, 1]) {
      const r = computeDataPanelLayout(opts({ viewportHeight }));
      const occupied = r.collapsed ? 0 : r.height;
      expect(occupied).toBeLessThanOrEqual(previous);
      previous = occupied;
    }
  });

  it('does not squeeze a hover-floating panel, which takes no layout height', () => {
    expect(computeDataPanelLayout(opts({ pinnedOpen: false }))).toEqual({
      height: USER_HEIGHT,
      collapsed: false,
    });
  });

  it('passes an unmeasured viewport through untouched', () => {
    // 0 means "not laid out yet" (first paint, or the node test tier); nothing may
    // collapse on the strength of a degenerate measurement.
    for (const viewportHeight of [0, -1, Number.NaN]) {
      expect(computeDataPanelLayout(opts({ viewportHeight }))).toEqual({
        height: USER_HEIGHT,
        collapsed: false,
      });
    }
  });

  it('never returns a fractional height', () => {
    // The value feeds a pixel style; a fraction would land on a half-pixel border.
    const r = computeDataPanelLayout(opts({ viewportHeight: 330.7 }));
    expect(Number.isInteger(r.height)).toBe(true);
  });
});
