import { describe, expect, it } from 'vitest';

import { computeSidePanelLayout, type SidePanelSqueezeOpts } from '../sidePanelSqueeze';
import { MAP_MIN_WIDTH, PANEL_SIZE_BOUNDS } from '../layoutConstants';
import { BAR } from '../Dock';

/**
 * #260: the side panels are sized in PIXELS and persisted, but the CSS viewport
 * shrinks with the native webview UI zoom (at 250% a 1536-physical-px window is
 * only ~614 CSS px). The map is the flex remainder, so it used to absorb the whole
 * shortfall - measured at 48 CSS px with the panels at 284/282. These tests pin the
 * escalation ladder that makes the PANELS yield instead.
 *
 * The numbers below are the real measurement (614 / 284 / 282) plus the exact
 * boundary widths the ladder switches at, so a change in policy shows up as a
 * failing expectation rather than a silently different layout.
 */

/** The measured real-world case: half-screen window at 250% webview zoom. */
const MEASURED_VIEWPORT = 614;
const USER_SECTIONS = 284;
const USER_DETAIL = 282;

function opts(overrides: {
  viewportWidth: number;
  sections?: Partial<SidePanelSqueezeOpts['sections']>;
  detail?: Partial<SidePanelSqueezeOpts['detail']>;
}): SidePanelSqueezeOpts {
  return {
    viewportWidth: overrides.viewportWidth,
    mapMinWidth: MAP_MIN_WIDTH,
    barWidth: BAR,
    sections: {
      width: USER_SECTIONS,
      min: PANEL_SIZE_BOUNDS.sections.min,
      present: true,
      pinnedOpen: true,
      ...overrides.sections,
    },
    detail: {
      width: USER_DETAIL,
      min: PANEL_SIZE_BOUNDS.detail.min,
      present: true,
      pinnedOpen: true,
      ...overrides.detail,
    },
  };
}

/** Width the map column actually ends up with for a computed layout. */
function mapWidth(o: SidePanelSqueezeOpts, r: ReturnType<typeof computeSidePanelLayout>): number {
  const occ = (p: SidePanelSqueezeOpts['sections'], l: { width: number; collapsed: boolean }) =>
    !p.present ? 0 : p.pinnedOpen && !l.collapsed ? l.width : o.barWidth;
  return o.viewportWidth - occ(o.sections, r.sections) - occ(o.detail, r.detail);
}

describe('computeSidePanelLayout - comfortable viewport', () => {
  it('leaves both panels at the user widths when the map already clears its floor', () => {
    const o = opts({ viewportWidth: 1600 });
    const r = computeSidePanelLayout(o);

    expect(r).toEqual({
      sections: { width: USER_SECTIONS, collapsed: false },
      detail: { width: USER_DETAIL, collapsed: false },
    });
    expect(mapWidth(o, r)).toBeGreaterThanOrEqual(MAP_MIN_WIDTH);
  });

  it('treats an unmeasured (zero / non-finite) viewport as "leave it alone"', () => {
    for (const viewportWidth of [0, -1, Number.NaN]) {
      expect(computeSidePanelLayout(opts({ viewportWidth }))).toEqual({
        sections: { width: USER_SECTIONS, collapsed: false },
        detail: { width: USER_DETAIL, collapsed: false },
      });
    }
  });
});

describe('computeSidePanelLayout - squeeze before collapse', () => {
  it('shrinks both panels in proportion to their slack, stopping exactly at the map floor', () => {
    // 800 - 284 - 282 = 234 map; 126 short. Slack is 134 (sections) + 82 (detail)
    // = 216, so both give up ~58% of what they offered.
    const o = opts({ viewportWidth: 800 });
    const r = computeSidePanelLayout(o);

    expect(r.sections.collapsed).toBe(false);
    expect(r.detail.collapsed).toBe(false);
    expect(r.sections.width).toBe(206);
    expect(r.detail.width).toBe(234);
    expect(mapWidth(o, r)).toBe(MAP_MIN_WIDTH);
  });

  it('bottoms out at both PANEL_SIZE_BOUNDS minimums without collapsing anything', () => {
    // 710 is the exact width where the total available slack equals the shortfall.
    const o = opts({ viewportWidth: 710 });
    const r = computeSidePanelLayout(o);

    expect(r).toEqual({
      sections: { width: PANEL_SIZE_BOUNDS.sections.min, collapsed: false },
      detail: { width: PANEL_SIZE_BOUNDS.detail.min, collapsed: false },
    });
    expect(mapWidth(o, r)).toBe(MAP_MIN_WIDTH);
  });

  it('never squeezes a panel below its own minimum', () => {
    for (let viewportWidth = 400; viewportWidth <= 1600; viewportWidth += 7) {
      const r = computeSidePanelLayout(opts({ viewportWidth }));
      expect(r.sections.width).toBeGreaterThanOrEqual(PANEL_SIZE_BOUNDS.sections.min);
      expect(r.detail.width).toBeGreaterThanOrEqual(PANEL_SIZE_BOUNDS.detail.min);
    }
  });
});

describe('computeSidePanelLayout - collapse ladder', () => {
  it('collapses Details first, and does NOT hand the freed space back to Sections', () => {
    // The measured 250%-zoom case. Minimums alone are not enough (150 + 200 + 360 >
    // 614), so Details - a view of the current selection, reachable again from that
    // selection - is the one that goes.
    const o = opts({ viewportWidth: MEASURED_VIEWPORT });
    const r = computeSidePanelLayout(o);

    expect(r.detail.collapsed).toBe(true);
    expect(r.sections.collapsed).toBe(false);
    // Sections stays at the width the both-open squeeze had already driven it to.
    //
    // Collapsing Details frees 270px here, and geometrically Sections COULD take
    // 242 of it (614 - 12 bar - 360 map). It deliberately does not: both-open runs
    // out of slack at viewport 710, where Sections is already squeezed to exactly
    // its 150 minimum, so letting it rebound to 242 at the SMALLER 614 viewport is
    // the panel growing as the user zooms in - the #260 follow-up bug. The surplus
    // goes to the map, which is the primary view.
    expect(r.sections.width).toBe(PANEL_SIZE_BOUNDS.sections.min);
    expect(mapWidth(o, r)).toBeGreaterThan(MAP_MIN_WIDTH);
  });

  it('collapses Sections too - last, being primary navigation - when Details is not enough', () => {
    const o = opts({ viewportWidth: 400 });
    const r = computeSidePanelLayout(o);

    expect(r).toEqual({
      sections: { width: USER_SECTIONS, collapsed: true },
      detail: { width: USER_DETAIL, collapsed: true },
    });
    expect(mapWidth(o, r)).toBeGreaterThanOrEqual(MAP_MIN_WIDTH);
  });

  it('stays at both-collapsed (rather than looping or throwing) below the hard floor', () => {
    // Narrower than two opener bars plus the map minimum: nothing left to give.
    const r = computeSidePanelLayout(opts({ viewportWidth: 200 }));

    expect(r.sections.collapsed).toBe(true);
    expect(r.detail.collapsed).toBe(true);
  });

  it('never collapses Sections while leaving Details open', () => {
    for (let viewportWidth = 100; viewportWidth <= 1600; viewportWidth += 3) {
      const r = computeSidePanelLayout(opts({ viewportWidth }));
      if (r.sections.collapsed) expect(r.detail.collapsed, `w=${viewportWidth}`).toBe(true);
    }
  });
});

describe('computeSidePanelLayout - reversibility', () => {
  it('returns the user widths as soon as the viewport grows back', () => {
    const narrow = computeSidePanelLayout(opts({ viewportWidth: MEASURED_VIEWPORT }));
    expect(narrow.detail.collapsed).toBe(true);
    expect(narrow.sections.width).toBeLessThan(USER_SECTIONS);

    // Same user widths (the store was never written), wider viewport.
    const wide = computeSidePanelLayout(opts({ viewportWidth: 1400 }));
    expect(wide).toEqual({
      sections: { width: USER_SECTIONS, collapsed: false },
      detail: { width: USER_DETAIL, collapsed: false },
    });
  });

  it('un-collapses in the reverse order it collapsed', () => {
    const seen = [400, 614, 800, 1600].map((viewportWidth) =>
      computeSidePanelLayout(opts({ viewportWidth })),
    );
    expect(seen.map((r) => [r.sections.collapsed, r.detail.collapsed])).toEqual([
      [true, true],
      [false, true],
      [false, false],
      [false, false],
    ]);
  });
});

describe('computeSidePanelLayout - panels that cost no layout width', () => {
  it('ignores a hover-mode panel: it overlays the map instead of reflowing it', () => {
    const o = opts({ viewportWidth: MEASURED_VIEWPORT, detail: { pinnedOpen: false } });
    const r = computeSidePanelLayout(o);

    // Details already costs only its opener bar, so it is never reported as
    // collapsed-by-the-viewport, and its width is untouched.
    expect(r.detail).toEqual({ width: USER_DETAIL, collapsed: false });
    expect(r.sections.width).toBe(242);
    expect(mapWidth(o, r)).toBe(MAP_MIN_WIDTH);
  });

  it('ignores an absent panel: Sections is not rendered at all in Plan/Export', () => {
    const o = opts({ viewportWidth: 500, sections: { present: false } });
    const r = computeSidePanelLayout(o);

    expect(r.sections).toEqual({ width: USER_SECTIONS, collapsed: false });
    expect(r.detail.collapsed).toBe(true);
    expect(mapWidth(o, r)).toBeGreaterThanOrEqual(MAP_MIN_WIDTH);
  });
});

describe('computeSidePanelLayout - the reported width never exceeds the container', () => {
  /**
   * The two branches that skip the squeeze - a COLLAPSED panel (which reports the
   * user's own width so it comes back intact) and a HOVER-mode one (never squeezed,
   * because it overlays the map rather than reflowing it) - both still render at the
   * reported width when the user floats them open, and it is also where the Data
   * overlay's left/right insets stop. Reported unclamped, a persisted 284px panel in
   * a 200px container puts that edge outside the box it is positioned in.
   */
  it('clamps a collapsed panel to the viewport', () => {
    const r = computeSidePanelLayout(opts({ viewportWidth: 200 }));
    expect(r.sections.collapsed).toBe(true);
    expect(r.detail.collapsed).toBe(true);
    expect(r.sections.width).toBeLessThanOrEqual(200);
    expect(r.detail.width).toBeLessThanOrEqual(200);
  });

  it('clamps a hover-mode panel to the viewport', () => {
    const r = computeSidePanelLayout(
      opts({ viewportWidth: 200, sections: { pinnedOpen: false }, detail: { pinnedOpen: false } }),
    );
    expect(r.sections.width).toBeLessThanOrEqual(200);
    expect(r.detail.width).toBeLessThanOrEqual(200);
  });

  it('holds for every panel state across a full sweep', () => {
    for (const sPin of [true, false]) {
      for (const dPin of [true, false]) {
        for (let viewportWidth = 1; viewportWidth <= 700; viewportWidth += 1) {
          const r = computeSidePanelLayout(
            opts({ viewportWidth, sections: { pinnedOpen: sPin }, detail: { pinnedOpen: dPin } }),
          );
          const where = `w=${viewportWidth} s=${sPin} d=${dPin}`;
          expect(r.sections.width, where).toBeLessThanOrEqual(viewportWidth);
          expect(r.detail.width, where).toBeLessThanOrEqual(viewportWidth);
        }
      }
    }
  });
});

describe('computeSidePanelLayout - fractional viewports', () => {
  /**
   * Every other case here uses an integer viewport, but the UI zoom does not: a
   * non-integer zoom step leaves Main a fractional CSS width, and only the sections
   * share of the shortfall is rounded - so the detail side used to emit half-pixel
   * widths, and the rounding could even hand a panel MORE width than the user set.
   */
  it('never emits a fractional width', () => {
    for (let viewportWidth = 520; viewportWidth <= 760; viewportWidth += 0.1) {
      const w = Math.round(viewportWidth * 10) / 10;
      for (const dPin of [true, false]) {
        const r = computeSidePanelLayout(opts({ viewportWidth: w, detail: { pinnedOpen: dPin } }));
        expect(Number.isInteger(r.sections.width), `w=${w} d=${dPin}`).toBe(true);
        expect(Number.isInteger(r.detail.width), `w=${w} d=${dPin}`).toBe(true);
      }
    }
  });

  it('never WIDENS a panel past the width the user set', () => {
    // Rounding the sections share UP could push it past the whole shortfall when
    // detail offers no slack (a hover-mode Details panel), and `detailWidth -= takeD`
    // with a negative takeD then grew Details by up to half a pixel.
    for (let viewportWidth = 400; viewportWidth <= 800; viewportWidth += 0.1) {
      const w = Math.round(viewportWidth * 10) / 10;
      const r = computeSidePanelLayout(opts({ viewportWidth: w, detail: { pinnedOpen: false } }));
      expect(r.detail.width, `w=${w}`).toBeLessThanOrEqual(USER_DETAIL);
      expect(r.sections.width, `w=${w}`).toBeLessThanOrEqual(USER_SECTIONS);
    }
  });

  it('assigns the whole shortfall when rounding leaves a sliver over', () => {
    // The rebalance branch: reachable ONLY on a fractional viewport (with integer
    // inputs the leftover is an integer strictly below 0.5, i.e. zero). At 710.9 the
    // detail side is already at its slack ceiling and 0.1px is left unassigned, which
    // the map would otherwise be short of its floor.
    const o = opts({ viewportWidth: 710.9 });
    const r = computeSidePanelLayout(o);
    expect(r.sections.collapsed).toBe(false);
    expect(r.detail.collapsed).toBe(false);
    expect(r.detail.width).toBe(PANEL_SIZE_BOUNDS.detail.min);
    // Sections lands on 150.9 before the floor, i.e. its minimum after it.
    expect(r.sections.width).toBe(PANEL_SIZE_BOUNDS.sections.min);
    expect(mapWidth(o, r)).toBeGreaterThanOrEqual(MAP_MIN_WIDTH);
  });
});

describe('computeSidePanelLayout - monotonicity', () => {
  /**
   * The invariant that actually matters to a user turning the zoom up: a SMALLER
   * viewport must never render a panel WIDER. The first cut broke it by re-solving
   * each collapse step from the user's original widths, so the space freed by
   * collapsing Details went straight back to Sections and the panel visibly grew
   * as the user zoomed in.
   */
  it('never widens a panel as the viewport shrinks', () => {
    let prevSections = Infinity;
    let prevDetail = Infinity;
    for (let viewport = 1400; viewport >= 60; viewport -= 1) {
      const o = opts({ viewportWidth: viewport });
      const r = computeSidePanelLayout(o);
      // A collapsed panel occupies only its bar, so compare LAYOUT footprint -
      // that is what squeezes the map - rather than the restore-width it reports.
      const s = r.sections.collapsed ? 0 : r.sections.width;
      const d = r.detail.collapsed ? 0 : r.detail.width;
      expect(s, `sections grew at viewport ${viewport}`).toBeLessThanOrEqual(prevSections);
      expect(d, `detail grew at viewport ${viewport}`).toBeLessThanOrEqual(prevDetail);
      prevSections = s;
      prevDetail = d;
    }
  });

  it('pins the regression case: 838 -> 700 must not widen sections', () => {
    const wide = computeSidePanelLayout(opts({ viewportWidth: 838 }));
    const narrow = computeSidePanelLayout(opts({ viewportWidth: 700 }));
    expect(wide.sections.collapsed).toBe(false);
    expect(narrow.sections.width).toBeLessThanOrEqual(wide.sections.width);
  });
});
