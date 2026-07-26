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
    // Un-squeezed (so the user's value returns when the viewport does), but still
    // capped at the container it would be floated open inside - see the cap tests.
    expect(r.height).toBe(MIN + MAP_MIN_HEIGHT - 1);
    expect(computeDataPanelLayout(opts({ viewportHeight: 900, height: USER_HEIGHT })).height).toBe(
      USER_HEIGHT,
    );
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
    // It overlays the map rather than reflowing it, so the map floor does not apply:
    // at a viewport that can afford the height, nothing changes.
    expect(computeDataPanelLayout(opts({ pinnedOpen: false, viewportHeight: 900 }))).toEqual({
      height: USER_HEIGHT,
      collapsed: false,
    });
    // ...and it is never reported as collapsed-by-the-viewport either.
    expect(computeDataPanelLayout(opts({ pinnedOpen: false, viewportHeight: 120 })).collapsed).toBe(
      false,
    );
  });

  it('caps a FLOATING panel at the container even though it is not squeezed', () => {
    // The #260 hole: `closedBottomInset` on BOTH side Docks is fed this height
    // whenever the Data panel is open - and `isOpen` includes hover-floating open.
    // A 500px persisted height against a 330px Main therefore raised each side
    // bar's bottom to 500 in a 330px box, computing the bar's overlay to height 0
    // and clipping the Data tab above Main's top: the exact failure MAP_MIN_HEIGHT
    // was added to remove, reached through the branch that skips the squeeze.
    const r = computeDataPanelLayout(opts({ pinnedOpen: false }));
    expect(r.height).toBeLessThanOrEqual(MEASURED_MAIN_HEIGHT);
    expect(r.height).toBe(MEASURED_MAIN_HEIGHT);
  });

  it('caps the height in EVERY branch, floating or collapsed, at every viewport', () => {
    for (const pinnedOpen of [true, false]) {
      for (const viewportHeight of [1, 50, 120, 299, 330, 400, 500, 900]) {
        const r = computeDataPanelLayout(opts({ pinnedOpen, viewportHeight }));
        expect(r.height, `pinned=${pinnedOpen} vh=${viewportHeight}`).toBeLessThanOrEqual(
          viewportHeight,
        );
      }
    }
  });

  it('still returns an integer height when the cap is what binds', () => {
    // Same half-pixel-border argument as the squeeze path below: a fractional
    // viewport must not become a fractional style value.
    expect(computeDataPanelLayout(opts({ pinnedOpen: false, viewportHeight: 330.7 })).height).toBe(
      330,
    );
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
