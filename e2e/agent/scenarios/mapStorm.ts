/**
 * map-storm: fire a seeded barrage of jumpTo() calls (random center offset,
 * zoom, bearing) at the live MapLibre map while a rAF-gap probe runs in the
 * page, then report the worst main-thread stall. Fails if the map instance
 * disappears mid-storm (canvas teardown / crash). Timing is a metric, not a
 * failure.
 */
import type { Scenario } from './framework';
import { ensureProjectLoaded } from './common';

export const mapStorm: Scenario = {
  name: 'map-storm',
  description: 'Seeded jumpTo barrage on the live map; probe main-thread stalls.',
  defaultIterations: 200,
  async run(ctx, { iterations }) {
    await ensureProjectLoaded(ctx);

    const base = await ctx.eval<{ ok: boolean; center?: [number, number]; zoom?: number }>(`
      const m = window.__stalagmight_map__;
      if (!m) return { ok: false };
      const c = m.getCenter();
      return { ok: true, center: [c.lng, c.lat], zoom: m.getZoom() };
    `);
    if (!base.ok || !base.center) throw new Error('map not available (need single-system view)');

    // Start an in-page requestAnimationFrame gap probe.
    await ctx.eval(`
      window.__rafProbe = { last: performance.now(), max: 0, running: true };
      const tick = () => {
        if (!window.__rafProbe || !window.__rafProbe.running) return;
        const now = performance.now();
        const gap = now - window.__rafProbe.last;
        if (gap > window.__rafProbe.max) window.__rafProbe.max = gap;
        window.__rafProbe.last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    `);

    const [lng, lat] = base.center;
    let maxJumpMs = 0;
    let probeMax = 0;
    try {
      for (let i = 0; i < iterations; i++) {
        const dx = (ctx.rng() - 0.5) * 0.02;
        const dy = (ctx.rng() - 0.5) * 0.02;
        const zoom = 10 + ctx.rng() * 8;
        const bearing = ctx.rng() * 360;
        const t0 = Date.now();
        const alive = await ctx.eval<boolean>(
          `
          const m = window.__stalagmight_map__;
          if (!m) return false;
          m.jumpTo({ center: args[0], zoom: args[1], bearing: args[2] });
          return true;
        `,
          [[lng + dx, lat + dy], zoom, bearing],
        );
        maxJumpMs = Math.max(maxJumpMs, Date.now() - t0);
        ctx.metric('jumps');
        if (!alive) throw new Error(`map instance disappeared at jump ${i}`);
      }
    } finally {
      // Always stop the probe: a thrown step must not leave a rAF loop running
      // in the page for the rest of the session.
      const probe = await ctx
        .eval<{ max: number }>(`
          if (window.__rafProbe) window.__rafProbe.running = false;
          const max = window.__rafProbe ? window.__rafProbe.max : 0;
          delete window.__rafProbe;
          return { max };
        `)
        .catch(() => ({ max: 0 }));
      probeMax = probe.max;
    }
    ctx.setMetric('maxJumpMs', maxJumpMs);
    ctx.setMetric('maxRafGapMs', Math.round(probeMax));
    ctx.log(`${iterations} jumps; maxJumpMs=${maxJumpMs} maxRafGapMs=${Math.round(probeMax)}`);
  },
};
