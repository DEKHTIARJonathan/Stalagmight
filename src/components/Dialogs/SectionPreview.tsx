import { useEffect, useRef, useState, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import type { DmpSection, DmpShot } from '../../types/commands';
import { metersToMapCoords, getBounds } from '../../utils/coordinates';

/**
 * Compute station coordinates from DMP shots.
 * Each station is positioned relative to the previous one based on shot heading and length.
 */
function computeStations(shots: DmpShot[]): Array<{ x: number; y: number; z: number }> {
  // Start at origin
  const stations: Array<{ x: number; y: number; z: number }> = [{ x: 0, y: 0, z: 0 }];

  for (const shot of shots) {
    if (shot.shot_type !== 'Standard') continue;

    const prev = stations[stations.length - 1];
    if (!prev) continue;

    // Average heading (foresight and backsight)
    const azimuth = (shot.heading_in + shot.heading_out) / 2;
    const azimuthRad = (azimuth * Math.PI) / 180;

    // Compute next station position
    const x = prev.x + shot.length * Math.sin(azimuthRad);
    const y = prev.y + shot.length * Math.cos(azimuthRad);
    const z = shot.depth_out;

    stations.push({ x, y, z });
  }

  return stations;
}

interface SectionPreviewProps {
  /** The section to preview. When null, shows empty state. */
  section: DmpSection | null;
  /** Color for the section lines and stations */
  color?: string;
}

/**
 * A minimal MapLibre preview component for showing section shape.
 * - Fixed 250x250 size
 * - Station dots + shot lines
 * - Zoom (wheel) + pan (drag)
 * - Auto-fits bounds when section changes
 * - No labels (minimal view)
 */
export default function SectionPreview({ section, color = '#4ecdc4' }: SectionPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);

  // Compute stations from shots
  const stations = useMemo(() => {
    if (!section) return [];
    const standardShots = section.shots.filter((s) => s.shot_type === 'Standard');
    return computeStations(standardShots);
  }, [section]);

  // Initialize MapLibre instance
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

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
      zoom: 14,
      attributionControl: false,
      interactive: true,
    });

    // Disable rotation
    map.dragRotate.disable();
    map.touchPitch.disable();

    map.on('load', () => {
      // Add sources
      map.addSource('preview-shots', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addSource('preview-stations', {
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

      mapRef.current = map;
      setMapLoaded(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setMapLoaded(false);
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

    // Build station features
    const stationFeatures: GeoJSON.Feature[] = stations.map((station) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: metersToMapCoords(station.x, station.y),
      },
      properties: { color },
    }));

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

    // Fit bounds if we have stations
    if (stations.length > 0) {
      const bounds = getBounds(stations);
      const sw = metersToMapCoords(bounds.minX, bounds.minY);
      const ne = metersToMapCoords(bounds.maxX, bounds.maxY);

      // Add padding and fit
      map.fitBounds([sw, ne], {
        padding: 30,
        maxZoom: 18,
        duration: 300,
      });
    }
  }, [section, stations, color, mapLoaded]);

  return (
    <div
      data-testid="section-preview"
      className="border border-border rounded overflow-hidden bg-background"
      style={{ width: 250, height: 250 }}
    >
      {!section ? (
        <div className="w-full h-full flex items-center justify-center text-text-secondary text-sm">
          Select a section to preview
        </div>
      ) : (
        <div ref={containerRef} className="w-full h-full" data-testid="section-preview-map" />
      )}
    </div>
  );
}
