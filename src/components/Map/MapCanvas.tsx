import { useEffect, useRef, useCallback, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore, type Selection } from '../../store/uiStore';
import { getBounds } from '../../utils/coordinates';
import { useMapTools } from '../../hooks/useMapTools';
import SurveyLayer from './SurveyLayer';

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
  const [measureResult, setMeasureResult] = useState<{ distance: number; depthDiff: number } | null>(null);
  const [boxSelect, setBoxSelect] = useState<BoxSelectState>({ start: null, end: null });
  const [moveDrag, setMoveDrag] = useState<MoveDragState | null>(null);

  const { project, stations, config, moveSection, moveStation } = useProjectStore();
  const {
    mapZoom,
    setMapCenter,
    setMapZoom,
    activeTool,
    showGrid,
    showSatellite,
    selection,
    mergeStationA,
    measureStart,
    measureEnd,
    addToSelection,
    clearSelection,
  } = useUIStore();

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
  });

  // Box select handlers
  const handleBoxSelectStart = useCallback(
    (e: React.MouseEvent) => {
      if (activeTool !== 'select') return;
      if (!mapContainer.current) return;

      // Only start box select on left click and not on a feature
      if (e.button !== 0) return;

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

    // Calculate initial center from stations
    const coords = stations.map((s) => s.coordinates);
    const bounds = getBounds(coords);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
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
      center: [centerX, centerY],
      zoom: mapZoom,
      attributionControl: false,
    });

    // Add navigation controls
    map.current.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      'top-right'
    );

    // Add scale control
    map.current.addControl(
      new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }),
      'bottom-left'
    );

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
    });

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Update survey layer when data changes
  useEffect(() => {
    if (surveyLayerRef.current && project) {
      surveyLayerRef.current.update(project.sections, stations);
    }
  }, [project, stations]);

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

  // Update cursor based on tool
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

    map.current.getCanvas().style.cursor = cursors[activeTool] ?? 'default';
  }, [activeTool]);

  // Handle satellite toggle
  useEffect(() => {
    if (!map.current) return;

    if (showSatellite) {
      // Add OSM satellite layer
      if (!map.current.getSource('osm-tiles')) {
        map.current.addSource('osm-tiles', {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors',
        });

        map.current.addLayer(
          {
            id: 'osm-tiles',
            type: 'raster',
            source: 'osm-tiles',
            paint: {
              'raster-opacity': 0.5,
            },
          },
          'background'
        );
      }
    } else {
      if (map.current.getLayer('osm-tiles')) {
        map.current.removeLayer('osm-tiles');
      }
      if (map.current.getSource('osm-tiles')) {
        map.current.removeSource('osm-tiles');
      }
    }
  }, [showSatellite]);

  // Fit to survey bounds
  const fitToBounds = useCallback(() => {
    if (!map.current || stations.length === 0) return;

    const coords = stations.map((s) => s.coordinates);
    const bounds = getBounds(coords);

    // Add padding
    const padding = 50;

    map.current.fitBounds(
      [
        [bounds.minX - padding, bounds.minY - padding],
        [bounds.maxX + padding, bounds.maxY + padding],
      ],
      { padding: 50 }
    );
  }, [stations]);

  // Fit to bounds when project loads
  useEffect(() => {
    if (project && stations.length > 0) {
      // Small delay to ensure map is ready
      setTimeout(fitToBounds, 100);
    }
  }, [project?.name, fitToBounds]);

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
      if (moveDrag) {
        handleMoveDragMove(e);
      } else if (boxSelect.start) {
        handleBoxSelectMove(e);
      }
    },
    [moveDrag, boxSelect.start, handleMoveDragMove, handleBoxSelectMove]
  );

  const handleMouseUp = useCallback(() => {
    if (moveDrag) {
      handleMoveDragEnd();
    } else if (boxSelect.start) {
      handleBoxSelectEnd();
    }
  }, [moveDrag, boxSelect.start, handleMoveDragEnd, handleBoxSelectEnd]);

  return (
    <div
      className="relative w-full h-full"
      onMouseDown={handleBoxSelectStart}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <div ref={mapContainer} className="w-full h-full" />

      {/* Box select overlay */}
      {boxSelectStyle && (
        <div
          className="absolute border-2 border-accent border-dashed bg-accent/10 pointer-events-none"
          style={boxSelectStyle}
        />
      )}

      {/* Grid overlay (simple CSS grid for now) */}
      {showGrid && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `
              linear-gradient(to right, ${config?.display.grid_color ?? '#333366'}22 1px, transparent 1px),
              linear-gradient(to bottom, ${config?.display.grid_color ?? '#333366'}22 1px, transparent 1px)
            `,
            backgroundSize: '50px 50px',
          }}
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

      {/* Merge tool indicator */}
      {activeTool === 'merge' && mergeStationA && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-panel border border-accent rounded px-3 py-2 text-sm">
          <span className="text-accent">Merge Tool:</span> Click another station to merge, or click empty to cancel
        </div>
      )}

      {/* Measure tool indicator */}
      {activeTool === 'measure' && measureStart && !measureEnd && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-panel border border-accent rounded px-3 py-2 text-sm">
          <span className="text-accent">Measure Tool:</span> Click another point to measure distance
        </div>
      )}

      {/* Measurement result display */}
      {measureResult && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-panel border border-border rounded px-3 py-2 text-sm">
          <span className="font-medium">Distance:</span> {measureResult.distance.toFixed(2)}m
          <span className="mx-2">|</span>
          <span className="font-medium">Depth diff:</span> {measureResult.depthDiff.toFixed(2)}m
        </div>
      )}

      {/* Move drag indicator */}
      {moveDrag && (
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
