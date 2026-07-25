import { describe, it, expect } from 'vitest';
import { GhostFollow, GHOST_REBAKE_PX, type GhostOffset } from '../dragGhostFollow';

/**
 * Ghost-follow single-flight state machine (#mem drag latency overshoot fix).
 *
 * The regression these tests lock out: an ELASTIC OVERSHOOT where the drag
 * preview moved FURTHER than the cursor and bounced back on stop, caused by a
 * translate reference (baked offset) that lagged the displayed geometry while
 * several `setData` bakes were in flight. The machine here bakes single-flight
 * and always translates against the LAST LANDED bake, so the invariant
 *
 *     displayed = landed + translate == live cursor
 *
 * holds after every move and every land regardless of land timing. The core
 * assertion in every scenario is `displayedOffset()` deep-equalling
 * `liveOffset()` - i.e. NO overshoot, ever.
 */

interface Harness {
  gf: GhostFollow;
  bakes: GhostOffset[];
  translates: GhostOffset[];
  /** Deliver the one in-flight bake's land signal (mirrors sourcedata/timeout). */
  land: () => void;
}

function makeHarness(rebakePx = GHOST_REBAKE_PX): Harness {
  const bakes: GhostOffset[] = [];
  const translates: GhostOffset[] = [];
  const gf = new GhostFollow(
    {
      bake: (pos) => bakes.push(pos),
      translate: (residual) => translates.push(residual),
    },
    rebakePx,
  );
  return { gf, bakes, translates, land: () => gf.land() };
}

/** After any machine op the displayed position must equal the live cursor. */
function expectGlued(h: Harness): void {
  expect(h.gf.displayedOffset()).toEqual(h.gf.liveOffset());
}

describe('GhostFollow invariant: displayed position == live cursor', () => {
  it('holds through a simple move -> land -> move -> land cycle', () => {
    const h = makeHarness();
    h.gf.start(); // bake @0 in flight
    expectGlued(h);
    h.gf.move(30, 0); // > threshold but a bake is in flight -> translate only
    expectGlued(h);
    expect(h.gf.hasBakeInFlight()).toBe(true);
    h.land(); // @0 lands; residual 30 > threshold -> chain bake @30
    expectGlued(h);
    h.gf.move(45, 0);
    expectGlued(h);
    h.land(); // @30 lands
    expectGlued(h);
  });

  it('never overshoots across DELAYED landings (many moves, then a drain)', () => {
    const h = makeHarness();
    h.gf.start();
    // Fast fling: cursor races ahead while only ONE bake (the @0 from start) is
    // in flight. Under the old multi-flight logic the displayed geometry would
    // shoot past the cursor here.
    for (const x of [20, 60, 120, 200, 300]) {
      h.gf.move(x, 0);
      expectGlued(h); // translate carries the whole gap; still glued
      expect(h.gf.hasBakeInFlight()).toBe(true); // single-flight: no new bake
    }
    expect(h.bakes).toHaveLength(1); // only the initial @0
    // Now the queue drains one land at a time; the cursor has stopped at 300.
    h.land(); // @0 lands -> landed=0 -> chain bake @300
    expectGlued(h);
    h.land(); // @300 lands -> landed=300, residual 0
    expectGlued(h);
    expect(h.gf.hasBakeInFlight()).toBe(false);
    // Final translate is exactly zero (geometry now baked at the cursor).
    expect(h.translates[h.translates.length - 1]).toEqual({ dx: 0, dy: 0 });
  });

  it('reproduces the OLD overshoot trigger and stays glued (earlier bake lands mid-motion)', () => {
    const h = makeHarness(10);
    h.gf.start(); // bake @0
    h.gf.move(50, 0); // translate 50, @0 still pending
    expectGlued(h);
    h.land(); // @0 lands -> landed=50? no: landed=0, translate=50, chain bake @50
    expectGlued(h);
    // The chain bake @50 is now in flight; cursor keeps moving. The displayed
    // geometry is still @0 until @50 lands. Old logic rebased to the REQUESTED
    // (@50) here even though @0 is what is drawn -> overshoot. New logic keeps
    // translating against landed(@0).
    h.gf.move(90, 0);
    expectGlued(h);
    expect(h.gf.displayedOffset()).toEqual({ dx: 90, dy: 0 });
    h.land(); // @50 lands -> landed=50, translate=40
    expectGlued(h);
    expect(h.translates[h.translates.length - 1]).toEqual({ dx: 40, dy: 0 });
  });

  it('holds on a 2-D diagonal drag with mixed signs', () => {
    const h = makeHarness();
    h.gf.start();
    const path: GhostOffset[] = [
      { dx: 15, dy: -15 }, { dx: -40, dy: 30 }, { dx: 5, dy: 80 }, { dx: -100, dy: -60 },
    ];
    for (const p of path) {
      h.gf.move(p.dx, p.dy);
      expectGlued(h);
      // Occasionally drain a land to interleave motion + landings out of phase.
      if (h.gf.hasBakeInFlight() && Math.abs(p.dx) > 30) {
        h.land();
        expectGlued(h);
      }
    }
    // Drain remaining and settle.
    h.land();
    expectGlued(h);
  });

  it('translate residual always equals live - landed (never exceeds the gap)', () => {
    const h = makeHarness(5);
    h.gf.start();
    let landedX = 0;
    const seq: Array<{ kind: 'move' | 'land'; x?: number }> = [
      { kind: 'move', x: 10 }, { kind: 'move', x: 25 }, { kind: 'land' },
      { kind: 'move', x: 40 }, { kind: 'land' }, { kind: 'move', x: 42 }, { kind: 'land' },
    ];
    // Track landed independently: each land adopts the position of the bake that
    // was issued most recently before it (single-flight => deterministic).
    let inFlightX = 0; // @0 from start
    for (const step of seq) {
      const bakesBefore = h.bakes.length;
      if (step.kind === 'move') {
        h.gf.move(step.x!, 0);
        if (h.bakes.length > bakesBefore) inFlightX = h.bakes[h.bakes.length - 1]!.dx;
      } else {
        landedX = inFlightX;
        h.gf.land();
        if (h.bakes.length > bakesBefore) inFlightX = h.bakes[h.bakes.length - 1]!.dx;
      }
      const live = h.gf.liveOffset();
      const t = h.translates[h.translates.length - 1]!;
      expect(t).toEqual({ dx: live.dx - landedX, dy: 0 }); // dy stays 0 this drag
      expectGlued(h);
    }
  });
});

describe('GhostFollow single-flight cadence', () => {
  it('bakes only when idle AND residual exceeds the threshold', () => {
    const h = makeHarness(20);
    h.gf.start(); // one bake @0 in flight
    expect(h.bakes).toHaveLength(1);
    h.gf.move(5, 0); // under threshold -> no bake even after...
    h.land(); // ...landing: residual 5 < 20, no chain bake
    expect(h.bakes).toHaveLength(1);
    expect(h.gf.hasBakeInFlight()).toBe(false);
    h.gf.move(25, 0); // now over threshold + idle -> bake
    expect(h.bakes).toHaveLength(2);
    expect(h.bakes[h.bakes.length - 1]).toEqual({ dx: 25, dy: 0 });
    expect(h.gf.hasBakeInFlight()).toBe(true);
  });

  it('a spurious land with nothing in flight is a no-op', () => {
    const h = makeHarness();
    h.gf.start();
    h.land(); // @0 lands, nothing chained (residual 0)
    const bakesAfter = h.bakes.length;
    const translatesAfter = h.translates.length;
    h.land(); // nothing in flight
    h.land();
    expect(h.bakes).toHaveLength(bakesAfter);
    expect(h.translates).toHaveLength(translatesAfter);
    expectGlued(h);
  });
});
