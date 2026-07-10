/**
 * Main-thread registry + `addProtocol` handler for the on-demand survey
 * vector tiles (#mem). See `vectorTileData.ts` for the data model, the tile
 * cutter, the MVT encoder and the rationale.
 *
 * SurveyLayer stores each bulk layer's `VtLayerData` here under a stable key
 * and points the matching vector source at `vtTileUrl(key, version)`; bumping
 * the version changes the tile URL template so MapLibre reloads tiles.
 */
import { addProtocol } from 'maplibre-gl';
import { cutTile, type VtLayerData } from './vectorTileData';

export const VT_PROTOCOL = 'stalx';

const registry = new Map<string, { data: VtLayerData; version: number }>();

let protocolRegistered = false;

/**
 * Store (replace) a layer's data and return the new version. The caller
 * points its vector source at `vtTileUrl(key, version)` so tiles reload.
 */
export function setVtLayerData(key: string, data: VtLayerData): number {
  const entry = registry.get(key);
  const version = (entry?.version ?? 0) + 1;
  registry.set(key, { data, version });
  return version;
}

/** Drop a layer's data (project close / layer teardown). Serving falls back
 *  to empty tiles until the next `setVtLayerData`. */
export function clearVtLayerData(key: string): void {
  registry.delete(key);
}

/** Tile URL template for a registry key at a version. */
export function vtTileUrl(key: string, version: number): string {
  return `${VT_PROTOCOL}://${key}/{z}/{x}/{y}?v=${version}`;
}

/** Register the tile protocol once (idempotent). */
export function ensureVtProtocol(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  addProtocol(VT_PROTOCOL, async (params) => {
    // URL shape: stalx://<key>/<z>/<x>/<y>?v=<n>
    const m = /^stalx:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error(`bad ${VT_PROTOCOL} tile url: ${params.url}`);
    const entry = registry.get(m[1]!);
    if (!entry) return { data: new ArrayBuffer(0) };
    const bytes = cutTile(entry.data, Number(m[2]), Number(m[3]), Number(m[4]));
    if (!bytes) return { data: new ArrayBuffer(0) };
    // The cutter returns an exact-size standalone Uint8Array; hand its buffer over.
    return { data: bytes.buffer as ArrayBuffer };
  });
}
