import type maplibregl from 'maplibre-gl';

/**
 * Check if map instance has a live style (not destroyed).
 * Uses internal property access since maplibre-gl doesn't expose this publicly.
 * After map.remove() is called, the internal style object is destroyed,
 * and any calls to getLayer/getSource/etc will throw.
 */
export function hasLiveStyle(map: maplibregl.Map | null): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return !!(map && (map as any).style);
}
