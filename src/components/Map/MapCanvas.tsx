import { useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { getBounds } from '../../utils/coordinates';
import SurveyLayer from './SurveyLayer';

export default function MapCanvas() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const surveyLayerRef = useRef<SurveyLayer | null>(null);

  const { project, stations, config } = useProjectStore();
  const {
    mapZoom,
    setMapCenter,
    setMapZoom,
    activeTool,
    showGrid,
    showSatellite,
  } = useUIStore();

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
      surveyLayerRef.current = new SurveyLayer(map.current);
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

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full" />

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
    </div>
  );
}
