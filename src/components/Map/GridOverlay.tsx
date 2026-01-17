import { useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { metersToMapCoords } from '../../utils/coordinates';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';

interface GridOverlayProps {
  map: maplibregl.Map;
}

/** Available grid spacing options in meters */
export const GRID_SPACING_OPTIONS = [1, 5, 10, 25, 50, 100] as const;

/**
 * GridOverlay renders a coordinate grid on the map that scales with the survey data.
 * Grid lines are rendered in map coordinates (meters) and update when the map view changes.
 */
export default function GridOverlay({ map }: GridOverlayProps) {
  const layerAdded = useRef(false);
  const { showGrid, gridSpacing } = useUIStore();
  const { stations, config } = useProjectStore();

  const gridColor = config?.display.grid_color ?? '#333366';

  // Generate grid GeoJSON based on current station bounds
  const generateGridGeoJSON = useCallback((): GeoJSON.FeatureCollection => {
    if (stations.length === 0) {
      return { type: 'FeatureCollection', features: [] };
    }

    // Calculate bounds from stations
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const station of stations) {
      const { x, y } = station.coordinates;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    // Expand bounds by 20% for padding
    const width = maxX - minX;
    const height = maxY - minY;
    const padding = Math.max(width, height) * 0.2;
    minX -= padding;
    maxX += padding;
    minY -= padding;
    maxY += padding;

    // Align to grid spacing
    const gridMinX = Math.floor(minX / gridSpacing) * gridSpacing;
    const gridMaxX = Math.ceil(maxX / gridSpacing) * gridSpacing;
    const gridMinY = Math.floor(minY / gridSpacing) * gridSpacing;
    const gridMaxY = Math.ceil(maxY / gridSpacing) * gridSpacing;

    const features: GeoJSON.Feature[] = [];

    // Vertical lines (constant X)
    for (let x = gridMinX; x <= gridMaxX; x += gridSpacing) {
      const start = metersToMapCoords(x, gridMinY);
      const end = metersToMapCoords(x, gridMaxY);
      features.push({
        type: 'Feature',
        properties: { type: 'grid-line' },
        geometry: {
          type: 'LineString',
          coordinates: [start, end],
        },
      });
    }

    // Horizontal lines (constant Y)
    for (let y = gridMinY; y <= gridMaxY; y += gridSpacing) {
      const start = metersToMapCoords(gridMinX, y);
      const end = metersToMapCoords(gridMaxX, y);
      features.push({
        type: 'Feature',
        properties: { type: 'grid-line' },
        geometry: {
          type: 'LineString',
          coordinates: [start, end],
        },
      });
    }

    return { type: 'FeatureCollection', features };
  }, [stations, gridSpacing]);

  // Add/update grid layer
  useEffect(() => {
    if (!map) return;

    const sourceId = 'grid-source';
    const layerId = 'grid-lines';

    const updateGrid = () => {
      const geojson = generateGridGeoJSON();
      const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(geojson);
      }
    };

    if (showGrid && !layerAdded.current) {
      // Add source and layer
      const geojson = generateGridGeoJSON();

      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: 'geojson',
          data: geojson,
        });
      }

      if (!map.getLayer(layerId)) {
        // Insert below survey layers if they exist
        const surveyLayer = map.getLayer('survey-shots');
        map.addLayer(
          {
            id: layerId,
            type: 'line',
            source: sourceId,
            paint: {
              'line-color': gridColor,
              'line-width': 0.5,
              'line-opacity': 0.4,
            },
          },
          surveyLayer ? 'survey-shots' : undefined
        );
      }

      layerAdded.current = true;
    } else if (!showGrid && layerAdded.current) {
      // Remove layer and source
      if (map.getLayer(layerId)) {
        map.removeLayer(layerId);
      }
      if (map.getSource(sourceId)) {
        map.removeSource(sourceId);
      }
      layerAdded.current = false;
    } else if (showGrid && layerAdded.current) {
      // Update existing grid data
      updateGrid();
    }

    return () => {
      // Cleanup on unmount
      if (map.getLayer(layerId)) {
        map.removeLayer(layerId);
      }
      if (map.getSource(sourceId)) {
        map.removeSource(sourceId);
      }
      layerAdded.current = false;
    };
  }, [map, showGrid, generateGridGeoJSON, gridColor]);

  // Update grid color when config changes
  useEffect(() => {
    if (!map || !showGrid) return;

    const layerId = 'grid-lines';
    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, 'line-color', gridColor);
    }
  }, [map, showGrid, gridColor]);

  // Update grid when spacing changes
  useEffect(() => {
    if (!map || !showGrid) return;

    const sourceId = 'grid-source';
    const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(generateGridGeoJSON());
    }
  }, [map, showGrid, gridSpacing, generateGridGeoJSON]);

  return null;
}
