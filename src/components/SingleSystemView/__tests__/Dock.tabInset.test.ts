import { describe, expect, it } from 'vitest';

import { clampTabInset } from '../Dock';

/**
 * #260: the Dock's opener tabs are anchored by a FIXED inset from one container
 * edge - `right: tabInset` (40) for the bottom Data tab, `top: tabTop` (40 / 79)
 * for the side tabs. Once the container is narrower/shorter than that inset the
 * tab's whole box lands outside it: the Data tab was observed sitting on top of a
 * Sections panel row, having walked off the left edge of a squeezed map column.
 */
describe('clampTabInset', () => {
  it('leaves the requested inset alone when the tab comfortably fits', () => {
    expect(clampTabInset(40, 600, 28)).toBe(40);
  });

  it('pulls the tab back to the far edge when the container is barely wider than it', () => {
    // 48px container, 28px tab: the largest inset that still keeps the tab inside
    // is 20, not the requested 40.
    expect(clampTabInset(40, 48, 28)).toBe(20);
  });

  it('pins the tab flush to the near edge rather than letting it escape entirely', () => {
    // The reported failure: container narrower than the tab itself.
    expect(clampTabInset(40, 20, 28)).toBe(0);
    expect(clampTabInset(79, 10, 30)).toBe(0);
  });

  it('never returns a negative inset, which is what put the tab outside its container', () => {
    for (let container = 0; container <= 200; container += 1) {
      for (const tab of [0, 28, 64]) {
        expect(clampTabInset(79, container, tab)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('keeps the tab box inside the container whenever the tab can fit at all', () => {
    for (let container = 1; container <= 300; container += 1) {
      const tab = 28;
      const inset = clampTabInset(40, container, tab);
      if (container >= tab) expect(inset + tab, `c=${container}`).toBeLessThanOrEqual(container);
    }
  });

  it('passes the request through unchanged while the container is unmeasured', () => {
    // `null` means "no layout yet" (first paint / zero-layout test env) - clamping
    // to it would yank every tab to 0 for a frame.
    expect(clampTabInset(40, null, 28)).toBe(40);
    expect(clampTabInset(79, null, 0)).toBe(79);
  });

  it('clamps a MEASURED zero instead of opting out of it', () => {
    // The two readings used to be conflated on `container > 0`, so the clamp opted
    // out in exactly the case it exists for: an open Data panel taller than Main
    // raises a minimized side bar's bottom past its top, the bar's overlay computes
    // to height 0 - a real measurement, not a missing one - and passing `top: 79`
    // through put the tab 79px below a zero-height container.
    expect(clampTabInset(40, 0, 28)).toBe(0);
    expect(clampTabInset(79, 0, 0)).toBe(0);
    expect(clampTabInset(79, 0, 30)).toBe(0);
  });

  it('treats a non-finite reading as unmeasured rather than clamping to NaN', () => {
    expect(clampTabInset(40, Number.NaN, 28)).toBe(40);
  });
});
