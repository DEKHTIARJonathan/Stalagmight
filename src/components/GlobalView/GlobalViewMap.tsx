import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import maplibregl from 'maplibre-gl';
import type { ProjectMetadata } from '../../types/project';
import GlobalSurveyLayer, { type SystemGeometry } from './GlobalSurveyLayer';
import type { SurveyGeometry } from '../../types/survey';
import { useGlobalViewStore, type SystemGeometryState } from '../../store/globalViewStore';
import { ViewModeToggle, useViewMode, type ViewMode } from './ViewModeToggle';

/**
 * Handle exposed by GlobalViewMap for parent components.
 */
export interface GlobalViewMapHandle {
  /**
   * Get centroids of all GPS-positioned systems.
   * Returns a Map of file_path -> [lng, lat] centroid.
   * For systems with geometry, uses the average of all station positions.
   * For systems without geometry, uses gps_center.
   */
  getSystemCentroids: () => Map<string, [number, number]>;
}

interface GlobalViewMapProps {
  projects: ProjectMetadata[];
  selectedProjectId: string | null;
  onProjectSelect: (filePath: string) => void;
  onProjectOpen: (filePath: string) => void;
  /** Survey geometry data keyed by file_path. */
  geometryData?: Map<string, SurveyGeometry>;
  /** Loading states keyed by file_path. */
  geometryStates?: Map<string, SystemGeometryState>;
  /** Search filter term (owned by GlobalView, passed down for filtering) */
  searchTerm?: string;
}

/**
 * Map component for GlobalView showing all GPS-positioned systems.
 * Uses MapLibre GL JS with satellite tiles.
 */
const GlobalViewMap = forwardRef<GlobalViewMapHandle, GlobalViewMapProps>(function GlobalViewMap(
  {
    projects,
    selectedProjectId,
    onProjectSelect,
    onProjectOpen,
    geometryData = new Map(),
    geometryStates = new Map(),
    searchTerm = '',
  },
  ref
) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const surveyLayerRef = useRef<GlobalSurveyLayer | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  // Buffer for geometry data that arrives before map is ready
  const pendingGeometryRef = useRef<Map<string, SurveyGeometry> | null>(null);
  // Store searchTerm in ref for access during map initialization (avoids stale closure)
  const searchTermRef = useRef(searchTerm);
  searchTermRef.current = searchTerm;

  // Access lazy loading functions and multi-select from store
  const {
    loadGeometryBatch,
    selectedSystemIds,
    selectSystem,
    toggleSystemSelection,
    cancelPendingLoads,
  } = useGlobalViewStore();

  // View mode state (persisted in localStorage)
  const [viewMode, setViewMode] = useViewMode();
  // Store viewMode in ref for callbacks that need current value without closure staleness
  const viewModeRef = useRef<ViewMode>(viewMode);
  viewModeRef.current = viewMode;

  // Filter to only projects with GPS coordinates (null check only, no sentinel)
  const gpsProjects = projects.filter((p) => p.gps_center !== null);

  // Store gpsProjects and geometryData in refs for imperative handle
  const gpsProjectsRef = useRef(gpsProjects);
  const geometryDataRef = useRef(geometryData);
  useEffect(() => {
    gpsProjectsRef.current = gpsProjects;
    geometryDataRef.current = geometryData;
  }, [gpsProjects, geometryData]);

  // Expose imperative handle for parent to get system centroids
  useImperativeHandle(ref, () => ({
    getSystemCentroids: () => {
      const centroids = new Map<string, [number, number]>();

      for (const project of gpsProjectsRef.current) {
        const geometry = geometryDataRef.current.get(project.file_path);

        if (geometry && geometry.shots.length > 0) {
          // Calculate centroid from station positions
          const stations = new Set<string>();
          let sumLng = 0;
          let sumLat = 0;

          for (const shot of geometry.shots) {
            const fromKey = `${shot.from[0]},${shot.from[1]}`;
            const toKey = `${shot.to[0]},${shot.to[1]}`;

            if (!stations.has(fromKey)) {
              stations.add(fromKey);
              sumLng += shot.from[0];
              sumLat += shot.from[1];
            }
            if (!stations.has(toKey)) {
              stations.add(toKey);
              sumLng += shot.to[0];
              sumLat += shot.to[1];
            }
          }

          if (stations.size > 0) {
            centroids.set(project.file_path, [sumLng / stations.size, sumLat / stations.size]);
          }
        } else if (project.gps_center) {
          // Fall back to gps_center if no geometry loaded
          centroids.set(project.file_path, project.gps_center);
        }
      }

      return centroids;
    },
  }), []);

  // Calculate raw bounds (no padding) for all systems
  // Note: These are the actual bounds of all systems, without any span limiting
  const calculateRawBounds = useCallback((): maplibregl.LngLatBounds | null => {
    if (gpsProjects.length === 0) {
      return null;
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

    return new maplibregl.LngLatBounds([minLng, minLat], [maxLng, maxLat]);
  }, [gpsProjects]);

  // Calculate bounds with padding factor
  const addPaddingToBounds = useCallback((bounds: maplibregl.LngLatBounds, paddingFactor: number): maplibregl.LngLatBounds => {
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const lngSpan = ne.lng - sw.lng;
    const latSpan = ne.lat - sw.lat;

    // Add padding as percentage of span
    const lngPadding = lngSpan * paddingFactor;
    const latPadding = latSpan * paddingFactor;

    return new maplibregl.LngLatBounds(
      [sw.lng - lngPadding, Math.max(-85, sw.lat - latPadding)],
      [ne.lng + lngPadding, Math.min(85, ne.lat + latPadding)]
    );
  }, []);

  // Calculate bounds to fit all systems (for Fit All button and initial view)
  // This applies a max span limit to avoid extremely zoomed-out initial views
  const calculateBounds = useCallback(() => {
    const rawBounds = calculateRawBounds();
    if (!rawBounds) {
      // Default to world view if no GPS projects
      return new maplibregl.LngLatBounds([-180, -85], [180, 85]);
    }

    // Apply max span limit for fitting (500km ~ 4.5 degrees at mid-latitudes)
    const MAX_SPAN_DEGREES = 4.5;
    const sw = rawBounds.getSouthWest();
    const ne = rawBounds.getNorthEast();
    const lngSpan = ne.lng - sw.lng;
    const latSpan = ne.lat - sw.lat;

    if (lngSpan > MAX_SPAN_DEGREES || latSpan > MAX_SPAN_DEGREES) {
      // Limit to max span, centered on the center of all projects
      const centerLng = (sw.lng + ne.lng) / 2;
      const centerLat = (sw.lat + ne.lat) / 2;
      return new maplibregl.LngLatBounds(
        [centerLng - MAX_SPAN_DEGREES / 2, centerLat - MAX_SPAN_DEGREES / 2],
        [centerLng + MAX_SPAN_DEGREES / 2, centerLat + MAX_SPAN_DEGREES / 2]
      );
    }

    return rawBounds;
  }, [calculateRawBounds]);

  // Soft bounds (20% padding) - animate back if user pans beyond this
  const softBoundsRef = useRef<maplibregl.LngLatBounds | null>(null);

  // Update bounds when projects change
  useEffect(() => {
    const rawBounds = calculateRawBounds();
    if (rawBounds) {
      softBoundsRef.current = addPaddingToBounds(rawBounds, 0.2);
    } else {
      softBoundsRef.current = null;
    }
  }, [calculateRawBounds, addPaddingToBounds]);

  // Calculate hard bounds (50% padding) for maxBounds constraint
  const calculateHardBounds = useCallback((): maplibregl.LngLatBounds | null => {
    const rawBounds = calculateRawBounds();
    if (!rawBounds) return null;
    return addPaddingToBounds(rawBounds, 0.5);
  }, [calculateRawBounds, addPaddingToBounds]);

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    const bounds = calculateBounds();
    const center = bounds.getCenter();
    const hardBounds = calculateHardBounds();

    // Build map options - only include maxBounds if we have GPS projects
    const mapOptions: maplibregl.MapOptions = {
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
    };

    // Hard bounds (50% padding) - user cannot pan beyond this
    if (hardBounds) {
      mapOptions.maxBounds = hardBounds;
    }

    map.current = new maplibregl.Map(mapOptions);

    // Disable rotation
    map.current.dragRotate.disable();
    map.current.touchPitch.disable();

    // Disable MapLibre's built-in keyboard handler to prevent conflicts with our shortcuts
    // Per memory: disable the map library's built-in keyboard handler to prevent double-zoom
    map.current.keyboard.disable();

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
        // Disable default double-click zoom so our handler can open projects
        map.current.doubleClickZoom.disable();

        surveyLayerRef.current = new GlobalSurveyLayer(map.current, {
          onSystemClick: (filePath, _event, ctrlKey) => {
            if (ctrlKey) {
              // Ctrl+click: toggle selection (multi-select)
              // Don't call onProjectSelect to avoid resetting to single-select
              toggleSystemSelectionRef.current(filePath);
            } else {
              // Regular click: select single system in store and notify parent
              selectSystemRef.current(filePath);
              onProjectSelectRef.current(filePath);
            }
          },
          onSystemDoubleClick: (filePath) => {
            onProjectOpenRef.current(filePath);
          },
          onSystemHover: () => {
            // Hover handling could update metadata panel preview
          },
        });

        // Apply any pending geometry that arrived before map was ready
        // Only apply if still in survey mode (user may have toggled to markers while map was loading)
        if (pendingGeometryRef.current && pendingGeometryRef.current.size > 0 && viewModeRef.current === 'survey') {
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
        }
        // Always clear pending ref after processing (whether applied or not)
        pendingGeometryRef.current = null;

        // Apply current search filter immediately after layer construction
        surveyLayerRef.current.setSearchFilter(searchTermRef.current || null);
      }

      // Trigger re-render so effects that depend on mapLoaded can run
      setMapLoaded(true);
    });

    // Rubber-band effect: when user releases pan outside soft bounds, animate back
    // This creates a natural "spring" feel without requiring internal MapLibre APIs
    let isRubberBanding = false;
    const handleMoveEndRubberBand = (e: maplibregl.MapLibreEvent & { originalEvent?: Event }) => {
      if (!map.current || !softBoundsRef.current) return;

      // Skip if we're already in a rubber-band animation (prevents infinite loop)
      if (isRubberBanding) return;

      // Only apply rubber-band effect for user-initiated moves (not programmatic moves)
      // originalEvent is present when the move was user-initiated
      if (!e.originalEvent) return;

      const mapCenter = map.current.getCenter();
      const softBounds = softBoundsRef.current;

      // Check if center is outside soft bounds
      let targetLng = mapCenter.lng;
      let targetLat = mapCenter.lat;
      let needsCorrection = false;

      const sw = softBounds.getSouthWest();
      const ne = softBounds.getNorthEast();

      if (mapCenter.lng < sw.lng) {
        targetLng = sw.lng;
        needsCorrection = true;
      } else if (mapCenter.lng > ne.lng) {
        targetLng = ne.lng;
        needsCorrection = true;
      }

      if (mapCenter.lat < sw.lat) {
        targetLat = sw.lat;
        needsCorrection = true;
      } else if (mapCenter.lat > ne.lat) {
        targetLat = ne.lat;
        needsCorrection = true;
      }

      if (needsCorrection) {
        // Set flag to prevent re-triggering during animation
        isRubberBanding = true;

        // Animate back to soft bounds with gentle easing
        map.current.easeTo({
          center: [targetLng, targetLat],
          duration: 300,
          easing: (t) => 1 - Math.pow(1 - t, 3), // Ease out cubic
        });

        // Clear flag after animation completes
        // Use slightly longer timeout than animation duration to be safe
        setTimeout(() => {
          isRubberBanding = false;
        }, 350);
      }
    };

    map.current.on('moveend', handleMoveEndRubberBand);

    return () => {
      map.current?.off('moveend', handleMoveEndRubberBand);
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
  const selectSystemRef = useRef(selectSystem);
  const toggleSystemSelectionRef = useRef(toggleSystemSelection);
  useEffect(() => {
    onProjectSelectRef.current = onProjectSelect;
    onProjectOpenRef.current = onProjectOpen;
    selectSystemRef.current = selectSystem;
    toggleSystemSelectionRef.current = toggleSystemSelection;
  }, [onProjectSelect, onProjectOpen, selectSystem, toggleSystemSelection]);

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

  // Update survey layer selection when selected systems change (from store)
  useEffect(() => {
    surveyLayerRef.current?.setSelectedSystems(selectedSystemIds);
  }, [selectedSystemIds]);

  // Sync search filter to survey layer (searchTerm is owned by GlobalView, passed as prop)
  useEffect(() => {
    surveyLayerRef.current?.setSearchFilter(searchTerm || null);
  }, [searchTerm]);

  // Sync single-selection prop to store for compatibility
  useEffect(() => {
    // If selectedProjectId from props changes, update the store
    // This maintains backward compatibility with existing code
    // Handle both truthy and null/undefined cases
    selectSystem(selectedProjectId);
  }, [selectedProjectId, selectSystem]);

  // Handle view mode changes - cancel pending loads and update visibility
  const handleViewModeChange = useCallback((newMode: ViewMode) => {
    setViewMode(newMode);

    // Cancel any in-progress geometry loads when switching to markers mode
    // (preserves already-loaded geometry so it's available when switching back)
    if (newMode === 'markers') {
      cancelPendingLoads();
      // Clear pending geometry buffer to prevent stale data from being applied
      pendingGeometryRef.current = null;
    }

    // Update survey layer visibility
    surveyLayerRef.current?.setVisible(newMode === 'survey');
  }, [setViewMode, cancelPendingLoads]);

  // Sync view mode to survey layer when it becomes ready
  useEffect(() => {
    if (surveyLayerRef.current) {
      surveyLayerRef.current.setVisible(viewMode === 'survey');
    }
  }, [mapLoaded, viewMode]);

  // Lazy load geometry for visible systems when map loads or moveend
  // Only load when in survey mode
  useEffect(() => {
    if (!map.current || !mapLoaded) return;
    // Don't load geometry when in markers-only mode
    if (viewMode !== 'survey') return;

    const loadVisibleSystems = () => {
      if (!map.current) return;
      // Check ref for current mode (avoid stale closure)
      if (viewModeRef.current !== 'survey') return;

      const bounds = map.current.getBounds();
      const center = bounds.getCenter();

      // Find systems in view and sort by distance from center
      const visibleSystems = gpsProjects
        .filter((p) => {
          if (!p.gps_center) return false;
          const [lng, lat] = p.gps_center;
          return bounds.contains([lng, lat]);
        })
        .map((p) => {
          const [lng, lat] = p.gps_center!;
          const dist = Math.sqrt(
            Math.pow(lng - center.lng, 2) + Math.pow(lat - center.lat, 2)
          );
          return { project: p, dist };
        })
        .sort((a, b) => a.dist - b.dist)
        .map((item) => item.project.file_path);

      // Load systems sequentially in priority order (loadGeometryBatch handles this)
      // Don't await - let it run in background so map stays responsive
      loadGeometryBatch(visibleSystems);
    };

    // Load visible systems now
    loadVisibleSystems();

    // Load visible systems on map movement
    const handleMoveEnd = () => loadVisibleSystems();
    map.current.on('moveend', handleMoveEnd);

    return () => {
      map.current?.off('moveend', handleMoveEnd);
    };
  }, [mapLoaded, gpsProjects, loadGeometryBatch, viewMode]);

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
      const loadingState = geometryStates.get(project.file_path)?.state ?? 'idle';
      const isSelected = selectedProjectId === project.file_path;

      // Determine marker color based on state
      let bgColor: string;
      let borderColor: string;
      if (loadingState === 'error') {
        bgColor = '#ef4444'; // Red for error
        borderColor = '#fca5a5';
      } else if (isSelected) {
        bgColor = '#3b82f6'; // Blue for selected
        borderColor = '#60a5fa';
      } else {
        bgColor = '#4ecdc4'; // Teal default
        borderColor = '#ffffff';
      }

      // Create marker element
      const el = document.createElement('div');
      el.className = 'globalview-system-marker';
      el.setAttribute('data-testid', `system-marker-${project.file_path}`);
      el.style.cssText = `
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background-color: ${bgColor};
        border: 3px solid ${borderColor};
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        transition: transform 0.2s, background-color 0.2s;
      `;

      // Add spinner for loading state
      if (loadingState === 'loading') {
        const spinner = document.createElement('div');
        spinner.className = 'marker-spinner';
        spinner.style.cssText = `
          width: 12px;
          height: 12px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: white;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        `;
        el.appendChild(spinner);
      }

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

      // Add popup with project name and loading state
      const stateText = loadingState === 'loading' ? '<br/><span style="font-size: 0.75em; color: #888;">Loading geometry...</span>'
        : loadingState === 'error' ? '<br/><span style="font-size: 0.75em; color: #ef4444;">Failed to load</span>'
        : '';
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 15,
      }).setHTML(`
        <div style="color: #1a1a2e; font-weight: 500; padding: 4px;">
          ${project.name}
          ${project.location ? `<br/><span style="font-size: 0.85em; color: #666;">${project.location}</span>` : ''}
          ${stateText}
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
  }, [gpsProjects, selectedProjectId, mapLoaded, onProjectSelect, onProjectOpen, geometryStates]);

  // Update marker styles when selection or loading states change
  useEffect(() => {
    markersRef.current.forEach((marker, filePath) => {
      const el = marker.getElement();
      const isSelected = selectedProjectId === filePath;
      const loadingState = geometryStates.get(filePath)?.state ?? 'idle';

      // Determine marker color based on state
      if (loadingState === 'error') {
        el.style.backgroundColor = '#ef4444';
        el.style.borderColor = '#fca5a5';
      } else if (isSelected) {
        el.style.backgroundColor = '#3b82f6';
        el.style.borderColor = '#60a5fa';
      } else {
        el.style.backgroundColor = '#4ecdc4';
        el.style.borderColor = '#ffffff';
      }
    });
  }, [selectedProjectId, geometryStates]);

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

      {/* View mode toggle - positioned below navigation controls */}
      <div className="absolute top-24 right-2">
        <ViewModeToggle
          mode={viewMode}
          onModeChange={handleViewModeChange}
        />
      </div>

      {/* Project count indicator */}
      <div className="absolute bottom-8 right-2 bg-panel/90 border border-border rounded px-2 py-1 text-xs">
        {gpsProjects.length} system{gpsProjects.length !== 1 ? 's' : ''} on map
      </div>
    </div>
  );
});

export default GlobalViewMap;
