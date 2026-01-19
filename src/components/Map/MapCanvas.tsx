import { useEffect, useRef, useCallback, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore, type Selection } from '../../store/uiStore';
import { getBounds, metersToMapCoords, mapCoordsToMeters } from '../../utils/coordinates';
import { useMapTools } from '../../hooks/useMapTools';
import SurveyLayer from './SurveyLayer';
import PlacementOverlay from './PlacementOverlay';
import GridOverlay from './GridOverlay';

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
  const [moveDrag, setMoveDrag] = useState<MoveDragState | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [isHoveringFeature, setIsHoveringFeature] = useState(false);
  // Placement mode cursor position (screen pixels)
  const [placementCursor, setPlacementCursor] = useState<{ x: number; y: number } | null>(null);

  const { project, stations, config, moveSection, moveStation } = useProjectStore();
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
        const mapCoords = metersToMapCoords(station.coordinates.x, station.coordinates.y);
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
        const mapCoords = metersToMapCoords(station.coordinates.x, station.coordinates.y);
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
    const mapCenter = metersToMapCoords(centerX, centerY);

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
    });

    // Initialize survey layer
    map.current.on('load', () => {
      if (!map.current) return;
      surveyLayerRef.current = new SurveyLayer(map.current, toolCallbacks);
      setMapLoaded(true);
    });

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Update survey layer when data changes or map loads
  useEffect(() => {
    if (surveyLayerRef.current && project) {
      surveyLayerRef.current.update(project.sections, stations, project.station_merges, project.loop_closures);
    }
  }, [project, stations, mapLoaded]);

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
    if (!isHoveringFeature) {
      // In select mode with Ctrl held, show grab cursor for panning
      if (activeTool === 'select' && ctrlHeld) {
        map.current.getCanvas().style.cursor = 'grab';
      } else {
        map.current.getCanvas().style.cursor = cursors[activeTool] ?? 'default';
      }
    }
  }, [activeTool, ctrlHeld, isHoveringFeature]);

  // Disable map drag pan for tools that need custom interaction
  // Exception: In select mode, Ctrl+drag enables panning
  useEffect(() => {
    if (!map.current) return;

    // Tools that should have map panning disabled
    const noPanTools = ['select', 'draw', 'delete', 'merge', 'measure', 'move_section', 'move_station'];

    // Enable panning in select mode when Ctrl is held
    if (activeTool === 'select' && ctrlHeld) {
      map.current.dragPan.enable();
    } else if (noPanTools.includes(activeTool)) {
      map.current.dragPan.disable();
    } else {
      map.current.dragPan.enable();
    }
  }, [activeTool, ctrlHeld]);

  // Track Ctrl key for pan-in-select-mode feature
  // IMPORTANT: Enable dragPan directly in the handler, not via useEffect, to avoid timing issues
  useEffect(() => {
    const noPanTools = ['select', 'draw', 'delete', 'merge', 'measure', 'move_section', 'move_station'];

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control' && !e.repeat) {
        setCtrlHeld(true);
        // Enable dragPan immediately when Ctrl is pressed (for select mode)
        if (map.current && activeTool === 'select') {
          map.current.dragPan.enable();
        }
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') {
        setCtrlHeld(false);
        // Disable dragPan when Ctrl is released (for select mode)
        if (map.current && noPanTools.includes(activeTool)) {
          map.current.dragPan.disable();
        }
      }
    };
    // Also handle window blur (Ctrl held, switch windows, release outside)
    const handleBlur = () => {
      setCtrlHeld(false);
      if (map.current && noPanTools.includes(activeTool)) {
        map.current.dragPan.disable();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [activeTool]);

  // Get satellite tile URL based on provider config
  const getSatelliteTileConfig = useCallback(() => {
    const provider = config?.map?.satellite_provider ?? 'openstreetmap';

    switch (provider.toLowerCase()) {
      case 'esri':
        return {
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          attribution: '&copy; Esri, Maxar, Earthstar Geographics',
          tileSize: 256,
        };
      case 'mapbox':
        // Mapbox requires an access token - fall back to ESRI if not available
        return {
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          attribution: '&copy; Esri, Maxar, Earthstar Geographics',
          tileSize: 256,
        };
      case 'openstreetmap':
      default:
        // OSM doesn't have satellite - use ESRI as default satellite provider
        return {
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          attribution: '&copy; Esri, Maxar, Earthstar Geographics',
          tileSize: 256,
        };
    }
  }, [config?.map?.satellite_provider]);

  // Handle satellite toggle
  useEffect(() => {
    if (!map.current) return;

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

        currentMap.addLayer(
          {
            id: 'satellite-tiles',
            type: 'raster',
            source: 'satellite-tiles',
            paint: {
              'raster-opacity': 0.7,
            },
          },
          'background'
        );

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
  }, [showSatellite, getSatelliteTileConfig]);

  // Fit to survey bounds using transformed coordinates
  const fitToBounds = useCallback(() => {
    if (!map.current || stations.length === 0) return;

    const coords = stations.map((s) => s.coordinates);
    const bounds = getBounds(coords);

    // Transform bounds to map coordinates
    const sw = metersToMapCoords(bounds.minX, bounds.minY);
    const ne = metersToMapCoords(bounds.maxX, bounds.maxY);

    // Use MapLibre's fitBounds with padding
    map.current.fitBounds([sw, ne], {
      padding: 50,
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
      const noPanTools = ['select', 'draw', 'delete', 'merge', 'measure', 'move_section', 'move_station'];
      if (!noPanTools.includes(activeTool)) {
        map.current.dragPan.enable();
      }
      // Reset cursor based on current tool
      const cursors: Record<string, string> = {
        select: 'default',
        pan: 'grab',
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
        const meters = mapCoordsToMeters(lngLat.lng, lngLat.lat);
        updatePlacementCursor({ x: meters.x, y: meters.y, z: 0 });

        // Check for snap to existing station
        const snapped = checkPlacementSnap(screenX, screenY);
        updatePlacementSnap(snapped);
        return;
      }

      if (moveDrag) {
        handleMoveDragMove(e);
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
    [moveDrag, boxSelect.start, handleMoveDragMove, handleBoxSelectMove, checkSnapToStation, placementMode, checkPlacementSnap, updatePlacementCursor, updatePlacementSnap]
  );

  const handleMouseUp = useCallback(() => {
    if (moveDrag) {
      handleMoveDragEnd();
    } else if (boxSelect.start) {
      handleBoxSelectEnd();
    }
  }, [moveDrag, boxSelect.start, handleMoveDragEnd, handleBoxSelectEnd]);

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

  // Mouse handlers always attached - they check e.ctrlKey internally to decide behavior
  return (
    <div
      className="relative w-full h-full"
      onMouseDown={placementMode ? handlePlacementClick : handleBoxSelectStart}
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
          alignStation={placementMode.alignStation}
          cursorPosition={placementCursor}
          isSnapped={placementMode.snappedToStation !== null}
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
