import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type maplibregl from 'maplibre-gl';
import type { Section, SectionId, ShotId, Station, StationRef, StationMerge, LoopClosure } from '../../types/project';
import type { Config, GpsOrigin } from '../../types/config';
import { metersToMapCoords } from '../../utils/coordinates';
import { getDepthColor } from '../../utils/colors';
import { hasLiveStyle } from './mapUtils';
import { isNonInteractiveTool } from '../../utils/toolUtils';
import type { ToolType } from '../../store/uiStore';
// Note: buildPriorityExpression, compositeIdEquals, inSection no longer needed
// after switching to setFeatureState for hover/selection highlighting

export interface SurveyLayerCallbacks {
  onStationClick?: (ref: StationRef, event: MapMouseEvent) => void;
  onShotClick?: (sectionId: SectionId, shotId: ShotId, event: MapMouseEvent) => void;
  onEmptyClick?: (event: MapMouseEvent) => void;
  onStationHover?: (ref: StationRef | null) => void;
  onShotHover?: (shot: { sectionId: SectionId; shotId: ShotId } | null) => void;
  onFeatureHover?: ((isHovering: boolean) => void) | undefined;
  onContextMenu?: (
    target: { type: 'station'; ref: StationRef } | { type: 'shot'; sectionId: SectionId; shotId: ShotId } | null,
    event: MapMouseEvent
  ) => void;
  /** Called when user clicks near a hidden station (for toast feedback) */
  onHiddenStationClick?: () => void;
  /** Called when user clicks near a hidden shot (for toast feedback) */
  onHiddenShotClick?: () => void;
}

/**
 * Survey layer that renders shots and stations on the map
 *
 * This is a simplified implementation using MapLibre GL JS.
 * For better performance with large datasets, this could be
 * replaced with deck.gl layers.
 */
/**
 * Ghost section data for merge preview visualization.
 */
export interface GhostSectionData {
  /** Shot line coordinates (pairs of [from, to] positions in meters) */
  shots: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>;
  /** Station positions in meters */
  stations: Array<{ x: number; y: number }>;
  /** Section color */
  color: string;
  /** Merge station highlight position (the station being merged) */
  mergeStation?: { x: number; y: number };
}

export default class SurveyLayer {
  private map: MaplibreMap;
  private sourceId = 'survey-data';
  private shotsLayerId = 'survey-shots';
  private stationsLayerId = 'survey-stations';
  private labelsLayerId = 'survey-labels';
  private shotLabelsLayerId = 'survey-shot-labels';
  private stationLabelsLayerId = 'survey-station-labels';
  private mergesLayerId = 'survey-merges';
  private loopClosuresLayerId = 'survey-loop-closures';
  private ghostShotsLayerId = 'survey-ghost-shots';
  private ghostStationsLayerId = 'survey-ghost-stations';
  private ghostMergeLayerId = 'survey-ghost-merge';
  private stationsHighlightLayerId = 'survey-stations-highlight';
  // Hitbox layers for improved click detection
  private stationsHitboxLayerId = 'survey-stations-hitbox';
  private shotsHitboxLayerId = 'survey-shots-hitbox';
  private ghostStationsHitboxLayerId = 'survey-ghost-stations-hitbox';
  private ghostShotsHitboxLayerId = 'survey-ghost-shots-hitbox';
  private callbacks: SurveyLayerCallbacks;

  // Config storage with fallback defaults for when config is null (initial load)
  private config: Config | null = null;
  private static readonly DEFAULTS = {
    station: { radius: 4, hit_area: 10, hover_radius: 6, selection_radius: 5 },
    shot: { width: 2, hit_area: 8, hover_width: 4, selection_width: 3 },
  };

  // Visual state
  private selectedStationId: string | null = null;
  private selectedShotId: string | null = null;
  private hoveredStationId: string | null = null;
  private hoveredShotId: string | null = null;
  private snappedStationId: string | null = null;
  private hoveredSectionId: string | null = null;
  private selectedSectionId: string | null = null;

  // Active tool state (for disabling interactions when non-interactive tools are active)
  private activeTool: ToolType = 'select';

  // Visibility state (for hidden feature detection)
  private stationsVisible: boolean = true;
  private shotsVisible: boolean = true;

  // GPS origin for coordinate transforms (enables satellite tile alignment)
  private gpsOrigin: GpsOrigin | null = null;

  // Depth gradient mode state (used during update() for feature color calculation)
  private showDepthGradient: boolean = false;
  private depthRange: { min: number; max: number } = { min: 0, max: 50 };

  // Bound event handlers stored for proper cleanup in destroy()
  private boundMouseMove: ((e: maplibregl.MapMouseEvent) => void) | null = null;
  private boundMapLeave: (() => void) | null = null;

  // Hover update batching - only process latest mouse position per frame
  private pendingHoverEvent: maplibregl.MapMouseEvent | null = null;
  private hoverRafId: number | null = null;

  // Previous feature IDs for setFeatureState (to clear state when hover/selection changes)
  private prevHoveredStationFeatureId: number | null = null;
  private prevHoveredShotFeatureId: number | null = null;
  private prevSelectedStationFeatureId: number | null = null;
  private prevSelectedShotFeatureId: number | null = null;

  constructor(map: MaplibreMap, callbacks: SurveyLayerCallbacks = {}) {
    this.map = map;
    this.callbacks = callbacks;
    this.initializeSources();
    this.initializeLayers();
    this.initializeEventHandlers();
  }

  setCallbacks(callbacks: SurveyLayerCallbacks) {
    this.callbacks = callbacks;
  }

  // Config setter - triggers layer updates when config changes
  public setConfig(config: Config): void {
    this.config = config;
    this.updateHitboxLayers();
    this.updateGhostVisualLayers();
    this.updateVisualState();
    this.updateDebugVisualization();
  }

  /**
   * Set the active tool. When switching to a non-interactive tool (pan/zoom),
   * clears hover state and notifies callbacks to sync MapCanvas state.
   * Self-healing: also clears stale hover if already in a non-interactive tool.
   */
  public setActiveTool(tool: ToolType): void {
    this.activeTool = tool;

    const isNonInteractive = isNonInteractiveTool(tool);

    // Clear hover when in non-interactive tool AND there's stale hover state
    // This is self-healing: handles both transitions (interactive→non-interactive)
    // and missed initial syncs or future refactors
    if (isNonInteractive && (this.hoveredStationId || this.hoveredShotId || this.hoveredSectionId)) {
      this.hoveredStationId = null;
      this.hoveredShotId = null;
      this.hoveredSectionId = null;
      this.updateVisualState();
      this.map.getCanvas().style.cursor = '';

      // CRITICAL: Also notify callbacks to clear MapCanvas state
      this.callbacks.onFeatureHover?.(false);
      this.callbacks.onStationHover?.(null);
      this.callbacks.onShotHover?.(null);
    }
  }

  // Helper methods that use fallback defaults when config is null
  private getStationRadius(): number {
    return this.config?.map?.station?.radius ?? SurveyLayer.DEFAULTS.station.radius;
  }

  private getStationHitArea(): number {
    return this.config?.map?.station?.hit_area ?? SurveyLayer.DEFAULTS.station.hit_area;
  }

  private getShotWidth(): number {
    return this.config?.map?.shot?.width ?? SurveyLayer.DEFAULTS.shot.width;
  }

  private getShotHitArea(): number {
    return this.config?.map?.shot?.hit_area ?? SurveyLayer.DEFAULTS.shot.hit_area;
  }

  private getStationHoverRadius(): number {
    return this.config?.map?.station?.hover_radius ?? SurveyLayer.DEFAULTS.station.hover_radius;
  }

  private getStationSelectionRadius(): number {
    return this.config?.map?.station?.selection_radius ?? SurveyLayer.DEFAULTS.station.selection_radius;
  }

  private getShotHoverWidth(): number {
    return this.config?.map?.shot?.hover_width ?? SurveyLayer.DEFAULTS.shot.hover_width;
  }

  private getShotSelectionWidth(): number {
    return this.config?.map?.shot?.selection_width ?? SurveyLayer.DEFAULTS.shot.selection_width;
  }

  private initializeSources() {
    // Shots line source - promoteId enables setFeatureState for hover/selection
    this.map.addSource(this.sourceId + '-shots', {
      type: 'geojson',
      promoteId: 'featureId',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Stations point source - promoteId enables setFeatureState for hover/selection
    this.map.addSource(this.sourceId + '-stations', {
      type: 'geojson',
      promoteId: 'featureId',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Merge connections line source
    this.map.addSource(this.sourceId + '-merges', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Loop closures line source
    this.map.addSource(this.sourceId + '-loop-closures', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Shot labels point source (midpoint of each shot)
    this.map.addSource(this.sourceId + '-shot-labels', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Section name labels point source (first station of each section)
    this.map.addSource(this.sourceId + '-section-labels', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Station index labels point source (at each station)
    this.map.addSource(this.sourceId + '-station-labels', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Ghost section sources for merge preview
    this.map.addSource(this.sourceId + '-ghost-shots', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    this.map.addSource(this.sourceId + '-ghost-stations', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    this.map.addSource(this.sourceId + '-ghost-merge', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });
  }

  private initializeLayers() {
    // === HITBOX LAYERS (invisible, for click detection) ===
    // Layer order (bottom to top):
    // 1. survey-shots-hitbox
    // 2. survey-stations-hitbox (above shots for hover priority)
    // 3. survey-ghost-shots-hitbox (debug only)
    // 4. survey-ghost-stations-hitbox (debug only)
    // Then visual layers follow...

    // Shot hitbox layer - added first (bottom of stack)
    // Use opaque color with tiny opacity for reliable queryRenderedFeatures
    this.map.addLayer({
      id: this.shotsHitboxLayerId,
      type: 'line',
      source: this.sourceId + '-shots',
      layout: {
        'line-cap': 'round', // Better endpoint detection
      },
      paint: {
        'line-width': this.getShotHitArea(),
        'line-color': '#000000', // Opaque color - use opacity for invisibility
        'line-opacity': 0.001, // CRITICAL: non-zero for queryRenderedFeatures
      },
    });

    // Station hitbox layer - above shots for correct hover priority
    // Use opaque color with tiny opacity for reliable queryRenderedFeatures
    this.map.addLayer({
      id: this.stationsHitboxLayerId,
      type: 'circle',
      source: this.sourceId + '-stations',
      paint: {
        'circle-radius': this.getStationHitArea(),
        'circle-color': '#000000', // Opaque color - use opacity for invisibility
        'circle-opacity': 0.001, // CRITICAL: non-zero for queryRenderedFeatures
        'circle-stroke-width': 0,
      },
    });

    // Ghost shot hitbox layer (for debug visualization only - NOT interactive)
    this.map.addLayer({
      id: this.ghostShotsHitboxLayerId,
      type: 'line',
      source: this.sourceId + '-ghost-shots',
      layout: {
        'line-cap': 'round',
      },
      paint: {
        'line-width': this.getShotHitArea(),
        'line-color': 'rgba(255, 255, 0, 0.3)', // Visible when debug enabled
        'line-opacity': 0, // Hidden by default, shown via updateDebugVisualization
      },
    });

    // Ghost station hitbox layer (for debug visualization only - NOT interactive)
    this.map.addLayer({
      id: this.ghostStationsHitboxLayerId,
      type: 'circle',
      source: this.sourceId + '-ghost-stations',
      paint: {
        'circle-radius': this.getStationHitArea(),
        'circle-color': 'rgba(255, 255, 0, 0.3)', // Visible when debug enabled
        'circle-opacity': 0, // Hidden by default, shown via updateDebugVisualization
        'circle-stroke-width': 0,
      },
    });

    // === VISUAL LAYERS ===

    // Ghost section shots layer (dashed, semi-transparent) - rendered first so it's behind everything
    // Uses config-based line width, updated via updateGhostVisualLayers()
    this.map.addLayer({
      id: this.ghostShotsLayerId,
      type: 'line',
      source: this.sourceId + '-ghost-shots',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': this.getShotWidth(),
        'line-opacity': 0.5,
        'line-dasharray': [4, 2],
      },
    });

    // Ghost section stations layer (semi-transparent)
    // Uses config-based radius, updated via updateGhostVisualLayers()
    this.map.addLayer({
      id: this.ghostStationsLayerId,
      type: 'circle',
      source: this.sourceId + '-ghost-stations',
      paint: {
        'circle-radius': this.getStationRadius(),
        'circle-color': ['get', 'color'],
        'circle-stroke-width': 1,
        'circle-stroke-color': '#000000',
        'circle-opacity': 0.5,
      },
    });

    // Ghost merge station highlight layer
    this.map.addLayer({
      id: this.ghostMergeLayerId,
      type: 'circle',
      source: this.sourceId + '-ghost-merge',
      paint: {
        'circle-radius': 8,
        'circle-color': '#4ecdc4',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
        'circle-opacity': 0.8,
      },
    });

    // Merge connections layer (dashed lines) - rendered first so it's behind everything
    this.map.addLayer({
      id: this.mergesLayerId,
      type: 'line',
      source: this.sourceId + '-merges',
      paint: {
        'line-color': '#00cccc', // Cyan for merge connections
        'line-width': 2,
        'line-opacity': 0.5,
        'line-dasharray': [4, 4], // Dashed line
      },
    });

    // Loop closures layer (dashed lines with color based on error severity)
    this.map.addLayer({
      id: this.loopClosuresLayerId,
      type: 'line',
      source: this.sourceId + '-loop-closures',
      paint: {
        // Color based on error percentage: green (<1%), yellow (1-3%), orange (3-5%), red (>5%)
        'line-color': ['get', 'color'],
        'line-width': 3,
        'line-opacity': 0.8,
        'line-dasharray': [6, 4], // Longer dashes than regular merges
      },
    });

    // Shots layer (lines) - uses feature-state for hover/selection
    const baseWidth = this.getShotWidth();
    const hoverWidth = this.getShotHoverWidth();
    const selectionWidth = this.getShotSelectionWidth();

    this.map.addLayer({
      id: this.shotsLayerId,
      type: 'line',
      source: this.sourceId + '-shots',
      paint: {
        'line-color': ['get', 'color'],
        // Width: hover > selected > base (uses feature-state)
        'line-width': [
          'case',
          ['boolean', ['feature-state', 'hover'], false], hoverWidth,
          ['boolean', ['feature-state', 'selected'], false], selectionWidth,
          baseWidth,
        ],
        'line-opacity': ['case', ['get', 'isVirtual'], 0.5, 1],
      },
    });

    // Stations layer (circles)
    // Uses feature-state for efficient hover/selection highlighting
    const baseRadius = this.getStationRadius();
    const hoverRadius = this.getStationHoverRadius();
    const selectionRadius = this.getStationSelectionRadius();

    this.map.addLayer({
      id: this.stationsLayerId,
      type: 'circle',
      source: this.sourceId + '-stations',
      paint: {
        // Radius: hover > selected > zeroDatum > base (uses feature-state)
        'circle-radius': [
          'case',
          ['boolean', ['feature-state', 'hover'], false], hoverRadius,
          ['boolean', ['feature-state', 'selected'], false], selectionRadius,
          ['get', 'isZeroDatum'], baseRadius * 2,
          baseRadius,
        ],
        // Color from feature property
        'circle-color': ['get', 'color'],
        // Stroke width: hover/selected states get thicker strokes (uses feature-state)
        'circle-stroke-width': [
          'case',
          ['boolean', ['feature-state', 'hover'], false], 4,
          ['boolean', ['feature-state', 'selected'], false], 2.5,
          ['get', 'isZeroDatum'], 2,
          1,
        ],
        // Stroke color: hover=blue, selected=lightblue, else from property
        'circle-stroke-color': [
          'case',
          ['boolean', ['feature-state', 'hover'], false], '#0066ff',
          ['boolean', ['feature-state', 'selected'], false], '#00aaff',
          ['get', 'strokeColor'],
        ],
      },
    });

    // Station highlight layer for snapped/active stations
    // Inserted immediately after stations - labels added later render on top naturally
    // Radius is config-based (baseRadius + 3), updated via updateVisualState()
    this.map.addLayer({
      id: this.stationsHighlightLayerId,
      type: 'circle',
      source: this.sourceId + '-stations',
      filter: ['==', ['get', 'sectionId'], -9999], // Filter to nothing initially
      paint: {
        'circle-radius': this.getStationRadius() + 3, // Snapped state: radius + 3
        'circle-color': '#00ffcc',
        'circle-stroke-width': 4,
        'circle-stroke-color': '#00ffcc',
      },
    });

    // Shot data labels layer - shows azimuth, length, depth at shot midpoint
    // Visibility controlled by showShotLabels toggle and zoom-based density
    this.map.addLayer({
      id: this.shotLabelsLayerId,
      type: 'symbol',
      source: this.sourceId + '-shot-labels',
      minzoom: 14, // Performance: don't render at low zooms
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Open Sans Regular'],
        'text-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14, 9,
          18, 12,
        ],
        'text-offset': [0, 0.5],
        'text-anchor': 'top',
        // Progressive density: hide labels at low zoom
        'text-allow-overlap': false,
        'visibility': 'none', // Start hidden, controlled by setShowShotLabels
      },
      paint: {
        'text-color': ['get', 'color'], // Dynamic color for depth gradient support
        'text-halo-color': '#000000',
        'text-halo-width': 2, // Increased for readability with depth colors
        'text-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14, 0.7,
          18, 1,
        ],
      },
      filter: [
        'case',
        // At zoom < 14: show nothing (filter all)
        ['<', ['zoom'], 14],
        false,
        // At zoom 14-16: show every 5th label (index % 5 == 0)
        ['all', ['>=', ['zoom'], 14], ['<', ['zoom'], 16]],
        ['==', ['%', ['get', 'index'], 5], 0],
        // At zoom 16-18: show every 2nd label
        ['all', ['>=', ['zoom'], 16], ['<', ['zoom'], 18]],
        ['==', ['%', ['get', 'index'], 2], 0],
        // At zoom >= 18: show all
        true,
      ],
    });

    // Section name labels layer - shows section name at first station
    // Visibility controlled by showSectionNames toggle
    this.map.addLayer({
      id: this.labelsLayerId,
      type: 'symbol',
      source: this.sourceId + '-section-labels',
      minzoom: 10, // Performance: don't render at very low zooms
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Regular'],
        'text-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          12, 11,
          18, 14,
        ],
        'text-offset': [0, -1.2],
        'text-anchor': 'bottom',
        'text-allow-overlap': false, // Avoid clutter in dense areas
        'visibility': 'visible', // Start visible, controlled by setShowSectionNames
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#1a1a2e', // Dark halo for contrast with any section color
        'text-halo-width': 1.5,
        'text-opacity': 1,
      },
    });

    // Station index labels layer - shows station index (0, 1, 2...) near each station
    // Visibility controlled by showStationLabels toggle and zoom-dependent density
    this.map.addLayer({
      id: this.stationLabelsLayerId,
      type: 'symbol',
      source: this.sourceId + '-station-labels',
      minzoom: 14, // Performance: don't render at low zooms
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Open Sans Regular'],
        'text-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14, 9,
          18, 11,
        ],
        'text-offset': [0.8, -0.8], // Offset to top-right of station dot
        'text-anchor': 'bottom-left',
        'text-allow-overlap': false, // Avoid clutter with overlapping labels
        'visibility': 'none', // Start hidden, controlled by setShowStationLabels
      },
      paint: {
        'text-color': ['get', 'color'], // Dynamic color for depth gradient support
        'text-halo-color': '#000000',
        'text-halo-width': 2, // Increased for readability with depth colors
        'text-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14, 0.7,
          18, 1,
        ],
      },
      // Zoom-dependent filtering using globalOrdinal (stable sequential index)
      // Always show first station in each section (isFirstInSection) to avoid empty-looking sections
      filter: [
        'case',
        // At zoom < 14: show nothing
        ['<', ['zoom'], 14],
        false,
        // At zoom 14-16: show first station + every 5th (globalOrdinal % 5 == 0)
        ['all', ['>=', ['zoom'], 14], ['<', ['zoom'], 16]],
        ['any', ['get', 'isFirstInSection'], ['==', ['%', ['get', 'globalOrdinal'], 5], 0]],
        // At zoom 16-18: show first station + every 2nd
        ['all', ['>=', ['zoom'], 16], ['<', ['zoom'], 18]],
        ['any', ['get', 'isFirstInSection'], ['==', ['%', ['get', 'globalOrdinal'], 2], 0]],
        // At zoom >= 18: show all
        true,
      ],
    });

  }

  private initializeEventHandlers() {
    // UNIFIED click handler - queries both hitbox layers with station priority
    // This replaces per-layer click handlers to ensure proper nearest-to-click resolution
    this.map.on('click', this.handleMapClick);

    // Note: Per-layer click handlers removed - unified handler handles all click logic

    // Process hover update for a given mouse event
    const processHoverUpdate = (e: maplibregl.MapMouseEvent) => {
      // Query both hitbox layers in a single call for better performance
      const allFeatures = this.map.queryRenderedFeatures(e.point, {
        layers: [this.stationsHitboxLayerId, this.shotsHitboxLayerId],
      });

      // Filter results by layer type
      const stationFeatures = allFeatures.filter(
        (f) => f.layer.id === this.stationsHitboxLayerId
      );
      const shotFeatures = allFeatures.filter(
        (f) => f.layer.id === this.shotsHitboxLayerId
      );

      // Resolve nearest of each type
      const nearestStation = this.resolveNearestStation(e, stationFeatures);
      const nearestShot = this.resolveNearestShot(e, shotFeatures);

      // Determine what to highlight (stations always take priority)
      let newHoveredStationId: string | null = null;
      let newHoveredShotId: string | null = null;

      if (nearestStation) {
        const { sectionId, stationIndex } = nearestStation.properties ?? {};
        if (sectionId !== undefined && stationIndex !== undefined) {
          newHoveredStationId = `${sectionId}:${stationIndex}`;
        }
      } else if (nearestShot) {
        const { sectionId, shotId } = nearestShot.properties ?? {};
        if (sectionId !== undefined && shotId !== undefined) {
          newHoveredShotId = `${sectionId}:${shotId}`;
        }
      }

      // Update state only if changed
      const stationChanged = newHoveredStationId !== this.hoveredStationId;
      const shotChanged = newHoveredShotId !== this.hoveredShotId;

      if (stationChanged || shotChanged) {
        this.hoveredStationId = newHoveredStationId;
        this.hoveredShotId = newHoveredShotId;

        // Update cursor
        this.map.getCanvas().style.cursor = (newHoveredStationId || newHoveredShotId) ? 'pointer' : '';

        // Update MapLibre visual state
        this.updateVisualState();

        // Notify React callbacks (deferred)
        queueMicrotask(() => {
          this.callbacks.onFeatureHover?.(Boolean(newHoveredStationId || newHoveredShotId));

          if (stationChanged) {
            if (newHoveredStationId) {
              const [secId, stIdx] = newHoveredStationId.split(':').map(Number);
              this.callbacks.onStationHover?.({ section_id: secId!, station_index: stIdx! });
            } else {
              this.callbacks.onStationHover?.(null);
            }
          }

          if (shotChanged) {
            if (newHoveredShotId) {
              const [secId, shId] = newHoveredShotId.split(':').map(Number);
              this.callbacks.onShotHover?.({ sectionId: secId!, shotId: shId! });
            } else {
              this.callbacks.onShotHover?.(null);
            }
          }
        });
      }
    };

    // Mousemove handler with RAF batching
    // Only processes the latest mouse position per animation frame,
    // preventing event queue buildup when queryRenderedFeatures is slow
    this.boundMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (isNonInteractiveTool(this.activeTool)) return;

      // Store latest event (overwrites any pending)
      this.pendingHoverEvent = e;

      // Schedule processing if not already scheduled
      if (this.hoverRafId === null) {
        this.hoverRafId = requestAnimationFrame(() => {
          this.hoverRafId = null;
          if (this.pendingHoverEvent) {
            const event = this.pendingHoverEvent;
            this.pendingHoverEvent = null;
            processHoverUpdate(event);
          }
        });
      }
    };

    // Clear all hover when cursor leaves the map canvas
    this.boundMapLeave = () => {
      if (this.hoveredStationId || this.hoveredShotId) {
        this.hoveredStationId = null;
        this.hoveredShotId = null;
        this.map.getCanvas().style.cursor = '';
        // Update visual state immediately
        this.updateVisualState();
        // Defer React callbacks
        queueMicrotask(() => {
          this.callbacks.onFeatureHover?.(false);
          this.callbacks.onStationHover?.(null);
          this.callbacks.onShotHover?.(null);
        });
      }
    };

    this.map.on('mousemove', this.boundMouseMove);
    this.map.getCanvas().addEventListener('mouseleave', this.boundMapLeave);

    // UNIFIED context menu handler - queries both hitbox layers with station priority
    this.map.on('contextmenu', this.handleContextMenu);
  }

  /**
   * UNIFIED click handler - queries both hitbox layers and resolves priority.
   * Stations always take priority over shots. Uses nearest-to-click resolution
   * when multiple features overlap.
   */
  private handleMapClick = (e: MapMouseEvent): void => {
    // Query both hitbox layers in a single call for better performance
    const allFeatures = this.map.queryRenderedFeatures(e.point, {
      layers: [this.stationsHitboxLayerId, this.shotsHitboxLayerId],
    });
    const stationFeatures = allFeatures.filter((f) => f.layer.id === this.stationsHitboxLayerId);
    const shotFeatures = allFeatures.filter((f) => f.layer.id === this.shotsHitboxLayerId);

    // Stations take priority - resolve nearest station first
    const nearestStation = this.resolveNearestStation(e, stationFeatures);
    if (nearestStation) {
      const { sectionId, stationIndex } = nearestStation.properties ?? {};
      if (sectionId !== undefined && stationIndex !== undefined) {
        const ref: StationRef = {
          section_id: sectionId as number,
          station_index: stationIndex as number,
        };
        // Debug logging - only on click, NOT hover (prevents console spam)
        if (this.config?.debug?.map?.log_hit_detection) {
          console.log('[HitDetection] Station click', {
            layer: this.stationsHitboxLayerId,
            featureId: `${sectionId}:${stationIndex}`,
            coordinates: e.lngLat,
            featuresCount: stationFeatures.length,
          });
        }
        this.callbacks.onStationClick?.(ref, e);
        return;
      }
    }

    // Then shots - resolve nearest shot
    const nearestShot = this.resolveNearestShot(e, shotFeatures);
    if (nearestShot) {
      const { sectionId, shotId } = nearestShot.properties ?? {};
      if (sectionId !== undefined && shotId !== undefined) {
        // Debug logging - only on click, NOT hover (prevents console spam)
        if (this.config?.debug?.map?.log_hit_detection) {
          console.log('[HitDetection] Shot click', {
            layer: this.shotsHitboxLayerId,
            featureId: `${sectionId}:${shotId}`,
            coordinates: e.lngLat,
            featuresCount: shotFeatures.length,
          });
        }
        this.callbacks.onShotClick?.(sectionId as number, shotId as number, e);
        return;
      }
    }

    // Empty click - check for hidden features before firing empty callback
    this.handleEmptyClick(e);
  };

  /**
   * UNIFIED context menu handler - queries both hitbox layers and resolves priority.
   * Same pattern as click handler: stations take priority, uses nearest resolution.
   */
  private handleContextMenu = (e: MapMouseEvent): void => {
    // Query both hitbox layers in a single call for better performance
    const allFeatures = this.map.queryRenderedFeatures(e.point, {
      layers: [this.stationsHitboxLayerId, this.shotsHitboxLayerId],
    });
    const stationFeatures = allFeatures.filter((f) => f.layer.id === this.stationsHitboxLayerId);
    const shotFeatures = allFeatures.filter((f) => f.layer.id === this.shotsHitboxLayerId);

    // Stations take priority
    const nearestStation = this.resolveNearestStation(e, stationFeatures);
    if (nearestStation) {
      const { sectionId, stationIndex } = nearestStation.properties ?? {};
      if (sectionId !== undefined && stationIndex !== undefined) {
        const ref: StationRef = {
          section_id: sectionId as number,
          station_index: stationIndex as number,
        };
        // Debug logging - only on contextmenu, NOT hover (prevents console spam)
        if (this.config?.debug?.map?.log_hit_detection) {
          console.log('[HitDetection] Station context menu', {
            layer: this.stationsHitboxLayerId,
            featureId: `${sectionId}:${stationIndex}`,
            coordinates: e.lngLat,
            featuresCount: stationFeatures.length,
          });
        }
        this.callbacks.onContextMenu?.({ type: 'station', ref }, e);
        return;
      }
    }

    // Then shots
    const nearestShot = this.resolveNearestShot(e, shotFeatures);
    if (nearestShot) {
      const { sectionId, shotId } = nearestShot.properties ?? {};
      if (sectionId !== undefined && shotId !== undefined) {
        // Debug logging - only on contextmenu, NOT hover (prevents console spam)
        if (this.config?.debug?.map?.log_hit_detection) {
          console.log('[HitDetection] Shot context menu', {
            layer: this.shotsHitboxLayerId,
            featureId: `${sectionId}:${shotId}`,
            coordinates: e.lngLat,
            featuresCount: shotFeatures.length,
          });
        }
        this.callbacks.onContextMenu?.({ type: 'shot', sectionId: sectionId as number, shotId: shotId as number }, e);
        return;
      }
    }

    // Empty context menu
    this.callbacks.onContextMenu?.(null, e);
  };

  /**
   * Handle empty click - check for hidden features before firing empty callback.
   * This provides toast feedback when clicking near hidden stations/shots.
   */
  private handleEmptyClick(e: MapMouseEvent): void {
    const HIDDEN_CLICK_THRESHOLD_PX = 15;

    // Check for clicks on hidden stations (stations take priority)
    if (!this.stationsVisible && this.callbacks.onHiddenStationClick) {
      const sourceFeatures = this.map.querySourceFeatures(this.sourceId + '-stations');
      for (const feature of sourceFeatures) {
        if (feature.geometry.type === 'Point') {
          const coords = feature.geometry.coordinates as [number, number];
          const projected = this.map.project(coords);
          const dx = projected.x - e.point.x;
          const dy = projected.y - e.point.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < HIDDEN_CLICK_THRESHOLD_PX) {
            this.callbacks.onHiddenStationClick();
            return;
          }
        }
      }
    }

    // Check for clicks on hidden shots
    if (!this.shotsVisible && this.callbacks.onHiddenShotClick) {
      const sourceFeatures = this.map.querySourceFeatures(this.sourceId + '-shots');
      for (const feature of sourceFeatures) {
        if (feature.geometry.type === 'LineString') {
          const lineCoords = feature.geometry.coordinates as [number, number][];
          for (let i = 0; i < lineCoords.length - 1; i++) {
            const coord1 = lineCoords[i];
            const coord2 = lineCoords[i + 1];
            if (!coord1 || !coord2) continue;
            const p1 = this.map.project(coord1);
            const p2 = this.map.project(coord2);
            const dist = this.distanceToLineSegment(e.point.x, e.point.y, p1.x, p1.y, p2.x, p2.y);
            if (dist < HIDDEN_CLICK_THRESHOLD_PX) {
              this.callbacks.onHiddenShotClick();
              return;
            }
          }
        }
      }
    }

    // No hidden features nearby, fire empty click
    this.callbacks.onEmptyClick?.(e);
  }

  /**
   * Resolve nearest station feature to click point.
   * For multiple overlapping station hitboxes, returns the one whose center
   * is closest to the click point.
   */
  private resolveNearestStation(
    e: MapMouseEvent,
    features: maplibregl.MapGeoJSONFeature[]
  ): maplibregl.MapGeoJSONFeature | null {
    if (features.length === 0) return null;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length check above ensures element exists
    if (features.length === 1) return features[0]!;

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length >= 2 ensures element exists
    let nearest: maplibregl.MapGeoJSONFeature = features[0]!;
    let nearestDist = Infinity;

    for (const feature of features) {
      const geom = feature.geometry;
      if (geom.type === 'Point') {
        const coords = geom.coordinates as [number, number];
        const screenPos = this.map.project(coords);
        const dist = Math.sqrt(
          (screenPos.x - e.point.x) ** 2 + (screenPos.y - e.point.y) ** 2
        );
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = feature;
        }
      }
    }

    return nearest;
  }

  /**
   * Resolve nearest shot feature to click point.
   * Uses perpendicular distance to line segment for accurate selection
   * when multiple shot hitboxes overlap.
   */
  private resolveNearestShot(
    e: MapMouseEvent,
    features: maplibregl.MapGeoJSONFeature[]
  ): maplibregl.MapGeoJSONFeature | null {
    if (features.length === 0) return null;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length check above ensures element exists
    if (features.length === 1) return features[0]!;

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length >= 2 ensures element exists
    let nearest: maplibregl.MapGeoJSONFeature = features[0]!;
    let nearestDist = Infinity;

    for (const feature of features) {
      const geom = feature.geometry;
      if (geom.type === 'LineString' && geom.coordinates.length >= 2) {
        // Iterate all segments to find minimum distance
        // (handles multi-segment lines if shot geometries ever become complex)
        for (let i = 0; i < geom.coordinates.length - 1; i++) {
          const coord1 = geom.coordinates[i] as [number, number] | undefined;
          const coord2 = geom.coordinates[i + 1] as [number, number] | undefined;
          if (!coord1 || !coord2) continue;

          const p1 = this.map.project(coord1);
          const p2 = this.map.project(coord2);

          const dist = this.distanceToLineSegment(
            e.point.x, e.point.y,
            p1.x, p1.y, p2.x, p2.y
          );

          if (dist < nearestDist) {
            nearestDist = dist;
            nearest = feature;
          }
        }
      }
    }

    return nearest;
  }

  /**
   * Calculate distance from point (px, py) to line segment (x1,y1)-(x2,y2).
   * Returns perpendicular distance if projection falls on segment,
   * otherwise returns distance to nearest endpoint.
   */
  private distanceToLineSegment(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number
  ): number {
    const A = px - x1;
    const B = py - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = lenSq !== 0 ? dot / lenSq : -1;

    let xx: number, yy: number;
    if (param < 0) {
      xx = x1; yy = y1;  // Closest to start
    } else if (param > 1) {
      xx = x2; yy = y2;  // Closest to end
    } else {
      xx = x1 + param * C;  // Perpendicular point on segment
      yy = y1 + param * D;
    }

    return Math.sqrt((px - xx) ** 2 + (py - yy) ** 2);
  }

  // Convert "sectionId:index" string ID to numeric featureId for setFeatureState
  private parseFeatureId(id: string | null): number | null {
    if (!id) return null;
    const [sectionId, index] = id.split(':').map(Number);
    if (isNaN(sectionId!) || isNaN(index!)) return null;
    return sectionId! * 100000 + index!;
  }

  // Update visual state using setFeatureState (much faster than setPaintProperty)
  // Only updates the specific features that changed, not the entire layer
  private updateVisualState() {
    const stationsSource = this.sourceId + '-stations';
    const shotsSource = this.sourceId + '-shots';

    // Update station hover state
    const newHoveredStationFeatureId = this.parseFeatureId(this.hoveredStationId);
    if (newHoveredStationFeatureId !== this.prevHoveredStationFeatureId) {
      // Clear previous hover
      if (this.prevHoveredStationFeatureId !== null) {
        this.map.setFeatureState(
          { source: stationsSource, id: this.prevHoveredStationFeatureId },
          { hover: false }
        );
      }
      // Set new hover
      if (newHoveredStationFeatureId !== null) {
        this.map.setFeatureState(
          { source: stationsSource, id: newHoveredStationFeatureId },
          { hover: true }
        );
      }
      this.prevHoveredStationFeatureId = newHoveredStationFeatureId;
    }

    // Update shot hover state
    const newHoveredShotFeatureId = this.parseFeatureId(this.hoveredShotId);
    if (newHoveredShotFeatureId !== this.prevHoveredShotFeatureId) {
      // Clear previous hover
      if (this.prevHoveredShotFeatureId !== null) {
        this.map.setFeatureState(
          { source: shotsSource, id: this.prevHoveredShotFeatureId },
          { hover: false }
        );
      }
      // Set new hover
      if (newHoveredShotFeatureId !== null) {
        this.map.setFeatureState(
          { source: shotsSource, id: newHoveredShotFeatureId },
          { hover: true }
        );
      }
      this.prevHoveredShotFeatureId = newHoveredShotFeatureId;
    }

    // Update station selection state
    const newSelectedStationFeatureId = this.parseFeatureId(this.selectedStationId);
    if (newSelectedStationFeatureId !== this.prevSelectedStationFeatureId) {
      // Clear previous selection
      if (this.prevSelectedStationFeatureId !== null) {
        this.map.setFeatureState(
          { source: stationsSource, id: this.prevSelectedStationFeatureId },
          { selected: false }
        );
      }
      // Set new selection
      if (newSelectedStationFeatureId !== null) {
        this.map.setFeatureState(
          { source: stationsSource, id: newSelectedStationFeatureId },
          { selected: true }
        );
      }
      this.prevSelectedStationFeatureId = newSelectedStationFeatureId;
    }

    // Update shot selection state
    const newSelectedShotFeatureId = this.parseFeatureId(this.selectedShotId);
    if (newSelectedShotFeatureId !== this.prevSelectedShotFeatureId) {
      // Clear previous selection
      if (this.prevSelectedShotFeatureId !== null) {
        this.map.setFeatureState(
          { source: shotsSource, id: this.prevSelectedShotFeatureId },
          { selected: false }
        );
      }
      // Set new selection
      if (newSelectedShotFeatureId !== null) {
        this.map.setFeatureState(
          { source: shotsSource, id: newSelectedShotFeatureId },
          { selected: true }
        );
      }
      this.prevSelectedShotFeatureId = newSelectedShotFeatureId;
    }
  }

  // Update hitbox layer sizes from config
  private updateHitboxLayers(): void {
    if (!this.map) return;

    const stationHitArea = this.getStationHitArea();
    const shotHitArea = this.getShotHitArea();

    // Update hitbox layer sizes (guard layer existence for safety)
    if (this.map.getLayer(this.stationsHitboxLayerId)) {
      this.map.setPaintProperty(this.stationsHitboxLayerId, 'circle-radius', stationHitArea);
    }
    if (this.map.getLayer(this.shotsHitboxLayerId)) {
      this.map.setPaintProperty(this.shotsHitboxLayerId, 'line-width', shotHitArea);
    }
    if (this.map.getLayer(this.ghostStationsHitboxLayerId)) {
      this.map.setPaintProperty(this.ghostStationsHitboxLayerId, 'circle-radius', stationHitArea);
    }
    if (this.map.getLayer(this.ghostShotsHitboxLayerId)) {
      this.map.setPaintProperty(this.ghostShotsHitboxLayerId, 'line-width', shotHitArea);
    }
  }

  // Update ghost visual layer sizes from config (merge preview layers)
  private updateGhostVisualLayers(): void {
    if (!this.map) return;

    const baseRadius = this.getStationRadius();
    const baseWidth = this.getShotWidth();

    // Update ghost visual layers to match config (guard layer existence)
    if (this.map.getLayer(this.ghostStationsLayerId)) {
      this.map.setPaintProperty(this.ghostStationsLayerId, 'circle-radius', baseRadius);
    }
    if (this.map.getLayer(this.ghostShotsLayerId)) {
      this.map.setPaintProperty(this.ghostShotsLayerId, 'line-width', baseWidth);
    }
  }

  // Update debug visualization based on config
  // Sets BOTH color AND opacity on all hitbox layers for debug mode
  // CRITICAL: In normal mode, use OPAQUE color (#000) with tiny opacity (0.001)
  // Using transparent color (rgba(0,0,0,0)) would multiply with opacity to give
  // effective alpha of 0, breaking queryRenderedFeatures/hover detection
  private updateDebugVisualization(): void {
    if (!this.map) return;

    const showHitboxes = this.config?.debug?.map?.show_hitboxes ?? false;
    const debugColor = 'rgba(255, 0, 0, 0.3)'; // Semi-transparent red for debug
    const opaqueColor = '#000000'; // OPAQUE color for normal mode (opacity controls visibility)

    // Station hitbox - MUST use opaque color in normal mode for queryRenderedFeatures
    if (this.map.getLayer(this.stationsHitboxLayerId)) {
      this.map.setPaintProperty(
        this.stationsHitboxLayerId,
        'circle-color',
        showHitboxes ? debugColor : opaqueColor
      );
      this.map.setPaintProperty(
        this.stationsHitboxLayerId,
        'circle-opacity',
        showHitboxes ? 1 : 0.001
      );
    }

    // Shot hitbox - MUST use opaque color in normal mode for queryRenderedFeatures
    if (this.map.getLayer(this.shotsHitboxLayerId)) {
      this.map.setPaintProperty(
        this.shotsHitboxLayerId,
        'line-color',
        showHitboxes ? debugColor : opaqueColor
      );
      this.map.setPaintProperty(
        this.shotsHitboxLayerId,
        'line-opacity',
        showHitboxes ? 1 : 0.001
      );
    }

    // Ghost hitbox layers - debug visualization only (NOT used for hit detection)
    // Keep at opacity 0 when debug off to avoid unnecessary rendering work
    if (this.map.getLayer(this.ghostStationsHitboxLayerId)) {
      this.map.setPaintProperty(
        this.ghostStationsHitboxLayerId,
        'circle-color',
        showHitboxes ? debugColor : opaqueColor
      );
      this.map.setPaintProperty(
        this.ghostStationsHitboxLayerId,
        'circle-opacity',
        showHitboxes ? 1 : 0 // 0 when off - not used for hit detection
      );
    }

    if (this.map.getLayer(this.ghostShotsHitboxLayerId)) {
      this.map.setPaintProperty(
        this.ghostShotsHitboxLayerId,
        'line-color',
        showHitboxes ? debugColor : opaqueColor
      );
      this.map.setPaintProperty(
        this.ghostShotsHitboxLayerId,
        'line-opacity',
        showHitboxes ? 1 : 0 // 0 when off - not used for hit detection
      );
    }
  }

  // Set selected station (called from outside to sync with uiStore)
  setSelectedStation(ref: StationRef | null) {
    this.selectedStationId = ref ? `${ref.section_id}:${ref.station_index}` : null;
    this.updateVisualState();
  }

  // Set selected shot (called from outside to sync with uiStore)
  setSelectedShot(sectionId: SectionId | null, shotId: ShotId | null) {
    this.selectedShotId = sectionId !== null && shotId !== null ? `${sectionId}:${shotId}` : null;
    this.updateVisualState();
  }

  // Set snapped station (called from outside for snap indicator)
  setSnappedStation(ref: StationRef | null) {
    const newId = ref ? `${ref.section_id}:${ref.station_index}` : null;
    if (this.snappedStationId === newId) return;
    this.snappedStationId = newId;
    // Update highlight layer for snapped station
    if (newId !== null) {
      this.setHighlightedStations([newId]);
    } else {
      this.setHighlightedStations([]);
    }
    this.updateVisualState();
  }

  /**
   * Set the hovered section for visual highlighting.
   * Stores the section ID for use by updateVisualState() to apply hover styling
   * to all shots and stations in this section.
   * @param sectionId - The SectionId (number) to hover, or null to clear
   */
  setHoveredSection(sectionId: SectionId | null): void {
    // Convert numeric SectionId to string for consistent comparison
    const stringId = sectionId !== null ? String(sectionId) : null;
    if (this.hoveredSectionId === stringId) return;
    this.hoveredSectionId = stringId;
    this.updateVisualState();
  }

  /**
   * Set the hovered shot for visual highlighting (external hover, e.g. from DataTable).
   * This allows external components to trigger shot hover highlighting without mouse interaction.
   * @param sectionId - The SectionId of the shot, or null to clear
   * @param shotId - The ShotId of the shot, or null to clear
   */
  setHoveredShot(sectionId: SectionId | null, shotId: ShotId | null): void {
    // Convert to composite string ID format used internally
    const stringId = sectionId !== null && shotId !== null ? `${sectionId}:${shotId}` : null;
    if (this.hoveredShotId === stringId) return;
    this.hoveredShotId = stringId;
    this.updateVisualState();
  }

  /**
   * Set the selected section for visual highlighting.
   * Stores the section ID for use by updateVisualState() to apply selected styling
   * to all shots and stations in this section.
   * @param sectionId - The SectionId (number) to select, or null to clear
   */
  setSelectedSection(sectionId: SectionId | null): void {
    // Convert numeric SectionId to string for consistent comparison
    const stringId = sectionId !== null ? String(sectionId) : null;
    if (this.selectedSectionId === stringId) return;
    this.selectedSectionId = stringId;
    this.updateVisualState();
  }

  // Depth gradient accessors - return current depth mode state
  getShowDepthGradient(): boolean {
    return this.showDepthGradient;
  }

  getDepthRange(): { min: number; max: number } {
    // Return a copy to prevent external mutation
    return { min: this.depthRange.min, max: this.depthRange.max };
  }

  // Control shot data labels visibility
  setShowShotLabels(show: boolean) {
    this.map.setLayoutProperty(
      this.shotLabelsLayerId,
      'visibility',
      show ? 'visible' : 'none'
    );
  }

  // Control section name labels visibility
  setShowSectionNames(show: boolean) {
    this.map.setLayoutProperty(
      this.labelsLayerId,
      'visibility',
      show ? 'visible' : 'none'
    );
  }

  // Control station index labels visibility
  setShowStationLabels(show: boolean) {
    this.map.setLayoutProperty(
      this.stationLabelsLayerId,
      'visibility',
      show ? 'visible' : 'none'
    );
  }

  // Control stations visibility (also hides merges, loop closures, and station hitbox)
  // Note: Highlight layer stays visible - it uses filter to control what renders,
  // allowing snapped/origin stations to appear even when stations layer is hidden
  setShowStations(visible: boolean): void {
    if (!this.map) return;
    this.stationsVisible = visible;
    const visibility = visible ? 'visible' : 'none';
    // Clear hover state FIRST when hiding to prevent any race conditions
    // then set visibility to prevent hover events from triggering while clearing
    if (!visible) {
      this.clearStationHover();
    }
    this.map.setLayoutProperty(this.stationsLayerId, 'visibility', visibility);
    this.map.setLayoutProperty(this.stationsHitboxLayerId, 'visibility', visibility);
    this.map.setLayoutProperty(this.mergesLayerId, 'visibility', visibility);
    this.map.setLayoutProperty(this.loopClosuresLayerId, 'visibility', visibility);
    // Note: stationsHighlightLayerId intentionally NOT hidden - it uses filter
    // to show only snapped/origin stations even when main stations layer is hidden
  }

  // Control shots visibility (also hides shot hitbox)
  setShowShots(visible: boolean): void {
    if (!this.map) return;
    this.shotsVisible = visible;
    const visibility = visible ? 'visible' : 'none';
    // Clear hover state FIRST when hiding to prevent any race conditions
    if (!visible) {
      this.clearShotHover();
    }
    this.map.setLayoutProperty(this.shotsLayerId, 'visibility', visibility);
    this.map.setLayoutProperty(this.shotsHitboxLayerId, 'visibility', visibility);
  }

  // Control virtual shots visibility via filter (while keeping regular shots visible)
  setShowVirtualShots(visible: boolean): void {
    if (!this.map) return;
    if (visible) {
      // Show all shots (clear filter)
      this.map.setFilter(this.shotsLayerId, null);
    } else {
      // Hide virtual shots only
      this.map.setFilter(this.shotsLayerId, ['!=', ['get', 'isVirtual'], true]);
    }
  }

  // Set highlighted stations by their string IDs (format: "sectionId:stationIndex")
  setHighlightedStations(stationIds: string[]): void {
    if (!this.map) return;
    // Build filter expression to match stations in the highlight set
    // Uses compound expression matching the internal ID format used elsewhere (sectionId:stationIndex)
    const idExpr = ['concat', ['to-string', ['get', 'sectionId']], ':', ['to-string', ['get', 'stationIndex']]];
    if (stationIds.length > 0) {
      this.map.setFilter(
        this.stationsHighlightLayerId,
        ['in', idExpr, ['literal', stationIds]] as unknown as maplibregl.FilterSpecification
      );
    } else {
      // Filter to nothing when no stations highlighted
      this.map.setFilter(this.stationsHighlightLayerId, ['==', ['get', 'sectionId'], -9999]);
    }
  }

  // Clear station hover state
  clearStationHover(): void {
    this.hoveredStationId = null;
    this.callbacks.onStationHover?.(null);
    // Only clear feature hover if no shot is being hovered
    if (!this.hoveredShotId) {
      this.callbacks.onFeatureHover?.(false);
    }
    this.updateVisualState();
  }

  // Clear shot hover state
  clearShotHover(): void {
    this.hoveredShotId = null;
    this.callbacks.onShotHover?.(null);
    // Only clear feature hover if no station is being hovered
    if (!this.hoveredStationId) {
      this.callbacks.onFeatureHover?.(false);
    }
    this.updateVisualState();
  }

  // Clear snapped station state
  clearSnappedStation(): void {
    this.setSnappedStation(null);
  }

  // Clear all interaction state (hover, selection, snap, highlights)
  clearAllInteractionState(): void {
    this.hoveredStationId = null;
    this.hoveredShotId = null;
    this.hoveredSectionId = null;
    this.snappedStationId = null;
    this.selectedStationId = null;
    this.selectedShotId = null;
    this.selectedSectionId = null;
    this.setHighlightedStations([]);
    this.callbacks.onStationHover?.(null);
    this.callbacks.onShotHover?.(null);
    this.callbacks.onFeatureHover?.(false);
    this.updateVisualState();
  }

  /**
   * Set ghost section data for merge preview visualization.
   * Pass null to clear the ghost section.
   */
  setGhostSection(data: GhostSectionData | null) {
    // Build ghost shot features
    const shotFeatures: GeoJSON.Feature[] = [];
    const stationFeatures: GeoJSON.Feature[] = [];
    const mergeFeatures: GeoJSON.Feature[] = [];

    if (data) {
      // Build shot lines
      for (const shot of data.shots) {
        shotFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              metersToMapCoords(shot.from.x, shot.from.y, this.gpsOrigin),
              metersToMapCoords(shot.to.x, shot.to.y, this.gpsOrigin),
            ],
          },
          properties: { color: data.color },
        });
      }

      // Build station points
      for (const station of data.stations) {
        stationFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(station.x, station.y, this.gpsOrigin),
          },
          properties: { color: data.color },
        });
      }

      // Build merge station highlight
      if (data.mergeStation) {
        mergeFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(data.mergeStation.x, data.mergeStation.y, this.gpsOrigin),
          },
          properties: {},
        });
      }
    }

    // Update sources
    const ghostShotsSource = this.map.getSource(this.sourceId + '-ghost-shots');
    if (ghostShotsSource && 'setData' in ghostShotsSource) {
      (ghostShotsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: shotFeatures,
      });
    }

    const ghostStationsSource = this.map.getSource(this.sourceId + '-ghost-stations');
    if (ghostStationsSource && 'setData' in ghostStationsSource) {
      (ghostStationsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: stationFeatures,
      });
    }

    const ghostMergeSource = this.map.getSource(this.sourceId + '-ghost-merge');
    if (ghostMergeSource && 'setData' in ghostMergeSource) {
      (ghostMergeSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: mergeFeatures,
      });
    }
  }

  update(
    sections: Section[],
    stations: Station[],
    stationMerges?: StationMerge[],
    loopClosures?: LoopClosure[],
    gpsOrigin?: GpsOrigin | null,
    showDepthGradient: boolean = false,
    depthRange: { min: number; max: number } = { min: 0, max: 50 }
  ) {
    // Store gpsOrigin for coordinate transforms
    this.gpsOrigin = gpsOrigin ?? null;
    // Store depth mode parameters for use in feature color calculation
    this.showDepthGradient = showDepthGradient;
    // Clone and normalize depth range (handle min > max, NaN)
    // getDepthColor() handles min === max (flat cave) by returning shallowColor
    const minD = Number.isFinite(depthRange.min) ? depthRange.min : 0;
    const maxD = Number.isFinite(depthRange.max) ? depthRange.max : 50;
    this.depthRange = {
      min: Math.min(minD, maxD),
      max: Math.max(minD, maxD),
    };
    // Build shot features and shot label features
    const shotFeatures: GeoJSON.Feature[] = [];
    const shotLabelFeatures: GeoJSON.Feature[] = [];
    let globalShotIndex = 0;

    for (const section of sections) {
      const sectionStations = stations
        .filter((s) => s.station_ref.section_id === section.id)
        .sort((a, b) => a.station_ref.station_index - b.station_ref.station_index);

      for (let i = 0; i < section.shots.length; i++) {
        const shot = section.shots[i];
        const fromStation = sectionStations[i];
        const toStation = sectionStations[i + 1];

        if (fromStation && toStation && shot) {
          // Calculate shot color - use depth gradient if enabled, otherwise section color
          const avgDepth = (fromStation.coordinates.z + toStation.coordinates.z) / 2;
          const depthColor = this.showDepthGradient
            ? getDepthColor(avgDepth, '#00bfff', '#ff4444', this.depthRange.min, this.depthRange.max)
            : null;
          const shotColor = depthColor ?? section.color;

          // Generate unique featureId for setFeatureState
          const shotFeatureId = section.id * 100000 + shot.id;

          shotFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                metersToMapCoords(fromStation.coordinates.x, fromStation.coordinates.y, this.gpsOrigin),
                metersToMapCoords(toStation.coordinates.x, toStation.coordinates.y, this.gpsOrigin),
              ],
            },
            properties: {
              featureId: shotFeatureId,
              sectionId: section.id,
              shotId: shot.id,
              color: shotColor,
              isVirtual: shot.is_virtual,
              length: shot.length,
              azimuth: shot.azimuth_in,
            },
          });

          // Generate shot label at midpoint
          const midX = (fromStation.coordinates.x + toStation.coordinates.x) / 2;
          const midY = (fromStation.coordinates.y + toStation.coordinates.y) / 2;
          const labelDepth = (fromStation.coordinates.z + toStation.coordinates.z) / 2;

          // Format: "45° 3.2m -12.5m" (azimuth, length, depth)
          const label = `${shot.azimuth_in.toFixed(0)}° ${shot.length.toFixed(1)}m ${labelDepth.toFixed(1)}m`;

          // Shot label color - use depth gradient if enabled, otherwise default white
          // (labels default to white for readability, unlike shots which use section color)
          const shotLabelDepthColor = this.showDepthGradient
            ? getDepthColor(avgDepth, '#00bfff', '#ff4444', this.depthRange.min, this.depthRange.max)
            : null;
          const shotLabelColor = shotLabelDepthColor ?? '#ffffff';

          shotLabelFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: metersToMapCoords(midX, midY, this.gpsOrigin),
            },
            properties: {
              label,
              index: globalShotIndex,
              sectionId: section.id,
              shotId: shot.id,
              color: shotLabelColor,
            },
          });

          globalShotIndex++;
        }
      }
    }

    // Build station features
    const stationFeatures: GeoJSON.Feature[] = stations.map((station) => {
      // Find section color for this station
      const section = sections.find((s) => s.id === station.station_ref.section_id);
      const sectionColor = section?.color ?? '#ffffff';

      const isZeroDatum = station.is_zero_datum;
      const stationDepth = station.coordinates.z;

      // Calculate station fill color:
      // - Depth mode: use depth-based color for all stations (including zero datum)
      // - Normal mode: gold for zero datum, section color for others
      let color: string;
      if (this.showDepthGradient) {
        // getDepthColor can return null for invalid inputs, fallback to section color
        color = getDepthColor(stationDepth, '#00bfff', '#ff4444', this.depthRange.min, this.depthRange.max) ?? sectionColor;
      } else {
        color = isZeroDatum ? '#ffd700' : sectionColor;
      }

      // Stroke color: gold for zero datum when depth gradient enabled (so entry points stand out),
      // black otherwise (normal mode keeps zero datum with gold fill + black stroke)
      const strokeColor = this.showDepthGradient && isZeroDatum ? '#ffd700' : '#000000';

      // Generate unique featureId for setFeatureState (sectionId * 100000 + stationIndex)
      const featureId = station.station_ref.section_id * 100000 + station.station_ref.station_index;

      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: metersToMapCoords(station.coordinates.x, station.coordinates.y, this.gpsOrigin),
        },
        properties: {
          featureId,
          sectionId: station.station_ref.section_id,
          stationIndex: station.station_ref.station_index,
          isZeroDatum: station.is_zero_datum,
          isMerged: station.merged_with.length > 0,
          depth: station.coordinates.z,
          color,
          strokeColor,
        },
      };
    });

    // Helper to find station coordinates (used by merges and loop closures)
    const findStationCoords = (ref: StationRef) => {
      const station = stations.find(
        (s) => s.station_ref.section_id === ref.section_id && s.station_ref.station_index === ref.station_index
      );
      return station?.coordinates;
    };

    // Build merge connection features
    const mergeFeatures: GeoJSON.Feature[] = [];
    if (stationMerges && stationMerges.length > 0) {
      for (const merge of stationMerges) {
        const coordsA = findStationCoords(merge.station_a);
        const coordsB = findStationCoords(merge.station_b);

        if (coordsA && coordsB) {
          mergeFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                metersToMapCoords(coordsA.x, coordsA.y, this.gpsOrigin),
                metersToMapCoords(coordsB.x, coordsB.y, this.gpsOrigin),
              ],
            },
            properties: {
              stationA: `${merge.station_a.section_id}:${merge.station_a.station_index}`,
              stationB: `${merge.station_b.section_id}:${merge.station_b.station_index}`,
            },
          });
        }
      }
    }

    // Build section name label features (at first station of each section)
    const sectionLabelFeatures: GeoJSON.Feature[] = [];
    for (const section of sections) {
      // Find the station with the minimum index for this section
      // (don't assume index 0 exists - data may start at 1 or have gaps)
      const sectionStations = stations.filter(
        (s) => s.station_ref.section_id === section.id
      );
      if (sectionStations.length > 0) {
        // Find station with minimum index using reduce for type safety
        const firstStation = sectionStations.reduce((min, s) =>
          s.station_ref.station_index < min.station_ref.station_index ? s : min
        );
        sectionLabelFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(firstStation.coordinates.x, firstStation.coordinates.y, this.gpsOrigin),
          },
          properties: {
            name: section.name,
            color: section.color,
            sectionId: section.id,
          },
        });
      }
    }

    // Build station index label features (at each station)
    // Group stations by section to determine first station in each section
    const sectionMinIndices = new Map<number, number>();
    for (const station of stations) {
      const sectionId = station.station_ref.section_id;
      const currentMin = sectionMinIndices.get(sectionId);
      if (currentMin === undefined || station.station_ref.station_index < currentMin) {
        sectionMinIndices.set(sectionId, station.station_ref.station_index);
      }
    }

    const stationLabelFeatures: GeoJSON.Feature[] = stations.map((station, globalOrdinal) => {
      const isFirstInSection = station.station_ref.station_index === sectionMinIndices.get(station.station_ref.section_id);

      // Calculate station label color - use depth gradient if enabled, otherwise default white
      const stationLabelDepthColor = this.showDepthGradient
        ? getDepthColor(station.coordinates.z, '#00bfff', '#ff4444', this.depthRange.min, this.depthRange.max)
        : null;
      const stationLabelColor = stationLabelDepthColor ?? '#ffffff';

      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: metersToMapCoords(station.coordinates.x, station.coordinates.y, this.gpsOrigin),
        },
        properties: {
          label: String(station.station_ref.station_index),
          stationIndex: station.station_ref.station_index,
          sectionId: station.station_ref.section_id,
          globalOrdinal, // Stable sequential index for filtering
          isFirstInSection, // Always show first station in section
          color: stationLabelColor,
        },
      };
    });

    // Update sources
    const shotsSource = this.map.getSource(this.sourceId + '-shots');
    if (shotsSource && 'setData' in shotsSource) {
      (shotsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: shotFeatures,
      });
    }

    const stationsSource = this.map.getSource(this.sourceId + '-stations');
    if (stationsSource && 'setData' in stationsSource) {
      (stationsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: stationFeatures,
      });
    }

    const mergesSource = this.map.getSource(this.sourceId + '-merges');
    if (mergesSource && 'setData' in mergesSource) {
      (mergesSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: mergeFeatures,
      });
    }

    // Update shot labels source
    const shotLabelsSource = this.map.getSource(this.sourceId + '-shot-labels');
    if (shotLabelsSource && 'setData' in shotLabelsSource) {
      (shotLabelsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: shotLabelFeatures,
      });
    }

    // Update section labels source
    const sectionLabelsSource = this.map.getSource(this.sourceId + '-section-labels');
    if (sectionLabelsSource && 'setData' in sectionLabelsSource) {
      (sectionLabelsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: sectionLabelFeatures,
      });
    }

    // Update station labels source
    const stationLabelsSource = this.map.getSource(this.sourceId + '-station-labels');
    if (stationLabelsSource && 'setData' in stationLabelsSource) {
      (stationLabelsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: stationLabelFeatures,
      });
    }

    // Build loop closure features with severity-based colors
    const loopClosureFeatures: GeoJSON.Feature[] = [];
    if (loopClosures && loopClosures.length > 0) {
      // Helper function to get color based on error percentage
      const getErrorColor = (errorPct: number): string => {
        if (errorPct < 1) return '#22c55e'; // Green - excellent
        if (errorPct < 3) return '#eab308'; // Yellow - acceptable
        if (errorPct < 5) return '#f97316'; // Orange - marginal
        return '#ef4444'; // Red - poor
      };

      for (const closure of loopClosures) {
        const coordsA = findStationCoords(closure.station_a);
        const coordsB = findStationCoords(closure.station_b);

        if (coordsA && coordsB) {
          loopClosureFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                metersToMapCoords(coordsA.x, coordsA.y, this.gpsOrigin),
                metersToMapCoords(coordsB.x, coordsB.y, this.gpsOrigin),
              ],
            },
            properties: {
              stationA: `${closure.station_a.section_id}:${closure.station_a.station_index}`,
              stationB: `${closure.station_b.section_id}:${closure.station_b.station_index}`,
              errorPercentage: closure.error_percentage,
              misclosureDistance: closure.misclosure_distance,
              pathLength: closure.path_length,
              color: getErrorColor(closure.error_percentage),
            },
          });
        }
      }
    }

    const loopClosuresSource = this.map.getSource(this.sourceId + '-loop-closures');
    if (loopClosuresSource && 'setData' in loopClosuresSource) {
      (loopClosuresSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: loopClosureFeatures,
      });
    }
  }

  destroy() {
    // Cancel any pending hover RAF
    if (this.hoverRafId !== null) {
      cancelAnimationFrame(this.hoverRafId);
      this.hoverRafId = null;
    }
    this.pendingHoverEvent = null;

    // Guard against map being destroyed (race condition on unmount)
    if (!hasLiveStyle(this.map)) {
      // Clear bound handler references even if map is destroyed
      this.boundMouseMove = null;
      this.boundMapLeave = null;
      return;
    }

    try {
      // Unregister event handlers first (before removing layers)
      this.map.off('click', this.handleMapClick);
      this.map.off('contextmenu', this.handleContextMenu);

      if (this.boundMouseMove) {
        this.map.off('mousemove', this.boundMouseMove);
      }
      if (this.boundMapLeave) {
        this.map.getCanvas().removeEventListener('mouseleave', this.boundMapLeave);
      }

      // Remove all layers first (must be done before removing their sources)
      if (this.map.getLayer(this.labelsLayerId)) {
        this.map.removeLayer(this.labelsLayerId);
      }
      if (this.map.getLayer(this.shotLabelsLayerId)) {
        this.map.removeLayer(this.shotLabelsLayerId);
      }
      if (this.map.getLayer(this.stationLabelsLayerId)) {
        this.map.removeLayer(this.stationLabelsLayerId);
      }
      if (this.map.getLayer(this.stationsLayerId)) {
        this.map.removeLayer(this.stationsLayerId);
      }
      if (this.map.getLayer(this.stationsHighlightLayerId)) {
        this.map.removeLayer(this.stationsHighlightLayerId);
      }
      if (this.map.getLayer(this.shotsLayerId)) {
        this.map.removeLayer(this.shotsLayerId);
      }
      if (this.map.getLayer(this.mergesLayerId)) {
        this.map.removeLayer(this.mergesLayerId);
      }
      if (this.map.getLayer(this.loopClosuresLayerId)) {
        this.map.removeLayer(this.loopClosuresLayerId);
      }
      // Remove ghost section layers
      if (this.map.getLayer(this.ghostShotsLayerId)) {
        this.map.removeLayer(this.ghostShotsLayerId);
      }
      if (this.map.getLayer(this.ghostStationsLayerId)) {
        this.map.removeLayer(this.ghostStationsLayerId);
      }
      if (this.map.getLayer(this.ghostMergeLayerId)) {
        this.map.removeLayer(this.ghostMergeLayerId);
      }
      // Remove hitbox layers
      if (this.map.getLayer(this.stationsHitboxLayerId)) {
        this.map.removeLayer(this.stationsHitboxLayerId);
      }
      if (this.map.getLayer(this.shotsHitboxLayerId)) {
        this.map.removeLayer(this.shotsHitboxLayerId);
      }
      if (this.map.getLayer(this.ghostStationsHitboxLayerId)) {
        this.map.removeLayer(this.ghostStationsHitboxLayerId);
      }
      if (this.map.getLayer(this.ghostShotsHitboxLayerId)) {
        this.map.removeLayer(this.ghostShotsHitboxLayerId);
      }

      // Remove all sources after layers are removed
      if (this.map.getSource(this.sourceId + '-shots')) {
        this.map.removeSource(this.sourceId + '-shots');
      }
      if (this.map.getSource(this.sourceId + '-stations')) {
        this.map.removeSource(this.sourceId + '-stations');
      }
      if (this.map.getSource(this.sourceId + '-merges')) {
        this.map.removeSource(this.sourceId + '-merges');
      }
      if (this.map.getSource(this.sourceId + '-loop-closures')) {
        this.map.removeSource(this.sourceId + '-loop-closures');
      }
      if (this.map.getSource(this.sourceId + '-section-labels')) {
        this.map.removeSource(this.sourceId + '-section-labels');
      }
      if (this.map.getSource(this.sourceId + '-shot-labels')) {
        this.map.removeSource(this.sourceId + '-shot-labels');
      }
      if (this.map.getSource(this.sourceId + '-station-labels')) {
        this.map.removeSource(this.sourceId + '-station-labels');
      }
      // Remove ghost section sources
      if (this.map.getSource(this.sourceId + '-ghost-shots')) {
        this.map.removeSource(this.sourceId + '-ghost-shots');
      }
      if (this.map.getSource(this.sourceId + '-ghost-stations')) {
        this.map.removeSource(this.sourceId + '-ghost-stations');
      }
      if (this.map.getSource(this.sourceId + '-ghost-merge')) {
        this.map.removeSource(this.sourceId + '-ghost-merge');
      }
    } catch {
      // Map already destroyed during unmount, cleanup not needed
    }

    // Clear bound handler references
    this.boundMouseMove = null;
    this.boundMapLeave = null;
  }
}
