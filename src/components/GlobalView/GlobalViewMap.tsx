import { useEffect, useRef, useCallback, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type { ProjectMetadata } from '../../types/project';
import GlobalSurveyLayer, { type SystemGeometry } from './GlobalSurveyLayer';
import type { SurveyGeometry } from '../../types/survey';

interface GlobalViewMapProps {
  projects: ProjectMetadata[];
  selectedProjectId: string | null;
  onProjectSelect: (filePath: string) => void;
  onProjectOpen: (filePath: string) => void;
  /** Survey geometry data keyed by file_path. Populated by parent via lazy loading (fn-15-ygz.3). */
  geometryData?: Map<string, SurveyGeometry>;
}

/**
 * Map component for GlobalView showing all GPS-positioned systems.
 * Uses MapLibre GL JS with satellite tiles.
 */
export default function GlobalViewMap({
  projects,
  selectedProjectId,
  onProjectSelect,
  onProjectOpen,
  geometryData = new Map(),
}: GlobalViewMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const surveyLayerRef = useRef<GlobalSurveyLayer | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  // Buffer for geometry data that arrives before map is ready
  const pendingGeometryRef = useRef<Map<string, SurveyGeometry> | null>(null);

  // Filter to only projects with GPS coordinates
  const gpsProjects = projects.filter(
    (p) => p.gps_center !== null
  );

  // Calculate bounds to fit all systems (max 500km x 500km)
  const calculateBounds = useCallback(() => {
    if (gpsProjects.length === 0) {
      // Default to world view if no GPS projects
      return new maplibregl.LngLatBounds([-180, -85], [180, 85]);
    }

    // Use individual project bounds if available, otherwise use center points
    let minLng = Infinity;
    let maxLng = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;

    for (const project of gpsProjects) {
      if (project.gps_bounds) {
        minLng = Math.min(minLng, project.gps_bounds.west);
        maxLng = Math.max(maxLng, project.gps_bounds.east);
        minLat = Math.min(minLat, project.gps_bounds.south);
        maxLat = Math.max(maxLat, project.gps_bounds.north);
      } else if (project.gps_center) {
        const [lng, lat] = project.gps_center;
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
      }
    }

    // Check if bounds exceed 500km x 500km (approximately 4.5 degrees at mid-latitudes)
    const MAX_SPAN_DEGREES = 4.5;
    const lngSpan = maxLng - minLng;
    const latSpan = maxLat - minLat;

    if (lngSpan > MAX_SPAN_DEGREES || latSpan > MAX_SPAN_DEGREES) {
      // Limit to max span, centered on the center of all projects
      const centerLng = (minLng + maxLng) / 2;
      const centerLat = (minLat + maxLat) / 2;
      minLng = centerLng - MAX_SPAN_DEGREES / 2;
      maxLng = centerLng + MAX_SPAN_DEGREES / 2;
      minLat = centerLat - MAX_SPAN_DEGREES / 2;
      maxLat = centerLat + MAX_SPAN_DEGREES / 2;
    }

    return new maplibregl.LngLatBounds([minLng, minLat], [maxLng, maxLat]);
  }, [gpsProjects]);

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    const bounds = calculateBounds();
    const center = bounds.getCenter();

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          'osm-tiles': {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; OpenStreetMap contributors',
          },
        },
        layers: [
          {
            id: 'osm-tiles',
            type: 'raster',
            source: 'osm-tiles',
            paint: {
              'raster-opacity': 1,
            },
          },
        ],
      },
      center: [center.lng, center.lat],
      zoom: 10,
    });

    // Disable rotation
    map.current.dragRotate.disable();
    map.current.touchPitch.disable();

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

    map.current.on('load', () => {
      // Fit to bounds after load
      if (gpsProjects.length > 0 && map.current) {
        map.current.fitBounds(bounds, { padding: 50, maxZoom: 15 });
      }

      // Initialize survey layer now that map is loaded
      if (!surveyLayerRef.current && map.current) {
        surveyLayerRef.current = new GlobalSurveyLayer(map.current, {
          onSystemClick: (filePath) => {
            onProjectSelectRef.current(filePath);
          },
          onSystemHover: () => {
            // Hover handling could update metadata panel preview
          },
        });

        // Apply any pending geometry that arrived before map was ready
        if (pendingGeometryRef.current && pendingGeometryRef.current.size > 0) {
          const systems: SystemGeometry[] = [];
          for (const project of gpsProjects) {
            const geometry = pendingGeometryRef.current.get(project.file_path);
            if (geometry) {
              systems.push({ metadata: project, geometry });
            }
          }
          if (systems.length > 0) {
            surveyLayerRef.current.update(systems);
          }
          pendingGeometryRef.current = null;
        }
      }

      // Trigger re-render so effects that depend on mapLoaded can run
      setMapLoaded(true);
    });

    return () => {
      // Clean up survey layer
      surveyLayerRef.current?.destroy();
      surveyLayerRef.current = null;
      // Clean up markers
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current.clear();
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Store callbacks in refs to avoid stale closures in map event handlers
  const onProjectSelectRef = useRef(onProjectSelect);
  const onProjectOpenRef = useRef(onProjectOpen);
  useEffect(() => {
    onProjectSelectRef.current = onProjectSelect;
    onProjectOpenRef.current = onProjectOpen;
  }, [onProjectSelect, onProjectOpen]);

  // Update survey layer when geometry data changes (from props)
  useEffect(() => {
    if (geometryData.size === 0) return;

    // Build system geometry array
    const systems: SystemGeometry[] = [];
    for (const project of gpsProjects) {
      const geometry = geometryData.get(project.file_path);
      if (geometry) {
        systems.push({ metadata: project, geometry });
      }
    }

    if (surveyLayerRef.current) {
      // Layer ready - apply immediately
      surveyLayerRef.current.update(systems);
      pendingGeometryRef.current = null;
    } else {
      // Layer not ready yet - buffer for when it initializes
      pendingGeometryRef.current = geometryData;
    }
  }, [geometryData, gpsProjects]);

  // Update survey layer selection when selected project changes
  useEffect(() => {
    surveyLayerRef.current?.setSelectedSystem(selectedProjectId);
  }, [selectedProjectId]);

  // Update markers when projects or selection changes
  useEffect(() => {
    if (!map.current || !mapLoaded) return;

    // Remove old markers
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current.clear();

    // Add markers for each GPS project
    for (const project of gpsProjects) {
      if (!project.gps_center) continue;

      const [lng, lat] = project.gps_center;

      // Create marker element
      const el = document.createElement('div');
      el.className = 'globalview-system-marker';
      el.setAttribute('data-testid', `system-marker-${project.file_path}`);
      el.style.cssText = `
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background-color: ${selectedProjectId === project.file_path ? '#3b82f6' : '#4ecdc4'};
        border: 3px solid ${selectedProjectId === project.file_path ? '#60a5fa' : '#ffffff'};
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        transition: transform 0.2s, background-color 0.2s;
      `;

      // Hover effect
      el.addEventListener('mouseenter', () => {
        el.style.transform = 'scale(1.2)';
      });
      el.addEventListener('mouseleave', () => {
        el.style.transform = 'scale(1)';
      });

      // Click handler
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onProjectSelect(project.file_path);
      });

      // Double-click handler
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        onProjectOpen(project.file_path);
      });

      // Create and add marker
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([lng, lat])
        .addTo(map.current!);

      // Add popup with project name
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 15,
      }).setHTML(`
        <div style="color: #1a1a2e; font-weight: 500; padding: 4px;">
          ${project.name}
          ${project.location ? `<br/><span style="font-size: 0.85em; color: #666;">${project.location}</span>` : ''}
        </div>
      `);

      el.addEventListener('mouseenter', () => {
        popup.setLngLat([lng, lat]).addTo(map.current!);
      });
      el.addEventListener('mouseleave', () => {
        popup.remove();
      });

      markersRef.current.set(project.file_path, marker);
    }
  }, [gpsProjects, selectedProjectId, mapLoaded, onProjectSelect, onProjectOpen]);

  // Update marker styles when selection changes
  useEffect(() => {
    markersRef.current.forEach((marker, filePath) => {
      const el = marker.getElement();
      const isSelected = selectedProjectId === filePath;
      el.style.backgroundColor = isSelected ? '#3b82f6' : '#4ecdc4';
      el.style.borderColor = isSelected ? '#60a5fa' : '#ffffff';
    });
  }, [selectedProjectId]);

  // Fit to bounds button handler
  const fitToBounds = useCallback(() => {
    if (!map.current || gpsProjects.length === 0) return;
    const bounds = calculateBounds();
    map.current.fitBounds(bounds, { padding: 50, maxZoom: 15 });
  }, [calculateBounds, gpsProjects.length]);

  if (gpsProjects.length === 0) {
    return (
      <div
        data-testid="globalview-map"
        className="h-full flex items-center justify-center bg-panel text-text-secondary"
      >
        <div className="text-center">
          <div className="text-4xl mb-4">&#127758;</div>
          <p>No GPS-positioned systems to display.</p>
          <p className="text-sm mt-2">
            Add GPS coordinates to your projects to see them on the map.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="globalview-map" className="h-full relative">
      <div ref={mapContainer} className="w-full h-full" />

      {/* Fit to bounds button */}
      <button
        onClick={fitToBounds}
        className="absolute top-2 left-2 bg-panel border border-border rounded px-2 py-1 text-sm hover:bg-background"
        title="Fit all systems in view"
      >
        Fit All
      </button>

      {/* Project count indicator */}
      <div className="absolute bottom-8 right-2 bg-panel/90 border border-border rounded px-2 py-1 text-xs">
        {gpsProjects.length} system{gpsProjects.length !== 1 ? 's' : ''} on map
      </div>
    </div>
  );
}
