import { useEffect, useRef, useState, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import type { DmpSection, DmpShot } from '../../types/commands';
import type { Station } from '../../types/project';
import { metersToMapCoords, getBounds } from '../../utils/coordinates';

/**
 * Compute circular mean of two angles in degrees.
 * Handles wrap-around correctly (e.g., 350 and 10 averages to 0, not 180).
 */
function circularMeanDegrees(a: number, b: number): number {
  const aRad = (a * Math.PI) / 180;
  const bRad = (b * Math.PI) / 180;

  // Average the unit vectors
  const x = (Math.cos(aRad) + Math.cos(bRad)) / 2;
  const y = (Math.sin(aRad) + Math.sin(bRad)) / 2;

  // Convert back to angle
  let result = Math.atan2(y, x) * (180 / Math.PI);
  if (result < 0) result += 360;
  return result;
}

/**
 * Compute station coordinates from DMP shots.
 * Each station is positioned relative to the previous one based on shot heading, length, and pitch.
 */
function computeStations(shots: DmpShot[]): Array<{ x: number; y: number; z: number }> {
  // Start at origin
  const stations: Array<{ x: number; y: number; z: number }> = [{ x: 0, y: 0, z: 0 }];

  for (const shot of shots) {
    if (shot.shot_type !== 'Standard') continue;

    const prev = stations[stations.length - 1];
    if (!prev) continue;

    // Use circular mean for heading to handle wrap-around correctly
    const azimuth = circularMeanDegrees(shot.heading_in, shot.heading_out);
    const azimuthRad = (azimuth * Math.PI) / 180;

    // Average pitch (0 means horizontal, positive means upward)
    const pitchIn = shot.pitch_in ?? 0;
    const pitchOut = shot.pitch_out ?? 0;
    const avgPitch = (pitchIn + pitchOut) / 2;
    const pitchRad = (avgPitch * Math.PI) / 180;

    // Project length onto horizontal plane using pitch
    const horizontalLength = shot.length * Math.cos(pitchRad);
    const verticalChange = shot.length * Math.sin(pitchRad);

    // Compute next station position
    const x = prev.x + horizontalLength * Math.sin(azimuthRad);
    const y = prev.y + horizontalLength * Math.cos(azimuthRad);
    // Use depth from shot if available, otherwise compute from pitch
    const z = shot.depth_out !== 0 ? shot.depth_out : prev.z - verticalChange;

    stations.push({ x, y, z });
  }

  return stations;
}

interface SectionPreviewProps {
  /** The section to preview. When null, shows empty state. */
  section: DmpSection | null;
  /** Color for the section lines and stations */
  color?: string;
  /** Existing station to connect to (for "From Existing Station" placement mode) */
  existingStation?: Station | null;
  /** Which station of the import to connect: 'first' or 'last' */
  importStationIndex?: 'first' | 'last' | null;
  /** Callback when a station dot is clicked */
  onStationClick?: (stationIndex: number) => void;
  /** Index of the currently selected station (shows highlight ring) */
  selectedStationIndex?: number | null;
  /** Size of the preview container in pixels (default 250) */
  size?: number;
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
 * - Shows connection line when existingStation is provided
 */
export default function SectionPreview({
  section,
  color = '#4ecdc4',
  existingStation,
  importStationIndex,
  onStationClick,
  selectedStationIndex,
  size = 250,
}: SectionPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const onStationClickRef = useRef(onStationClick);

  // Keep ref updated
  useEffect(() => {
    onStationClickRef.current = onStationClick;
  }, [onStationClick]);

  // Compute stations from shots
  const stations = useMemo(() => {
    if (!section) return [];
    const standardShots = section.shots.filter((s) => s.shot_type === 'Standard');
    return computeStations(standardShots);
  }, [section]);

  // Initialize MapLibre instance - container is always mounted
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Base zoom level 14 represents 1x, so:
    // 0.25x = 14 - 2 = 12 (minZoom)
    // 4x = 14 + 2 = 16 (maxZoom)
    const baseZoom = 14;
    const minZoom = baseZoom - 2; // 0.25x
    const maxZoom = baseZoom + 2; // 4x

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
              'background-color': '#1a1a2e',
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
          'line-color': '#ffcc00',
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
          'circle-stroke-color': '#000000',
        },
      });

      // Add existing station layer (different color)
      map.addLayer({
        id: 'preview-existing-station-layer',
        type: 'circle',
        source: 'preview-existing-station',
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffcc00',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#000000',
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
          'circle-stroke-color': '#ffffff',
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

  // Update data and fit bounds when section changes
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;

    const map = mapRef.current;

    // Build shot features
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
            metersToMapCoords(from.x, from.y),
            metersToMapCoords(to.x, to.y),
          ],
        },
        properties: { color },
      });
    }

    // Build station features with index for click handling
    const stationFeatures: GeoJSON.Feature[] = stations.map((station, index) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: metersToMapCoords(station.x, station.y),
      },
      properties: { color, stationIndex: index },
    }));

    // Build connection line and existing station features
    const connectionFeatures: GeoJSON.Feature[] = [];
    const existingStationFeatures: GeoJSON.Feature[] = [];

    if (existingStation && stations.length > 0 && importStationIndex) {
      // Determine which import station to connect
      const importStationCoords =
        importStationIndex === 'first' ? stations[0] : stations[stations.length - 1];

      if (importStationCoords) {
        // For visualization, we'll show a simple connection indicator
        // by placing the existing station at an offset from the import station
        // (In the actual import, the merge will position them correctly)
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
              metersToMapCoords(importStationCoords.x, importStationCoords.y),
              metersToMapCoords(existingX, existingY),
            ],
          },
          properties: {},
        });

        // Add existing station marker
        existingStationFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(existingX, existingY),
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

    // Build and update selected station highlight feature
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
            coordinates: metersToMapCoords(selectedStation.x, selectedStation.y),
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

    // Fit bounds if we have stations
    if (stations.length > 0) {
      const bounds = getBounds(stations);

      // Include existing station in bounds if present
      if (existingStationFeatures.length > 0) {
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
          center: metersToMapCoords(centerX, centerY),
          zoom: 16,
        });
      } else {
        const sw = metersToMapCoords(bounds.minX, bounds.minY);
        const ne = metersToMapCoords(bounds.maxX, bounds.maxY);

        // Add padding and fit
        map.fitBounds([sw, ne], {
          padding: 30,
          maxZoom: 18,
          duration: 300,
        });
      }
    }
  }, [section, stations, color, mapLoaded, existingStation, importStationIndex, selectedStationIndex]);

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
