import { useEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invokeIpc } from '../../utils/ipc';
import maplibregl from 'maplibre-gl';
import { getTileFetchStats, type TileFetchStats } from '../../utils/tileProtocol';
import { formatFixed, formatNumber } from '../../i18n/format';

interface CacheStats {
  total_tiles: bigint;
  total_bytes: bigint;
  providers: Record<string, { tiles: bigint; bytes: bigint }>;
}

interface MapDevStatsProps {
  map: maplibregl.Map;
}

interface RenderProfile {
  drawCalls: number;
  triangles: number;
  renderMs: number;
  layers: { total: number; visible: number; byType: Record<string, number> };
  sources: Array<{ name: string; features: number }>;
}

/**
 * Instruments WebGL draw calls by wrapping drawArrays/drawElements on the context.
 * Returns a controller to read per-frame counters and clean up.
 */
function createDrawCallCounter(canvas: HTMLCanvasElement) {
  const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGL2RenderingContext | null;
  if (!gl) return null;

  let drawCalls = 0;
  let triangles = 0;
  let lines = 0;
  let points = 0;

  // Save originals
  const origDrawArrays = gl.drawArrays.bind(gl);
  const origDrawElements = gl.drawElements.bind(gl);
  const origDrawArraysInstanced = gl.drawArraysInstanced?.bind(gl);
  const origDrawElementsInstanced = gl.drawElementsInstanced?.bind(gl);

  const countPrimitives = (mode: number, count: number, instances = 1) => {
    drawCalls++;
    const total = count * instances;
    if (mode === gl.TRIANGLES) triangles += total / 3;
    else if (mode === gl.TRIANGLE_STRIP || mode === gl.TRIANGLE_FAN) triangles += Math.max(0, total - 2);
    else if (mode === gl.LINES) lines += total / 2;
    else if (mode === gl.LINE_STRIP) lines += Math.max(0, total - 1);
    else if (mode === gl.POINTS) points += total;
  };

  gl.drawArrays = function (mode: number, first: number, count: number) {
    countPrimitives(mode, count);
    return origDrawArrays(mode, first, count);
  };

  gl.drawElements = function (mode: number, count: number, type: number, offset: number) {
    countPrimitives(mode, count);
    return origDrawElements(mode, count, type, offset);
  };

  if (origDrawArraysInstanced) {
    gl.drawArraysInstanced = function (mode: number, first: number, count: number, instanceCount: number) {
      countPrimitives(mode, count, instanceCount);
      return origDrawArraysInstanced(mode, first, count, instanceCount);
    };
  }

  if (origDrawElementsInstanced) {
    gl.drawElementsInstanced = function (mode: number, count: number, type: number, offset: number, instanceCount: number) {
      countPrimitives(mode, count, instanceCount);
      return origDrawElementsInstanced(mode, count, type, offset, instanceCount);
    };
  }

  return {
    /** Read and reset counters (call once per frame) */
    flush: () => {
      const result = { drawCalls, triangles: Math.round(triangles), lines: Math.round(lines), points: Math.round(points) };
      drawCalls = 0;
      triangles = 0;
      lines = 0;
      points = 0;
      return result;
    },
    /** Restore original WebGL methods */
    dispose: () => {
      gl.drawArrays = origDrawArrays;
      gl.drawElements = origDrawElements;
      if (origDrawArraysInstanced) gl.drawArraysInstanced = origDrawArraysInstanced;
      if (origDrawElementsInstanced) gl.drawElementsInstanced = origDrawElementsInstanced;
    },
  };
}

interface WebGLInfo {
  renderer: string;
  vendor: string;
  webglVersion: string;
  // GPU limits (static, cached on mount)
  maxTextureSize: number;
  maxTextureUnits: number;
  maxVertexAttribs: number;
  maxViewportDims: [number, number];
  // Color depth
  colorBits: { r: number; g: number; b: number; a: number };
  depthBits: number;
  stencilBits: number;
  // Anti-aliasing
  samples: number;
}

/**
 * Developer stats overlay for the MapLibre map.
 * Shows FPS, WebGL info, cache statistics, network status, and map coordinates.
 *
 * References:
 * - https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/
 * - https://deepwiki.com/maplibre/maplibre-gl-js/5-build-system-and-performance
 */
export function MapDevStats({ map }: MapDevStatsProps) {
  const { t } = useTranslation();
  // FPS tracking
  const [fps, setFps] = useState(0);
  const [frameTime, setFrameTime] = useState(0);
  const frameTimesRef = useRef<number[]>([]);
  const lastFrameTimeRef = useRef(performance.now());


  // Cache and network stats
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [networkStatus, setNetworkStatus] = useState<boolean | null>(null);
  const [tileFetchStats, setTileFetchStats] = useState<TileFetchStats | null>(null);

  // Map state — zoom/center stored in refs and flushed to React state periodically
  // to avoid triggering expensive re-renders on every pan frame
  const [zoom, setZoom] = useState(map.getZoom());
  const [center, setCenter] = useState(map.getCenter());
  const zoomRef = useRef(map.getZoom());
  const centerRef = useRef(map.getCenter());
  const [mapLoaded, setMapLoaded] = useState(map.loaded());
  const [tilesLoaded, setTilesLoaded] = useState(map.areTilesLoaded());

  // WebGL info
  const [webglInfo, setWebglInfo] = useState<WebGLInfo | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // Debug toggles (MapLibre built-in)
  const [showTileBoundaries, setShowTileBoundaries] = useState(map.showTileBoundaries);
  const [showCollisionBoxes, setShowCollisionBoxes] = useState(map.showCollisionBoxes);
  const [showOverdraw, setShowOverdraw] = useState(map.showOverdrawInspector);
  const [hideSymbols, setHideSymbols] = useState(false);

  // Zoom performance tracking
  const [isZooming, setIsZooming] = useState(false);
  const [zoomFps, setZoomFps] = useState<number | null>(null);
  const [lastZoomDuration, setLastZoomDuration] = useState<number | null>(null);
  const [lastZoomLevels, setLastZoomLevels] = useState<number | null>(null);
  const [worstFrameTime, setWorstFrameTime] = useState<number | null>(null);
  const zoomStartTimeRef = useRef<number | null>(null);
  const zoomStartLevelRef = useRef<number | null>(null);
  const zoomFrameTimesRef = useRef<number[]>([]);
  const worstFrameRef = useRef<number>(0);

  // Render profiling
  const [renderProfile, setRenderProfile] = useState<RenderProfile | null>(null);
  const drawCounterRef = useRef<ReturnType<typeof createDrawCallCounter>>(null);
  // Accumulate draw stats across sub-frames; flush to React state periodically
  const pendingDrawsRef = useRef({ drawCalls: 0, triangles: 0 });

  // Install WebGL draw call counter on mount
  useEffect(() => {
    const counter = createDrawCallCounter(map.getCanvas());
    drawCounterRef.current = counter;
    return () => {
      drawCounterRef.current?.dispose();
      drawCounterRef.current = null;
    };
  }, [map]);

  // Collect draw calls and render stats; update React state at ~2 Hz to avoid churn
  // PERF NOTE: querySourceFeatures is expensive (20-40ms) — only run on idle, not on render.
  // The render event handler only flushes draw call counters (cheap).
  useEffect(() => {
    let lastProfileUpdate = 0;
    const PROFILE_INTERVAL = 500; // ms — match the FPS update cadence

    const handleRender = () => {
      // Flush per-frame draw call counters (accumulated since last flush)
      const counter = drawCounterRef.current;
      if (counter) {
        const draws = counter.flush();
        pendingDrawsRef.current = draws; // Overwrite with latest frame's counts
      }
    };

    // Collect stats on idle only (NOT on every render — avoids feedback loop)
    let idleRafId = 0;
    const scheduleIdleUpdate = () => {
      cancelAnimationFrame(idleRafId);
      idleRafId = requestAnimationFrame(() => {
        const now = performance.now();
        if (now - lastProfileUpdate < PROFILE_INTERVAL) return;
        lastProfileUpdate = now;

        const draws = pendingDrawsRef.current;

        // Collect layer stats
        const style = map.getStyle();
        const allLayers = style?.layers ?? [];
        let visible = 0;
        const byType: Record<string, number> = {};
        for (const layer of allLayers) {
          const vis = map.getLayoutProperty(layer.id, 'visibility');
          if (vis !== 'none') visible++;
          byType[layer.type] = (byType[layer.type] ?? 0) + 1;
        }

        // Collect source feature counts via querySourceFeatures (official API).
        // This can be expensive (~20-40ms) but we only run on idle with 500ms throttle.
        const sources: Array<{ name: string; features: number }> = [];
        if (style?.sources) {
          for (const [name, spec] of Object.entries(style.sources)) {
            const s = spec as { type: string };
            if (s.type === 'geojson') {
              try {
                const features = map.querySourceFeatures(name);
                sources.push({ name: name.replace('survey-', ''), features: features.length });
              } catch {
                // Source may not be loaded yet
              }
            }
          }
        }

        setRenderProfile({
          ...draws,
          renderMs: frameTimesRef.current.length > 0
            ? Math.round((frameTimesRef.current.reduce((a, b) => a + b, 0) / frameTimesRef.current.length) * 100) / 100
            : 0,
          layers: { total: allLayers.length, visible, byType },
          sources,
        });
      });
    };

    map.on('render', handleRender);
    map.on('idle', scheduleIdleUpdate);

    return () => {
      map.off('render', handleRender);
      map.off('idle', scheduleIdleUpdate);
      cancelAnimationFrame(idleRafId);
    };
  }, [map]);

  // Get WebGL info on mount (cached - these don't change)
  useEffect(() => {
    const canvas = map.getCanvas();
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');

    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
      const vendor = debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
        : gl.getParameter(gl.VENDOR);
      const webglVersion = gl instanceof WebGL2RenderingContext ? 'WebGL2' : 'WebGL1';

      // GPU limits (static values)
      const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const maxTextureUnits = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number;
      const maxVertexAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;
      const viewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;

      // Color/depth bits
      const colorBits = {
        r: gl.getParameter(gl.RED_BITS) as number,
        g: gl.getParameter(gl.GREEN_BITS) as number,
        b: gl.getParameter(gl.BLUE_BITS) as number,
        a: gl.getParameter(gl.ALPHA_BITS) as number,
      };
      const depthBits = gl.getParameter(gl.DEPTH_BITS) as number;
      const stencilBits = gl.getParameter(gl.STENCIL_BITS) as number;

      // Anti-aliasing samples
      const samples = gl.getParameter(gl.SAMPLES) as number;

      setWebglInfo({
        renderer,
        vendor,
        webglVersion,
        maxTextureSize,
        maxTextureUnits,
        maxVertexAttribs,
        maxViewportDims: [viewportDims[0] ?? 0, viewportDims[1] ?? 0],
        colorBits,
        depthBits,
        stencilBits,
        samples,
      });
    }

    // Get initial canvas size
    setCanvasSize({ width: canvas.width, height: canvas.height });
  }, [map]);

  // FPS measurement using requestAnimationFrame
  // Only update React state every 500ms to avoid triggering re-renders every frame
  const lastStateUpdateRef = useRef(performance.now());
  const STATE_UPDATE_INTERVAL = 500; // ms
  const isZoomingRef = useRef(false); // Non-reactive ref for frame loop
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const measureFrame = () => {
      const now = performance.now();
      const delta = now - lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;

      // Store frame times for averaging
      if (delta < 2000) {
        frameTimesRef.current.push(delta);
        if (frameTimesRef.current.length > 60) {
          frameTimesRef.current.shift();
        }
      }

      // Track frame times during zoom
      if (isZoomingRef.current) {
        zoomFrameTimesRef.current.push(delta);
        if (delta > worstFrameRef.current) {
          worstFrameRef.current = delta;
        }
      }

      // Only update React state periodically to avoid re-render every frame
      if (now - lastStateUpdateRef.current >= STATE_UPDATE_INTERVAL) {
        lastStateUpdateRef.current = now;
        if (frameTimesRef.current.length > 0) {
          const avgFrameTime =
            frameTimesRef.current.reduce((a, b) => a + b, 0) / frameTimesRef.current.length;
          setFrameTime(Math.round(avgFrameTime * 100) / 100);
          setFps(Math.round(1000 / avgFrameTime));
        }
        // Flush zoom/center from refs (written by move handler every frame)
        setZoom(zoomRef.current);
        setCenter(centerRef.current);
      }

      animationFrameRef.current = requestAnimationFrame(measureFrame);
    };

    animationFrameRef.current = requestAnimationFrame(measureFrame);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Fetch cache stats periodically
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const stats = await invokeIpc<CacheStats>('get_cache_stats', undefined, { purpose: 'fetch tile cache stats' });
        setCacheStats(stats);
      } catch (e) {
        console.debug('[MapDevStats] Failed to fetch cache stats:', e);
      }
    };

    // Initial fetch
    fetchStats();

    // Refresh every 2 seconds
    const interval = setInterval(fetchStats, 2000);

    return () => clearInterval(interval);
  }, []);

  // Fetch network status periodically
  useEffect(() => {
    const fetchNetworkStatus = async () => {
      try {
        const status = await invokeIpc<boolean>('get_network_status', undefined, { purpose: 'check network status for dev stats' });
        setNetworkStatus(status);
      } catch (e) {
        console.debug('[MapDevStats] Failed to fetch network status:', e);
        setNetworkStatus(null);
      }
    };

    // Initial fetch
    fetchNetworkStatus();

    // Refresh every 10 seconds (network status check is blocking)
    const interval = setInterval(fetchNetworkStatus, 10000);

    return () => clearInterval(interval);
  }, []);

  // Track map state changes
  useEffect(() => {
    const handleMove = () => {
      // Write to refs only — flushed to React state in the periodic update loop
      zoomRef.current = map.getZoom();
      centerRef.current = map.getCenter();
    };

    const handleLoad = () => {
      setMapLoaded(true);
    };

    // Throttle sourcedata handler - it fires very frequently during tile loading
    let sourcedataTimeout: ReturnType<typeof setTimeout> | null = null;
    const handleSourceData = () => {
      if (sourcedataTimeout) return; // Skip if already scheduled
      sourcedataTimeout = setTimeout(() => {
        sourcedataTimeout = null;
        setTilesLoaded(map.areTilesLoaded());
      }, 250);
    };

    // Idle event fires when map finishes rendering - ensures we catch final state
    const handleIdle = () => {
      setMapLoaded(map.loaded());
      setTilesLoaded(map.areTilesLoaded());
    };

    const handleResize = () => {
      const canvas = map.getCanvas();
      setCanvasSize({ width: canvas.width, height: canvas.height });
    };

    // Zoom performance tracking
    const handleZoomStart = () => {
      zoomStartTimeRef.current = performance.now();
      zoomStartLevelRef.current = map.getZoom();
      zoomFrameTimesRef.current = [];
      worstFrameRef.current = 0;
      isZoomingRef.current = true;
      setIsZooming(true);
    };

    const handleZoomEnd = () => {
      isZoomingRef.current = false;
      setIsZooming(false);

      if (zoomStartTimeRef.current !== null) {
        const duration = performance.now() - zoomStartTimeRef.current;
        setLastZoomDuration(Math.round(duration));
      }

      if (zoomStartLevelRef.current !== null) {
        const levels = Math.abs(map.getZoom() - zoomStartLevelRef.current);
        setLastZoomLevels(Math.round(levels * 100) / 100);
      }

      // Calculate average FPS during zoom
      if (zoomFrameTimesRef.current.length > 0) {
        const avgFrameTime =
          zoomFrameTimesRef.current.reduce((a, b) => a + b, 0) / zoomFrameTimesRef.current.length;
        setZoomFps(Math.round(1000 / avgFrameTime));
      }

      // Record worst frame
      if (worstFrameRef.current > 0) {
        setWorstFrameTime(Math.round(worstFrameRef.current));
      }

      zoomStartTimeRef.current = null;
      zoomStartLevelRef.current = null;
    };

    map.on('move', handleMove);
    map.on('load', handleLoad);
    map.on('sourcedata', handleSourceData);
    map.on('resize', handleResize);
    map.on('zoomstart', handleZoomStart);
    map.on('zoomend', handleZoomEnd);
    map.on('idle', handleIdle);

    return () => {
      map.off('move', handleMove);
      map.off('load', handleLoad);
      map.off('sourcedata', handleSourceData);
      map.off('resize', handleResize);
      map.off('zoomstart', handleZoomStart);
      map.off('zoomend', handleZoomEnd);
      map.off('idle', handleIdle);
      if (sourcedataTimeout) clearTimeout(sourcedataTimeout);
    };
  }, [map]);

  // Poll tile fetch stats periodically via IPC
  useEffect(() => {
    const fetchTileStats = async () => {
      try {
        const stats = await getTileFetchStats();
        setTileFetchStats(stats);
      } catch (e) {
        console.debug('[MapDevStats] Failed to fetch tile stats:', e);
      }
    };

    // Initial fetch
    fetchTileStats();

    // Refresh every 2 seconds (matches cache stats cadence, avoids IPC overhead)
    const interval = setInterval(fetchTileStats, 2000);

    return () => clearInterval(interval);
  }, []);

  // Toggle handlers for debug options
  const toggleTileBoundaries = useCallback(() => {
    const newValue = !map.showTileBoundaries;
    map.showTileBoundaries = newValue;
    setShowTileBoundaries(newValue);
  }, [map]);

  const toggleCollisionBoxes = useCallback(() => {
    const newValue = !map.showCollisionBoxes;
    map.showCollisionBoxes = newValue;
    setShowCollisionBoxes(newValue);
  }, [map]);

  const toggleOverdraw = useCallback(() => {
    const newValue = !map.showOverdrawInspector;
    map.showOverdrawInspector = newValue;
    setShowOverdraw(newValue);
  }, [map]);

  // Toggle visibility of all symbol layers (labels) for debugging
  const toggleSymbols = useCallback(() => {
    const newValue = !hideSymbols;
    const style = map.getStyle();
    if (style?.layers) {
      for (const layer of style.layers) {
        if (layer.type === 'symbol') {
          map.setLayoutProperty(layer.id, 'visibility', newValue ? 'none' : 'visible');
        }
      }
    }
    setHideSymbols(newValue);
  }, [map, hideSymbols]);

  // Hide ALL layers except background for ultimate performance test
  const [hideAllLayers, setHideAllLayers] = useState(false);
  const toggleAllLayers = useCallback(() => {
    const newValue = !hideAllLayers;
    const style = map.getStyle();
    if (style?.layers) {
      for (const layer of style.layers) {
        if (layer.id !== 'background') {
          map.setLayoutProperty(layer.id, 'visibility', newValue ? 'none' : 'visible');
        }
      }
    }
    setHideAllLayers(newValue);
  }, [map, hideAllLayers]);

  // Format bytes to human readable
  const formatBytes = useCallback((bytes: number | bigint): string => {
    const value = typeof bytes === 'bigint' ? Number(bytes) : bytes;
    const sizes = [
      t('map.devStats.units.bytes'),
      t('map.devStats.units.kilobytes'),
      t('map.devStats.units.megabytes'),
      t('map.devStats.units.gigabytes'),
    ];
    if (value === 0) {
      return t('map.devStats.bytesValue', {
        value: formatNumber(0),
        unit: sizes[0],
      });
    }
    const k = 1024;
    const i = Math.floor(Math.log(value) / Math.log(k));
    return t('map.devStats.bytesValue', {
      value: formatFixed(value / Math.pow(k, i), undefined, 1),
      unit: sizes[i] ?? sizes[sizes.length - 1],
    });
  }, [t]);

  // Get FPS color based on performance
  const getFpsColor = useCallback((currentFps: number): string => {
    if (currentFps >= 55) return 'text-success';
    if (currentFps >= 30) return 'text-warning';
    return 'text-error';
  }, []);

  // Get network status indicator
  const getNetworkIndicator = useCallback(() => {
    if (networkStatus === null) {
      return { color: 'text-text-secondary', text: t('map.devStats.network.checking') };
    }
    if (networkStatus) {
      return { color: 'text-success', text: t('map.devStats.network.online') };
    }
    return { color: 'text-error', text: t('map.devStats.network.offline') };
  }, [networkStatus, t]);

  const networkIndicator = getNetworkIndicator();

  // Shorten GPU renderer name for display
  const shortRenderer = webglInfo?.renderer
    ? webglInfo.renderer.replace(/ANGLE \(|, .*?\)$/g, '').substring(0, 30)
    : null;

  return (
    <div
      className="absolute bottom-2 right-2 bg-panel-90 text-text-primary text-xs font-mono p-2 rounded border border-border select-none"
      style={{ minWidth: '200px', maxWidth: '280px' }}
      data-testid="map-dev-stats"
    >
      {/* Performance */}
      <div className="mb-1">
        <span className="text-text-secondary">{t('map.devStats.fps')}:</span>{' '}
        <span className={getFpsColor(fps)}>{formatNumber(fps)}</span>
        <span className="text-text-secondary opacity-80 ml-2">
          {t('map.devStats.frameTime', { ms: formatNumber(frameTime) })}
        </span>
        {isZooming && <span className="text-warning ml-2">{t('map.devStats.zooming')}</span>}
      </div>

      {/* Zoom performance (show last zoom stats) */}
      {(zoomFps !== null || lastZoomDuration !== null) && (
        <div className="mb-1 text-[10px]">
          <span className="text-text-secondary">{t('map.devStats.lastZoom')}:</span>{' '}
          {zoomFps !== null && (
            <>
              <span className={getFpsColor(zoomFps)}>
                {t('map.devStats.fpsValue', { value: formatNumber(zoomFps) })}
              </span>
              <span className="text-text-secondary opacity-80 mx-1">|</span>
            </>
          )}
          {lastZoomDuration !== null && (
            <span className="text-text-primary">
              {t('map.devStats.durationMs', { ms: formatNumber(lastZoomDuration) })}
            </span>
          )}
          {lastZoomLevels !== null && (
            <span className="text-text-secondary opacity-80 ml-1">
              {t('map.devStats.zoomLevels', {
                count: lastZoomLevels,
                countFormatted: formatNumber(lastZoomLevels),
              })}
            </span>
          )}
          {worstFrameTime !== null && worstFrameTime > 20 && (
            <span className={`ml-1 ${worstFrameTime > 50 ? 'text-error' : 'text-warning'}`}>
              {t('map.devStats.worstFrame', { ms: formatNumber(worstFrameTime) })}
            </span>
          )}
        </div>
      )}

      {/* Render pipeline profile */}
      {renderProfile && (
        <div className="border-t border-border pt-1 mt-1">
          <div className="text-text-secondary mb-0.5">Render:</div>
          <div className="pl-2 text-[10px]">
            <span className="text-text-secondary opacity-80">Draw calls:</span>{' '}
            <span className={renderProfile.drawCalls > 100 ? 'text-warning' : 'text-text-primary'}>
              {formatNumber(renderProfile.drawCalls)}
            </span>
            <span className="text-text-secondary opacity-80 ml-2">Render:</span>{' '}
            <span className={renderProfile.renderMs > 16 ? 'text-error' : renderProfile.renderMs > 8 ? 'text-warning' : 'text-text-primary'}>
              {formatFixed(renderProfile.renderMs, undefined, 1)}ms
            </span>
          </div>
          <div className="pl-2 text-[10px]">
            <span className="text-text-secondary opacity-80">Tris:</span>{' '}
            <span className="text-text-primary">{formatNumber(renderProfile.triangles)}</span>
          </div>
          <div className="pl-2 text-[10px]">
            <span className="text-text-secondary opacity-80">Layers:</span>{' '}
            <span className="text-text-primary">
              {formatNumber(renderProfile.layers.visible)}/{formatNumber(renderProfile.layers.total)}
            </span>
            <span className="text-text-secondary opacity-80 ml-2">
              ({Object.entries(renderProfile.layers.byType)
                .map(([type, count]) => `${count}${type[0]}`)
                .join(' ')})
            </span>
          </div>
          {renderProfile.sources.length > 0 && (
            <div className="pl-2 text-[10px]">
              <span className="text-text-secondary opacity-80">Features:</span>{' '}
              <span className="text-text-primary">
                {formatNumber(renderProfile.sources.reduce((sum, s) => sum + s.features, 0))}
              </span>
              <span className="text-text-secondary opacity-80 ml-1">
                ({renderProfile.sources
                  .filter((s) => s.features > 0)
                  .map((s) => `${s.name}:${s.features}`)
                  .join(' ')})
              </span>
            </div>
          )}
        </div>
      )}

      {/* Map state */}
      <div className="mb-1">
        <span className="text-text-secondary">{t('map.devStats.map')}:</span>{' '}
        <span className={mapLoaded ? 'text-success' : 'text-warning'}>
          {mapLoaded ? t('map.devStats.loaded') : t('map.devStats.loading')}
        </span>
        <span className="text-text-secondary opacity-80 mx-1">|</span>
        <span className={tilesLoaded ? 'text-success' : 'text-warning'}>
          {tilesLoaded ? t('map.devStats.tilesReady') : t('map.devStats.tilesLoading')}
        </span>
      </div>

      {/* Zoom and center */}
      <div className="mb-1">
        <span className="text-text-secondary">{t('map.devStats.zoom')}:</span>{' '}
        <span className="text-text-primary">{formatFixed(zoom, undefined, 2)}</span>
        <span className="text-text-secondary opacity-80 ml-2 text-[10px]">
          {t('map.devStats.canvasSize', {
            width: formatNumber(canvasSize.width),
            height: formatNumber(canvasSize.height),
          })}
        </span>
      </div>
      <div className="mb-1 text-text-secondary opacity-80 text-[10px]">
        {formatFixed(center.lng, undefined, 6)}, {formatFixed(center.lat, undefined, 6)}
      </div>

      {/* WebGL Info */}
      {webglInfo && (
        <div className="border-t border-border pt-1 mt-1">
          <div className="text-text-secondary mb-0.5">{t('map.devStats.webgl')}:</div>
          <div
            className="pl-2 text-[10px] text-text-secondary opacity-80 truncate"
            title={webglInfo.renderer}
          >
            {webglInfo.webglVersion} - {shortRenderer}
          </div>
          <div className="pl-2 text-[10px]">
            <span className="text-text-secondary opacity-80">{t('map.devStats.maxTexture')}:</span>{' '}
            <span className="text-text-primary">{formatNumber(webglInfo.maxTextureSize)}</span>
            <span className="text-text-secondary opacity-80 ml-2">{t('map.devStats.textureUnits')}:</span>{' '}
            <span className="text-text-primary">{formatNumber(webglInfo.maxTextureUnits)}</span>
          </div>
          <div className="pl-2 text-[10px]">
            <span className="text-text-secondary opacity-80">{t('map.devStats.colorBits')}:</span>{' '}
            <span className="text-text-primary">
              {webglInfo.colorBits.r}/{webglInfo.colorBits.g}/{webglInfo.colorBits.b}/{webglInfo.colorBits.a}
            </span>
            <span className="text-text-secondary opacity-80 ml-2">{t('map.devStats.depthBits')}:</span>{' '}
            <span className="text-text-primary">{formatNumber(webglInfo.depthBits)}</span>
            {webglInfo.samples > 0 && (
              <>
                <span className="text-text-secondary opacity-80 ml-2">{t('map.devStats.msaa')}:</span>{' '}
                <span className="text-success">
                  {t('map.devStats.msaaValue', {
                    count: webglInfo.samples,
                    countFormatted: formatNumber(webglInfo.samples),
                  })}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Debug toggles */}
      <div className="border-t border-border pt-1 mt-1 pointer-events-auto">
        <div className="text-text-secondary mb-0.5">{t('map.devStats.debug')}:</div>
        <div className="pl-2 flex flex-wrap gap-1">
          <button
            onClick={toggleTileBoundaries}
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              showTileBoundaries
                ? 'bg-accent-30 border-accent text-accent'
                : 'bg-panel border-border text-text-secondary hover:border-accent'
            }`}
            title={t('map.devStats.titles.tiles')}
          >
            {t('map.devStats.tiles')}
          </button>
          <button
            onClick={toggleCollisionBoxes}
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              showCollisionBoxes
                ? 'bg-accent-30 border-accent text-accent'
                : 'bg-panel border-border text-text-secondary hover:border-accent'
            }`}
            title={t('map.devStats.titles.collision')}
          >
            {t('map.devStats.collision')}
          </button>
          <button
            onClick={toggleOverdraw}
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              showOverdraw
                ? 'bg-accent-30 border-accent text-accent'
                : 'bg-panel border-border text-text-secondary hover:border-accent'
            }`}
            title={t('map.devStats.titles.overdraw')}
          >
            {t('map.devStats.overdraw')}
          </button>
          <button
            onClick={toggleSymbols}
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              hideSymbols
                ? 'bg-error-20 border-error text-error'
                : 'bg-panel border-border text-text-secondary hover:border-accent'
            }`}
            title={t('map.devStats.titles.labels')}
          >
            {hideSymbols ? t('map.devStats.labelsOff') : t('map.devStats.labels')}
          </button>
          <button
            onClick={toggleAllLayers}
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              hideAllLayers
                ? 'bg-error-20 border-error text-error'
                : 'bg-panel border-border text-text-secondary hover:border-accent'
            }`}
            title={t('map.devStats.titles.allLayers')}
          >
            {hideAllLayers ? t('map.devStats.allLayersOff') : t('map.devStats.allLayers')}
          </button>
        </div>
      </div>

      {/* Tile fetch stats */}
      {tileFetchStats && (
        <div className="border-t border-border pt-1 mt-1">
          <div className="text-text-secondary mb-0.5">{t('map.devStats.satelliteTiles')}:</div>
          <div className="pl-2">
            <span className="text-text-secondary opacity-80">{t('map.devStats.inFlight')}:</span>{' '}
            <span className={tileFetchStats.inFlight > 0 ? 'text-warning' : 'text-success'}>
              {formatNumber(tileFetchStats.inFlight)}
            </span>
            <span className="text-text-secondary opacity-80 ml-2">{t('map.devStats.latency')}:</span>{' '}
            <span className={tileFetchStats.avgLatencyMs > 500 ? 'text-warning' : 'text-text-primary'}>
              {t('map.devStats.durationMs', { ms: formatNumber(tileFetchStats.avgLatencyMs) })}
            </span>
          </div>
          <div className="pl-2">
            <span className="text-text-secondary opacity-80">{t('map.devStats.fetched')}:</span>{' '}
            <span className="text-text-primary">{formatNumber(tileFetchStats.totalFetched)}</span>
            {tileFetchStats.totalErrors > 0 && (
              <span className="text-error ml-1">
                {t('map.devStats.errors', {
                  count: tileFetchStats.totalErrors,
                  countFormatted: formatNumber(tileFetchStats.totalErrors),
                })}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Network status */}
      <div className="border-t border-border pt-1 mt-1">
        <span className="text-text-secondary">{t('map.devStats.network.label')}:</span>{' '}
        <span className={networkIndicator.color}>{networkIndicator.text}</span>
      </div>

      {/* Cache stats */}
      {cacheStats && (
        <div className="border-t border-border pt-1 mt-1">
          <div className="text-text-secondary mb-0.5">{t('map.devStats.cache')}:</div>
          <div className="pl-2">
            <span className="text-text-secondary opacity-80">{t('map.devStats.tiles')}:</span>{' '}
            <span className="text-text-primary">{formatNumber(Number(cacheStats.total_tiles))}</span>
            <span className="text-text-secondary opacity-80 ml-2">{t('map.devStats.size')}:</span>{' '}
            <span className="text-text-primary">{formatBytes(cacheStats.total_bytes)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
