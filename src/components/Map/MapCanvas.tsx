import { useEffect, useRef, useCallback, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore, type Selection } from '../../store/uiStore';
import { getBounds, metersToMapCoords, mapCoordsToMeters } from '../../utils/coordinates';
import { registerTileProtocol, unregisterTileProtocol } from '../../utils/tileProtocol';
import { useMapTools } from '../../hooks/useMapTools';
import SurveyLayer from './SurveyLayer';
import PlacementOverlay from './PlacementOverlay';
import GridOverlay from './GridOverlay';

// Tools that support Ctrl+drag for panning (excludes tools with their own drag behaviors)
const CTRL_PAN_TOOLS = ['select', 'draw', 'delete', 'merge', 'measure'];

interface BoxSelectState {
  start: { x: number; y: number } | null;
  end: { x: number; y: number } | null;
}

interface MoveDragState {
  type: 'section' | 'station';
  sectionId?: number;
  stationRef?: { section_id: number; station_index: number };
  startLngLat: { lng: number; lat: number };
  currentLngLat: { lng: number; lat: number };
}

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

  const { project, stations, config, moveSection, moveStation } = useProjectStore();

  // Get GPS origin for coordinate transforms (enables satellite tile alignment)
  const gpsOrigin = config?.map.satellite_gps_origin ?? null;
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
    selection,
    mergeStationA,
    measureStart,
    measureEnd,
    addToSelection,
    clearSelection,
    requestFitToBounds,
    clearFitToBoundsRequest,
    snappedStation,
    setSnappedStation,
    placementMode,
    updatePlacementCursor,
    updatePlacementSnap,
    cancelPlacementMode,
    confirmPlacement,
  } = useUIStore();

  // Snap-to-station detection
  const checkSnapToStation = useCallback(
    (screenX: number, screenY: number) => {
      if (!map.current || !config) {
        setSnappedStation(null);
        return;
      }

      // Check if snap is enabled for the current tool
      const snapConfig = config.snap;
      const shouldSnap =
        (activeTool === 'draw' && snapConfig.enabled_draw) ||
        (activeTool === 'merge' && snapConfig.enabled_merge) ||
        (activeTool === 'measure' && snapConfig.enabled_measure);

      if (!shouldSnap) {
        setSnappedStation(null);
        return;
      }

      const threshold = snapConfig.threshold_pixels;
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
    [activeTool, config, stations, snappedStation, setSnappedStation]
  );

  // Check snap for placement mode
  const checkPlacementSnap = useCallback(
    (screenX: number, screenY: number) => {
      if (!map.current || !config || !placementMode) {
        return null;
      }

      const threshold = config.snap.threshold_pixels;
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
    (data: { type: 'section' | 'station'; sectionId?: number; stationRef?: { section_id: number; station_index: number } }) => {
      if (!map.current) return;

      // Get current mouse position from map center as starting point
      // The actual drag will be tracked via mouse events
      const center = map.current.getCenter();
      const baseDragState = {
        type: data.type,
        startLngLat: { lng: center.lng, lat: center.lat },
        currentLngLat: { lng: center.lng, lat: center.lat },
      };

      // Build the drag state conditionally to avoid undefined values
      if (data.type === 'section' && data.sectionId !== undefined) {
        setMoveDrag({ ...baseDragState, type: 'section', sectionId: data.sectionId });
      } else if (data.type === 'station' && data.stationRef !== undefined) {
        setMoveDrag({ ...baseDragState, type: 'station', stationRef: data.stationRef });
      }
    },
    []
  );

  // Get map tool callbacks
  const toolCallbacks = useMapTools({
    onMeasureComplete: (distance, depthDiff) => {
      setMeasureResult({ distance, depthDiff });
      // Clear after a few seconds
      setTimeout(() => setMeasureResult(null), 5000);
    },
    onMoveDragStart: handleMoveDragStart,
    onFeatureHover: setIsHoveringFeature,
  });

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
      // Query stations in the box
      const features = map.current.queryRenderedFeatures(
        [[minX, minY], [maxX, maxY]],
        { layers: ['survey-stations'] }
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
    // Task 3 will enhance with full box zoom for larger drags
    if (maxX - minX < 10 && maxY - minY < 10) {
      // Click zoom-in at center of box (effectively the click point)
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const clickLngLat = map.current.unproject([centerX, centerY]);

      const step = config?.map.zoom_step ?? 1.0;
      const maxZoom = config?.map.zoom_max ?? 22;
      const currentZoom = map.current.getZoom();
      const targetZoom = Math.min(maxZoom, currentZoom + step);

      if (targetZoom !== currentZoom) {
        map.current.easeTo({
          center: clickLngLat,
          zoom: targetZoom,
          duration: 300,
        });
      }
    }
    // Task 3 will add: else { box zoom to bounds }

    setZoomBox({ start: null, end: null });
  }, [zoomBox, config]);

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
    },
    [moveDrag]
  );

  const handleMoveDragEnd = useCallback(async () => {
    if (!moveDrag || !map.current) {
      setMoveDrag(null);
      return;
    }

    // Calculate offset (delta from start to current)
    const dx = moveDrag.currentLngLat.lng - moveDrag.startLngLat.lng;
    const dy = moveDrag.currentLngLat.lat - moveDrag.startLngLat.lat;

    // Only process if there's a meaningful movement
    if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001) {
      const offset = { x: dx, y: dy, z: 0 };

      if (moveDrag.type === 'section' && moveDrag.sectionId !== undefined) {
        await moveSection(moveDrag.sectionId, offset);
      } else if (moveDrag.type === 'station' && moveDrag.stationRef) {
        // For station, we need the new absolute position
        // Get the station's current position and add the offset
        const station = stations.find(
          (s) =>
            s.station_ref.section_id === moveDrag.stationRef!.section_id &&
            s.station_ref.station_index === moveDrag.stationRef!.station_index
        );
        if (station) {
          const newPosition = {
            x: station.coordinates.x + dx,
            y: station.coordinates.y + dy,
            z: station.coordinates.z,
          };
          await moveStation(moveDrag.stationRef, newPosition);
        }
      }
    }

    setMoveDrag(null);
  }, [moveDrag, moveSection, moveStation, stations]);

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
              'background-color': config?.display.default_background ?? '#1a1a2e',
            },
          },
        ],
      },
      center: mapCenter,
      zoom: mapZoom,
      attributionControl: false,
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

  // Expose map instance for E2E testing (development only)
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
      surveyLayerRef.current.update(project.sections, stations, project.station_merges, project.loop_closures, gpsOrigin);
    }
  }, [project, stations, mapLoaded, gpsOrigin]);

  // Update callbacks when they change
  useEffect(() => {
    if (surveyLayerRef.current) {
      surveyLayerRef.current.setCallbacks(toolCallbacks);
    }
  }, [toolCallbacks]);

  // Sync selection state with SurveyLayer for visual feedback
  useEffect(() => {
    if (!surveyLayerRef.current) return;

    if (selection?.type === 'station' && selection.stationRef) {
      surveyLayerRef.current.setSelectedStation(selection.stationRef);
      surveyLayerRef.current.setSelectedShot(null, null);
    } else if (selection?.type === 'shot' && selection.sectionId !== undefined && selection.shotId !== undefined) {
      surveyLayerRef.current.setSelectedStation(null);
      surveyLayerRef.current.setSelectedShot(selection.sectionId, selection.shotId);
    } else {
      surveyLayerRef.current.setSelectedStation(null);
      surveyLayerRef.current.setSelectedShot(null, null);
    }
  }, [selection]);

  // Sync snapped station with SurveyLayer for snap indicator
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    surveyLayerRef.current.setSnappedStation(snappedStation);
  }, [snappedStation]);

  // Sync shot data labels visibility with SurveyLayer
  useEffect(() => {
    if (!surveyLayerRef.current) return;
    surveyLayerRef.current.setShowShotLabels(showShotData);
  }, [showShotData, mapLoaded]);

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

    const noPanTools = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure', 'move_section', 'move_station'];

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

  // Set map zoom limits from config
  useEffect(() => {
    if (!map.current || !config) return;
    map.current.setMinZoom(config.map.zoom_min ?? 0);
    map.current.setMaxZoom(config.map.zoom_max ?? 22);
  }, [config]);

  // Track Ctrl key for cursor updates and box select cancellation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control' && !e.repeat) {
        setCtrlHeld(true);

        // Cancel any active box select when Ctrl is pressed (mid-drag Ctrl converts to pan)
        setBoxSelect({ start: null, end: null });
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
      // Cancel any active box select
      setBoxSelect({ start: null, end: null });
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

    const handleMouseUpCapture = () => {
      if (ctrlPanStart && map.current) {
        ctrlPanStart = null;
        // Restore cursor using the same mapping as the main cursor effect
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
        };
        map.current.getCanvas().style.cursor = cursors[activeTool] ?? 'default';
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

  // Extract zoom config values for stable dependencies
  const zoomStep = config?.map.zoom_step ?? 1.0;
  const zoomMin = config?.map.zoom_min ?? 0;

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
    const handleClickCapture = (e: MouseEvent) => {
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
    return {
      tiles: ['cavechef-tiles://esri/{z}/{y}/{x}'],
      attribution: '&copy; Esri, Maxar, Earthstar Geographics',
      tileSize: 256,
    };
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
        // 'survey-ghost-shots' is the first/bottom survey layer
        const firstSurveyLayer = currentMap.getLayer('survey-ghost-shots') ? 'survey-ghost-shots' : undefined;
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

  // Fit to survey bounds using transformed coordinates
  const fitToBounds = useCallback(() => {
    if (!map.current || stations.length === 0) return;

    const coords = stations.map((s) => s.coordinates);
    const bounds = getBounds(coords);

    // Transform bounds to map coordinates
    const sw = metersToMapCoords(bounds.minX, bounds.minY, gpsOrigin);
    const ne = metersToMapCoords(bounds.maxX, bounds.maxY, gpsOrigin);

    // Calculate 10% padding based on container size
    const container = map.current.getContainer();
    const paddingX = Math.round(container.clientWidth * 0.1);
    const paddingY = Math.round(container.clientHeight * 0.1);

    // Use MapLibre's fitBounds with percentage-based padding
    map.current.fitBounds([sw, ne], {
      padding: { top: paddingY, bottom: paddingY, left: paddingX, right: paddingX },
      maxZoom: 20,
    });
  }, [stations]);

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
      const noPanTools = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure', 'move_section', 'move_station'];
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
  // Only process events that originate from the map container (not overlay UI)
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Ignore clicks on overlay UI (buttons, indicators, etc.)
      if (!mapContainer.current?.contains(e.target as Node)) {
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
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={handleContextMenu}
    >
      <div ref={mapContainer} className="w-full h-full" />

      {/* Box select overlay */}
      {boxSelectStyle && (
        <div
          className="absolute border-2 border-accent border-dashed bg-accent/10 pointer-events-none"
          style={boxSelectStyle}
        />
      )}

      {/* Grid overlay using MapLibre layer */}
      {mapLoaded && map.current && <GridOverlay map={map.current} />}

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
            {moveDrag.type === 'section' ? 'Move Section' : 'Move Station'}:
          </span>{' '}
          Drag to new position, release to confirm
        </div>
      )}
    </div>
  );
}
