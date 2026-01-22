import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { useProjectStore } from '../../store/projectStore';
import { metersToMapCoords, getBounds } from '../../utils/coordinates';
import {
  calculateDepthRange,
  computeStationColor,
  computeShotColor,
  formatDepth,
  type DepthPresetColors,
} from '../../utils/export-colors';
import type { ExportImageOptions } from '../../types/commands';

/** Theme mode for the export preview */
export type ExportTheme = 'dark' | 'light';

// Re-export DepthPresetColors for consumers that import from this file
export type { DepthPresetColors };

interface ExportPreviewProps {
  /** Export options that affect preview appearance */
  options: ExportImageOptions;
  /** Theme for the preview (dark or light) */
  theme: ExportTheme;
  /** Preset colors for depth gradient (fetched from backend) */
  presetColors?: DepthPresetColors | null;
}

/** Debounce delay in milliseconds */
const DEBOUNCE_DELAY = 300;

/**
 * Export preview component that shows a 300x300 preview of what the
 * exported map image will look like. Updates are debounced for performance.
 *
 * Supports both section color mode and depth gradient mode. When depth mode
 * is active, colors are derived from station/shot depths using preset stops.
 */
export default function ExportPreview({ options, theme, presetColors }: ExportPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const updateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { project, stations } = useProjectStore();

  const [isLoading, setIsLoading] = useState(true);
  const [mapReady, setMapReady] = useState(false);

  // Theme colors
  const colors = useMemo(
    () => ({
      background: theme === 'dark' ? '#1a1a2e' : '#f5f5f5',
      gridColor: theme === 'dark' ? '#333366' : '#cccccc',
      textColor: theme === 'dark' ? '#f5f5f5' : '#1a1a1a',
      textHalo: theme === 'dark' ? '#1a1a2e' : '#ffffff',
    }),
    [theme]
  );

  // Initialize MapLibre instance
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    setIsLoading(true);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {},
        glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
        layers: [
          {
            id: 'background',
            type: 'background',
            paint: {
              'background-color': colors.background,
            },
          },
        ],
      },
      center: [0, 0],
      zoom: 14,
      attributionControl: false,
      interactive: false, // Preview is non-interactive
    });

    mapRef.current = map;

    map.on('load', () => {
      if (!mapRef.current) return;

      // Add grid source (if grid is enabled)
      map.addSource('preview-grid', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Add shots source
      map.addSource('preview-shots', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Add stations source
      map.addSource('preview-stations', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Add section labels source
      map.addSource('preview-section-labels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Add station labels source
      map.addSource('preview-station-labels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Add shot labels source
      map.addSource('preview-shot-labels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Add grid layer (rendered first, below everything)
      map.addLayer({
        id: 'preview-grid-layer',
        type: 'line',
        source: 'preview-grid',
        paint: {
          'line-color': colors.gridColor,
          'line-width': 0.5,
          'line-opacity': 0.5,
        },
        layout: {
          visibility: 'none',
        },
      });

      // Add shots layer
      map.addLayer({
        id: 'preview-shots-layer',
        type: 'line',
        source: 'preview-shots',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
          'line-opacity': ['case', ['get', 'isVirtual'], 0.5, 1],
        },
      });

      // Add stations layer
      map.addLayer({
        id: 'preview-stations-layer',
        type: 'circle',
        source: 'preview-stations',
        paint: {
          'circle-radius': [
            'case',
            ['get', 'isZeroDatum'],
            6,
            3,
          ],
          'circle-color': [
            'case',
            ['get', 'isZeroDatum'],
            '#ffd700',
            ['get', 'color'],
          ],
          'circle-stroke-width': 1,
          'circle-stroke-color': theme === 'dark' ? '#000000' : '#333333',
        },
      });

      // Add section labels layer
      map.addLayer({
        id: 'preview-section-labels-layer',
        type: 'symbol',
        source: 'preview-section-labels',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Regular'],
          'text-size': 10,
          'text-offset': [0, -1.2],
          'text-anchor': 'bottom',
          'text-allow-overlap': false,
          visibility: 'none',
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': colors.textHalo,
          'text-halo-width': 1.5,
        },
      });

      // Add station labels layer
      map.addLayer({
        id: 'preview-station-labels-layer',
        type: 'symbol',
        source: 'preview-station-labels',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Regular'],
          'text-size': 8,
          'text-offset': [0.8, -0.8],
          'text-anchor': 'bottom-left',
          'text-allow-overlap': false,
          visibility: 'none',
        },
        paint: {
          'text-color': colors.textColor,
          'text-halo-color': colors.textHalo,
          'text-halo-width': 1.5,
        },
      });

      // Add shot labels layer
      map.addLayer({
        id: 'preview-shot-labels-layer',
        type: 'symbol',
        source: 'preview-shot-labels',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Regular'],
          'text-size': 7,
          'text-offset': [0, 0.5],
          'text-anchor': 'top',
          'text-allow-overlap': false,
          visibility: 'none',
        },
        paint: {
          'text-color': colors.textColor,
          'text-halo-color': colors.textHalo,
          'text-halo-width': 1.5,
        },
      });

      setMapReady(true);
      setIsLoading(false);
    });

    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
      mapRef.current = null;
      setMapReady(false);
      map.remove();
    };
  }, []);

  // Update map theme when theme changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // Update background color
    map.setPaintProperty('background', 'background-color', colors.background);

    // Update grid color
    if (map.getLayer('preview-grid-layer')) {
      map.setPaintProperty('preview-grid-layer', 'line-color', colors.gridColor);
    }

    // Update station stroke color
    if (map.getLayer('preview-stations-layer')) {
      map.setPaintProperty(
        'preview-stations-layer',
        'circle-stroke-color',
        theme === 'dark' ? '#000000' : '#333333'
      );
    }

    // Update label colors
    if (map.getLayer('preview-section-labels-layer')) {
      map.setPaintProperty('preview-section-labels-layer', 'text-halo-color', colors.textHalo);
    }
    if (map.getLayer('preview-station-labels-layer')) {
      map.setPaintProperty('preview-station-labels-layer', 'text-color', colors.textColor);
      map.setPaintProperty('preview-station-labels-layer', 'text-halo-color', colors.textHalo);
    }
    if (map.getLayer('preview-shot-labels-layer')) {
      map.setPaintProperty('preview-shot-labels-layer', 'text-color', colors.textColor);
      map.setPaintProperty('preview-shot-labels-layer', 'text-halo-color', colors.textHalo);
    }
  }, [theme, colors, mapReady]);

  // Debounced update function
  const updatePreview = useCallback(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !project) return;

    setIsLoading(true);

    const sections = project.sections;
    const colorMode = options.color_mode ?? 'section';
    const presetStops = presetColors?.stops ?? null;

    // Compute depth range using pure function
    const depthRange = calculateDepthRange(stations);

    // Get unit and precision for labels (clamp precision to match Rust backend's MAX_DECIMAL_PRECISION)
    const depthUnit = options.depth_unit || 'm';
    const rawPrecision = options.decimal_precision ?? 1;
    const decimalPrecision = Math.max(0, Math.min(6, Math.floor(rawPrecision) || 0));

    // Build shot features
    const shotFeatures: GeoJSON.Feature[] = [];
    const shotLabelFeatures: GeoJSON.Feature[] = [];

    for (const section of sections) {
      const sectionStations = stations
        .filter((s) => s.station_ref.section_id === section.id)
        .sort((a, b) => a.station_ref.station_index - b.station_ref.station_index);

      for (let i = 0; i < section.shots.length; i++) {
        const shot = section.shots[i];
        const fromStation = sectionStations[i];
        const toStation = sectionStations[i + 1];

        if (fromStation && toStation && shot) {
          // Compute shot color using pure function
          const shotColor = computeShotColor(
            fromStation.coordinates.z,
            toStation.coordinates.z,
            section.color,
            colorMode,
            depthRange,
            presetStops,
          );

          shotFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                metersToMapCoords(fromStation.coordinates.x, fromStation.coordinates.y),
                metersToMapCoords(toStation.coordinates.x, toStation.coordinates.y),
              ],
            },
            properties: {
              sectionId: section.id,
              shotId: shot.id,
              color: shotColor,
              isVirtual: shot.is_virtual,
            },
          });

          // Generate shot label at midpoint
          if (options.include_shot_data) {
            const midX = (fromStation.coordinates.x + toStation.coordinates.x) / 2;
            const midY = (fromStation.coordinates.y + toStation.coordinates.y) / 2;
            const avgDepth = (fromStation.coordinates.z + toStation.coordinates.z) / 2;
            // Format with proper units and precision
            const depthLabel = formatDepth(avgDepth, depthUnit, decimalPrecision);
            const lengthLabel = `${shot.length.toFixed(decimalPrecision)}m`;
            const label = `${shot.azimuth_in.toFixed(0)}° ${lengthLabel} ${depthLabel}`;

            shotLabelFeatures.push({
              type: 'Feature',
              geometry: {
                type: 'Point',
                coordinates: metersToMapCoords(midX, midY),
              },
              properties: { label },
            });
          }
        }
      }
    }

    // Build station features using pure function
    const stationFeatures: GeoJSON.Feature[] = stations.map((station) => {
      const section = sections.find((s) => s.id === station.station_ref.section_id);

      // Compute station color using pure function (handles zero datum gold color)
      const stationColor = computeStationColor(
        station,
        section?.color ?? '#ffffff',
        colorMode,
        depthRange,
        presetStops,
      );

      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: metersToMapCoords(station.coordinates.x, station.coordinates.y),
        },
        properties: {
          sectionId: station.station_ref.section_id,
          stationIndex: station.station_ref.station_index,
          isZeroDatum: station.is_zero_datum,
          color: stationColor,
        },
      };
    });

    // Build station label features
    const stationLabelFeatures: GeoJSON.Feature[] = options.include_labels
      ? stations.map((station) => ({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(station.coordinates.x, station.coordinates.y),
          },
          properties: {
            label: String(station.station_ref.station_index),
          },
        }))
      : [];

    // Build section name label features (at first station of each section)
    const sectionLabelFeatures: GeoJSON.Feature[] = [];
    if (options.include_section_names) {
      for (const section of sections) {
        const sectionStations = stations.filter((s) => s.station_ref.section_id === section.id);
        if (sectionStations.length > 0) {
          const firstStation = sectionStations.reduce((min, s) =>
            s.station_ref.station_index < min.station_ref.station_index ? s : min
          );
          sectionLabelFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: metersToMapCoords(firstStation.coordinates.x, firstStation.coordinates.y),
            },
            properties: {
              name: section.name,
              color: section.color,
            },
          });
        }
      }
    }

    // Build grid features if enabled
    const gridFeatures: GeoJSON.Feature[] = [];
    if (options.include_grid && stations.length > 0) {
      const coords = stations.map((s) => s.coordinates);
      const bounds = getBounds(coords);

      // Add padding
      const padding = 20;
      const minX = Math.floor((bounds.minX - padding) / 10) * 10;
      const maxX = Math.ceil((bounds.maxX + padding) / 10) * 10;
      const minY = Math.floor((bounds.minY - padding) / 10) * 10;
      const maxY = Math.ceil((bounds.maxY + padding) / 10) * 10;

      // Create grid lines (every 10 meters)
      for (let x = minX; x <= maxX; x += 10) {
        gridFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              metersToMapCoords(x, minY),
              metersToMapCoords(x, maxY),
            ],
          },
          properties: {},
        });
      }
      for (let y = minY; y <= maxY; y += 10) {
        gridFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              metersToMapCoords(minX, y),
              metersToMapCoords(maxX, y),
            ],
          },
          properties: {},
        });
      }
    }

    // Update sources
    const shotsSource = map.getSource('preview-shots');
    if (shotsSource && 'setData' in shotsSource) {
      (shotsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: shotFeatures,
      });
    }

    const stationsSource = map.getSource('preview-stations');
    if (stationsSource && 'setData' in stationsSource) {
      (stationsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: stationFeatures,
      });
    }

    const sectionLabelsSource = map.getSource('preview-section-labels');
    if (sectionLabelsSource && 'setData' in sectionLabelsSource) {
      (sectionLabelsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: sectionLabelFeatures,
      });
    }

    const stationLabelsSource = map.getSource('preview-station-labels');
    if (stationLabelsSource && 'setData' in stationLabelsSource) {
      (stationLabelsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: stationLabelFeatures,
      });
    }

    const shotLabelsSource = map.getSource('preview-shot-labels');
    if (shotLabelsSource && 'setData' in shotLabelsSource) {
      (shotLabelsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: shotLabelFeatures,
      });
    }

    const gridSource = map.getSource('preview-grid');
    if (gridSource && 'setData' in gridSource) {
      (gridSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: gridFeatures,
      });
    }

    // Update layer visibility (with guards in case layers failed to create)
    if (map.getLayer('preview-grid-layer')) {
      map.setLayoutProperty(
        'preview-grid-layer',
        'visibility',
        options.include_grid ? 'visible' : 'none'
      );
    }
    if (map.getLayer('preview-section-labels-layer')) {
      map.setLayoutProperty(
        'preview-section-labels-layer',
        'visibility',
        options.include_section_names ? 'visible' : 'none'
      );
    }
    if (map.getLayer('preview-station-labels-layer')) {
      map.setLayoutProperty(
        'preview-station-labels-layer',
        'visibility',
        options.include_labels ? 'visible' : 'none'
      );
    }
    if (map.getLayer('preview-shot-labels-layer')) {
      map.setLayoutProperty(
        'preview-shot-labels-layer',
        'visibility',
        options.include_shot_data ? 'visible' : 'none'
      );
    }

    // Fit bounds to show all content
    if (stations.length > 0) {
      const coords = stations.map((s) => s.coordinates);
      const bounds = getBounds(coords);
      const extentX = bounds.maxX - bounds.minX;
      const extentY = bounds.maxY - bounds.minY;
      const minExtent = 1;

      if (extentX < minExtent && extentY < minExtent) {
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        map.jumpTo({
          center: metersToMapCoords(centerX, centerY),
          zoom: 16,
        });
      } else {
        const sw = metersToMapCoords(bounds.minX, bounds.minY);
        const ne = metersToMapCoords(bounds.maxX, bounds.maxY);

        map.fitBounds([sw, ne], {
          padding: 20,
          maxZoom: 18,
          duration: 0, // No animation for preview
        });
      }
    }

    setIsLoading(false);
  }, [project, stations, options, mapReady, presetColors]);

  // Debounced effect for options changes
  useEffect(() => {
    if (!mapReady) return;

    setIsLoading(true);

    // Clear any pending update
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
    }

    // Schedule new update
    updateTimeoutRef.current = setTimeout(() => {
      updatePreview();
    }, DEBOUNCE_DELAY);

    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
    };
  }, [options, mapReady, updatePreview]);

  // Initial render when map becomes ready
  useEffect(() => {
    if (mapReady) {
      updatePreview();
    }
  }, [mapReady, updatePreview]);

  return (
    <div
      data-testid="export-preview"
      className="relative border border-border rounded overflow-hidden bg-background"
      style={{ width: 300, height: 300 }}
    >
      {/* Map container */}
      <div ref={containerRef} className="w-full h-full" />

      {/* Loading overlay */}
      {isLoading && (
        <div
          data-testid="export-preview-loading"
          className="absolute inset-0 flex items-center justify-center bg-background/80"
        >
          <div className="flex flex-col items-center gap-2">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-text-secondary">Rendering preview...</span>
          </div>
        </div>
      )}

      {/* Empty state when no project */}
      {!project && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background text-text-secondary text-sm">
          No project loaded
        </div>
      )}
    </div>
  );
}
