import { useEffect, useRef, useState, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import type { DmpSection, DmpShot } from '../../types/commands';
import type { Section, Station, Shot } from '../../types/project';
import { metersToMapCoords, getBounds } from '../../utils/coordinates';
import { circularMeanDegrees } from '../../utils/angles';
import { useUIStore } from '../../store/uiStore';
import { getMapThemeColors, getThemeColor } from '../../utils/themeColors';
import { getTileConfig } from '../../utils/tileConfig';
import type { GpsOrigin } from '../../types/config';

/**
 * Merge preview configuration for "From Existing" placement mode.
 * Shows both sections positioned correctly with a connection line.
 */
export interface MergePreviewConfig {
  /** The existing/target section to merge with */
  targetSection: Section;
  /** Station index in the current (import) section to merge */
  importStationIndex: number;
  /** Station index in the target section to merge */
  targetStationIndex: number;
}

/**
 * Compute station coordinates from DMP shots.
 * Each station is positioned relative to the previous one based on shot heading and length.
 * Depth change uses depth_in/out to stay consistent with placement overlay behavior.
 */
function computeStationsFromDmpShots(shots: DmpShot[]): Array<{ x: number; y: number; z: number }> {
  // Start at origin
  const stations: Array<{ x: number; y: number; z: number }> = [{ x: 0, y: 0, z: 0 }];

  for (const shot of shots) {
    if (shot.shot_type !== 'Standard') continue;

    const prev = stations[stations.length - 1];
    if (!prev) continue;

    // Use circular mean for heading to handle wrap-around correctly
    const azimuth = circularMeanDegrees(shot.heading_in, shot.heading_out);
    const azimuthRad = (azimuth * Math.PI) / 180;

    const depthChange = shot.depth_out - shot.depth_in;

    // Compute next station position
    const x = prev.x + shot.length * Math.sin(azimuthRad);
    const y = prev.y + shot.length * Math.cos(azimuthRad);
    const z = prev.z + depthChange;

    stations.push({ x, y, z });
  }

  return stations;
}

/**
 * Compute station coordinates from project Section shots.
 * Used for existing sections in merge preview.
 * Depth change uses depth_in/out to stay consistent with placement overlay behavior.
 */
function computeStationsFromShots(shots: Shot[]): Array<{ x: number; y: number; z: number }> {
  // Start at origin
  const stations: Array<{ x: number; y: number; z: number }> = [{ x: 0, y: 0, z: 0 }];

  for (const shot of shots) {
    // Skip reference shots for position calculation
    if (shot.is_reference) continue;

    const prev = stations[stations.length - 1];
    if (!prev) continue;

    // Use circular mean for heading to handle wrap-around correctly
    const azimuth = circularMeanDegrees(shot.azimuth_in, shot.azimuth_out);
    const azimuthRad = (azimuth * Math.PI) / 180;

    const depthChange = shot.depth_out - shot.depth_in;

    // Compute next station position
    const x = prev.x + shot.length * Math.sin(azimuthRad);
    const y = prev.y + shot.length * Math.cos(azimuthRad);
    const z = prev.z + depthChange;

    stations.push({ x, y, z });
  }

  return stations;
}

interface SectionPreviewProps {
  /** The section to preview. When null, shows empty state. */
  section: DmpSection | null;
  /** Color for the section lines and stations */
  color?: string;
  /** Existing station to connect to (for "From Existing Station" placement mode) - legacy prop */
  existingStation?: Station | null;
  /** Which station of the import to connect: 'first' or 'last' - legacy prop */
  importStationIndex?: 'first' | 'last' | null;
  /** Merge preview configuration - shows both sections with proper alignment */
  mergePreview?: MergePreviewConfig | null;
  /** Callback when a station dot is clicked */
  onStationClick?: (stationIndex: number) => void;
  /** Index of the currently selected station (shows highlight ring) */
  selectedStationIndex?: number | null;
  /** Size of the preview container in pixels (default 250) */
  size?: number;
  /** GPS origin for real-world positioning. When set, enables satellite tiles and positions geometry at real coordinates. */
  gpsOrigin?: GpsOrigin | null;
  /** Station index to offset the gpsOrigin to (default 0). The section is positioned so this station sits at gpsOrigin. */
  gpsStationIndex?: number;
}

/**
 * A minimal MapLibre preview component for showing section shape.
 * - Configurable size (default 250x250)
 * - Station dots + shot lines
 * - Zoom (wheel, 0.25x to 4x) + pan (drag)
 * - Click on station to select (optional callback)
 * - Selected station shows highlight ring
 * - Auto-fits bounds when section changes
 * - No labels (minimal view)
 * - Shows merge preview with both sections when mergePreview is provided
 * - Shows connection line when existingStation is provided (legacy mode)
 */
export default function SectionPreview({
  section,
  color = getThemeColor('--cc-accent'),
  existingStation,
  importStationIndex,
  mergePreview,
  onStationClick,
  selectedStationIndex,
  size = 250,
  gpsOrigin,
  gpsStationIndex = 0,
}: SectionPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const onStationClickRef = useRef(onStationClick);
  const resolvedTheme = useUIStore((s) => s.resolvedTheme);

  // Keep ref updated
  useEffect(() => {
    onStationClickRef.current = onStationClick;
  }, [onStationClick]);

  // Compute stations from shots for the current (import) section
  const stations = useMemo(() => {
    if (!section) return [];
    const standardShots = section.shots.filter((s) => s.shot_type === 'Standard');
    return computeStationsFromDmpShots(standardShots);
  }, [section]);

  // Compute stations for the target section (for merge preview)
  const targetStations = useMemo(() => {
    if (!mergePreview) return [];
    const nonReferenceShots = mergePreview.targetSection.shots.filter((s) => !s.is_reference);
    return computeStationsFromShots(nonReferenceShots);
  }, [mergePreview]);

  // Compute offset so the GPS station sits at the GPS origin (local 0,0)
  const gpsStationOffset = useMemo(() => {
    if (!gpsOrigin || stations.length === 0) return { x: 0, y: 0 };
    const station = stations[gpsStationIndex];
    if (!station) return { x: 0, y: 0 };
    return { x: -station.x, y: -station.y };
  }, [gpsOrigin, stations, gpsStationIndex]);

  // Initialize MapLibre instance - container is always mounted
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Base zoom level 14 represents 1x
    // Allow zooming out to 0.25x and in much further for detail
    const baseZoom = 14;
    const minZoom = baseZoom - 2; // 0.25x (zoom level 12)
    const maxZoom = 22; // Maximum zoom for detailed inspection

    const initialThemeColors = getMapThemeColors();
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: 'background',
            type: 'background',
            paint: {
              'background-color': initialThemeColors.previewBg,
            },
          },
        ],
      },
      center: [0, 0],
      zoom: baseZoom,
      minZoom,
      maxZoom,
      attributionControl: false,
      interactive: true,
    });

    // Store map ref immediately for cleanup support
    mapRef.current = map;

    // Disable rotation
    map.dragRotate.disable();
    map.touchPitch.disable();

    map.on('load', () => {
      // Check if map was removed during async load
      if (!mapRef.current) return;

      // Add sources
      map.addSource('preview-shots', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addSource('preview-stations', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addSource('preview-connection', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addSource('preview-existing-station', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addSource('preview-selected-station', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Sources for merge preview
      map.addSource('preview-target-shots', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addSource('preview-target-stations', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addSource('preview-merge-highlight', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Add target section shot lines layer (dimmed, rendered first so it's behind)
      map.addLayer({
        id: 'preview-target-shots-layer',
        type: 'line',
        source: 'preview-target-shots',
        paint: {
          'line-color': initialThemeColors.grayLine,
          'line-width': 1.5,
          'line-opacity': 0.6,
        },
      });

      // Add target section stations layer (dimmed)
      map.addLayer({
        id: 'preview-target-stations-layer',
        type: 'circle',
        source: 'preview-target-stations',
        paint: {
          'circle-radius': 3,
          'circle-color': initialThemeColors.grayLine,
          'circle-stroke-width': 1,
          'circle-stroke-color': initialThemeColors.strokeColor,
          'circle-opacity': 0.6,
        },
      });

      // Add shot lines layer
      map.addLayer({
        id: 'preview-shots-layer',
        type: 'line',
        source: 'preview-shots',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
        },
      });

      // Add connection line layer (dashed line)
      map.addLayer({
        id: 'preview-connection-layer',
        type: 'line',
        source: 'preview-connection',
        paint: {
          'line-color': initialThemeColors.zeroDatum,
          'line-width': 2,
          'line-dasharray': [4, 4],
        },
      });

      // Add stations layer
      map.addLayer({
        id: 'preview-stations-layer',
        type: 'circle',
        source: 'preview-stations',
        paint: {
          'circle-radius': 4,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 1,
          'circle-stroke-color': initialThemeColors.strokeColor,
        },
      });

      // Add existing station layer (different color)
      map.addLayer({
        id: 'preview-existing-station-layer',
        type: 'circle',
        source: 'preview-existing-station',
        paint: {
          'circle-radius': 6,
          'circle-color': initialThemeColors.zeroDatum,
          'circle-stroke-width': 2,
          'circle-stroke-color': initialThemeColors.strokeColor,
        },
      });

      // Add selected station highlight layer (ring around selected station)
      map.addLayer({
        id: 'preview-selected-station-layer',
        type: 'circle',
        source: 'preview-selected-station',
        paint: {
          'circle-radius': 8,
          'circle-color': 'transparent',
          'circle-stroke-width': 3,
          'circle-stroke-color': initialThemeColors.compassColor,
        },
      });

      // Add merge highlight layer (highlighted merge stations)
      map.addLayer({
        id: 'preview-merge-highlight-layer',
        type: 'circle',
        source: 'preview-merge-highlight',
        paint: {
          'circle-radius': 7,
          'circle-color': initialThemeColors.selectHighlight,
          'circle-stroke-width': 2,
          'circle-stroke-color': initialThemeColors.compassColor,
        },
      });

      // Cursor changes to pointer on station hover
      map.on('mouseenter', 'preview-stations-layer', () => {
        map.getCanvas().style.cursor = 'pointer';
      });

      map.on('mouseleave', 'preview-stations-layer', () => {
        map.getCanvas().style.cursor = '';
      });

      // Click handler for station selection
      map.on('click', 'preview-stations-layer', (e) => {
        const feature = e.features?.[0];
        if (feature) {
          const stationIndex = feature.properties?.stationIndex;
          if (typeof stationIndex === 'number' && onStationClickRef.current) {
            onStationClickRef.current(stationIndex);
          }
        }
      });

      setMapLoaded(true);
    });

    return () => {
      mapRef.current = null;
      setMapLoaded(false);
      map.remove();
    };
  }, []);

  // Toggle satellite tiles when gpsOrigin changes
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;

    if (gpsOrigin) {
      // Add satellite tiles if not already present
      if (!map.getSource('satellite-tiles')) {
        const tileConfig = getTileConfig('esri');
        map.addSource('satellite-tiles', {
          type: 'raster',
          tiles: tileConfig.tiles,
          tileSize: tileConfig.tileSize,
          attribution: tileConfig.attribution,
          minzoom: tileConfig.minZoom,
          maxzoom: tileConfig.maxZoom,
        });
        // Insert satellite below all other layers (above background)
        map.addLayer(
          {
            id: 'satellite-tiles-layer',
            type: 'raster',
            source: 'satellite-tiles',
            paint: { 'raster-opacity': 0.85 },
          },
          'preview-target-shots-layer'
        );
      }
      // Dim the background so satellite shows through
      if (map.getLayer('background')) {
        map.setPaintProperty('background', 'background-opacity', 0);
      }
    } else {
      // Remove satellite tiles
      if (map.getLayer('satellite-tiles-layer')) {
        map.removeLayer('satellite-tiles-layer');
      }
      if (map.getSource('satellite-tiles')) {
        map.removeSource('satellite-tiles');
      }
      // Restore background
      if (map.getLayer('background')) {
        map.setPaintProperty('background', 'background-opacity', 1);
      }
    }
  }, [gpsOrigin, mapLoaded]);

  // Update data and fit bounds when section changes
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;

    const map = mapRef.current;

    // Calculate offset for merge preview - positions the import section so merge stations align
    let importOffset = { x: 0, y: 0 };
    if (mergePreview && stations.length > 0 && targetStations.length > 0) {
      const importMergeStation = stations[mergePreview.importStationIndex];
      const targetMergeStation = targetStations[mergePreview.targetStationIndex];
      if (importMergeStation && targetMergeStation) {
        // Calculate offset to align import station with target station
        importOffset = {
          x: targetMergeStation.x - importMergeStation.x,
          y: targetMergeStation.y - importMergeStation.y,
        };
      }
    }

    // Combined offset: merge preview alignment + GPS station positioning
    const totalOffset = {
      x: importOffset.x + gpsStationOffset.x,
      y: importOffset.y + gpsStationOffset.y,
    };

    // Build shot features for the current (import) section with offset
    const shotFeatures: GeoJSON.Feature[] = [];
    const standardShots = section?.shots.filter((s) => s.shot_type === 'Standard') ?? [];

    for (let i = 0; i < standardShots.length; i++) {
      const from = stations[i];
      const to = stations[i + 1];
      if (!from || !to) continue;

      shotFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            metersToMapCoords(from.x + totalOffset.x, from.y + totalOffset.y, gpsOrigin),
            metersToMapCoords(to.x + totalOffset.x, to.y + totalOffset.y, gpsOrigin),
          ],
        },
        properties: { color },
      });
    }

    // Build station features with offset for click handling
    const stationFeatures: GeoJSON.Feature[] = stations.map((station, index) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: metersToMapCoords(station.x + totalOffset.x, station.y + totalOffset.y, gpsOrigin),
      },
      properties: { color, stationIndex: index },
    }));

    // Build target section features (for merge preview)
    const targetShotFeatures: GeoJSON.Feature[] = [];
    const targetStationFeatures: GeoJSON.Feature[] = [];
    const mergeHighlightFeatures: GeoJSON.Feature[] = [];
    const connectionFeatures: GeoJSON.Feature[] = [];

    if (mergePreview && targetStations.length > 0) {
      const targetSection = mergePreview.targetSection;
      const nonReferenceShots = targetSection.shots.filter((s) => !s.is_reference);

      // Build target section shots
      for (let i = 0; i < nonReferenceShots.length; i++) {
        const from = targetStations[i];
        const to = targetStations[i + 1];
        if (!from || !to) continue;

        targetShotFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              metersToMapCoords(from.x, from.y, gpsOrigin),
              metersToMapCoords(to.x, to.y, gpsOrigin),
            ],
          },
          properties: {},
        });
      }

      // Build target section stations
      for (let i = 0; i < targetStations.length; i++) {
        const station = targetStations[i];
        if (!station) continue;
        targetStationFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(station.x, station.y, gpsOrigin),
          },
          properties: { stationIndex: i },
        });
      }

      // Highlight the merge stations
      const importMergeStation = stations[mergePreview.importStationIndex];
      const targetMergeStation = targetStations[mergePreview.targetStationIndex];

      if (importMergeStation) {
        mergeHighlightFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(
              importMergeStation.x + totalOffset.x,
              importMergeStation.y + totalOffset.y,
              gpsOrigin
            ),
          },
          properties: { type: 'import' },
        });
      }

      if (targetMergeStation) {
        mergeHighlightFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(targetMergeStation.x, targetMergeStation.y, gpsOrigin),
          },
          properties: { type: 'target' },
        });
      }

      // Draw dotted connection line between merge stations
      // Since they should be at the same position after offset, we show a small indicator
      if (importMergeStation && targetMergeStation) {
        connectionFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              metersToMapCoords(
                importMergeStation.x + totalOffset.x,
                importMergeStation.y + totalOffset.y,
                gpsOrigin
              ),
              metersToMapCoords(targetMergeStation.x, targetMergeStation.y, gpsOrigin),
            ],
          },
          properties: {},
        });
      }
    }

    // Legacy mode: Build connection line and existing station features
    const existingStationFeatures: GeoJSON.Feature[] = [];

    if (!mergePreview && existingStation && stations.length > 0 && importStationIndex) {
      // Determine which import station to connect
      const importStationCoords =
        importStationIndex === 'first' ? stations[0] : stations[stations.length - 1];

      if (importStationCoords) {
        // For visualization, we'll show a simple connection indicator
        // by placing the existing station at an offset from the import station
        const offsetX = 10; // Show existing station 10m to the side for visibility
        const offsetY = 10;

        const existingX = importStationCoords.x + offsetX;
        const existingY = importStationCoords.y + offsetY;

        // Add connection line
        connectionFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              metersToMapCoords(importStationCoords.x, importStationCoords.y, gpsOrigin),
              metersToMapCoords(existingX, existingY, gpsOrigin),
            ],
          },
          properties: {},
        });

        // Add existing station marker
        existingStationFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(existingX, existingY, gpsOrigin),
          },
          properties: { label: 'Existing' },
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

    const connectionSource = map.getSource('preview-connection');
    if (connectionSource && 'setData' in connectionSource) {
      (connectionSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: connectionFeatures,
      });
    }

    const existingStationSource = map.getSource('preview-existing-station');
    if (existingStationSource && 'setData' in existingStationSource) {
      (existingStationSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: existingStationFeatures,
      });
    }

    // Update merge preview sources
    const targetShotsSource = map.getSource('preview-target-shots');
    if (targetShotsSource && 'setData' in targetShotsSource) {
      (targetShotsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: targetShotFeatures,
      });
    }

    const targetStationsSource = map.getSource('preview-target-stations');
    if (targetStationsSource && 'setData' in targetStationsSource) {
      (targetStationsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: targetStationFeatures,
      });
    }

    const mergeHighlightSource = map.getSource('preview-merge-highlight');
    if (mergeHighlightSource && 'setData' in mergeHighlightSource) {
      (mergeHighlightSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: mergeHighlightFeatures,
      });
    }

    // Build and update selected station highlight feature (with combined offset)
    const selectedStationFeatures: GeoJSON.Feature[] = [];
    if (
      selectedStationIndex !== null &&
      selectedStationIndex !== undefined &&
      selectedStationIndex >= 0 &&
      selectedStationIndex < stations.length
    ) {
      const selectedStation = stations[selectedStationIndex];
      if (selectedStation) {
        selectedStationFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(
              selectedStation.x + totalOffset.x,
              selectedStation.y + totalOffset.y,
              gpsOrigin
            ),
          },
          properties: {},
        });
      }
    }

    const selectedStationSource = map.getSource('preview-selected-station');
    if (selectedStationSource && 'setData' in selectedStationSource) {
      (selectedStationSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: selectedStationFeatures,
      });
    }

    // Fit bounds if we have stations - do this after a small delay to ensure
    // the container has proper dimensions and the map is fully rendered
    if (stations.length > 0) {
      const doFitBounds = () => {
        // Get bounds for import section (with combined offset applied)
        const offsetStations = stations.map((s) => ({
          x: s.x + totalOffset.x,
          y: s.y + totalOffset.y,
          z: s.z,
        }));
        const bounds = getBounds(offsetStations);

        // Include target section in bounds if merge preview is active
        if (mergePreview && targetStations.length > 0) {
          const targetBounds = getBounds(targetStations);
          bounds.minX = Math.min(bounds.minX, targetBounds.minX);
          bounds.maxX = Math.max(bounds.maxX, targetBounds.maxX);
          bounds.minY = Math.min(bounds.minY, targetBounds.minY);
          bounds.maxY = Math.max(bounds.maxY, targetBounds.maxY);
        }

        // Include existing station in bounds if present (legacy mode)
        if (!mergePreview && existingStationFeatures.length > 0) {
          const importStation =
            importStationIndex === 'first' ? stations[0] : stations[stations.length - 1];
          if (importStation) {
            const existingX = importStation.x + 10;
            const existingY = importStation.y + 10;
            bounds.minX = Math.min(bounds.minX, existingX);
            bounds.maxX = Math.max(bounds.maxX, existingX);
            bounds.minY = Math.min(bounds.minY, existingY);
            bounds.maxY = Math.max(bounds.maxY, existingY);
          }
        }

        // Check for degenerate bounds (single point or very small extent)
        const extentX = bounds.maxX - bounds.minX;
        const extentY = bounds.maxY - bounds.minY;
        const minExtent = 1; // 1 meter minimum extent

        if (extentX < minExtent && extentY < minExtent) {
          // Single point or very small area - use setCenter with fixed zoom
          const centerX = (bounds.minX + bounds.maxX) / 2;
          const centerY = (bounds.minY + bounds.maxY) / 2;
          map.jumpTo({
            center: metersToMapCoords(centerX, centerY, gpsOrigin),
            zoom: gpsOrigin ? 18 : 16,
          });
        } else {
          const sw = metersToMapCoords(bounds.minX, bounds.minY, gpsOrigin);
          const ne = metersToMapCoords(bounds.maxX, bounds.maxY, gpsOrigin);

          // Calculate 10% padding based on container size
          const container = map.getContainer();
          const paddingX = Math.round(container.clientWidth * 0.1);
          const paddingY = Math.round(container.clientHeight * 0.1);

          // Add padding and fit (no animation for initial load)
          map.fitBounds([sw, ne], {
            padding: { top: paddingY, bottom: paddingY, left: paddingX, right: paddingX },
            maxZoom: 20, // Don't auto-zoom too close, user can zoom in more if needed
            duration: 0,
          });
        }
      };

      // Use requestAnimationFrame to ensure container has proper dimensions
      requestAnimationFrame(() => {
        if (mapRef.current) {
          doFitBounds();
        }
      });
    }
  }, [section, stations, targetStations, color, mapLoaded, existingStation, importStationIndex, mergePreview, selectedStationIndex, gpsOrigin, gpsStationOffset]);

  // Re-apply theme colors when resolvedTheme changes
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;
    const colors = getMapThemeColors();

    // Update background color
    if (map.getLayer('background')) {
      map.setPaintProperty('background', 'background-color', colors.previewBg);
    }
    // Target section layers
    if (map.getLayer('preview-target-shots-layer')) {
      map.setPaintProperty('preview-target-shots-layer', 'line-color', colors.grayLine);
    }
    if (map.getLayer('preview-target-stations-layer')) {
      map.setPaintProperty('preview-target-stations-layer', 'circle-color', colors.grayLine);
      map.setPaintProperty('preview-target-stations-layer', 'circle-stroke-color', colors.strokeColor);
    }
    // Connection line
    if (map.getLayer('preview-connection-layer')) {
      map.setPaintProperty('preview-connection-layer', 'line-color', colors.zeroDatum);
    }
    // Stations
    if (map.getLayer('preview-stations-layer')) {
      map.setPaintProperty('preview-stations-layer', 'circle-stroke-color', colors.strokeColor);
    }
    // Existing station
    if (map.getLayer('preview-existing-station-layer')) {
      map.setPaintProperty('preview-existing-station-layer', 'circle-color', colors.zeroDatum);
      map.setPaintProperty('preview-existing-station-layer', 'circle-stroke-color', colors.strokeColor);
    }
    // Selected station highlight
    if (map.getLayer('preview-selected-station-layer')) {
      map.setPaintProperty('preview-selected-station-layer', 'circle-stroke-color', colors.compassColor);
    }
    // Merge highlight
    if (map.getLayer('preview-merge-highlight-layer')) {
      map.setPaintProperty('preview-merge-highlight-layer', 'circle-color', colors.selectHighlight);
      map.setPaintProperty('preview-merge-highlight-layer', 'circle-stroke-color', colors.compassColor);
    }
  }, [resolvedTheme, mapLoaded]);

  // Always render the container, overlay placeholder when no section
  return (
    <div
      data-testid="section-preview"
      className="relative border border-border rounded overflow-hidden bg-background"
      style={{ width: size, height: size }}
    >
      {/* Map container is always mounted for proper lifecycle */}
      <div ref={containerRef} className="w-full h-full" data-testid="section-preview-map" />

      {/* Overlay placeholder when no section selected */}
      {!section && (
        <div className="absolute inset-0 flex items-center justify-center bg-background text-text-secondary text-sm">
          Select a section to preview
        </div>
      )}
    </div>
  );
}
