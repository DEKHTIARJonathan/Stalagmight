/**
 * Shared Web-Mercator coordinate helper.
 *
 * Extracted from `vectorTileData.ts` so the custom WebGL renderer (which
 * mercator-projects its own geometry) does not have to import from a
 * stock-pipeline module. Worker-safe (no maplibre import), like its former
 * home; used by both the stock VT tile cutter and the custom renderer.
 */

/** Mercator-project a lng/lat to [0,1] world space. */
export function lngLatToMercator(lng: number, lat: number): [number, number] {
  const x = lng / 360 + 0.5;
  const s = Math.sin((lat * Math.PI) / 180);
  const clamped = Math.min(Math.max(s, -0.9999), 0.9999);
  const y = 0.5 - (0.25 * Math.log((1 + clamped) / (1 - clamped))) / Math.PI;
  return [x, y];
}
