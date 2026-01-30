import { useEffect, useState, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import maplibregl from 'maplibre-gl';
import { getTileFetchStats, type TileFetchStats } from '../../utils/tileProtocol';

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
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }, []);

  // Get FPS color based on performance
  const getFpsColor = useCallback((currentFps: number): string => {
    if (currentFps >= 55) return 'text-green-400';
    if (currentFps >= 30) return 'text-yellow-400';
    return 'text-red-400';
  }, []);

  // Get network status indicator
  const getNetworkIndicator = useCallback(() => {
    if (networkStatus === null) return { color: 'text-gray-400', text: 'checking...' };
    if (networkStatus) return { color: 'text-green-400', text: 'online' };
    return { color: 'text-red-400', text: 'offline' };
  }, [networkStatus]);

  const networkIndicator = getNetworkIndicator();

  // Shorten GPU renderer name for display
  const shortRenderer = webglInfo?.renderer
    ? webglInfo.renderer.replace(/ANGLE \(|, .*?\)$/g, '').substring(0, 30)
    : null;

  return (
    <div
      className="absolute bottom-2 right-2 bg-black/85 text-white text-xs font-mono p-2 rounded border border-gray-600 select-none"
      style={{ minWidth: '200px', maxWidth: '280px' }}
      data-testid="map-dev-stats"
    >
      {/* Performance */}
      <div className="mb-1">
        <span className="text-gray-400">FPS:</span>{' '}
        <span className={getFpsColor(fps)}>{fps}</span>
        <span className="text-gray-500 ml-2">({frameTime}ms)</span>
        {isZooming && <span className="text-yellow-400 ml-2">ZOOMING</span>}
      </div>

      {/* Zoom performance (show last zoom stats) */}
      {(zoomFps !== null || lastZoomDuration !== null) && (
        <div className="mb-1 text-[10px]">
          <span className="text-gray-400">Last zoom:</span>{' '}
          {zoomFps !== null && (
            <>
              <span className={getFpsColor(zoomFps)}>{zoomFps} fps</span>
              <span className="text-gray-500 mx-1">|</span>
            </>
          )}
          {lastZoomDuration !== null && (
            <span className="text-white">{lastZoomDuration}ms</span>
          )}
          {lastZoomLevels !== null && (
            <span className="text-gray-500 ml-1">({lastZoomLevels} lvls)</span>
          )}
          {worstFrameTime !== null && worstFrameTime > 20 && (
            <span className={`ml-1 ${worstFrameTime > 50 ? 'text-red-400' : 'text-yellow-400'}`}>
              worst: {worstFrameTime}ms
            </span>
          )}
        </div>
      )}

      {/* Map state */}
      <div className="mb-1">
        <span className="text-gray-400">Map:</span>{' '}
        <span className={mapLoaded ? 'text-green-400' : 'text-yellow-400'}>
          {mapLoaded ? 'loaded' : 'loading'}
        </span>
        <span className="text-gray-500 mx-1">|</span>
        <span className={tilesLoaded ? 'text-green-400' : 'text-yellow-400'}>
          {tilesLoaded ? 'tiles ready' : 'tiles loading'}
        </span>
      </div>

      {/* Zoom and center */}
      <div className="mb-1">
        <span className="text-gray-400">Zoom:</span>{' '}
        <span className="text-white">{zoom.toFixed(2)}</span>
        <span className="text-gray-500 ml-2 text-[10px]">
          {canvasSize.width}x{canvasSize.height}
        </span>
      </div>
      <div className="mb-1 text-gray-500 text-[10px]">
        {center.lng.toFixed(6)}, {center.lat.toFixed(6)}
      </div>

      {/* WebGL Info */}
      {webglInfo && (
        <div className="border-t border-gray-700 pt-1 mt-1">
          <div className="text-gray-400 mb-0.5">WebGL:</div>
          <div className="pl-2 text-[10px] text-gray-500 truncate" title={webglInfo.renderer}>
            {webglInfo.webglVersion} - {shortRenderer}
          </div>
          <div className="pl-2 text-[10px]">
            <span className="text-gray-500">Max tex:</span>{' '}
            <span className="text-white">{webglInfo.maxTextureSize}</span>
            <span className="text-gray-500 ml-2">Units:</span>{' '}
            <span className="text-white">{webglInfo.maxTextureUnits}</span>
          </div>
          <div className="pl-2 text-[10px]">
            <span className="text-gray-500">Color:</span>{' '}
            <span className="text-white">
              {webglInfo.colorBits.r}/{webglInfo.colorBits.g}/{webglInfo.colorBits.b}/{webglInfo.colorBits.a}
            </span>
            <span className="text-gray-500 ml-2">Depth:</span>{' '}
            <span className="text-white">{webglInfo.depthBits}</span>
            {webglInfo.samples > 0 && (
              <>
                <span className="text-gray-500 ml-2">MSAA:</span>{' '}
                <span className="text-green-400">{webglInfo.samples}x</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Debug toggles */}
      <div className="border-t border-gray-700 pt-1 mt-1 pointer-events-auto">
        <div className="text-gray-400 mb-0.5">Debug:</div>
        <div className="pl-2 flex flex-wrap gap-1">
          <button
            onClick={toggleTileBoundaries}
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              showTileBoundaries
                ? 'bg-accent-30 border-accent text-accent'
                : 'bg-gray-800 border-gray-600 text-gray-400 hover:border-gray-500'
            }`}
            title="Show tile boundaries and IDs"
          >
            Tiles
          </button>
          <button
            onClick={toggleCollisionBoxes}
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              showCollisionBoxes
                ? 'bg-accent-30 border-accent text-accent'
                : 'bg-gray-800 border-gray-600 text-gray-400 hover:border-gray-500'
            }`}
            title="Show symbol collision boxes"
          >
            Collision
          </button>
          <button
            onClick={toggleOverdraw}
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              showOverdraw
                ? 'bg-accent-30 border-accent text-accent'
                : 'bg-gray-800 border-gray-600 text-gray-400 hover:border-gray-500'
            }`}
            title="Show overdraw (fragment shader calls)"
          >
            Overdraw
          </button>
          <button
            onClick={toggleSymbols}
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              hideSymbols
                ? 'bg-red-500/30 border-red-500 text-red-400'
                : 'bg-gray-800 border-gray-600 text-gray-400 hover:border-gray-500'
            }`}
            title="Hide all symbol layers (labels) for performance testing"
          >
            {hideSymbols ? 'Labels OFF' : 'Labels'}
          </button>
          <button
            onClick={toggleAllLayers}
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              hideAllLayers
                ? 'bg-red-500/30 border-red-500 text-red-400'
                : 'bg-gray-800 border-gray-600 text-gray-400 hover:border-gray-500'
            }`}
            title="Hide ALL layers (background only) - tests if MapLibre/WebGL is the problem"
          >
            {hideAllLayers ? 'ALL OFF' : 'All Layers'}
          </button>
        </div>
      </div>

      {/* Tile fetch stats */}
      {tileFetchStats && (
        <div className="border-t border-gray-700 pt-1 mt-1">
          <div className="text-gray-400 mb-0.5">Satellite Tiles:</div>
          <div className="pl-2">
            <span className="text-gray-500">In-flight:</span>{' '}
            <span className={tileFetchStats.inFlight > 0 ? 'text-yellow-400' : 'text-green-400'}>
              {tileFetchStats.inFlight}
            </span>
            <span className="text-gray-500 ml-2">Latency:</span>{' '}
            <span className={tileFetchStats.avgLatencyMs > 500 ? 'text-yellow-400' : 'text-white'}>
              {tileFetchStats.avgLatencyMs}ms
            </span>
          </div>
          <div className="pl-2">
            <span className="text-gray-500">Fetched:</span>{' '}
            <span className="text-white">{tileFetchStats.totalFetched}</span>
            {tileFetchStats.totalErrors > 0 && (
              <span className="text-red-400 ml-1">({tileFetchStats.totalErrors} err)</span>
            )}
          </div>
        </div>
      )}

      {/* Network status */}
      <div className="border-t border-gray-700 pt-1 mt-1">
        <span className="text-gray-400">Network:</span>{' '}
        <span className={networkIndicator.color}>{networkIndicator.text}</span>
      </div>

      {/* Cache stats */}
      {cacheStats && (
        <div className="border-t border-gray-700 pt-1 mt-1">
          <div className="text-gray-400 mb-0.5">Cache:</div>
          <div className="pl-2">
            <span className="text-gray-500">Tiles:</span>{' '}
            <span className="text-white">{cacheStats.total_tiles}</span>
            <span className="text-gray-500 ml-2">Size:</span>{' '}
            <span className="text-white">{formatBytes(cacheStats.total_bytes)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
