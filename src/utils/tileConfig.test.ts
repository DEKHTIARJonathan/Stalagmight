/**
 * Unit tests for tile configuration utility.
 * Covers valid provider, unknown provider, default parameter, and returned shape.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { getTileConfig } from './tileConfig';

/** Override navigator.userAgent for a single test (restored in afterEach). */
function setUserAgent(ua: string): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
}

describe('getTileConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns correct config for esri provider', () => {
    const config = getTileConfig('esri');

    expect(config.tiles).toEqual(['stalagmight-tiles://esri/{z}/{y}/{x}']);
    expect(config.attribution).toBe('&copy; Esri, Maxar, Earthstar Geographics');
    expect(config.tileSize).toBe(256);
    expect(config.minZoom).toBe(0);
    expect(config.maxZoom).toBe(22);
  });

  it('uses the bare custom scheme on non-Windows platforms', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    expect(getTileConfig('esri').tiles).toEqual(['stalagmight-tiles://esri/{z}/{y}/{x}']);
  });

  it('uses the http://<scheme>.localhost form on Windows (WebView2)', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(getTileConfig('esri').tiles).toEqual([
      'http://stalagmight-tiles.localhost/esri/{z}/{y}/{x}',
    ]);
  });

  it('throws on unknown provider name', () => {
    expect(() => getTileConfig('unknown')).toThrow('Unknown tile provider: unknown');
    expect(() => getTileConfig('openstreetmap')).toThrow('Unknown tile provider: openstreetmap');
    expect(() => getTileConfig('')).toThrow('Unknown tile provider: ');
  });

  it('defaults to esri when no provider is specified', () => {
    const config = getTileConfig();
    const esriConfig = getTileConfig('esri');

    expect(config).toEqual(esriConfig);
  });

  it('returns an object with the expected shape', () => {
    const config = getTileConfig();

    // Verify all required fields are present and have correct types
    expect(config).toHaveProperty('tiles');
    expect(config).toHaveProperty('attribution');
    expect(config).toHaveProperty('tileSize');
    expect(config).toHaveProperty('minZoom');
    expect(config).toHaveProperty('maxZoom');

    expect(Array.isArray(config.tiles)).toBe(true);
    expect(config.tiles.length).toBeGreaterThan(0);
    expect(typeof config.attribution).toBe('string');
    expect(typeof config.tileSize).toBe('number');
    expect(typeof config.minZoom).toBe('number');
    expect(typeof config.maxZoom).toBe('number');

    // Zoom range is valid
    expect(config.minZoom).toBeLessThanOrEqual(config.maxZoom);
    expect(config.minZoom).toBeGreaterThanOrEqual(0);
  });

  it('returns a new object each call (no shared mutable state)', () => {
    const config1 = getTileConfig();
    const config2 = getTileConfig();

    expect(config1).toEqual(config2);
    expect(config1).not.toBe(config2);
    expect(config1.tiles).not.toBe(config2.tiles);
  });
});
