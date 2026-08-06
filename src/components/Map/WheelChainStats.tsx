/**
 * Wheel-chain diagnostics: originated as a temporary overlay for a
 * zoom-choppiness investigation (mounted unconditionally in dev builds), now
 * folded into the hamburger menu's Debug > Zoom Stats panel so it's only
 * live when a developer actually asks for it.
 *
 * Shows, for the PREVIOUS completed wheel chain (a burst of wheel events with
 * no gap > CHAIN_GAP_MS) and for the LIVE current chain:
 *  - event count and chain duration
 *  - signed scroll amount (sum of deltaY)
 *  - "finger travel" proxy: sum of |deltaY| + |deltaX| in pixels. The webview
 *    never sees raw trackpad finger positions; on Windows precision trackpads
 *    the pixel-mode wheel deltas are proportional to finger travel, so this is
 *    the best available measure. A mouse wheel instead shows ~100 px steps per
 *    notch (visible via the event count and the per-event average).
 *  - zoom level at chain start -> end
 *  - whether any event had ctrlKey set (OS pinch gesture) and the delta mode
 *    (px = trackpad/pixel scrolling, line = classic wheel notches)
 *
 * All bookkeeping lives in refs and plain DOM writes on a 100 ms interval, so
 * this adds no React renders to the hot path it is instrumenting.
 */
import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';

/** A gap longer than this starts a new chain (mirrors MapLibre's 400 ms
 *  wheel-vs-trackpad classification window). */
const CHAIN_GAP_MS = 400;

interface ChainStats {
  events: number;
  signedDeltaY: number;
  travelPx: number;
  startTime: number;
  endTime: number;
  zoomStart: number;
  zoomEnd: number;
  sawCtrl: boolean;
  sawLineMode: boolean;
  /** Per-event samples of MapLibre's ScrollZoomHandler classification
   *  ('wheel' = 1/450 zoom rate, 'trackpad' = 1/100, pending = not yet
   *  classified). Sampled right after each event's dispatch completes. */
  typeCounts: { wheel: number; trackpad: number; pending: number };
}

function newChain(now: number, zoom: number): ChainStats {
  return {
    events: 0,
    signedDeltaY: 0,
    travelPx: 0,
    startTime: now,
    endTime: now,
    zoomStart: zoom,
    zoomEnd: zoom,
    sawCtrl: false,
    sawLineMode: false,
    typeCounts: { wheel: 0, trackpad: 0, pending: 0 },
  };
}

function formatChain(label: string, c: ChainStats | null): string {
  if (!c || c.events === 0) return `${label}: (none)`;
  const dur = (c.endTime - c.startTime).toFixed(0);
  const avg = (c.travelPx / c.events).toFixed(1);
  const mode = c.sawLineMode ? 'line' : 'px';
  const pinch = c.sawCtrl ? ' pinch' : '';
  const dz = c.zoomEnd - c.zoomStart;
  // Effective zoom rate in milli-zoom per px of travel: 'trackpad' chains run
  // near 10 mz/px (1/100), 'wheel' chains near 2.2 mz/px (1/450).
  const rate = c.travelPx > 0 ? ((Math.abs(dz) / c.travelPx) * 1000).toFixed(1) : '0';
  const tc = c.typeCounts;
  const sampled = tc.wheel + tc.trackpad + tc.pending;
  const pct = (n: number) => (sampled > 0 ? Math.round((n / sampled) * 100) : 0);
  const types = `wheel ${pct(tc.wheel)}% / trackpad ${pct(tc.trackpad)}%` +
    (tc.pending > 0 ? ` / pending ${pct(tc.pending)}%` : '');
  return (
    `${label}: ${c.events} ev / ${dur} ms\n` +
    `  type ${types}\n` +
    `  scroll ${c.signedDeltaY.toFixed(0)} px, travel ${c.travelPx.toFixed(0)} px (avg ${avg}/ev, ${mode}${pinch})\n` +
    `  zoom ${c.zoomStart.toFixed(2)} -> ${c.zoomEnd.toFixed(2)} (d ${dz.toFixed(2)}, ${rate} mz/px)`
  );
}

/** Read MapLibre's private per-chain classification off the live handler. */
function readScrollZoomType(map: MapLibreMap): string | null {
  const sz = map.scrollZoom as unknown as { _type?: 'wheel' | 'trackpad' | null };
  return sz._type ?? null;
}

export function WheelChainStats({ map }: { map: MapLibreMap }) {
  const boxRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const current = { chain: null as ChainStats | null };
    const previous = { chain: null as ChainStats | null };
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    // Per-event classification timeouts (below). Tracked so a toggle-off mid-chain
    // - unlike the old dev-build-lifetime mount, this can now happen on any click -
    // can't write into a chain object after this effect's cleanup has run.
    const pendingClassifications = new Set<ReturnType<typeof setTimeout>>();

    const promote = () => {
      if (current.chain && current.chain.events > 0) {
        current.chain.zoomEnd = map.getZoom();
        previous.chain = current.chain;
      }
      current.chain = null;
    };

    const onWheel = (e: WheelEvent) => {
      const now = performance.now();
      if (current.chain && now - current.chain.endTime > CHAIN_GAP_MS) promote();
      if (!current.chain) current.chain = newChain(now, map.getZoom());

      const c = current.chain;
      c.events += 1;
      c.signedDeltaY += e.deltaY;
      c.travelPx += Math.abs(e.deltaY) + Math.abs(e.deltaX);
      c.endTime = now;
      c.zoomEnd = map.getZoom();
      if (e.ctrlKey) c.sawCtrl = true;
      if (e.deltaMode !== 0) c.sawLineMode = true;

      // MapLibre classifies on its own listener; ours (window capture) runs
      // first within the same dispatch, so sample on a 0 ms timeout - after
      // the dispatch completes this event's classification is settled. The
      // first event of a chain stays null for up to 40 ms ('pending').
      const classifyId = setTimeout(() => {
        pendingClassifications.delete(classifyId);
        const t = readScrollZoomType(map);
        if (t === 'wheel') c.typeCounts.wheel += 1;
        else if (t === 'trackpad') c.typeCounts.trackpad += 1;
        else c.typeCounts.pending += 1;
      }, 0);
      pendingClassifications.add(classifyId);

      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(promote, CHAIN_GAP_MS + 100);
    };

    // Imperative repaint: keeps this out of the React render path.
    const paint = setInterval(() => {
      if (!boxRef.current) return;
      boxRef.current.textContent =
        formatChain('prev chain', previous.chain) +
        '\n' +
        formatChain('live chain', current.chain);
    }, 100);

    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true });
      if (settleTimer) clearTimeout(settleTimer);
      clearInterval(paint);
      for (const id of pendingClassifications) clearTimeout(id);
      pendingClassifications.clear();
    };
  }, [map]);

  return (
    <pre
      ref={boxRef}
      data-testid="zoom-stats-wheel-chain"
      className="text-[10px] leading-tight whitespace-pre m-0"
      style={{ color: '#7fffb0' }}
    >
      {'prev chain: (none)\nlive chain: (none)'}
    </pre>
  );
}
