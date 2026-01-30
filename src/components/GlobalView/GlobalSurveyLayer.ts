import type { Map as MaplibreMap } from 'maplibre-gl';
import type maplibregl from 'maplibre-gl';
import type { ProjectMetadata } from '../../types/project';
import type { GeometryShot, SurveyGeometry } from '../../types/survey';
import { getMapThemeColors, type MapThemeColors } from '../../utils/themeColors';
import { hasLiveStyle } from '../Map/mapUtils';

/**
 * System geometry data with associated metadata for the global view.
 */
export interface SystemGeometry {
  /** Project metadata */
  metadata: ProjectMetadata;
  /** Survey geometry with GPS-transformed coordinates */
  geometry: SurveyGeometry;
}

/**
 * Callbacks for GlobalSurveyLayer interactions.
 */
export interface GlobalSurveyLayerCallbacks {
  /** Called when a system is clicked (with ctrlKey flag for multi-select) */
  onSystemClick?: (filePath: string, event: maplibregl.MapMouseEvent, ctrlKey: boolean) => void;
  /** Called when a system is double-clicked (to open the project) */
  onSystemDoubleClick?: (filePath: string) => void;
  /** Called when a system is hovered */
  onSystemHover?: (filePath: string | null) => void;
  /** Called when mouse enters/leaves any feature */
  onFeatureHover?: (isHovering: boolean) => void;
  /** Called when a system is right-clicked (for context menu) */
  onSystemContextMenu?: (filePath: string, event: MouseEvent) => void;
}

/**
 * Generate a deterministic color for a system based on its file_path.
 * Uses HSL with hue derived from a hash of the path, saturation 70%, lightness 50%.
 */
export function generateSystemColor(filePath: string): string {
  // Simple hash function (djb2)
  let hash = 5381;
  for (let i = 0; i < filePath.length; i++) {
    hash = ((hash << 5) + hash) + filePath.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Map hash to hue (0-360)
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 70%, 50%)`;
}

/**
 * Extract unique station positions from shots.
 * Returns [lng, lat] coordinates for each unique station.
 */
function extractStations(shots: GeometryShot[]): [number, number][] {
  const stationSet = new Map<string, [number, number]>();

  for (const shot of shots) {
    const fromKey = `${shot.from[0].toFixed(8)},${shot.from[1].toFixed(8)}`;
    const toKey = `${shot.to[0].toFixed(8)},${shot.to[1].toFixed(8)}`;

    if (!stationSet.has(fromKey)) {
      stationSet.set(fromKey, shot.from);
    }
    if (!stationSet.has(toKey)) {
      stationSet.set(toKey, shot.to);
    }
  }

  return Array.from(stationSet.values());
}

/**
 * GlobalSurveyLayer renders survey geometry for multiple systems on the global map.
 *
 * This is a read-only visualization layer that shows shots as lines and stations
 * as circles. Each system has a distinct, stable color derived from its file path.
 *
 * Layer architecture:
 * - Single GeoJSON source containing all systems (both shots and stations)
 * - Features distinguished by featureType property ('shot' or 'station')
 * - Multiple layers filter by featureType for rendering shots vs stations
 * - Shot lines layer (rendered first, below stations)
 * - Station circles layer (rendered second, above shots)
 * - Hitbox layers for click detection (invisible)
 *
 * Highlighting uses filter-based approach (not setFeatureState) for simplicity.
 */
export default class GlobalSurveyLayer {
  private map: MaplibreMap;
  private callbacks: GlobalSurveyLayerCallbacks;

  // Single source for all features
  private sourceId = 'global-survey-data';

  // Layer IDs
  private shotsLayerId = 'global-survey-shots-layer';
  private stationsLayerId = 'global-survey-stations-layer';
  private shotsHitboxLayerId = 'global-survey-shots-hitbox';
  private stationsHitboxLayerId = 'global-survey-stations-hitbox';

  // Visual state
  private hoveredSystemId: string | null = null;
  private selectedSystemIds: Set<string> = new Set();
  private searchFilter: string | null = null;

  // Store system colors for match expressions
  private systemColors: Map<string, string> = new Map();

  // Current GeoJSON tolerance (for simplification)
  private currentTolerance = 0.5;

  // Cached GeoJSON data for tolerance updates
  private cachedFeatures: GeoJSON.Feature[] = [];

  // Tooltip element
  private tooltip: HTMLDivElement | null = null;

  // Track if context menu is open (suppress tooltip while open)
  private contextMenuOpen = false;

  // Theme colors for MapLibre paint properties
  // Seeded at construction so first paint uses current theme, not legacy fallbacks
  private themeColors: MapThemeColors = getMapThemeColors();

  // Bound event handlers for cleanup
  private boundMouseMove: ((e: maplibregl.MapMouseEvent) => void) | null = null;
  private boundMapLeave: (() => void) | null = null;
  private boundClick: ((e: maplibregl.MapMouseEvent) => void) | null = null;
  private boundDoubleClick: ((e: maplibregl.MapMouseEvent) => void) | null = null;
  private boundContextMenu: ((e: MouseEvent) => void) | null = null;

  constructor(map: MaplibreMap, callbacks: GlobalSurveyLayerCallbacks = {}) {
    this.map = map;
    this.callbacks = callbacks;
    this.initializeSources();
    this.initializeLayers();
    this.initializeEventHandlers();
    this.initializeTooltip();
  }

  /**
   * Update the callbacks (e.g., when props change).
   */
  setCallbacks(callbacks: GlobalSurveyLayerCallbacks): void {
    this.callbacks = callbacks;
  }

  private initializeSources(): void {
    // Single GeoJSON source for all features (shots and stations)
    // Features are distinguished by featureType property
    this.map.addSource(this.sourceId, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
      tolerance: this.currentTolerance,
      generateId: true,
    });
  }

  private initializeLayers(): void {
    // === HITBOX LAYERS (invisible, for click detection) ===
    // Layer order: shots hitbox -> stations hitbox -> shots visual -> stations visual

    // Shot hitbox layer - wider hit area for easier selection
    // CRITICAL: Use opaque color with tiny opacity for queryRenderedFeatures
    this.map.addLayer({
      id: this.shotsHitboxLayerId,
      type: 'line',
      source: this.sourceId,
      filter: ['==', ['get', 'featureType'], 'shot'],
      layout: {
        'line-cap': 'round',
      },
      paint: {
        'line-width': 10, // Wide hit area
        'line-color': '#000000',
        'line-opacity': 0.001, // CRITICAL: non-zero for queryRenderedFeatures
      },
    });

    // Station hitbox layer - larger hit area
    this.map.addLayer({
      id: this.stationsHitboxLayerId,
      type: 'circle',
      source: this.sourceId,
      filter: ['==', ['get', 'featureType'], 'station'],
      paint: {
        'circle-radius': 10, // Larger hit area
        'circle-color': '#000000',
        'circle-opacity': 0.001, // CRITICAL: non-zero for queryRenderedFeatures
        'circle-stroke-width': 0,
      },
    });

    // === VISUAL LAYERS ===

    // Shots layer (lines) - rendered first (below stations)
    // Initial color is fallback gray; updateColorExpressions() sets per-system match expression
    this.map.addLayer({
      id: this.shotsLayerId,
      type: 'line',
      source: this.sourceId,
      filter: ['==', ['get', 'featureType'], 'shot'],
      paint: {
        'line-color': this.themeColors.grayLine, // Fallback, replaced by match expression on update()
        'line-width': [
          'case',
          ['boolean', ['get', 'isVirtual'], false],
          1,
          2,
        ],
        'line-opacity': [
          'case',
          ['boolean', ['get', 'isVirtual'], false],
          0.5,
          1,
        ],
      },
    });

    // Stations layer (circles) - rendered second (above shots)
    // Initial color is fallback gray; updateColorExpressions() sets per-system match expression
    this.map.addLayer({
      id: this.stationsLayerId,
      type: 'circle',
      source: this.sourceId,
      filter: ['==', ['get', 'featureType'], 'station'],
      paint: {
        'circle-radius': 4,
        'circle-color': this.themeColors.grayLine, // Fallback, replaced by match expression on update()
        'circle-stroke-width': 1,
        'circle-stroke-color': this.themeColors.strokeColor,
      },
    });
  }

  private initializeEventHandlers(): void {
    // Unified click handler - passes ctrlKey for multi-select
    this.boundClick = (e: maplibregl.MapMouseEvent) => {
      // Query both hitbox layers - stations have priority
      const stationFeatures = this.map.queryRenderedFeatures(e.point, {
        layers: [this.stationsHitboxLayerId],
      });

      const ctrlKey = e.originalEvent.ctrlKey || e.originalEvent.metaKey;

      if (stationFeatures.length > 0) {
        const feature = stationFeatures[0];
        const systemId = feature?.properties?.systemId as string | undefined;
        if (systemId) {
          this.callbacks.onSystemClick?.(systemId, e, ctrlKey);
          return;
        }
      }

      const shotFeatures = this.map.queryRenderedFeatures(e.point, {
        layers: [this.shotsHitboxLayerId],
      });

      if (shotFeatures.length > 0) {
        const feature = shotFeatures[0];
        const systemId = feature?.properties?.systemId as string | undefined;
        if (systemId) {
          this.callbacks.onSystemClick?.(systemId, e, ctrlKey);
        }
      }
    };
    this.map.on('click', this.boundClick);

    // Double-click handler to open project
    this.boundDoubleClick = (e: maplibregl.MapMouseEvent) => {
      // Query both hitbox layers - stations have priority
      const stationFeatures = this.map.queryRenderedFeatures(e.point, {
        layers: [this.stationsHitboxLayerId],
      });

      if (stationFeatures.length > 0) {
        const feature = stationFeatures[0];
        const systemId = feature?.properties?.systemId as string | undefined;
        if (systemId) {
          this.callbacks.onSystemDoubleClick?.(systemId);
          return;
        }
      }

      const shotFeatures = this.map.queryRenderedFeatures(e.point, {
        layers: [this.shotsHitboxLayerId],
      });

      if (shotFeatures.length > 0) {
        const feature = shotFeatures[0];
        const systemId = feature?.properties?.systemId as string | undefined;
        if (systemId) {
          this.callbacks.onSystemDoubleClick?.(systemId);
        }
      }
    };
    this.map.on('dblclick', this.boundDoubleClick);

    // Unified mousemove handler for hover detection and tooltip
    this.boundMouseMove = (e: maplibregl.MapMouseEvent) => {
      // Query both hitbox layers - stations have priority
      const stationFeatures = this.map.queryRenderedFeatures(e.point, {
        layers: [this.stationsHitboxLayerId],
      });
      const shotFeatures = this.map.queryRenderedFeatures(e.point, {
        layers: [this.shotsHitboxLayerId],
      });

      let newHoveredSystemId: string | null = null;
      let featureProperties: {
        name?: string;
        totalLength?: number;
        stationCount?: number;
      } | null = null;

      if (stationFeatures.length > 0) {
        const feature = stationFeatures[0];
        newHoveredSystemId = (feature?.properties?.systemId as string) || null;
        if (feature?.properties) {
          featureProperties = feature.properties as {
            name?: string;
            totalLength?: number;
            stationCount?: number;
          };
        }
      } else if (shotFeatures.length > 0) {
        const feature = shotFeatures[0];
        newHoveredSystemId = (feature?.properties?.systemId as string) || null;
        if (feature?.properties) {
          featureProperties = feature.properties as {
            name?: string;
            totalLength?: number;
            stationCount?: number;
          };
        }
      }

      // Update tooltip position and content
      this.updateTooltip(
        newHoveredSystemId ? e.originalEvent : null,
        featureProperties
      );

      if (newHoveredSystemId !== this.hoveredSystemId) {
        this.hoveredSystemId = newHoveredSystemId;

        // Update cursor
        if (newHoveredSystemId) {
          this.map.getCanvas().style.cursor = 'pointer';
          this.callbacks.onFeatureHover?.(true);
        } else {
          this.map.getCanvas().style.cursor = '';
          this.callbacks.onFeatureHover?.(false);
        }

        this.callbacks.onSystemHover?.(newHoveredSystemId);
        this.updateVisualState();
      }
    };
    this.map.on('mousemove', this.boundMouseMove);

    // Clear hover on mouse leave
    this.boundMapLeave = () => {
      if (this.hoveredSystemId) {
        this.hoveredSystemId = null;
        this.map.getCanvas().style.cursor = '';
        this.callbacks.onFeatureHover?.(false);
        this.callbacks.onSystemHover?.(null);
        this.updateVisualState();
      }
      // Clear context menu flag (menu closes when mouse leaves)
      this.contextMenuOpen = false;
      this.hideTooltip();
    };
    this.map.getCanvas().addEventListener('mouseleave', this.boundMapLeave);

    // Context menu handler for right-click
    this.boundContextMenu = (e: MouseEvent) => {
      // Only handle if callback is set - allows default context menu when no callback
      if (!this.callbacks.onSystemContextMenu) return;

      // Get point from mouse event relative to map container
      const rect = this.map.getContainer().getBoundingClientRect();
      const point: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];

      // Query both hitbox layers - stations have priority
      const stationFeatures = this.map.queryRenderedFeatures(point, {
        layers: [this.stationsHitboxLayerId],
      });

      if (stationFeatures.length > 0) {
        const feature = stationFeatures[0];
        const systemId = feature?.properties?.systemId as string | undefined;
        if (systemId) {
          // Prevent default browser context menu when we handle the event
          e.preventDefault();
          // Hide tooltip while context menu is open
          this.contextMenuOpen = true;
          this.hideTooltip();
          this.callbacks.onSystemContextMenu(systemId, e);
          return;
        }
      }

      const shotFeatures = this.map.queryRenderedFeatures(point, {
        layers: [this.shotsHitboxLayerId],
      });

      if (shotFeatures.length > 0) {
        const feature = shotFeatures[0];
        const systemId = feature?.properties?.systemId as string | undefined;
        if (systemId) {
          // Prevent default browser context menu when we handle the event
          e.preventDefault();
          // Hide tooltip while context menu is open
          this.contextMenuOpen = true;
          this.hideTooltip();
          this.callbacks.onSystemContextMenu(systemId, e);
        }
      }
    };
    this.map.getCanvas().addEventListener('contextmenu', this.boundContextMenu);
  }

  /**
   * Update the layer with new system geometry data.
   */
  update(systems: SystemGeometry[]): void {
    // Build all features in a single array
    const features: GeoJSON.Feature[] = [];

    // Clear and rebuild system colors
    this.systemColors.clear();

    for (const system of systems) {
      const color = generateSystemColor(system.metadata.file_path);
      this.systemColors.set(system.metadata.file_path, color);

      // Build shot features
      for (const shot of system.geometry.shots) {
        features.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [shot.from, shot.to],
          },
          properties: {
            featureType: 'shot',
            systemId: system.metadata.file_path,
            name: system.metadata.name,
            totalLength: system.metadata.total_length,
            stationCount: system.metadata.station_count,
            isVirtual: shot.is_virtual,
          },
        });
      }

      // Extract and build station features
      const stations = extractStations(system.geometry.shots);
      for (const [lng, lat] of stations) {
        features.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [lng, lat],
          },
          properties: {
            featureType: 'station',
            systemId: system.metadata.file_path,
            name: system.metadata.name,
            totalLength: system.metadata.total_length,
            stationCount: system.metadata.station_count,
          },
        });
      }
    }

    // Cache features for tolerance updates
    this.cachedFeatures = features;

    // Update the single source with all features
    const source = this.map.getSource(this.sourceId);
    if (source && 'setData' in source) {
      (source as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features,
      });
    }

    // Update color expressions using match on systemId
    this.updateColorExpressions();

    // Reapply hover/selection styling in case selection existed before data loaded
    this.updateVisualState();
  }

  /**
   * Build and apply match expressions for per-system colors.
   * Uses systemColors map to generate efficient match expressions.
   */
  private updateColorExpressions(): void {
    const fallback = this.themeColors.grayLine;
    if (this.systemColors.size === 0) {
      if (this.map.getLayer(this.shotsLayerId)) {
        this.map.setPaintProperty(this.shotsLayerId, 'line-color', fallback);
      }
      if (this.map.getLayer(this.stationsLayerId)) {
        this.map.setPaintProperty(this.stationsLayerId, 'circle-color', fallback);
      }
      return;
    }

    // Build match expression: ['match', ['get', 'systemId'], 'path1', 'color1', 'path2', 'color2', ..., fallback]
    const matchArgs: (string | maplibregl.ExpressionSpecification)[] = [
      'match',
      ['get', 'systemId'],
    ];

    for (const [systemId, color] of this.systemColors) {
      matchArgs.push(systemId, color);
    }

    // Fallback color for unknown systems
    matchArgs.push(fallback);

    const colorExpr = matchArgs as maplibregl.ExpressionSpecification;

    // Apply to visual layers
    if (this.map.getLayer(this.shotsLayerId)) {
      this.map.setPaintProperty(this.shotsLayerId, 'line-color', colorExpr);
    }
    if (this.map.getLayer(this.stationsLayerId)) {
      this.map.setPaintProperty(this.stationsLayerId, 'circle-color', colorExpr);
    }
  }

  /**
   * Set the selected system for highlighting (single selection).
   * For backwards compatibility - calls setSelectedSystems internally.
   */
  setSelectedSystem(filePath: string | null): void {
    const newSet = filePath ? new Set([filePath]) : new Set<string>();
    this.setSelectedSystems(newSet);
  }

  /**
   * Set the selected systems for highlighting (multi-select).
   */
  setSelectedSystems(systemIds: Set<string>): void {
    // Check if actually changed (compare set contents)
    if (
      this.selectedSystemIds.size === systemIds.size &&
      [...this.selectedSystemIds].every((id) => systemIds.has(id))
    ) {
      return;
    }
    this.selectedSystemIds = new Set(systemIds);
    this.updateVisualState();
  }

  /**
   * Set filter to hide virtual shots (or show all).
   * Applies to both visual and hitbox layers to prevent hidden shots from being clickable.
   */
  setShowVirtualShots(visible: boolean): void {
    // Base filter for shot features
    const shotTypeFilter: maplibregl.ExpressionSpecification = ['==', ['get', 'featureType'], 'shot'];

    // Combined filter: show shots AND (optionally) exclude virtual
    const filter: maplibregl.FilterSpecification = visible
      ? shotTypeFilter
      : ['all', shotTypeFilter, ['!=', ['get', 'isVirtual'], true]];

    // Apply filter to visual layer
    if (this.map.getLayer(this.shotsLayerId)) {
      this.map.setFilter(this.shotsLayerId, filter);
    }

    // Also apply to hitbox layer to prevent hidden shots from being clickable
    if (this.map.getLayer(this.shotsHitboxLayerId)) {
      this.map.setFilter(this.shotsHitboxLayerId, filter);
    }
  }

  /**
   * Set search filter to dim non-matching systems.
   * Uses case-insensitive substring match on system name.
   * Non-matching systems dim to 25% opacity but remain clickable.
   *
   * @param term - Search term to filter by, or null to clear filter
   */
  setSearchFilter(term: string | null): void {
    this.searchFilter = term;
    this.updateOpacityExpressions();
  }

  /**
   * Set visibility of all survey layers (shots and stations).
   * Used by view mode toggle to switch between survey and markers-only view.
   *
   * @param visible - Whether survey layers should be visible
   */
  setVisible(visible: boolean): void {
    const visibility = visible ? 'visible' : 'none';

    // Set visibility on visual layers
    if (this.map.getLayer(this.shotsLayerId)) {
      this.map.setLayoutProperty(this.shotsLayerId, 'visibility', visibility);
    }
    if (this.map.getLayer(this.stationsLayerId)) {
      this.map.setLayoutProperty(this.stationsLayerId, 'visibility', visibility);
    }

    // Also set visibility on hitbox layers to prevent invisible features from being clickable
    if (this.map.getLayer(this.shotsHitboxLayerId)) {
      this.map.setLayoutProperty(this.shotsHitboxLayerId, 'visibility', visibility);
    }
    if (this.map.getLayer(this.stationsHitboxLayerId)) {
      this.map.setLayoutProperty(this.stationsHitboxLayerId, 'visibility', visibility);
    }
  }

  /**
   * Set the GeoJSON simplification tolerance.
   * Higher values = more simplification = better performance but less detail.
   *
   * Note: MapLibre requires removing and re-adding the source to change tolerance,
   * so this recreates the source with the cached feature data.
   *
   * @param tolerance - GeoJSON simplification tolerance (e.g., 0.5 for normal, 1.0 for throttled)
   */
  setTolerance(tolerance: number): void {
    if (tolerance === this.currentTolerance) return;

    // Store old tolerance in case we need to revert on failure
    const oldTolerance = this.currentTolerance;

    // MapLibre doesn't allow changing source options after creation,
    // so we need to remove and re-add the source with new tolerance.
    // First, remove layers that depend on the source
    const layerIds = [
      this.stationsLayerId,
      this.shotsLayerId,
      this.stationsHitboxLayerId,
      this.shotsHitboxLayerId,
    ];

    try {
      // Remove layers in reverse order
      for (const layerId of layerIds) {
        if (this.map.getLayer(layerId)) {
          this.map.removeLayer(layerId);
        }
      }

      // Remove and re-add source with new tolerance
      if (this.map.getSource(this.sourceId)) {
        this.map.removeSource(this.sourceId);
      }

      this.map.addSource(this.sourceId, {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: this.cachedFeatures, // May be empty, that's OK
        },
        tolerance,
        generateId: true,
      });

      // Re-add layers
      this.initializeLayers();

      // Re-apply color expressions and visual state
      this.updateColorExpressions();
      this.updateVisualState();
      this.updateOpacityExpressions();

      // Only update currentTolerance after successful rebuild
      this.currentTolerance = tolerance;
    } catch {
      // Revert internal state on failure
      this.currentTolerance = oldTolerance;
      console.error('[GlobalSurveyLayer] Failed to update tolerance');
    }
  }

  /**
   * Get the current tolerance value.
   */
  getTolerance(): number {
    return this.currentTolerance;
  }

  /**
   * Update opacity expressions on visual layers based on search filter.
   * Non-matching systems are dimmed to 25% opacity.
   */
  private updateOpacityExpressions(): void {
    // Build opacity expression based on search filter
    // If no filter, all systems have full opacity
    // If filter set, use index-of + downcase for case-insensitive substring match
    let shotsOpacity: maplibregl.ExpressionSpecification | number;
    let stationsOpacity: maplibregl.ExpressionSpecification | number;

    if (!this.searchFilter) {
      // No search filter - shots use default opacity (virtual shots dimmed)
      shotsOpacity = [
        'case',
        ['boolean', ['get', 'isVirtual'], false],
        0.5,
        1,
      ];
      stationsOpacity = 1;
    } else {
      // Search filter active - dim non-matching systems
      // Case-insensitive substring match: index-of returns >= 0 if found
      // Use MapLibre downcase for both search term and name (no JS toLowerCase)
      const matchExpr: maplibregl.ExpressionSpecification = [
        '>=',
        ['index-of', ['downcase', ['literal', this.searchFilter]], ['downcase', ['get', 'name']]],
        0,
      ];

      // Shots: full opacity if match (with virtual dimming), 25% if no match
      shotsOpacity = [
        'case',
        matchExpr,
        ['case', ['boolean', ['get', 'isVirtual'], false], 0.5, 1],
        0.25,
      ];

      // Stations: full opacity if match, 25% if no match
      stationsOpacity = ['case', matchExpr, 1, 0.25];
    }

    // Apply to visual layers
    if (this.map.getLayer(this.shotsLayerId)) {
      this.map.setPaintProperty(this.shotsLayerId, 'line-opacity', shotsOpacity);
    }
    if (this.map.getLayer(this.stationsLayerId)) {
      this.map.setPaintProperty(this.stationsLayerId, 'circle-opacity', stationsOpacity);
      // Also dim stroke opacity to ensure full 25% dimming effect
      this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-opacity', stationsOpacity);
    }
  }

  /**
   * Update visual styling based on hover/selection state.
   * Uses paint property expressions for filter-based highlighting.
   */
  private updateVisualState(): void {
    // Build selection check expression
    // For empty set, use a never-matching condition
    // For non-empty set, use 'in' expression: ['in', ['get', 'systemId'], ['literal', [...]]]
    const selectedArray = [...this.selectedSystemIds];
    const isSelectedExpr: maplibregl.ExpressionSpecification =
      selectedArray.length === 0
        ? ['==', 1, 0] // Never matches
        : ['in', ['get', 'systemId'], ['literal', selectedArray]];

    // Shot line width: thicker for hovered/selected systems
    const shotLineWidth: maplibregl.ExpressionSpecification = [
      'case',
      // Hovered system: thick lines
      ['==', ['get', 'systemId'], this.hoveredSystemId ?? ''],
      4,
      // Selected systems: medium-thick lines
      isSelectedExpr,
      3,
      // Virtual shots: thin
      ['boolean', ['get', 'isVirtual'], false],
      1,
      // Default
      2,
    ];
    this.map.setPaintProperty(this.shotsLayerId, 'line-width', shotLineWidth);

    // Station radius: larger for hovered/selected systems
    const stationRadius: maplibregl.ExpressionSpecification = [
      'case',
      ['==', ['get', 'systemId'], this.hoveredSystemId ?? ''],
      6,
      isSelectedExpr,
      5,
      4,
    ];
    this.map.setPaintProperty(this.stationsLayerId, 'circle-radius', stationRadius);

    // Station stroke width: thicker for hovered/selected
    const stationStrokeWidth: maplibregl.ExpressionSpecification = [
      'case',
      ['==', ['get', 'systemId'], this.hoveredSystemId ?? ''],
      2,
      isSelectedExpr,
      2,
      1,
    ];
    this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-width', stationStrokeWidth);
  }

  /**
   * Get the color assigned to a system.
   */
  getSystemColor(filePath: string): string {
    return this.systemColors.get(filePath) ?? generateSystemColor(filePath);
  }

  /**
   * Check if the layer has any data loaded.
   */
  hasData(): boolean {
    return this.systemColors.size > 0;
  }

  /**
   * Apply new theme colors to MapLibre paint properties.
   * Called from GlobalViewMap when resolvedTheme changes.
   */
  applyThemeColors(colors: MapThemeColors): void {
    this.themeColors = colors;

    if (!hasLiveStyle(this.map)) return;

    const strokeColor = colors.strokeColor;

    // Update station stroke color
    if (this.map.getLayer(this.stationsLayerId)) {
      this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-color', strokeColor);
    }
    // Update per-system color expressions (fallback uses theme gray)
    this.updateColorExpressions();

    // Update tooltip colors
    if (this.tooltip) {
      this.tooltip.style.backgroundColor = colors.previewBg;
      this.tooltip.style.color = colors.labelColor;
    }
  }

  /**
   * Initialize the tooltip element.
   */
  private initializeTooltip(): void {
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'globalview-survey-tooltip';
    const bg = this.themeColors?.previewBg ?? 'rgba(26, 26, 46, 0.95)';
    const fg = this.themeColors?.labelColor ?? 'white';
    this.tooltip.style.cssText = `
      position: absolute;
      pointer-events: none;
      background-color: ${bg};
      color: ${fg};
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.4;
      z-index: 1000;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      display: none;
    `;
    // Append to map container
    this.map.getContainer().appendChild(this.tooltip);
  }

  /**
   * Update tooltip position and content.
   */
  private updateTooltip(
    event: MouseEvent | null,
    properties: {
      name?: string;
      totalLength?: number;
      stationCount?: number;
    } | null
  ): void {
    if (!this.tooltip) return;

    // Don't show tooltip if context menu is open
    if (this.contextMenuOpen) return;

    if (!event || !properties) {
      this.hideTooltip();
      return;
    }

    // Format total length
    const length = properties.totalLength ?? 0;
    let lengthStr: string;
    if (length >= 1000) {
      lengthStr = `${(length / 1000).toFixed(2)} km`;
    } else {
      lengthStr = `${length.toFixed(1)} m`;
    }

    // Build tooltip content using textContent to avoid XSS
    const name = properties.name ?? 'Unknown';
    const stationCount = properties.stationCount ?? 0;

    // Clear existing content
    this.tooltip.textContent = '';

    // Name row
    const nameDiv = document.createElement('div');
    nameDiv.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
    nameDiv.textContent = name;
    this.tooltip.appendChild(nameDiv);

    // Length row
    const grayText = this.themeColors?.grayText ?? '#aaa';
    const lengthDiv = document.createElement('div');
    lengthDiv.style.color = grayText;
    lengthDiv.textContent = `Length: ${lengthStr}`;
    this.tooltip.appendChild(lengthDiv);

    // Station count row
    const stationDiv = document.createElement('div');
    stationDiv.style.color = grayText;
    stationDiv.textContent = `Stations: ${stationCount}`;
    this.tooltip.appendChild(stationDiv);

    // Position tooltip near cursor (offset by 15px)
    const container = this.map.getContainer();
    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left + 15;
    const y = event.clientY - rect.top + 15;

    // Temporarily make visible but hidden for measurement
    this.tooltip.style.visibility = 'hidden';
    this.tooltip.style.display = 'block';

    // Measure tooltip dimensions
    const tooltipRect = this.tooltip.getBoundingClientRect();
    const maxX = container.clientWidth - tooltipRect.width - 10;
    const maxY = container.clientHeight - tooltipRect.height - 10;

    // Clamp position to keep tooltip within container bounds (min 0)
    this.tooltip.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
    this.tooltip.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
    this.tooltip.style.visibility = 'visible';
  }

  /**
   * Hide the tooltip.
   */
  private hideTooltip(): void {
    if (this.tooltip) {
      this.tooltip.style.display = 'none';
    }
  }

  /**
   * Destroy the layer, removing all sources and event handlers.
   */
  destroy(): void {
    // Remove event handlers
    if (this.boundClick) {
      this.map.off('click', this.boundClick);
    }
    if (this.boundDoubleClick) {
      this.map.off('dblclick', this.boundDoubleClick);
    }
    if (this.boundMouseMove) {
      this.map.off('mousemove', this.boundMouseMove);
    }
    if (this.boundMapLeave) {
      this.map.getCanvas().removeEventListener('mouseleave', this.boundMapLeave);
    }
    if (this.boundContextMenu) {
      this.map.getCanvas().removeEventListener('contextmenu', this.boundContextMenu);
    }

    // Remove tooltip
    if (this.tooltip && this.tooltip.parentNode) {
      this.tooltip.parentNode.removeChild(this.tooltip);
    }
    this.tooltip = null;

    // Remove layers (in reverse order of addition)
    try {
      if (this.map.getLayer(this.stationsLayerId)) {
        this.map.removeLayer(this.stationsLayerId);
      }
      if (this.map.getLayer(this.shotsLayerId)) {
        this.map.removeLayer(this.shotsLayerId);
      }
      if (this.map.getLayer(this.stationsHitboxLayerId)) {
        this.map.removeLayer(this.stationsHitboxLayerId);
      }
      if (this.map.getLayer(this.shotsHitboxLayerId)) {
        this.map.removeLayer(this.shotsHitboxLayerId);
      }

      // Remove source
      if (this.map.getSource(this.sourceId)) {
        this.map.removeSource(this.sourceId);
      }
    } catch {
      // Map may already be destroyed
    }

    // Clear bound handlers
    this.boundClick = null;
    this.boundDoubleClick = null;
    this.boundMouseMove = null;
    this.boundMapLeave = null;
    this.boundContextMenu = null;
  }
}
