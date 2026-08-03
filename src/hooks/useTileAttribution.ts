import { useEffect, useState } from 'react';
import { invokeIpc } from '../utils/ipc';
import { PROVIDER_ATTRIBUTION } from '../utils/tileConfig';
import type { TileAttribution } from '../types/tile';

/**
 * Attribution for one tile provider, as the UI consumes it.
 *
 * `text` is the data-source list that MUST be displayed wherever the imagery is
 * drawn. `notice`/`noticeUrl` are the provider credit ("Powered by Esri"), which
 * Esri permits behind a menu or button - the About dialog carries those.
 */
export interface ResolvedTileAttribution {
  /** Data-source names. Required on (or directly beneath) the map. */
  text: string;
  /** Provider notice, e.g. "Powered by Esri". */
  notice: string | null;
  /** Brand URL for `notice`. */
  noticeUrl: string | null;
  /** `true` once `text` came from the provider's live service metadata. */
  live: boolean;
}

/** The compiled-in answer, used before the IPC resolves and after it fails. */
export function fallbackAttribution(provider: string): ResolvedTileAttribution {
  const known = PROVIDER_ATTRIBUTION[provider];
  return {
    text: known?.attribution ?? '',
    notice: known?.notice ?? null,
    noticeUrl: known?.noticeUrl ?? null,
    live: false,
  };
}

/**
 * One in-flight (then settled) request per provider, shared process-wide.
 *
 * Three surfaces can display Esri imagery at once - the survey map, Global View
 * and a Section Preview - and mounting all three must not mean three round
 * trips. The backend caches for a day anyway; this just stops the duplicate
 * calls before they are made.
 */
const inFlight = new Map<string, Promise<ResolvedTileAttribution>>();

export function loadTileAttribution(provider: string): Promise<ResolvedTileAttribution> {
  const cached = inFlight.get(provider);
  if (cached) return cached;

  const request = invokeIpc<TileAttribution>(
    'get_tile_attribution',
    { provider },
    { purpose: 'display map imagery attribution' },
  )
    .then((result) => ({
      // An empty live string would leave required attribution blank, so treat
      // it the same as a failure and keep the compiled-in names.
      text: result.text || fallbackAttribution(provider).text,
      notice: result.notice,
      noticeUrl: result.notice_url,
      live: result.live && !!result.text,
    }))
    .catch(() => {
      // Never surfaced to the user: the fallback is a correct attribution, and
      // a toast about a copyright string is noise. Drop the memo so a later
      // mount (by which time the app may be online) can try again.
      inFlight.delete(provider);
      return fallbackAttribution(provider);
    });

  inFlight.set(provider, request);
  return request;
}

/** Test seam: forget every memoized request. */
export function resetTileAttributionCache(): void {
  inFlight.clear();
}

/**
 * Resolve a provider's attribution, starting from the compiled-in value so the
 * map never renders imagery with a blank credit while the IPC is in flight.
 */
export function useTileAttribution(provider: string): ResolvedTileAttribution {
  const [attribution, setAttribution] = useState<ResolvedTileAttribution>(() =>
    fallbackAttribution(provider),
  );

  useEffect(() => {
    let active = true;
    // Re-seed synchronously: switching providers must not leave the previous
    // provider's names under the new provider's imagery, even for a frame.
    setAttribution(fallbackAttribution(provider));
    loadTileAttribution(provider).then((resolved) => {
      if (active) setAttribution(resolved);
    });
    return () => {
      active = false;
    };
  }, [provider]);

  return attribution;
}
