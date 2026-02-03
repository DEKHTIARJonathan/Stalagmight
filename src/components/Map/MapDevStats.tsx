import { useEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import maplibregl from 'maplibre-gl';
import { getTileFetchStats, type TileFetchStats } from '../../utils/tileProtocol';
import { formatFixed, formatNumber } from '../../i18n/format';

interface CacheStats {
  total_tiles: number;
  total_bytes: number;
  providers: Record<string, { tiles: number; bytes: number }>;
}

interface MapDevStatsProps {
  map: maplibregl.Map;
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
  const animationFrameRef = useRef<number | null>(null);

  // Cache and network stats
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [networkStatus, setNetworkStatus] = useState<boolean | null>(null);
  const [tileFetchStats, setTileFetchStats] = useState<TileFetchStats | null>(null);

  // Map state
  const [zoom, setZoom] = useState(map.getZoom());
  const [center, setCenter] = useState(map.getCenter());
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

  useEffect(() => {
    const measureFrame = () => {
      const now = performance.now();
      const delta = now - lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;

      // Store frame times for averaging
      frameTimesRef.current.push(delta);
      if (frameTimesRef.current.length > 60) {
        frameTimesRef.current.shift();
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
        const avgFrameTime =
          frameTimesRef.current.reduce((a, b) => a + b, 0) / frameTimesRef.current.length;
        setFrameTime(Math.round(avgFrameTime * 100) / 100);
        setFps(Math.round(1000 / avgFrameTime));
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
        const stats = await invoke<CacheStats>('get_cache_stats');
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
        const status = await invoke<boolean>('get_network_status');
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
      setZoom(map.getZoom());
      setCenter(map.getCenter());
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

  // Poll tile fetch stats periodically
  useEffect(() => {
    const updateTileStats = () => {
      setTileFetchStats(getTileFetchStats());
    };

    // Initial fetch
    updateTileStats();

    // Poll every 500ms (balances responsiveness vs re-render overhead)
    const interval = setInterval(updateTileStats, 500);

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
  const formatBytes = useCallback((bytes: number): string => {
    const sizes = [
      t('map.devStats.units.bytes'),
      t('map.devStats.units.kilobytes'),
      t('map.devStats.units.megabytes'),
      t('map.devStats.units.gigabytes'),
    ];
    if (bytes === 0) {
      return t('map.devStats.bytesValue', {
        value: formatNumber(0),
        unit: sizes[0],
      });
    }
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return t('map.devStats.bytesValue', {
      value: formatFixed(bytes / Math.pow(k, i), undefined, 1),
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
              {t('map.devStats.zoomLevels', { count: formatNumber(lastZoomLevels) })}
            </span>
          )}
          {worstFrameTime !== null && worstFrameTime > 20 && (
            <span className={`ml-1 ${worstFrameTime > 50 ? 'text-error' : 'text-warning'}`}>
              {t('map.devStats.worstFrame', { ms: formatNumber(worstFrameTime) })}
            </span>
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
                  {t('map.devStats.msaaValue', { count: formatNumber(webglInfo.samples) })}
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
                {t('map.devStats.errors', { count: formatNumber(tileFetchStats.totalErrors) })}
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
            <span className="text-text-primary">{formatNumber(cacheStats.total_tiles)}</span>
            <span className="text-text-secondary opacity-80 ml-2">{t('map.devStats.size')}:</span>{' '}
            <span className="text-text-primary">{formatBytes(cacheStats.total_bytes)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
