import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import type { SectionId, ShotId, StationRef } from '../../types/project';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore, type Selection } from '../../store/uiStore';
import {
  getEffectiveShowVirtualShots,
  getEffectiveShowShotData,
} from '../../store/displaySelectors';
import { getBounds, metersToMapCoords, mapCoordsToMeters } from '../../utils/coordinates';
import { registerTileProtocol, unregisterTileProtocol } from '../../utils/tileProtocol';
import { getTileConfig } from '../../utils/tileConfig';
import { useMapTools } from '../../hooks/useMapTools';
import SurveyLayer from './SurveyLayer';
import PlacementOverlay from './PlacementOverlay';
import GridOverlay from './GridOverlay';
import { DepthLegend } from './DepthLegend';
import { MapDevStats } from './MapDevStats';
import { getMapThemeColors } from '../../utils/themeColors';

// Tools that support Ctrl+drag for panning (excludes tools with their own drag behaviors)
const CTRL_PAN_TOOLS = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure'];

interface BoxSelectState {
  start: { x: number; y: number } | null;
  end: { x: number; y: number } | null;
}

interface MoveDragState {
  type: 'section' | 'station' | 'segment' | 'shot';
  sectionId?: number;
  stationRef?: { section_id: number; station_index: number };
  shotIndex?: number;
  connectedSectionIds?: number[];
  startLngLat: { lng: number; lat: number };
  currentLngLat: { lng: number; lat: number };
}

// Helper to convert StationRef to highlight ID format (section_id:station_index)
// Moved outside component to avoid recreating on each render
const stationRefToId = (ref: { section_id: number; station_index: number } | null): string | null => {
  if (!ref) return null;
  return `${ref.section_id}:${ref.station_index}`;
};

export default function MapCanvas() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const surveyLayerRef = useRef<SurveyLayer | null>(null);
  const scaleControlRef = useRef<maplibregl.ScaleControl | null>(null);
  const scaleControlAddedRef = useRef<boolean>(false);
  const [measureResult, setMeasureResult] = useState<{ distance: number; depthDiff: number } | null>(null);
  const [boxSelect, setBoxSelect] = useState<BoxSelectState>({ start: null, end: null });
  const [zoomBox, setZoomBox] = useState<BoxSelectState>({ start: null, end: null });
  const [moveDrag, setMoveDrag] = useState<MoveDragState | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  // Ref to track if we're in a Ctrl+drag operation (to filter spurious keyup events from Tauri/WebKit)
  const ctrlDragActiveRef = useRef(false);
  const [isHoveringFeature, setIsHoveringFeature] = useState(false);
  // Placement mode cursor position (screen pixels)
  const [placementCursor, setPlacementCursor] = useState<{ x: number; y: number } | null>(null);
  // Current map scale in pixels per meter (for to-scale placement preview)
  const [pixelsPerMeter, setPixelsPerMeter] = useState(1);
  // Pending section zoom request (stored when map not loaded, processed when it loads)
  const pendingZoomToSectionRef = useRef<number | null>(null);
  // Pending pan-to-shot request (stored when map not loaded, processed when it loads)
  const pendingPanToShotRef = useRef<{ sectionId: number; shotId: number } | null>(null);
  // Pending center-on-station request (stored when map not loaded, processed when it loads)
  const pendingCenterOnStationRef = useRef<StationRef | null>(null);
  // Pending center-on-shot request (stored when map not loaded, processed when it loads)
  const pendingCenterOnShotRef = useRef<{ sectionId: number; shotId: number } | null>(null);
  // Anchored section IDs (cached when Move Segment tool is active)
  const [anchoredSectionIds, setAnchoredSectionIds] = useState<Set<number>>(new Set());
  // Whether anchored section IDs have been loaded for the current move_segment activation
  // Blocks segment drag until the set is populated to prevent moving anchored segments
  const [anchoredIdsLoaded, setAnchoredIdsLoaded] = useState(false);
  // Segment drag offset for real-time preview (meters)
  const [segmentDragOffset, setSegmentDragOffset] = useState<{ x: number; y: number } | null>(null);
  // Connected section IDs currently being dragged (for segment preview)
  const [dragConnectedSectionIds, setDragConnectedSectionIds] = useState<Set<number>>(new Set());
  // Token to invalidate stale getConnectedSectionIds results (incremented on each drag start,
  // checked in .then()/.catch() to discard late async results after mouseup)
  const segmentDragTokenRef = useRef(0);

  const { project, stations, stats, config, moveSection, moveStation, moveSegment, getConnectedSectionIds, getAnchoredSectionIds, executeBatch } = useProjectStore();

  // Get GPS origin for coordinate transforms (enables satellite tile alignment)
  // Priority: project's zero-datum GPS > config's satellite_gps_origin
  const gpsOrigin = useMemo(() => {
    const zeroDatum = project?.zero_datums?.[0];
    if (zeroDatum?.gps) {
      return { latitude: zeroDatum.gps.latitude, longitude: zeroDatum.gps.longitude };
    }
    return config?.map.satellite_gps_origin ?? null;
  }, [project?.zero_datums, config?.map.satellite_gps_origin]);

  // Extract zoom config values for stable dependencies (used by zoom handlers and effects)
  const zoomStep = config?.map.zoom_step ?? 1.0;
  const zoomMin = config?.map.zoom_min ?? 0;
  const zoomMax = config?.map.zoom_max ?? 22;

  const {
    mapZoom,
    setMapCenter,
    setMapZoom,
    activeTool,
    showSatellite,
    showShotData,
    showScaleBar,
    showSectionNames,
    showStationLabels,
    showStations,
    showShots,
    showVirtualShots,
    showDepthGradient,
    showDevStats,
    selection,
    mergeStationA,
    mergeStationB,
    measureStart,
    measureEnd,
    drawFromStation,
    addToSelection,
    clearSelection,
    clearSelectionByType,
    filterSelection,
    clearMergeStations,
    requestFitToBounds,
    clearFitToBoundsRequest,
    snappedStation,
    setSnappedStation,
    hoveredStation,
    setHoveredStation,
    setHoveredShot,
    hoveredShot,
    hoveredSectionId,
    placementMode,
    updatePlacementCursor,
    updatePlacementSnap,
    cancelPlacementMode,
    confirmPlacement,
    showToast,
    sectionsPanelOpen,
    sectionsPanelWidth,
    detailPanelOpen,
    detailPanelWidth,
    requestZoomToSection,
    clearZoomToSectionRequest,
    requestPanToShot,
    clearPanToShotRequest,
    requestCenterOnStation,
    clearCenterOnStationRequest,
    requestCenterOnShot,
    clearCenterOnShotRequest,
    resolvedTheme,
  } = useUIStore();

  // Snap-to-station detection
  // Note: Snap detection works even when stations are hidden - the highlight layer
  // will show the snapped station. Merge tool is an exception (blocked when hidden).
  const checkSnapToStation = useCallback(
    (screenX: number, screenY: number) => {
      if (!map.current || !config) {
        setSnappedStation(null);
        return;
      }

      // Check if snap is enabled for the current tool
      // Note: Merge requires stations to be visible (can't select merge targets when hidden)
      const snapConfig = config.map.snap;
      const shouldSnap =
        (activeTool === 'draw' && snapConfig.enabled_draw) ||
        (activeTool === 'merge' && snapConfig.enabled_merge && showStations) ||
        (activeTool === 'measure' && snapConfig.enabled_measure);

      if (!shouldSnap) {
        setSnappedStation(null);
        return;
      }

      const threshold = snapConfig.threshold;
      let nearestStation = null;
      let nearestDistance = Infinity;

      // Check each station's screen position
      for (const station of stations) {
        const mapCoords = metersToMapCoords(station.coordinates.x, station.coordinates.y, gpsOrigin);
        const screenPos = map.current.project(mapCoords as [number, number]);

        const dx = screenPos.x - screenX;
        const dy = screenPos.y - screenY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < threshold && distance < nearestDistance) {
          nearestDistance = distance;
          nearestStation = station.station_ref;
        }
      }

      // Update snapped station state
      if (nearestStation) {
        // Only update if different from current
        if (
          !snappedStation ||
          snappedStation.section_id !== nearestStation.section_id ||
          snappedStation.station_index !== nearestStation.station_index
        ) {
          setSnappedStation(nearestStation);
        }
      } else if (snappedStation) {
        setSnappedStation(null);
      }
    },
    [activeTool, config, stations, snappedStation, setSnappedStation, showStations]
  );

  // Check snap for placement mode
  const checkPlacementSnap = useCallback(
    (screenX: number, screenY: number) => {
      if (!map.current || !config || !placementMode) {
        return null;
      }

      const threshold = config.map.snap.threshold;
      let nearestStation = null;
      let nearestDistance = Infinity;

      // Check each existing station's screen position
      for (const station of stations) {
        const mapCoords = metersToMapCoords(station.coordinates.x, station.coordinates.y, gpsOrigin);
        const screenPos = map.current.project(mapCoords as [number, number]);

        const dx = screenPos.x - screenX;
        const dy = screenPos.y - screenY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < threshold && distance < nearestDistance) {
          nearestDistance = distance;
          nearestStation = station.station_ref;
        }
      }

      return nearestStation;
    },
    [config, stations, placementMode]
  );

  // Handle placement confirmation
  const handlePlacementConfirm = useCallback(() => {
    if (!map.current || !placementMode || !mapContainer.current) return;

    const placement = confirmPlacement();
    if (!placement || !placement.cursorPosition) return;

    // If there's a callback, call it with the result
    // The caller is responsible for what to do with the placement
    if (placement.onComplete) {
      placement.onComplete({
        position: placement.cursorPosition,
        snappedToStation: placement.snappedToStation,
      });
    }

    setPlacementCursor(null);
  }, [placementMode, confirmPlacement]);

  // Handle placement cancel
  const handlePlacementCancel = useCallback(() => {
    // Get the onCancel callback before canceling
    const onCancel = placementMode?.onCancel;
    cancelPlacementMode();
    setPlacementCursor(null);
    // Call the cancel callback if provided
    if (onCancel) {
      onCancel();
    }
  }, [placementMode, cancelPlacementMode]);

  // Clear snap when tool changes to non-snap tool
  useEffect(() => {
    const isSnapTool = activeTool === 'draw' || activeTool === 'merge' || activeTool === 'measure';
    if (!isSnapTool && snappedStation) {
      setSnappedStation(null);
    }
  }, [activeTool, snappedStation, setSnappedStation]);

  // Handle move drag start from SurveyLayer
  const handleMoveDragStart = useCallback(
    (data: { type: 'section' | 'station' | 'segment' | 'shot'; sectionId?: number; stationRef?: { section_id: number; station_index: number }; shotIndex?: number; screenX?: number; screenY?: number }) => {
      if (!map.current) return;

      // Use actual click position if available, otherwise fall back to map center
      let startLng: number, startLat: number;
      if (data.screenX !== undefined && data.screenY !== undefined) {
        // Convert screen coordinates relative to map container
        const rect = map.current.getCanvas().getBoundingClientRect();
        const lngLat = map.current.unproject([data.screenX - rect.left, data.screenY - rect.top]);
        startLng = lngLat.lng;
        startLat = lngLat.lat;
      } else {
        const center = map.current.getCenter();
        startLng = center.lng;
        startLat = center.lat;
      }
      const baseDragState: MoveDragState = {
        type: data.type,
        startLngLat: { lng: startLng, lat: startLat },
        currentLngLat: { lng: startLng, lat: startLat },
      };

      // Build the drag state conditionally to avoid undefined values
      if (data.type === 'section' && data.sectionId !== undefined) {
        setMoveDrag({ ...baseDragState, type: 'section', sectionId: data.sectionId });
      } else if (data.type === 'station' && data.stationRef !== undefined) {
        setMoveDrag({ ...baseDragState, type: 'station', stationRef: data.stationRef });
      } else if (data.type === 'segment' && data.sectionId !== undefined) {
        const segmentSectionId = data.sectionId;
        // Block segment drag until anchored IDs have been fetched (prevents
        // moving anchored segments during the window after tool activation)
        if (!anchoredIdsLoaded) return;
        // Check if section is anchored — silent no-op if so
        if (anchoredSectionIds.has(segmentSectionId)) return;

        // Set a pending drag token to detect stale async results
        const dragToken = ++segmentDragTokenRef.current;

        // Fetch connected section IDs at drag start
        getConnectedSectionIds(segmentSectionId).then((ids) => {
          // Discard late results if a newer drag started or drag was cancelled
          if (segmentDragTokenRef.current !== dragToken) return;

          // Filter out anchored sections
          const movable = ids.filter((id) => !anchoredSectionIds.has(id));
          const connectedSet = new Set(movable);
          setDragConnectedSectionIds(connectedSet);
          setMoveDrag({
            ...baseDragState,
            type: 'segment',
            sectionId: segmentSectionId,
            connectedSectionIds: movable,
          });
        }).catch(() => {
          // Discard late results if a newer drag started or drag was cancelled
          if (segmentDragTokenRef.current !== dragToken) return;

          // On failure, just move the single section
          setDragConnectedSectionIds(new Set([segmentSectionId]));
          setMoveDrag({
            ...baseDragState,
            type: 'segment',
            sectionId: segmentSectionId,
            connectedSectionIds: [segmentSectionId],
          });
        });
      } else if (data.type === 'shot' && data.sectionId !== undefined && data.shotIndex !== undefined) {
        setMoveDrag({
          ...baseDragState,
          type: 'shot',
          sectionId: data.sectionId,
          shotIndex: data.shotIndex,
        });
      }
    },
    [anchoredSectionIds, anchoredIdsLoaded, getConnectedSectionIds]
  );

  // Get map tool callbacks
  const baseToolCallbacks = useMapTools({
    onMeasureComplete: (distance, depthDiff) => {
      setMeasureResult({ distance, depthDiff });
      // Clear after a few seconds
      setTimeout(() => setMeasureResult(null), 5000);
    },
    onMoveDragStart: handleMoveDragStart,
    onFeatureHover: setIsHoveringFeature,
  });

  // Combine with hidden feature callbacks for toast feedback
  const toolCallbacks = useMemo(() => ({
    ...baseToolCallbacks,
    onHiddenStationClick: () => {
      showToast("Enable 'Stations' in Display menu to interact with station markers", 'stations-hidden');
    },
    onHiddenShotClick: () => {
      showToast("Enable 'Shots' in Display menu to interact with shot lines", 'shots-hidden');
    },
  }), [baseToolCallbacks, showToast]);

  // Box select handlers
  const handleBoxSelectStart = useCallback(
    (e: React.MouseEvent) => {
      if (activeTool !== 'select') return;
      if (!mapContainer.current) return;

      // Only start box select on left click and not on a feature
      if (e.button !== 0) return;

      // Don't start box select when Ctrl is held (Ctrl+drag is for panning)
      // Use e.ctrlKey directly instead of state to avoid timing issues
      if (e.ctrlKey) return;

      const rect = mapContainer.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setBoxSelect({ start: { x, y }, end: { x, y } });
    },
    [activeTool]
  );

  const handleBoxSelectMove = useCallback(
    (e: React.MouseEvent) => {
      if (!boxSelect.start || !mapContainer.current) return;

      const rect = mapContainer.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setBoxSelect((prev) => ({ ...prev, end: { x, y } }));
    },
    [boxSelect.start]
  );

  const handleBoxSelectEnd = useCallback(() => {
    if (!boxSelect.start || !boxSelect.end || !map.current) {
      setBoxSelect({ start: null, end: null });
      return;
    }

    // Calculate selection box bounds in map coordinates
    const minX = Math.min(boxSelect.start.x, boxSelect.end.x);
    const maxX = Math.max(boxSelect.start.x, boxSelect.end.x);
    const minY = Math.min(boxSelect.start.y, boxSelect.end.y);
    const maxY = Math.max(boxSelect.start.y, boxSelect.end.y);

    // Only process if box is large enough (not just a click)
    if (maxX - minX > 5 && maxY - minY > 5) {
      // Query stations in the box using hitbox layer (larger clickable area)
      const features = map.current.queryRenderedFeatures(
        [[minX, minY], [maxX, maxY]],
        { layers: ['survey-stations-hitbox'] }
      );

      if (features.length > 0) {
        // Clear existing selection if not holding shift
        clearSelection();

        // Add all stations in box to selection
        features.forEach((feature) => {
          if (feature.properties) {
            const { sectionId, stationIndex } = feature.properties;
            const sel: Selection = {
              type: 'station',
              stationRef: {
                section_id: sectionId as number,
                station_index: stationIndex as number,
              },
            };
            addToSelection(sel);
          }
        });
      }
    }

    setBoxSelect({ start: null, end: null });
  }, [boxSelect, clearSelection, addToSelection]);

  // Zoom box handlers (for click-to-zoom and box zoom in task 3)
  const handleZoomBoxStart = useCallback(
    (e: React.MouseEvent) => {
      if (activeTool !== 'zoom') return;
      if (!mapContainer.current) return;

      // Only start on left click, not when Ctrl is held (Ctrl+drag is for panning)
      if (e.button !== 0 || e.ctrlKey) return;

      const rect = mapContainer.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setZoomBox({ start: { x, y }, end: { x, y } });
    },
    [activeTool]
  );

  const handleZoomBoxMove = useCallback(
    (e: React.MouseEvent) => {
      if (!zoomBox.start || !mapContainer.current) return;
      // Only update if left mouse button is still pressed (prevents stuck state on focus loss)
      if (e.buttons !== 1) return;

      const rect = mapContainer.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setZoomBox((prev) => ({ ...prev, end: { x, y } }));
    },
    [zoomBox.start]
  );

  const handleZoomBoxEnd = useCallback(() => {
    if (!zoomBox.start || !zoomBox.end || !map.current) {
      setZoomBox({ start: null, end: null });
      return;
    }

    const minX = Math.min(zoomBox.start.x, zoomBox.end.x);
    const maxX = Math.max(zoomBox.start.x, zoomBox.end.x);
    const minY = Math.min(zoomBox.start.y, zoomBox.end.y);
    const maxY = Math.max(zoomBox.start.y, zoomBox.end.y);

    // For small drags (<10px), treat as click-to-zoom
    if (maxX - minX < 10 || maxY - minY < 10) {
      // Click zoom-in at center of box (effectively the click point)
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const clickLngLat = map.current.unproject([centerX, centerY]);

      const currentZoom = map.current.getZoom();
      const targetZoom = Math.min(zoomMax, currentZoom + zoomStep);

      if (targetZoom !== currentZoom) {
        map.current.easeTo({
          center: clickLngLat,
          zoom: targetZoom,
          duration: 300,
        });
      }
    } else {
      // Large drag: box zoom to bounds
      // Note: Y is inverted in screen coords (top=0)
      const sw = map.current.unproject([minX, maxY]); // bottom-left screen = SW
      const ne = map.current.unproject([maxX, minY]); // top-right screen = NE

      map.current.fitBounds([sw, ne], {
        padding: 20,
        linear: true,
        duration: 300,
        maxZoom: zoomMax,
      });
    }

    setZoomBox({ start: null, end: null });
  }, [zoomBox, zoomStep, zoomMax]);

  // Move drag handlers
  const handleMoveDragMove = useCallback(
    (e: React.MouseEvent) => {
      if (!moveDrag || !map.current || !mapContainer.current) return;

      const rect = mapContainer.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Convert screen coords to map coords
      const lngLat = map.current.unproject([x, y]);

      setMoveDrag((prev) =>
        prev ? { ...prev, currentLngLat: { lng: lngLat.lng, lat: lngLat.lat } } : null
      );

      // Compute drag offset in meters for segment preview
      if (moveDrag.type === 'segment') {
        const startMeters = mapCoordsToMeters(moveDrag.startLngLat.lng, moveDrag.startLngLat.lat, gpsOrigin);
        const currentMeters = mapCoordsToMeters(lngLat.lng, lngLat.lat, gpsOrigin);
        setSegmentDragOffset({
          x: currentMeters.x - startMeters.x,
          y: currentMeters.y - startMeters.y,
        });
      }
    },
    [moveDrag, gpsOrigin]
  );

  const handleMoveDragEnd = useCallback(async () => {
    // Invalidate any pending getConnectedSectionIds async results so late
    // .then() callbacks cannot call setMoveDrag after drag has ended.
    segmentDragTokenRef.current++;

    if (!moveDrag || !map.current) {
      setMoveDrag(null);
      setSegmentDragOffset(null);
      setDragConnectedSectionIds(new Set());
      return;
    }

    // Clear segment preview state before committing
    setSegmentDragOffset(null);
    setDragConnectedSectionIds(new Set());

    // Convert drag start/end from map lng/lat to meters, then compute delta
    const startMeters = mapCoordsToMeters(moveDrag.startLngLat.lng, moveDrag.startLngLat.lat, gpsOrigin);
    const endMeters = mapCoordsToMeters(moveDrag.currentLngLat.lng, moveDrag.currentLngLat.lat, gpsOrigin);
    const dx = endMeters.x - startMeters.x;
    const dy = endMeters.y - startMeters.y;

    // Only process if there's a meaningful movement (1mm threshold)
    if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
      const offset = { x: dx, y: dy, z: 0 };

      if (moveDrag.type === 'section' && moveDrag.sectionId !== undefined) {
        await moveSection(moveDrag.sectionId, offset);
      } else if (moveDrag.type === 'station' && moveDrag.stationRef) {
        await moveStation(moveDrag.stationRef, offset);
      } else if (moveDrag.type === 'segment' && moveDrag.sectionId !== undefined) {
        await moveSegment(moveDrag.sectionId, offset);
      } else if (moveDrag.type === 'shot' && moveDrag.sectionId !== undefined && moveDrag.shotIndex !== undefined) {
        // Move both stations atomically via executeBatch
        const fromRef = { section_id: moveDrag.sectionId, station_index: moveDrag.shotIndex };
        const toRef = { section_id: moveDrag.sectionId, station_index: moveDrag.shotIndex + 1 };
        await executeBatch([
          { type: 'move_station', station_ref: fromRef, offset },
          { type: 'move_station', station_ref: toRef, offset },
        ]);
      }
    }

    setMoveDrag(null);
  }, [moveDrag, moveSection, moveStation, moveSegment, executeBatch, gpsOrigin]);

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    // Calculate initial center from stations (in meters)
    const coords = stations.map((s) => s.coordinates);
    const bounds = getBounds(coords);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    // Transform to map coordinates
    const mapCenter = metersToMapCoords(centerX, centerY, gpsOrigin);

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        // Use OpenMapTiles fonts for text labels
        glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
        sources: {},
        layers: [
          {
            id: 'background',
            type: 'background',
            paint: {
              'background-color': config?.display.default_background ?? getMapThemeColors().background,
            },
          },
        ],
      },
      center: mapCenter,
      zoom: mapZoom,
      attributionControl: false,
      // Disable built-in keyboard zoom (handled by useKeyboardShortcuts with config.map.zoom_step)
      keyboard: false,

      // Performance optimizations
      // See: https://deepwiki.com/maplibre/maplibre-gl-js/5.2-performance-optimization-techniques
      maxTileCacheSize: 100, // Limit tile cache memory
      maxTileCacheZoomLevels: 5, // Limit zoom range caching
      fadeDuration: 0, // Disable fade animations for snappier response
      renderWorldCopies: false, // Not needed for cave maps (saves render work)

      // WebGL context optimizations (MapLibre v5+)
      // Type assertion needed: canvasContextAttributes is supported at runtime
      // but not yet in the MapLibre GL JS TypeScript definitions
      ...({
        canvasContextAttributes: {
          antialias: false, // Disable AA for better performance
          preserveDrawingBuffer: false, // Allow buffer discard
          failIfMajorPerformanceCaveat: false, // Don't fail on software renderer
        },
      } as Record<string, unknown>),
    });

    // Disable rotation (Ctrl+drag rotates by default, we want Ctrl+drag to pan)
    map.current.dragRotate.disable();
    map.current.touchPitch.disable();
    // Disable box zoom (Ctrl+drag draws selection box by default, we want Ctrl+drag to pan)
    map.current.boxZoom.disable();

    // Add navigation controls
    map.current.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      'top-right'
    );

    // Create scale control instance (will be added/removed based on showScaleBar state)
    scaleControlRef.current = new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' });

    // Track map movement
    map.current.on('move', () => {
      if (!map.current) return;
      const center = map.current.getCenter();
      setMapCenter([center.lng, center.lat]);
    });

    map.current.on('zoom', () => {
      if (!map.current) return;
      setMapZoom(map.current.getZoom());
      // Calculate pixels per meter at current zoom
      // Use map center to project 1 meter difference
      const center = map.current.getCenter();
      const centerScreen = map.current.project(center);
      // Point 1 meter north in map coordinates (1 meter = 1/111320 degrees)
      const northPoint = map.current.project([center.lng, center.lat + 1 / 111320]);
      const ppm = Math.abs(centerScreen.y - northPoint.y);
      setPixelsPerMeter(ppm > 0 ? ppm : 1);
    });

    // Initialize survey layer
    map.current.on('load', () => {
      if (!map.current) return;
      surveyLayerRef.current = new SurveyLayer(map.current, toolCallbacks);
      // Set initial tool immediately after creating SurveyLayer
      surveyLayerRef.current.setActiveTool(useUIStore.getState().activeTool);
      setMapLoaded(true);
      // Initialize pixels per meter
      const center = map.current.getCenter();
      const centerScreen = map.current.project(center);
      const northPoint = map.current.project([center.lng, center.lat + 1 / 111320]);
      const ppm = Math.abs(centerScreen.y - northPoint.y);
      setPixelsPerMeter(ppm > 0 ? ppm : 1);
    });

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Register custom tile protocol for offline caching
  // Uses ref-counted registration to safely handle multiple map instances
  useEffect(() => {
    registerTileProtocol();
    return () => {
      unregisterTileProtocol();
    };
  }, []);

  // Expose map instance for E2E testing and keyboard shortcuts
  useEffect(() => {
    if (map.current) {
      (window as unknown as { __cavechef_map__?: maplibregl.Map }).__cavechef_map__ = map.current;
    }
    return () => {
      delete (window as unknown as { __cavechef_map__?: maplibregl.Map }).__cavechef_map__;
    };
  }, [mapLoaded]);

  // Update survey layer when data changes or map loads
  useEffect(() => {
    if (surveyLayerRef.current && project) {
      surveyLayerRef.current.update(
        project.sections,
        stations,
        project.loop_closures,
        gpsOrigin,
        showDepthGradient,
        { min: stats?.min_depth ?? 0, max: stats?.max_depth ?? 50 }
      );
    }
  }, [project, stations, mapLoaded, gpsOrigin, showDepthGradient, stats?.min_depth, stats?.max_depth]);

  // Update callbacks when they change
  useEffect(() => {
    if (surveyLayerRef.current) {
      surveyLayerRef.current.setCallbacks(toolCallbacks);
    }
  }, [toolCallbacks]);

  // Sync config with SurveyLayer for visual and hitbox layer updates
  useEffect(() => {
    if (surveyLayerRef.current && config) {
      surveyLayerRef.current.setConfig(config);
    }
  }, [config, mapLoaded]);

  // Apply theme colors to SurveyLayer and map background when resolvedTheme changes
  // MapLibre GL JS does NOT read CSS variables — colors must be re-applied explicitly
  useEffect(() => {
    const colors = getMapThemeColors();
    if (surveyLayerRef.current) {
      surveyLayerRef.current.applyThemeColors(colors);
    }
    // Re-apply map background color (only if no custom color is configured)
    if (map.current && mapLoaded && !config?.display.default_background) {
      map.current.setPaintProperty('background', 'background-color', colors.background);
    }
  }, [resolvedTheme, mapLoaded, config?.display.default_background]);

  // Sync selection state with SurveyLayer for visual feedback
  useEffect(() => {
    if (!surveyLayerRef.current) return;

    if (selection?.type === 'station' && selection.stationRef) {
      surveyLayerRef.current.setSelectedStation(selection.stationRef);
      surveyLayerRef.current.setSelectedShot(null, null);
      surveyLayerRef.current.setSelectedSection(null);
    } else if (selection?.type === 'shot' && selection.sectionId !== undefined && selection.shotId !== undefined) {
      surveyLayerRef.current.setSelectedStation(null);
      surveyLayerRef.current.setSelectedShot(selection.sectionId, selection.shotId);
      surveyLayerRef.current.setSelectedSection(null);
    } else if (selection?.type === 'section' && selection.sectionId !== undefined) {
      // Section selection
      surveyLayerRef.current.setSelectedStation(null);
      surveyLayerRef.current.setSelectedShot(null, null);
      surveyLayerRef.current.setSelectedSection(selection.sectionId);
    } else {
      surveyLayerRef.current.setSelectedStation(null);
      surveyLayerRef.current.setSelectedShot(null, null);
      surveyLayerRef.current.setSelectedSection(null);
    }
  }, [selection]);

  // Sync snapped station with SurveyLayer for snap indicator
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    surveyLayerRef.current.setSnappedStation(snappedStation);
  }, [snappedStation]);

  // Sync hoveredSectionId from uiStore to SurveyLayer
  // Depends on mapLoaded to re-run when SurveyLayer becomes available
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    surveyLayerRef.current.setHoveredSection(hoveredSectionId);
  }, [hoveredSectionId, mapLoaded]);

  // Sync hoveredShot from uiStore to SurveyLayer (for DataTable row hover)
  // Depends on mapLoaded to re-run when SurveyLayer becomes available
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    surveyLayerRef.current.setHoveredShot(
      hoveredShot?.sectionId ?? null,
      hoveredShot?.shotId ?? null
    );
  }, [hoveredShot, mapLoaded]);

  // Sync hoveredStation from uiStore to SurveyLayer (for DetailLink hover)
  // Depends on mapLoaded to re-run when SurveyLayer becomes available
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    surveyLayerRef.current.setHoveredStation(hoveredStation);
  }, [hoveredStation, mapLoaded]);

  // Sync highlight layer with snap/draw/merge state
  // Shows snapped/origin stations even when stations layer is hidden
  useEffect(() => {
    if (!surveyLayerRef.current) return;

    const highlightIds: string[] = [];

    const snappedId = stationRefToId(snappedStation);
    if (snappedId) highlightIds.push(snappedId);

    const drawId = stationRefToId(drawFromStation);
    if (drawId && !highlightIds.includes(drawId)) highlightIds.push(drawId);

    const mergeAId = stationRefToId(mergeStationA);
    if (mergeAId && !highlightIds.includes(mergeAId)) highlightIds.push(mergeAId);

    const mergeBId = stationRefToId(mergeStationB);
    if (mergeBId && !highlightIds.includes(mergeBId)) highlightIds.push(mergeBId);

    surveyLayerRef.current.setHighlightedStations(highlightIds);
  }, [snappedStation, drawFromStation, mergeStationA, mergeStationB, mapLoaded]);

  // Sync shot data labels visibility with SurveyLayer (gated by showShots)
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    surveyLayerRef.current.setShowShotLabels(getEffectiveShowShotData(showShots, showShotData));
  }, [showShotData, showShots, mapLoaded]);

  // Sync section name labels visibility with SurveyLayer
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    surveyLayerRef.current.setShowSectionNames(showSectionNames);
  }, [showSectionNames, mapLoaded]);

  // Sync station index labels visibility with SurveyLayer
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    surveyLayerRef.current.setShowStationLabels(showStationLabels);
  }, [showStationLabels, mapLoaded]);

  // Sync stations visibility with SurveyLayer
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    surveyLayerRef.current.setShowStations(showStations);
  }, [showStations, mapLoaded]);

  // Sync shots visibility with SurveyLayer
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    surveyLayerRef.current.setShowShots(showShots);
  }, [showShots, mapLoaded]);

  // Sync virtual shots visibility with SurveyLayer (gated by showShots)
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    surveyLayerRef.current.setShowVirtualShots(getEffectiveShowVirtualShots(showShots, showVirtualShots));
  }, [showVirtualShots, showShots, mapLoaded]);

  // Sync anchored section IDs with SurveyLayer for fading
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    surveyLayerRef.current.setAnchoredSections(anchoredSectionIds);
  }, [anchoredSectionIds, mapLoaded]);

  // Sync segment drag preview with SurveyLayer for real-time visual offset
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    if (segmentDragOffset && dragConnectedSectionIds.size > 0) {
      // Convert meter offset to map coordinate offset
      // metersToMapCoords uses a linear scale: 1 meter = 1/111320 degrees at equator
      // We need to compute the delta in lng/lat that corresponds to the meter offset
      const originCoords = metersToMapCoords(0, 0, gpsOrigin);
      const offsetCoords = metersToMapCoords(segmentDragOffset.x, segmentDragOffset.y, gpsOrigin);
      const dLng = offsetCoords[0] - originCoords[0];
      const dLat = offsetCoords[1] - originCoords[1];
      surveyLayerRef.current.setSegmentDragPreview(dragConnectedSectionIds, dLng, dLat);
    } else {
      surveyLayerRef.current.setSegmentDragPreview(new Set(), 0, 0);
    }
  }, [segmentDragOffset, dragConnectedSectionIds, gpsOrigin, mapLoaded]);

  // Clear station selection, hover, and cancel merge when stations hidden
  // Note: Draw/Measure/Snap operations continue to work - highlight layer shows snapped stations
  useEffect(() => {
    if (!showStations) {
      // Clear station selection and hover (these require visible stations to interact)
      clearSelectionByType('station');
      setHoveredStation(null);
      surveyLayerRef.current?.clearStationHover();
      // Cancel merge (requires visible stations to select targets)
      clearMergeStations();
      // Cancel placement mode properly (calls onCancel callback and clears cursor)
      if (placementMode) {
        handlePlacementCancel();
      }
      // Note: Do NOT clear drawFromStation, snappedStation, or measure state
      // These operations work with hidden stations - highlight layer shows them
    }
  }, [showStations, clearSelectionByType, setHoveredStation, clearMergeStations, placementMode, handlePlacementCancel]);

  // Clear shot selection and hover when shots visibility changes to OFF
  useEffect(() => {
    if (!showShots) {
      clearSelectionByType('shot');
      setHoveredShot(null);
      surveyLayerRef.current?.clearShotHover();
    }
  }, [showShots, clearSelectionByType, setHoveredShot]);

  // Clear virtual shot selection when virtual shots visibility changes to OFF
  // Uses composite identity (file_path or created_at) since Project type has no id field
  const projectIdentity = project?.file_path ?? project?.created_at;
  useEffect(() => {
    if (!showVirtualShots && project?.sections) {
      filterSelection((s) => {
        if (s.type !== 'shot') return true;
        const section = project.sections.find((sec) => sec.id === s.sectionId);
        const shot = section?.shots.find((sh) => sh.id === s.shotId);
        return !shot?.is_virtual;
      });
      surveyLayerRef.current?.clearShotHover();
      setHoveredShot(null);
    }
  }, [showVirtualShots, projectIdentity, filterSelection, setHoveredShot]);

  // Handle scale bar toggle
  useEffect(() => {
    if (!map.current || !scaleControlRef.current || !mapLoaded) return;

    try {
      if (showScaleBar && !scaleControlAddedRef.current) {
        map.current.addControl(scaleControlRef.current, 'bottom-left');
        scaleControlAddedRef.current = true;
      } else if (!showScaleBar && scaleControlAddedRef.current) {
        map.current.removeControl(scaleControlRef.current);
        scaleControlAddedRef.current = false;
      }
    } catch (e) {
      // Control may not be in a state to be added/removed - ignore errors
      console.warn('[MapCanvas] Scale control toggle error:', e);
    }
  }, [showScaleBar, mapLoaded]);

  // Update cursor based on tool (and Ctrl state for select mode)
  useEffect(() => {
    if (!map.current) return;

    // Placement mode manages its own cursor - don't override
    if (placementMode) return;

    const cursors: Record<string, string> = {
      select: 'default',
      pan: 'grab',
      zoom: 'zoom-in',
      draw: 'crosshair',
      delete: 'not-allowed',
      merge: 'cell',
      measure: 'crosshair',
      move_section: 'move',
      move_station: 'move',
      move_segment: 'move',
      move_shot: 'move',
    };

    // If hovering over a feature, SurveyLayer sets cursor to 'pointer'
    // Otherwise, set cursor based on active tool
    // Force zoom-in cursor for zoom tool even when hovering over features
    if (!isHoveringFeature || activeTool === 'zoom') {
      // In supported tools with Ctrl held, show grab cursor for panning
      if (CTRL_PAN_TOOLS.includes(activeTool) && ctrlHeld) {
        map.current.getCanvas().style.cursor = 'grab';
      } else {
        map.current.getCanvas().style.cursor = cursors[activeTool] ?? 'default';
      }
    }
  }, [activeTool, ctrlHeld, isHoveringFeature, placementMode]);

  // Disable map drag pan for tools that need custom interaction
  // (Ctrl+drag panning is handled by custom implementation, not dragPan)
  useEffect(() => {
    if (!map.current) return;

    const noPanTools = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure', 'move_section', 'move_station', 'move_segment', 'move_shot'];

    if (noPanTools.includes(activeTool)) {
      map.current.dragPan.disable();
    } else {
      map.current.dragPan.enable();
    }
  }, [activeTool]);

  // Toggle doubleClickZoom based on active tool (disable for zoom tool, enable otherwise)
  useEffect(() => {
    if (!map.current) return;
    if (activeTool === 'zoom') {
      map.current.doubleClickZoom.disable();
    } else {
      map.current.doubleClickZoom.enable();
    }
  }, [activeTool]);

  // Fetch anchored section IDs when Move Segment tool becomes active.
  // Sets anchoredIdsLoaded=false immediately on activation, then true once fetched,
  // so drag start is blocked until the anchored set is populated.
  // Uses a cancelled flag to ignore stale results from late promise resolution
  // when activeTool or project changes before the fetch completes.
  useEffect(() => {
    let cancelled = false;
    if (activeTool === 'move_segment') {
      setAnchoredIdsLoaded(false);
      getAnchoredSectionIds().then((ids) => {
        if (cancelled) return;
        setAnchoredSectionIds(new Set(ids));
        setAnchoredIdsLoaded(true);
      }).catch(() => {
        if (cancelled) return;
        // Fail closed: keep anchoredIdsLoaded=false so segment drag remains blocked.
        // This prevents moving anchored segments when the IPC fails.
        setAnchoredSectionIds(new Set());
        showToast('Failed to load anchored segments. Move Segment is temporarily blocked.', 'anchored-ids-error');
      });
    } else {
      setAnchoredSectionIds(new Set());
      setAnchoredIdsLoaded(false);
    }
    return () => { cancelled = true; };
  }, [activeTool, getAnchoredSectionIds, project, showToast]);

  // Wire up setActiveTool - depend on mapLoaded to ensure it runs after layer creation
  useEffect(() => {
    if (surveyLayerRef.current) {
      surveyLayerRef.current.setActiveTool(activeTool);
    }
  }, [activeTool, mapLoaded]);

  // Set map zoom limits from config
  useEffect(() => {
    if (!map.current || !config) return;
    map.current.setMinZoom(config.map.zoom_min ?? 0);
    map.current.setMaxZoom(config.map.zoom_max ?? 22);
  }, [config]);

  // Track Ctrl key for cursor updates and box/zoom select cancellation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control' && !e.repeat) {
        setCtrlHeld(true);

        // Cancel any active box select or zoom box when Ctrl is pressed (mid-drag Ctrl converts to pan)
        setBoxSelect({ start: null, end: null });
        setZoomBox({ start: null, end: null });
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') {
        // WORKAROUND: Tauri/WebKit fires spurious keyup events when clicking while holding Ctrl
        // If we're in an active Ctrl+drag, ignore the keyup
        if (ctrlDragActiveRef.current) {
          return;
        }
        setCtrlHeld(false);
      }
    };
    // Also handle window blur (Ctrl held, switch windows, release outside)
    const handleBlur = () => {
      ctrlDragActiveRef.current = false;
      setCtrlHeld(false);
      // Cancel any active box select or zoom box
      setBoxSelect({ start: null, end: null });
      setZoomBox({ start: null, end: null });
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  // Escape key cancels zoom box drag
  useEffect(() => {
    if (!zoomBox.start) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setZoomBox({ start: null, end: null });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [zoomBox.start]);

  // Custom Ctrl+drag panning implementation
  // MapLibre's dragPan doesn't work reliably with Ctrl modifier in Tauri/WebKit,
  // so we implement our own panning by tracking mouse movement and calling panBy() directly
  useEffect(() => {
    const mapElement = mapContainer.current;
    if (!mapElement) return;

    // Track drag start position for custom panning
    let ctrlPanStart: { x: number; y: number } | null = null;

    const handleMouseDownCapture = (e: MouseEvent) => {
      if (e.ctrlKey && CTRL_PAN_TOOLS.includes(activeTool) && map.current) {
        // Mark that we're starting a Ctrl+drag (to filter spurious keyup events from Tauri/WebKit)
        ctrlDragActiveRef.current = true;
        ctrlPanStart = { x: e.clientX, y: e.clientY };

        // Change cursor to indicate panning
        map.current.getCanvas().style.cursor = 'grabbing';
      }
    };

    // Implement custom panning since MapLibre's dragPan doesn't work reliably with Ctrl modifier in Tauri/WebKit
    const handleMouseMoveCapture = (e: MouseEvent) => {
      if (ctrlPanStart && e.buttons === 1 && map.current) {
        const dx = e.clientX - ctrlPanStart.x;
        const dy = e.clientY - ctrlPanStart.y;

        // Pan the map by the delta (negative because we're dragging the "ground")
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          map.current.panBy([-dx, -dy], { animate: false });
          ctrlPanStart = { x: e.clientX, y: e.clientY };
        }
      }
    };

    const handleMouseUpCapture = (e: MouseEvent) => {
      if (ctrlPanStart && map.current) {
        ctrlPanStart = null;
        // Restore cursor: if Ctrl still held, show grab cursor for next potential pan
        // Otherwise restore the tool cursor
        if (e.ctrlKey && CTRL_PAN_TOOLS.includes(activeTool)) {
          map.current.getCanvas().style.cursor = 'grab';
        } else {
          const cursors: Record<string, string> = {
            select: 'default',
            pan: 'grab',
            zoom: 'zoom-in',
            draw: 'crosshair',
            delete: 'not-allowed',
            merge: 'cell',
            measure: 'crosshair',
            move_section: 'move',
            move_station: 'move',
            move_segment: 'move',
            move_shot: 'move',
          };
          map.current.getCanvas().style.cursor = cursors[activeTool] ?? 'default';
        }
      }
    };

    // Track if mouse is currently down (for filtering spurious keyup)
    let mouseIsDown = false;

    const handleMouseDownGlobal = () => {
      mouseIsDown = true;
    };

    const handleMouseUpGlobal = () => {
      mouseIsDown = false;
      // When mouse is released, clear the ctrlDragActive flag after a small delay
      // to allow any final spurious keyup events from Tauri/WebKit to be filtered
      if (ctrlDragActiveRef.current) {
        setTimeout(() => {
          // Only clear if mouse is still up (not in a new drag)
          if (!mouseIsDown) {
            ctrlDragActiveRef.current = false;
          }
        }, 50);
      }
    };

    // Use capture: true to intercept BEFORE MapLibre's handlers
    mapElement.addEventListener('mousedown', handleMouseDownCapture, { capture: true });
    mapElement.addEventListener('mousemove', handleMouseMoveCapture, { capture: true });
    mapElement.addEventListener('mouseup', handleMouseUpCapture, { capture: true });
    window.addEventListener('mousedown', handleMouseDownGlobal, { capture: true });
    window.addEventListener('mouseup', handleMouseUpGlobal);

    return () => {
      mapElement.removeEventListener('mousedown', handleMouseDownCapture, { capture: true });
      mapElement.removeEventListener('mousemove', handleMouseMoveCapture, { capture: true });
      mapElement.removeEventListener('mouseup', handleMouseUpCapture, { capture: true });
      window.removeEventListener('mousedown', handleMouseDownGlobal, { capture: true });
      window.removeEventListener('mouseup', handleMouseUpGlobal);
    };
  }, [activeTool]);

  // Zoom tool capture handlers - intercept clicks on the map canvas to prevent SurveyLayer selection
  // and handle right-click zoom out behavior. Attaches to the canvas element specifically to avoid
  // breaking MapLibre UI controls (NavigationControl, ScaleControl, etc.)
  useEffect(() => {
    if (!map.current || activeTool !== 'zoom') return;

    const canvas = map.current.getCanvas();
    if (!canvas) return;

    // Left-click capture: stop propagation to prevent SurveyLayer selection
    // Actual zoom is handled by zoom box end handler (handleZoomBoxEnd)
    // Don't intercept Ctrl+click (used for Ctrl+drag panning)
    // Don't intercept during placement mode (let placement click through)
    const handleClickCapture = (e: MouseEvent) => {
      if (placementMode) return;
      if (e.button === 0 && !e.ctrlKey) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        // Zoom-in is handled by handleZoomBoxEnd for <10px drags
      }
    };

    // Right-click capture: cancel zoom box if active, otherwise zoom out at click point
    const handleContextMenuCapture = (e: MouseEvent) => {
      // Don't intercept during placement mode
      if (placementMode) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // If a zoom box is in progress, cancel it instead of zooming
      if (zoomBox.start) {
        setZoomBox({ start: null, end: null });
        return;
      }

      if (!map.current || !mapContainer.current) return;

      const currentZoom = map.current.getZoom();
      const targetZoom = Math.max(zoomMin, currentZoom - zoomStep);

      // Early return if at min zoom (no recenter)
      if (targetZoom === currentZoom) return;

      // Convert click to map coords
      const rect = mapContainer.current.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const clickLngLat = map.current.unproject([screenX, screenY]);

      map.current.easeTo({
        center: clickLngLat,
        zoom: targetZoom,
        duration: 300,
      });
    };

    canvas.addEventListener('click', handleClickCapture, { capture: true });
    canvas.addEventListener('contextmenu', handleContextMenuCapture, { capture: true });

    return () => {
      canvas.removeEventListener('click', handleClickCapture, { capture: true });
      canvas.removeEventListener('contextmenu', handleContextMenuCapture, { capture: true });
    };
  }, [activeTool, zoomStep, zoomMin, placementMode, zoomBox.start]);

  // Get satellite tile URL based on provider config
  // Uses custom cavechef-tiles:// protocol for offline caching
  const getSatelliteTileConfig = useCallback(() => {
    return getTileConfig();
  }, []);

  // Handle satellite toggle
  useEffect(() => {
    if (!map.current || !mapLoaded) return;

    // Store reference for cleanup
    const currentMap = map.current;
    let errorHandler: ((e: { error?: { status?: number }; sourceId?: string }) => void) | null = null;

    if (showSatellite) {
      // Add satellite layer if not already present
      if (!currentMap.getSource('satellite-tiles')) {
        const tileConfig = getSatelliteTileConfig();

        currentMap.addSource('satellite-tiles', {
          type: 'raster',
          tiles: tileConfig.tiles,
          tileSize: tileConfig.tileSize,
          attribution: tileConfig.attribution,
        });

        // Add satellite layer below survey layers but above background
        // 'survey-shots-hitbox' is the first/bottom survey layer (hitbox layers are added first)
        const firstSurveyLayer = currentMap.getLayer('survey-shots-hitbox') ? 'survey-shots-hitbox' : undefined;
        currentMap.addLayer({
          id: 'satellite-tiles',
          type: 'raster',
          source: 'satellite-tiles',
          paint: {
            'raster-opacity': 0.7,
          },
        }, firstSurveyLayer);

        // Add error handler for offline fallback
        const sourceId = 'satellite-tiles';
        errorHandler = (e: { error?: { status?: number }; sourceId?: string }) => {
          if (e.sourceId === sourceId) {
            console.warn('[MapCanvas] Satellite tile load failed - tiles may be unavailable offline');
            // The map will gracefully show the background color where tiles fail to load
          }
        };

        currentMap.on('error', errorHandler);
      }
    } else {
      if (currentMap.getLayer('satellite-tiles')) {
        currentMap.removeLayer('satellite-tiles');
      }
      if (currentMap.getSource('satellite-tiles')) {
        currentMap.removeSource('satellite-tiles');
      }
    }

    // Cleanup function
    return () => {
      if (errorHandler) {
        currentMap.off('error', errorHandler);
      }
    };
  }, [showSatellite, getSatelliteTileConfig, mapLoaded]);

  // Shared padding helper: computes { top, bottom, left, right } with 10% margin
  // and optional panel offsets
  const calcPadding = useCallback(
    (
      container: HTMLElement,
      panels?: { sectionsPanelOpen: boolean; sectionsPanelWidth: number; detailPanelOpen: boolean; detailPanelWidth: number }
    ) => {
      const marginX = Math.round(container.clientWidth * 0.1);
      const marginY = Math.round(container.clientHeight * 0.1);
      const leftPanel = panels?.sectionsPanelOpen ? panels.sectionsPanelWidth : 0;
      const rightPanel = panels?.detailPanelOpen ? panels.detailPanelWidth : 0;
      return {
        top: marginY,
        bottom: marginY,
        left: marginX + leftPanel,
        right: marginX + rightPanel,
      };
    },
    []
  );

  // Fit to survey bounds using transformed coordinates
  const fitToBounds = useCallback(() => {
    if (!map.current || stations.length === 0) return;

    const coords = stations.map((s) => s.coordinates);
    const bounds = getBounds(coords);

    // Transform bounds to map coordinates
    const sw = metersToMapCoords(bounds.minX, bounds.minY, gpsOrigin);
    const ne = metersToMapCoords(bounds.maxX, bounds.maxY, gpsOrigin);

    // Reset padding to avoid MapLibre accumulation bug
    map.current.setPadding({ top: 0, right: 0, bottom: 0, left: 0 });

    // Calculate 10% padding based on container size (no panel offsets)
    const container = map.current.getContainer();
    const padding = calcPadding(container);

    // Use MapLibre's fitBounds with percentage-based padding
    map.current.fitBounds([sw, ne], {
      padding,
      maxZoom: 20,
    });
  }, [stations, calcPadding]);

  // Fit to a specific section's bounds
  const fitToSection = useCallback(
    (sectionId: number) => {
      if (!map.current || !config) return;

      // Filter stations belonging to this section
      const sectionStations = stations.filter((s) => s.station_ref.section_id === sectionId);

      // Empty section: nothing to zoom to
      if (sectionStations.length === 0) {
        return;
      }

      // Stop any running animation before starting a new one
      map.current.stop();

      // Reset padding to avoid MapLibre accumulation bug
      map.current.setPadding({ top: 0, right: 0, bottom: 0, left: 0 });

      // Get animation config
      const animationConfig = config.map.animation;
      const animationDuration = animationConfig.enabled ? animationConfig.duration : 0;

      // Calculate padding: 10% margin on all sides plus panel offsets
      const container = map.current.getContainer();
      const padding = calcPadding(container, {
        sectionsPanelOpen,
        sectionsPanelWidth,
        detailPanelOpen,
        detailPanelWidth,
      });

      // Single station: center at point_zoom level
      if (sectionStations.length === 1) {
        const station = sectionStations[0]!;
        const mapCoords = metersToMapCoords(station.coordinates.x, station.coordinates.y, gpsOrigin);

        map.current.easeTo({
          center: mapCoords as [number, number],
          zoom: animationConfig.point_zoom,
          duration: animationDuration,
          padding,
        });
        return;
      }

      // Multiple stations: calculate bounds and fit
      const coords = sectionStations.map((s) => s.coordinates);
      const bounds = getBounds(coords);

      // Handle zero-area bounds (all stations at same XY) like single-station case
      if (bounds.minX === bounds.maxX && bounds.minY === bounds.maxY) {
        const mapCoords = metersToMapCoords(bounds.minX, bounds.minY, gpsOrigin);
        map.current.easeTo({
          center: mapCoords as [number, number],
          zoom: animationConfig.point_zoom,
          duration: animationDuration,
          padding,
        });
        return;
      }

      // Transform bounds to map coordinates (pass gpsOrigin for satellite alignment)
      const sw = metersToMapCoords(bounds.minX, bounds.minY, gpsOrigin);
      const ne = metersToMapCoords(bounds.maxX, bounds.maxY, gpsOrigin);

      // Skip-zoom-in: if section already fits in usable viewport and occupies ≥30%,
      // just pan/center without zooming
      const usableWidth = Math.max(1, container.clientWidth - padding.left - padding.right);
      const usableHeight = Math.max(1, container.clientHeight - padding.top - padding.bottom);
      const swScreen = map.current.project(sw as [number, number]);
      const neScreen = map.current.project(ne as [number, number]);
      const screenWidth = Math.abs(neScreen.x - swScreen.x);
      const screenHeight = Math.abs(neScreen.y - swScreen.y);
      const ratioX = screenWidth / usableWidth;
      const ratioY = screenHeight / usableHeight;

      const fitsInViewport = ratioX <= 1.0 && ratioY <= 1.0;
      const occupiesEnough = ratioX >= 0.3 || ratioY >= 0.3;

      if (fitsInViewport && occupiesEnough) {
        // Section already visible and large enough — center without re-zooming
        const centerLng = (sw[0] + ne[0]) / 2;
        const centerLat = (sw[1] + ne[1]) / 2;
        map.current.easeTo({
          center: [centerLng, centerLat],
          padding,
          duration: animationDuration,
        });
      } else {
        // Section too large or too small — use fitBounds
        map.current.fitBounds([sw, ne], {
          padding,
          linear: true,
          duration: animationDuration,
          maxZoom: config.map.zoom_max ?? 22,
        });
      }
    },
    [stations, config, gpsOrigin, sectionsPanelOpen, sectionsPanelWidth, detailPanelOpen, detailPanelWidth, calcPadding]
  );

  // Pan to a shot's midpoint (used when double-clicking a row in DataTable)
  const panToShotMidpoint = useCallback(
    (sectionId: SectionId, shotId: ShotId) => {
      if (!map.current || !config || !project) return;

      // Find the section
      const section = project.sections.find((s) => s.id === sectionId);
      if (!section) return;

      // Find the shot index (shot position - 1, since shots connect stations)
      const shotIndex = section.shots.findIndex((s) => s.id === shotId);
      if (shotIndex === -1) return;

      // Shot at index N connects station_index N (from) to station_index N+1 (to)
      const fromStationIndex = shotIndex;
      const toStationIndex = shotIndex + 1;

      // Find the two stations
      const fromStation = stations.find(
        (s) => s.station_ref.section_id === sectionId && s.station_ref.station_index === fromStationIndex
      );
      const toStation = stations.find(
        (s) => s.station_ref.section_id === sectionId && s.station_ref.station_index === toStationIndex
      );

      if (!fromStation || !toStation) return;

      // Calculate midpoint in project coordinates (meters)
      const midpointX = (fromStation.coordinates.x + toStation.coordinates.x) / 2;
      const midpointY = (fromStation.coordinates.y + toStation.coordinates.y) / 2;

      // Convert to map coordinates
      const mapCoords = metersToMapCoords(midpointX, midpointY, gpsOrigin);

      // Get animation config
      const animationConfig = config.map.animation;
      const animationDuration = animationConfig.enabled ? animationConfig.duration : 0;

      // Pan to the midpoint with smooth animation
      map.current.easeTo({
        center: mapCoords as [number, number],
        duration: animationDuration,
      });
    },
    [project, stations, config, gpsOrigin]
  );

  // Center on a station (used by DetailLink)
  // Returns true if centering was performed, false if prerequisites not met
  const fitToStation = useCallback(
    (stationRef: StationRef): boolean => {
      if (!map.current || !config) return false;

      // Find the station
      const station = stations.find(
        (s) =>
          s.station_ref.section_id === stationRef.section_id &&
          s.station_ref.station_index === stationRef.station_index
      );
      if (!station) return false;

      // Stop any running animation before starting a new one
      map.current.stop();

      // Reset padding to avoid MapLibre accumulation bug (follows fitToSection pattern)
      map.current.setPadding({ top: 0, right: 0, bottom: 0, left: 0 });

      // Convert to map coordinates
      const mapCoords = metersToMapCoords(station.coordinates.x, station.coordinates.y, gpsOrigin);

      // Get animation config
      const animationConfig = config.map.animation;
      const animationDuration = animationConfig.enabled ? animationConfig.duration : 0;

      // Center on the station using point_zoom (single point centering, no padding needed)
      map.current.easeTo({
        center: mapCoords as [number, number],
        zoom: animationConfig.point_zoom,
        duration: animationDuration,
      });

      return true;
    },
    [stations, config, gpsOrigin]
  );

  // Center on a shot's midpoint (used by DetailLink)
  // Returns true if centering was performed, false if prerequisites not met
  const fitToShot = useCallback(
    (sectionId: SectionId, shotId: ShotId): boolean => {
      if (!map.current || !config || !project) return false;

      // Find the section
      const section = project.sections.find((s) => s.id === sectionId);
      if (!section) return false;

      // Find the shot index
      const shotIndex = section.shots.findIndex((s) => s.id === shotId);
      if (shotIndex === -1) return false;

      // Shot at index N connects station_index N (from) to station_index N+1 (to)
      const fromStationIndex = shotIndex;
      const toStationIndex = shotIndex + 1;

      // Find the two stations
      const fromStation = stations.find(
        (s) => s.station_ref.section_id === sectionId && s.station_ref.station_index === fromStationIndex
      );
      const toStation = stations.find(
        (s) => s.station_ref.section_id === sectionId && s.station_ref.station_index === toStationIndex
      );

      if (!fromStation || !toStation) return false;

      // Stop any running animation before starting a new one
      map.current.stop();

      // Reset padding to avoid MapLibre accumulation bug (follows fitToSection pattern)
      map.current.setPadding({ top: 0, right: 0, bottom: 0, left: 0 });

      // Calculate midpoint in project coordinates (meters)
      const midpointX = (fromStation.coordinates.x + toStation.coordinates.x) / 2;
      const midpointY = (fromStation.coordinates.y + toStation.coordinates.y) / 2;

      // Convert to map coordinates
      const mapCoords = metersToMapCoords(midpointX, midpointY, gpsOrigin);

      // Get animation config
      const animationConfig = config.map.animation;
      const animationDuration = animationConfig.enabled ? animationConfig.duration : 0;

      // Center on the shot midpoint using point_zoom (single point centering, no padding needed)
      map.current.easeTo({
        center: mapCoords as [number, number],
        zoom: animationConfig.point_zoom,
        duration: animationDuration,
      });

      return true;
    },
    [project, stations, config, gpsOrigin]
  );

  // Fit to bounds when requested (e.g., after import)
  useEffect(() => {
    if (requestFitToBounds && mapLoaded && stations.length > 0) {
      // Small delay to ensure data is rendered
      setTimeout(() => {
        fitToBounds();
        clearFitToBoundsRequest();
      }, 100);
    }
  }, [requestFitToBounds, mapLoaded, stations.length, clearFitToBoundsRequest]);

  // Fit to section when requested (e.g., from sections panel double-click)
  useEffect(() => {
    // CRITICAL: Clear request immediately (before any early returns) to prevent stuck requests
    if (requestZoomToSection !== null) {
      const sectionId = requestZoomToSection;
      clearZoomToSectionRequest();
      // If map is loaded, process immediately; otherwise store for later
      if (mapLoaded) {
        fitToSection(sectionId);
      } else {
        pendingZoomToSectionRef.current = sectionId;
      }
    }
  }, [requestZoomToSection, mapLoaded, clearZoomToSectionRequest, fitToSection]);

  // Process pending section zoom request when map loads
  useEffect(() => {
    if (mapLoaded && pendingZoomToSectionRef.current !== null) {
      const sectionId = pendingZoomToSectionRef.current;
      pendingZoomToSectionRef.current = null;
      fitToSection(sectionId);
    }
  }, [mapLoaded, fitToSection]);

  // Pan to shot midpoint when requested (e.g., from DataTable double-click)
  useEffect(() => {
    // CRITICAL: Clear request immediately (before any early returns) to prevent stuck requests
    if (requestPanToShot !== null) {
      const { sectionId, shotId } = requestPanToShot;
      clearPanToShotRequest();
      // If map is loaded, process immediately; otherwise store for later
      if (mapLoaded) {
        panToShotMidpoint(sectionId, shotId);
      } else {
        pendingPanToShotRef.current = { sectionId, shotId };
      }
    }
  }, [requestPanToShot, mapLoaded, clearPanToShotRequest, panToShotMidpoint]);

  // Process pending pan-to-shot request when map loads
  useEffect(() => {
    if (mapLoaded && pendingPanToShotRef.current !== null) {
      const { sectionId, shotId } = pendingPanToShotRef.current;
      pendingPanToShotRef.current = null;
      panToShotMidpoint(sectionId, shotId);
    }
  }, [mapLoaded, panToShotMidpoint]);

  // Center on station when requested (e.g., from DetailLink click)
  useEffect(() => {
    // CRITICAL: Clear request immediately (before any early returns) to prevent stuck requests
    if (requestCenterOnStation !== null) {
      const stationRef = requestCenterOnStation;
      clearCenterOnStationRequest();
      // If map is loaded, process immediately; otherwise store for later
      if (mapLoaded) {
        fitToStation(stationRef);
      } else {
        pendingCenterOnStationRef.current = stationRef;
      }
    }
  }, [requestCenterOnStation, mapLoaded, clearCenterOnStationRequest, fitToStation]);

  // Process pending center-on-station request when map loads
  useEffect(() => {
    if (mapLoaded && pendingCenterOnStationRef.current !== null) {
      const stationRef = pendingCenterOnStationRef.current;
      // Only clear pending ref if centering was successful
      if (fitToStation(stationRef)) {
        pendingCenterOnStationRef.current = null;
      }
    }
  }, [mapLoaded, fitToStation]);

  // Center on shot when requested (e.g., from DetailLink click)
  useEffect(() => {
    // CRITICAL: Clear request immediately (before any early returns) to prevent stuck requests
    if (requestCenterOnShot !== null) {
      const { sectionId, shotId } = requestCenterOnShot;
      clearCenterOnShotRequest();
      // If map is loaded, process immediately; otherwise store for later
      if (mapLoaded) {
        fitToShot(sectionId, shotId);
      } else {
        pendingCenterOnShotRef.current = { sectionId, shotId };
      }
    }
  }, [requestCenterOnShot, mapLoaded, clearCenterOnShotRequest, fitToShot]);

  // Process pending center-on-shot request when map loads
  useEffect(() => {
    if (mapLoaded && pendingCenterOnShotRef.current !== null) {
      const { sectionId, shotId } = pendingCenterOnShotRef.current;
      // Only clear pending ref if centering was successful
      if (fitToShot(sectionId, shotId)) {
        pendingCenterOnShotRef.current = null;
      }
    }
  }, [mapLoaded, fitToShot]);

  // Handle Escape key for placement mode
  useEffect(() => {
    if (!placementMode) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handlePlacementCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [placementMode, handlePlacementCancel]);

  // Update cursor style for placement mode
  useEffect(() => {
    if (!map.current) return;

    if (placementMode) {
      map.current.getCanvas().style.cursor = 'crosshair';
      // Disable drag pan during placement
      map.current.dragPan.disable();
    } else {
      // Re-enable drag pan when placement mode ends (unless current tool should disable it)
      const noPanTools = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure', 'move_section', 'move_station', 'move_segment', 'move_shot'];
      if (!noPanTools.includes(activeTool)) {
        map.current.dragPan.enable();
      }
      // Reset cursor based on current tool
      const cursors: Record<string, string> = {
        select: 'default',
        pan: 'grab',
        zoom: 'zoom-in',
        draw: 'crosshair',
        delete: 'crosshair',
        merge: 'crosshair',
        measure: 'crosshair',
        move_section: 'move',
        move_station: 'move',
        move_segment: 'move',
        move_shot: 'move',
      };
      map.current.getCanvas().style.cursor = cursors[activeTool] ?? 'default';
    }
  }, [placementMode, activeTool]);

  // Calculate box select overlay style
  const boxSelectStyle = boxSelect.start && boxSelect.end
    ? {
        left: Math.min(boxSelect.start.x, boxSelect.end.x),
        top: Math.min(boxSelect.start.y, boxSelect.end.y),
        width: Math.abs(boxSelect.end.x - boxSelect.start.x),
        height: Math.abs(boxSelect.end.y - boxSelect.start.y),
      }
    : null;

  // Combined mouse handlers
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Handle placement mode
      if (placementMode && mapContainer.current && map.current) {
        const rect = mapContainer.current.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        // Update cursor position for overlay
        setPlacementCursor({ x: screenX, y: screenY });

        // Convert screen position to map coordinates (meters)
        const lngLat = map.current.unproject([screenX, screenY]);
        const meters = mapCoordsToMeters(lngLat.lng, lngLat.lat, gpsOrigin);
        updatePlacementCursor({ x: meters.x, y: meters.y, z: 0 });

        // Check for snap to existing station
        const snapped = checkPlacementSnap(screenX, screenY);
        updatePlacementSnap(snapped);
        return;
      }

      if (moveDrag) {
        handleMoveDragMove(e);
      } else if (zoomBox.start) {
        handleZoomBoxMove(e);
      } else if (boxSelect.start) {
        handleBoxSelectMove(e);
      }

      // Always check snap when moving (snap logic internally checks if tool requires snap)
      if (mapContainer.current) {
        const rect = mapContainer.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        checkSnapToStation(x, y);
      }
    },
    [moveDrag, zoomBox.start, boxSelect.start, handleMoveDragMove, handleZoomBoxMove, handleBoxSelectMove, checkSnapToStation, placementMode, checkPlacementSnap, updatePlacementCursor, updatePlacementSnap]
  );

  const handleMouseUp = useCallback(() => {
    if (moveDrag) {
      handleMoveDragEnd();
    } else if (zoomBox.start) {
      handleZoomBoxEnd();
    } else if (boxSelect.start) {
      handleBoxSelectEnd();
    }
  }, [moveDrag, zoomBox.start, boxSelect.start, handleMoveDragEnd, handleZoomBoxEnd, handleBoxSelectEnd]);

  // Handle placement mode click
  const handlePlacementClick = useCallback(
    (e: React.MouseEvent) => {
      if (!placementMode) return;

      // Left click confirms placement
      if (e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        handlePlacementConfirm();
      }
    },
    [placementMode, handlePlacementConfirm]
  );

  // Handle placement mode right-click (cancel)
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (placementMode) {
        e.preventDefault();
        e.stopPropagation();
        handlePlacementCancel();
      }
    },
    [placementMode, handlePlacementCancel]
  );

  // Determine mousedown handler based on mode and tool
  // Only process events that originate from the map canvas (not UI controls or overlays)
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Ignore clicks on overlay UI (buttons, indicators, MapLibre controls)
      // Gate on canvas element to exclude .maplibregl-control-container clicks
      const canvas = map.current?.getCanvas();
      if (!canvas || !canvas.contains(e.target as Node)) {
        return;
      }
      if (placementMode) {
        handlePlacementClick(e);
      } else if (activeTool === 'zoom') {
        handleZoomBoxStart(e);
      } else {
        handleBoxSelectStart(e);
      }
    },
    [placementMode, activeTool, handlePlacementClick, handleZoomBoxStart, handleBoxSelectStart]
  );

  // Mouse handlers always attached - they check e.ctrlKey internally to decide behavior
  return (
    <div
      className="relative w-full h-full"
      data-testid="map-canvas"
      data-map-loaded={mapLoaded ? 'true' : 'false'}
      data-active-tool={activeTool}
      data-placement-mode={placementMode ? 'true' : 'false'}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={handleContextMenu}
    >
      <div ref={mapContainer} className="w-full h-full" data-testid="maplibre-container" />

      {/* Box select overlay */}
      {boxSelectStyle && (
        <div
          className="absolute border-2 border-accent border-dashed bg-accent/10 pointer-events-none"
          style={boxSelectStyle}
        />
      )}

      {/* Zoom box overlay */}
      {zoomBox.start && zoomBox.end && (
        <div
          className="absolute border-2 border-accent bg-accent/20 pointer-events-none"
          style={{
            left: Math.min(zoomBox.start.x, zoomBox.end.x),
            top: Math.min(zoomBox.start.y, zoomBox.end.y),
            width: Math.abs(zoomBox.end.x - zoomBox.start.x),
            height: Math.abs(zoomBox.end.y - zoomBox.start.y),
          }}
          data-testid="zoom-box-overlay"
        />
      )}

      {/* Grid overlay using MapLibre layer */}
      {mapLoaded && map.current && <GridOverlay map={map.current} />}

      {/* Depth legend when depth gradient is enabled */}
      {showDepthGradient && stats && (
        <DepthLegend
          minDepth={stats.min_depth}
          maxDepth={stats.max_depth}
          visible={showDepthGradient}
        />
      )}

      {/* Developer stats overlay */}
      {showDevStats && mapLoaded && map.current && (
        <MapDevStats map={map.current} />
      )}

      {/* Placement mode overlay */}
      {placementMode && placementCursor && (
        <PlacementOverlay
          sectionData={placementMode.sectionData}
          alignStationIndex={placementMode.alignStationIndex}
          cursorPosition={placementCursor}
          isSnapped={placementMode.snappedToStation !== null}
          pixelsPerMeter={pixelsPerMeter}
        />
      )}

      {/* Fit to view button */}
      <button
        onClick={fitToBounds}
        className="absolute top-2 left-2 bg-panel border border-border rounded px-2 py-1 text-sm hover:bg-background"
        title="Fit to view (Ctrl+0)"
        data-testid="fit-to-view-button"
      >
        ⊞
      </button>

      {/* Placement mode indicator */}
      {placementMode && (
        <div
          className="absolute top-2 left-1/2 -translate-x-1/2 bg-panel border border-accent rounded px-3 py-2 text-sm"
          data-testid="placement-mode-indicator"
        >
          <span className="text-accent">Placement Mode:</span>{' '}
          Click to place section, Escape to cancel
          {placementMode.snappedToStation && (
            <span className="ml-2 text-success">(Snapped)</span>
          )}
        </div>
      )}

      {/* Merge tool indicator */}
      {activeTool === 'merge' && mergeStationA && !placementMode && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-panel border border-accent rounded px-3 py-2 text-sm">
          <span className="text-accent">Merge Tool:</span> Click another station to merge, or click empty to cancel
        </div>
      )}

      {/* Measure tool indicator */}
      {activeTool === 'measure' && measureStart && !measureEnd && !placementMode && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-panel border border-accent rounded px-3 py-2 text-sm">
          <span className="text-accent">Measure Tool:</span> Click another point to measure distance
        </div>
      )}

      {/* Measurement result display */}
      {measureResult && !placementMode && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-panel border border-border rounded px-3 py-2 text-sm">
          <span className="font-medium">Distance:</span> {measureResult.distance.toFixed(2)}m
          <span className="mx-2">|</span>
          <span className="font-medium">Depth diff:</span> {measureResult.depthDiff.toFixed(2)}m
        </div>
      )}

      {/* Move drag indicator */}
      {moveDrag && !placementMode && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-panel border border-accent rounded px-3 py-2 text-sm">
          <span className="text-accent">
            {moveDrag.type === 'section' ? 'Move Section' : moveDrag.type === 'station' ? 'Move Station' : moveDrag.type === 'segment' ? 'Move Segment' : 'Move Shot'}:
          </span>{' '}
          Drag to new position, release to confirm
        </div>
      )}
    </div>
  );
}
