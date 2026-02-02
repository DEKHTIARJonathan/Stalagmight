import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type maplibregl from 'maplibre-gl';
import type {
  LoopClosure,
  Section,
  SectionId,
  ShotId,
  Station,
  StationRef,
} from '../../types/project';
import type { Config, GpsOrigin } from '../../types/config';
import { isNonInteractiveTool } from '../../utils/toolUtils';
import type { ToolType } from '../../store/uiStore';
import { hasLiveStyle } from './mapUtils';
import {
  buildGhostFeatures,
  buildSurveyFeatures,
  normalizeDepthRange,
  type DepthRange,
  type GhostSectionData,
} from './surveyLayer/features';
import { getMapThemeColors, type MapThemeColors } from '../../utils/themeColors';
import { metersToMapCoords } from '../../utils/coordinates';
import { getErrorColor } from '../../utils/colors';
import {
  distanceToLineSegment,
  resolveNearestShot,
  resolveNearestStation,
} from './surveyLayer/hitTest';
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
export type { GhostSectionData } from './surveyLayer/features';

export default class SurveyLayer {
  private map: MaplibreMap;
  private sourceId = 'survey-data';
  private shotsLayerId = 'survey-shots';
  private stationsLayerId = 'survey-stations';
  private labelsLayerId = 'survey-labels';
  private shotLabelsLayerId = 'survey-shot-labels';
  private stationLabelsLayerId = 'survey-station-labels';
  private loopClosuresLayerId = 'survey-loop-closures';
  private dragClosuresLayerId = 'survey-drag-loop-closures';
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
  // Multi-section hover for Move Segment tool (highlights all connected sections)
  private hoveredSegmentSectionIds: string[] = [];

  // Active tool state (for disabling interactions when non-interactive tools are active)
  private activeTool: ToolType = 'select';

  // Anchored section IDs (for fading when Move Segment tool is active)
  private anchoredSectionIds: Set<number> = new Set();
  private prevAnchoredFeatureIds: Set<number> = new Set();

  // Immovable feature IDs for Move Station / Move Shot tools
  // (per-feature granularity, unlike anchoredSectionIds which is per-section)
  private immovableStationFeatureIds: Set<number> = new Set();
  private immovableShotFeatureIds: Set<number> = new Set();

  // Drag preview state — uses temporary layers with *-translate paint properties
  // instead of rebuilding GeoJSON on every frame
  private dragPreviewActive = false;
  private dragSavedFilters = new Map<string, maplibregl.FilterSpecification | undefined>();
  // One-shot callback fired at end of update() — used to restore filters after
  // source data has been updated, in the same synchronous block (no paint gap).
  private onNextUpdateCallback: (() => void) | null = null;
  // Layers that participate in drag preview (main layer → temp layer config)
  private static readonly DRAG_LAYER_DEFS: Array<{
    mainLayerId: string;
    tempLayerId: string;
    sourceId: string;
    type: 'line' | 'circle' | 'symbol';
    translateProp: string;
    translateAnchorProp: string;
  }> = [
    { mainLayerId: 'survey-shots', tempLayerId: 'survey-drag-shots', sourceId: 'survey-data-shots', type: 'line', translateProp: 'line-translate', translateAnchorProp: 'line-translate-anchor' },
    { mainLayerId: 'survey-stations', tempLayerId: 'survey-drag-stations', sourceId: 'survey-data-stations', type: 'circle', translateProp: 'circle-translate', translateAnchorProp: 'circle-translate-anchor' },
    { mainLayerId: 'survey-shot-labels', tempLayerId: 'survey-drag-shot-labels', sourceId: 'survey-data-shot-labels', type: 'symbol', translateProp: 'text-translate', translateAnchorProp: 'text-translate-anchor' },
    { mainLayerId: 'survey-labels', tempLayerId: 'survey-drag-labels', sourceId: 'survey-data-section-labels', type: 'symbol', translateProp: 'text-translate', translateAnchorProp: 'text-translate-anchor' },
    { mainLayerId: 'survey-station-labels', tempLayerId: 'survey-drag-station-labels', sourceId: 'survey-data-station-labels', type: 'symbol', translateProp: 'text-translate', translateAnchorProp: 'text-translate-anchor' },
  ];

  // Station drag preview — dynamic geometry rebuild for connected shots
  // (translate is insufficient because only one endpoint of each shot moves)
  private stationDragShots: Array<{
    properties: Record<string, unknown>;
    fromCoord: [number, number]; // original [lng, lat]
    toCoord: [number, number];
    movingEnd: 'from' | 'to' | 'both';
    shotLabelProperties: Record<string, unknown>;
  }> | null = null;
  private static readonly STATION_DRAG_SHOT_SOURCE = 'survey-drag-station-shots-src';
  private static readonly STATION_DRAG_SHOT_LAYER = 'survey-drag-station-shots-layer';
  private static readonly STATION_DRAG_SHOT_LABEL_SOURCE = 'survey-drag-station-shot-labels-src';
  private static readonly STATION_DRAG_SHOT_LABEL_LAYER = 'survey-drag-station-shot-labels-layer';

  // Station drag preview — dynamic geometry rebuild for connected closure indicator lines
  // (translate is insufficient because only one endpoint of each closure line may move)
  private stationDragClosures: Array<{
    properties: Record<string, unknown>;
    fromCoord: [number, number]; // original [lng, lat] — station_a
    toCoord: [number, number];   // original [lng, lat] — station_b
    movingEnd: 'from' | 'to' | 'both';
  }> | null = null;
  private static readonly STATION_DRAG_CLOSURE_SOURCE = 'survey-drag-station-closures-src';
  private static readonly STATION_DRAG_CLOSURE_LAYER = 'survey-drag-station-closures-layer';

  // Visibility state (for hidden feature detection)
  private stationsVisible: boolean = true;
  private shotsVisible: boolean = true;

  // GPS origin for coordinate transforms (enables satellite tile alignment)
  private gpsOrigin: GpsOrigin | null = null;

  // Depth gradient mode state (used during update() for feature color calculation)
  private showDepthGradient: boolean = false;
  private depthRange: DepthRange = { min: 0, max: 50 };

  // Theme colors for MapLibre paint properties (MapLibre cannot read CSS vars)
  // Seeded at construction so first paint uses current theme, not legacy fallbacks
  private themeColors: MapThemeColors = getMapThemeColors();

  // Cached input data for feature rebuild on theme change
  private cachedSections: Section[] = [];
  private cachedStations: Station[] = [];
  private cachedLoopClosures: LoopClosure[] | undefined;

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

  // Previous section-level feature IDs for setFeatureState (to clear state when section hover/selection changes)
  private prevHoveredSectionShotIds: Set<number> = new Set();
  private prevHoveredSectionStationIds: Set<number> = new Set();
  private prevSelectedSectionShotIds: Set<number> = new Set();
  private prevSelectedSectionStationIds: Set<number> = new Set();

  // Cached section feature IDs to avoid re-scanning querySourceFeatures on every updateVisualState()
  // Key is comma-joined section IDs (handles both single-section and multi-section/segment hover)
  private cachedHoveredSectionKey: string = '';
  private cachedHoveredSectionShotIds: Set<number> = new Set();
  private cachedHoveredSectionStationIds: Set<number> = new Set();
  private cachedSelectedSectionId: string | null = null;
  private cachedSelectedSectionShotIds: Set<number> = new Set();
  private cachedSelectedSectionStationIds: Set<number> = new Set();

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

    // Move Station/Shot tools: set arrow cursor immediately on activation
    // (prevents MapLibre's grab cursor from showing before any hover event fires)
    if (tool === 'move_station' || tool === 'move_shot') {
      this.map.getCanvas().style.cursor = 'default';
    } else if (!isNonInteractive) {
      // Reset cursor when switching away from move tools to other interactive tools
      this.map.getCanvas().style.cursor = '';
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
    // Large buffer prevents tile-boundary clipping when features are translated
    // during segment drag preview. Default is 128; 512 = full tile width.
    // Cave survey data is small so the extra tiling cost is negligible.
    const dragBuffer = 512;

    // Shots line source - promoteId enables setFeatureState for hover/selection
    this.map.addSource(this.sourceId + '-shots', {
      type: 'geojson',
      promoteId: 'featureId',
      buffer: dragBuffer,
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Stations point source - promoteId enables setFeatureState for hover/selection
    this.map.addSource(this.sourceId + '-stations', {
      type: 'geojson',
      promoteId: 'featureId',
      buffer: dragBuffer,
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
      buffer: dragBuffer,
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Section name labels point source (first station of each section)
    this.map.addSource(this.sourceId + '-section-labels', {
      type: 'geojson',
      buffer: dragBuffer,
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Station index labels point source (at each station)
    this.map.addSource(this.sourceId + '-station-labels', {
      type: 'geojson',
      buffer: dragBuffer,
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
        'circle-stroke-color': this.themeColors.strokeColor,
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
        'circle-color': this.themeColors.selectHighlight,
        'circle-stroke-width': 2,
        'circle-stroke-color': this.themeColors.strokeColor,
        'circle-opacity': 0.8,
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
        'line-dasharray': [6, 4], // Dashed line pattern for loop closures
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
        'line-opacity': [
          'case',
          ['boolean', ['feature-state', 'anchored'], false], 0.25,
          ['get', 'isVirtual'], 0.5,
          1,
        ],
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
        // Opacity: reduced for anchored sections
        'circle-opacity': [
          'case',
          ['boolean', ['feature-state', 'anchored'], false], 0.25,
          1,
        ],
        // Stroke width: hover/selected states get thicker strokes (uses feature-state)
        'circle-stroke-width': [
          'case',
          ['boolean', ['feature-state', 'hover'], false], 4,
          ['boolean', ['feature-state', 'selected'], false], 2.5,
          ['get', 'isZeroDatum'], 2,
          1,
        ],
        // Stroke color: hover=highlight, selected=select, else from property
        'circle-stroke-color': [
          'case',
          ['boolean', ['feature-state', 'hover'], false], this.themeColors.hoverHighlight,
          ['boolean', ['feature-state', 'selected'], false], this.themeColors.selectHighlight,
          ['get', 'strokeColor'],
        ],
        // Stroke opacity: reduced for anchored sections
        'circle-stroke-opacity': [
          'case',
          ['boolean', ['feature-state', 'anchored'], false], 0.25,
          1,
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
        'circle-color': this.themeColors.snapColor,
        'circle-stroke-width': 4,
        'circle-stroke-color': this.themeColors.snapColor,
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
        'text-halo-color': this.themeColors.textHaloAlt,
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
        'text-halo-color': this.themeColors.textHalo,
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
        'text-halo-color': this.themeColors.textHaloAlt,
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
      const nearestStation = resolveNearestStation(this.map, e, stationFeatures);
      const nearestShot = resolveNearestShot(this.map, e, shotFeatures);

      // Determine what to highlight (stations take priority unless suppressed by tool)
      let newHoveredStationId: string | null = null;
      let newHoveredShotId: string | null = null;

      // Tool-specific hover suppression:
      // - move_station: only stations hover (suppress shot hover)
      // - move_shot: only shots hover (suppress station hover)
      const suppressStationHover = this.activeTool === 'move_shot';
      const suppressShotHover = this.activeTool === 'move_station';

      if (nearestStation && !suppressStationHover) {
        const { sectionId, stationIndex } = nearestStation.properties ?? {};
        if (sectionId !== undefined && stationIndex !== undefined) {
          newHoveredStationId = `${sectionId}:${stationIndex}`;
        }
      }
      // Show shot hover when no station is hovered (or station was suppressed) and shots not suppressed.
      if (!newHoveredStationId && nearestShot && !suppressShotHover) {
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

        // Update cursor - suppress for anchored/immovable features
        let showPointer = Boolean(newHoveredStationId || newHoveredShotId);
        if (showPointer && this.activeTool === 'move_segment' && this.anchoredSectionIds.size > 0) {
          // Check if hovered feature belongs to an anchored section
          const hoveredId = newHoveredStationId || newHoveredShotId;
          if (hoveredId) {
            const sectionId = parseInt(hoveredId.split(':')[0]!, 10);
            if (this.anchoredSectionIds.has(sectionId)) {
              showPointer = false;
            }
          }
        }
        // Suppress cursor for immovable features in Move Station / Move Shot tools
        if (showPointer && (this.activeTool === 'move_station' || this.activeTool === 'move_shot')) {
          if (newHoveredStationId) {
            const [secStr, idxStr] = newHoveredStationId.split(':');
            const featureId = Number(secStr) * 100000 + Number(idxStr);
            if (this.isStationImmovable(featureId)) showPointer = false;
          } else if (newHoveredShotId) {
            const [secStr, idxStr] = newHoveredShotId.split(':');
            const featureId = Number(secStr) * 100000 + Number(idxStr);
            if (this.isShotImmovable(featureId)) showPointer = false;
          }
        }
        // Move Station/Shot tools: use arrow cursor when not over a movable feature
        // (prevents MapLibre's default grab cursor from showing through)
        const useArrowFallback = this.activeTool === 'move_station' || this.activeTool === 'move_shot';
        this.map.getCanvas().style.cursor = showPointer ? 'pointer' : (useArrowFallback ? 'default' : '');

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
      if (this.dragPreviewActive) return; // Suppress hover during active drag

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
   * Stations take priority over shots unless the active tool suppresses one type
   * (move_shot suppresses stations, move_station suppresses shots).
   */
  private handleMapClick = (e: MapMouseEvent): void => {
    // Ctrl+click in move tools is for panning, not interacting with features
    if (e.originalEvent.ctrlKey &&
        (this.activeTool === 'move_station' || this.activeTool === 'move_shot' || this.activeTool === 'move_segment')) {
      return;
    }

    // Tool-specific suppression (consistent with hover in processHoverUpdate)
    const suppressStationClick = this.activeTool === 'move_shot';
    const suppressShotClick = this.activeTool === 'move_station';

    // Query both hitbox layers in a single call for better performance
    const allFeatures = this.map.queryRenderedFeatures(e.point, {
      layers: [this.stationsHitboxLayerId, this.shotsHitboxLayerId],
    });
    const stationFeatures = allFeatures.filter((f) => f.layer.id === this.stationsHitboxLayerId);
    const shotFeatures = allFeatures.filter((f) => f.layer.id === this.shotsHitboxLayerId);

    // Stations take priority - resolve nearest station first
    const nearestStation = !suppressStationClick ? resolveNearestStation(this.map, e, stationFeatures) : null;
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
    const nearestShot = !suppressShotClick ? resolveNearestShot(this.map, e, shotFeatures) : null;
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
    const nearestStation = resolveNearestStation(this.map, e, stationFeatures);
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
    const nearestShot = resolveNearestShot(this.map, e, shotFeatures);
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
            const dist = distanceToLineSegment(e.point.x, e.point.y, p1.x, p1.y, p2.x, p2.y);
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

  // Convert "sectionId:index" string ID to numeric featureId for setFeatureState
  private parseFeatureId(id: string | null): number | null {
    if (!id) return null;
    const [sectionId, index] = id.split(':').map(Number);
    if (isNaN(sectionId!) || isNaN(index!)) return null;
    return sectionId! * 100000 + index!;
  }

  // Collect all feature IDs belonging to a section from a given source
  private getSectionFeatureIds(source: string, sectionIdStr: string): Set<number> {
    const features = this.map.querySourceFeatures(source);
    const sectionIdNum = Number(sectionIdStr);
    const ids = new Set<number>();
    for (const f of features) {
      if (f.properties?.sectionId === sectionIdNum && f.properties?.featureId != null) {
        ids.add(f.properties.featureId as number);
      }
    }
    return ids;
  }

  // Get the effective section IDs for hover highlighting.
  // Segment hover (multi-section) takes priority over single-section hover.
  private getEffectiveHoverSectionIds(): string[] {
    if (this.hoveredSegmentSectionIds.length > 0) return this.hoveredSegmentSectionIds;
    if (this.hoveredSectionId) return [this.hoveredSectionId];
    return [];
  }

  // Check if a feature belongs to any section in the current effective hover set
  private featureBelongsToHoveredSections(featureId: number): boolean {
    const ids = this.getEffectiveHoverSectionIds();
    if (ids.length === 0) return false;
    const fSectionId = String(Math.floor(featureId / 100000));
    return ids.includes(fSectionId);
  }

  // Get cached section feature IDs for hover, recomputing only when effective section IDs change
  private getCachedHoveredSectionIds(shotsSource: string, stationsSource: string): { shots: Set<number>; stations: Set<number> } {
    const ids = this.getEffectiveHoverSectionIds();
    const key = ids.join(',');
    if (this.cachedHoveredSectionKey !== key) {
      this.cachedHoveredSectionKey = key;
      if (ids.length > 0) {
        const shotIds = new Set<number>();
        const stationIds = new Set<number>();
        for (const secId of ids) {
          for (const id of this.getSectionFeatureIds(shotsSource, secId)) shotIds.add(id);
          for (const id of this.getSectionFeatureIds(stationsSource, secId)) stationIds.add(id);
        }
        this.cachedHoveredSectionShotIds = shotIds;
        this.cachedHoveredSectionStationIds = stationIds;
      } else {
        this.cachedHoveredSectionShotIds = new Set();
        this.cachedHoveredSectionStationIds = new Set();
      }
    }
    return { shots: this.cachedHoveredSectionShotIds, stations: this.cachedHoveredSectionStationIds };
  }

  // Get cached section feature IDs for selection, recomputing only when section ID changes
  private getCachedSelectedSectionIds(shotsSource: string, stationsSource: string): { shots: Set<number>; stations: Set<number> } {
    if (this.cachedSelectedSectionId !== this.selectedSectionId) {
      this.cachedSelectedSectionId = this.selectedSectionId;
      if (this.selectedSectionId) {
        this.cachedSelectedSectionShotIds = this.getSectionFeatureIds(shotsSource, this.selectedSectionId);
        this.cachedSelectedSectionStationIds = this.getSectionFeatureIds(stationsSource, this.selectedSectionId);
      } else {
        this.cachedSelectedSectionShotIds = new Set();
        this.cachedSelectedSectionStationIds = new Set();
      }
    }
    return { shots: this.cachedSelectedSectionShotIds, stations: this.cachedSelectedSectionStationIds };
  }

  // Invalidate section ID caches (called after data updates that reset feature-state)
  private invalidateSectionCaches(): void {
    this.cachedHoveredSectionKey = '';
    this.cachedSelectedSectionId = null;
  }

  // Check if a featureId belongs to a section (derived from encoding: sectionId * 100000 + index)
  private featureBelongsToSection(featureId: number, sectionIdStr: string | null): boolean {
    if (!sectionIdStr) return false;
    return Math.floor(featureId / 100000) === Number(sectionIdStr);
  }

  // Check if a feature belongs to an anchored section (suppresses hover/interaction)
  private isFeatureAnchored(featureId: number): boolean {
    return this.anchoredSectionIds.size > 0 &&
      this.anchoredSectionIds.has(Math.floor(featureId / 100000));
  }

  // Check if a station feature is individually immovable (zero-datum or transitively connected)
  private isStationImmovable(featureId: number): boolean {
    return this.immovableStationFeatureIds.has(featureId);
  }

  // Check if a shot feature is individually immovable (endpoint is zero-datum or transitively connected)
  private isShotImmovable(featureId: number): boolean {
    return this.immovableShotFeatureIds.has(featureId);
  }

  // Update visual state using setFeatureState (much faster than setPaintProperty)
  // Only updates the specific features that changed, not the entire layer
  private updateVisualState() {
    const stationsSource = this.sourceId + '-stations';
    const shotsSource = this.sourceId + '-shots';

    // Update station hover state
    const newHoveredStationFeatureId = this.parseFeatureId(this.hoveredStationId);
    if (newHoveredStationFeatureId !== this.prevHoveredStationFeatureId) {
      // Clear previous hover — but restore section/segment hover if feature belongs to hovered sections.
      // Check both the section ID derivation AND the actual section hover set, because featureId
      // encoding may not match sectionId for shots spanning multiple sections.
      if (this.prevHoveredStationFeatureId !== null) {
        const restoreSection = this.featureBelongsToHoveredSections(this.prevHoveredStationFeatureId)
          || this.prevHoveredSectionStationIds.has(this.prevHoveredStationFeatureId);
        this.map.setFeatureState(
          { source: stationsSource, id: this.prevHoveredStationFeatureId },
          { hover: restoreSection }
        );
      }
      // Set new hover (suppress for anchored/immovable features — no interaction feedback)
      if (newHoveredStationFeatureId !== null &&
          !this.isFeatureAnchored(newHoveredStationFeatureId) &&
          !this.isStationImmovable(newHoveredStationFeatureId)) {
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
      // Clear previous hover — but restore section/segment hover if feature belongs to hovered sections.
      // Check both the section ID derivation AND the actual section hover set, because featureId
      // encoding may not match sectionId for shots spanning multiple sections.
      if (this.prevHoveredShotFeatureId !== null) {
        const restoreSection = this.featureBelongsToHoveredSections(this.prevHoveredShotFeatureId)
          || this.prevHoveredSectionShotIds.has(this.prevHoveredShotFeatureId);
        this.map.setFeatureState(
          { source: shotsSource, id: this.prevHoveredShotFeatureId },
          { hover: restoreSection }
        );
      }
      // Set new hover (suppress for anchored/immovable features — no interaction feedback)
      if (newHoveredShotFeatureId !== null &&
          !this.isFeatureAnchored(newHoveredShotFeatureId) &&
          !this.isShotImmovable(newHoveredShotFeatureId)) {
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
      // Clear previous selection — but restore section selection if feature belongs to selected section
      if (this.prevSelectedStationFeatureId !== null) {
        const restoreSection = this.featureBelongsToSection(this.prevSelectedStationFeatureId, this.selectedSectionId);
        this.map.setFeatureState(
          { source: stationsSource, id: this.prevSelectedStationFeatureId },
          { selected: restoreSection }
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
      // Clear previous selection — but restore section selection if feature belongs to selected section
      if (this.prevSelectedShotFeatureId !== null) {
        const restoreSection = this.featureBelongsToSection(this.prevSelectedShotFeatureId, this.selectedSectionId);
        this.map.setFeatureState(
          { source: shotsSource, id: this.prevSelectedShotFeatureId },
          { selected: restoreSection }
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

    // --- Section hover (shots + stations) ---
    {
      const { shots: newHoveredShotIds, stations: newHoveredStationIds } =
        this.getCachedHoveredSectionIds(shotsSource, stationsSource);

      // Clear previous section-hovered shots not in new set
      for (const id of this.prevHoveredSectionShotIds) {
        if (!newHoveredShotIds.has(id) && id !== newHoveredShotFeatureId) {
          this.map.setFeatureState({ source: shotsSource, id }, { hover: false });
        }
      }
      // Set new section-hovered shots not in prev set.
      // During move_segment: always re-apply hover on all section shots to ensure visual
      // consistency (individual hover interactions can leave stale feature-state).
      const forceReapply = this.activeTool === 'move_segment';
      for (const id of newHoveredShotIds) {
        if (forceReapply || (!this.prevHoveredSectionShotIds.has(id) && id !== newHoveredShotFeatureId)) {
          this.map.setFeatureState({ source: shotsSource, id }, { hover: true });
        }
      }
      this.prevHoveredSectionShotIds = newHoveredShotIds;

      // Clear previous section-hovered stations not in new set
      for (const id of this.prevHoveredSectionStationIds) {
        if (!newHoveredStationIds.has(id) && id !== newHoveredStationFeatureId) {
          this.map.setFeatureState({ source: stationsSource, id }, { hover: false });
        }
      }
      // Set new section-hovered stations not in prev set
      for (const id of newHoveredStationIds) {
        if (forceReapply || (!this.prevHoveredSectionStationIds.has(id) && id !== newHoveredStationFeatureId)) {
          this.map.setFeatureState({ source: stationsSource, id }, { hover: true });
        }
      }
      this.prevHoveredSectionStationIds = newHoveredStationIds;
    }

    // --- Section selection (shots + stations) ---
    {
      const { shots: newSelectedShotIds, stations: newSelectedStationIds } =
        this.getCachedSelectedSectionIds(shotsSource, stationsSource);

      // Clear previous section-selected shots not in new set
      for (const id of this.prevSelectedSectionShotIds) {
        if (!newSelectedShotIds.has(id) && id !== newSelectedShotFeatureId) {
          this.map.setFeatureState({ source: shotsSource, id }, { selected: false });
        }
      }
      // Set new section-selected shots not in prev set
      for (const id of newSelectedShotIds) {
        if (!this.prevSelectedSectionShotIds.has(id) && id !== newSelectedShotFeatureId) {
          this.map.setFeatureState({ source: shotsSource, id }, { selected: true });
        }
      }
      this.prevSelectedSectionShotIds = newSelectedShotIds;

      // Clear previous section-selected stations not in new set
      for (const id of this.prevSelectedSectionStationIds) {
        if (!newSelectedStationIds.has(id) && id !== newSelectedStationFeatureId) {
          this.map.setFeatureState({ source: stationsSource, id }, { selected: false });
        }
      }
      // Set new section-selected stations not in prev set
      for (const id of newSelectedStationIds) {
        if (!this.prevSelectedSectionStationIds.has(id) && id !== newSelectedStationFeatureId) {
          this.map.setFeatureState({ source: stationsSource, id }, { selected: true });
        }
      }
      this.prevSelectedSectionStationIds = newSelectedStationIds;
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
   * Set multi-section hover for Move Segment tool.
   * Highlights all shots and stations in the given sections (the connected segment).
   * Takes priority over single-section hover when non-empty.
   * @param sectionIds - Array of section IDs in the connected segment, or empty to clear
   */
  setHoveredSegment(sectionIds: number[]): void {
    const stringIds = sectionIds.map(String);
    // Quick equality check (arrays are small, typically <10 sections)
    if (stringIds.length === this.hoveredSegmentSectionIds.length &&
        stringIds.every((id, i) => id === this.hoveredSegmentSectionIds[i])) return;
    this.hoveredSegmentSectionIds = stringIds;
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
   * Set the hovered station for visual highlighting (external hover, e.g. from DetailLink).
   * This allows external components to trigger station hover highlighting without mouse interaction.
   * @param ref - The StationRef of the station, or null to clear
   */
  setHoveredStation(ref: StationRef | null): void {
    // Convert to composite string ID format used internally
    const stringId = ref !== null ? `${ref.section_id}:${ref.station_index}` : null;
    if (this.hoveredStationId === stringId) return;
    this.hoveredStationId = stringId;
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

  getDepthRange(): DepthRange {
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

  // Control stations visibility (also hides loop closures and station hitbox)
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
    this.hoveredSegmentSectionIds = [];
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
   * Set anchored section IDs for fading when Move Segment tool is active.
   * Sections in this set get reduced opacity via feature-state.
   */
  setAnchoredSections(sectionIds: Set<number>): void {
    const stationsSource = this.sourceId + '-stations';
    const shotsSource = this.sourceId + '-shots';

    // Clear previously anchored features
    for (const featureId of this.prevAnchoredFeatureIds) {
      try {
        this.map.setFeatureState({ source: stationsSource, id: featureId }, { anchored: false });
      } catch { /* feature may not exist */ }
      try {
        this.map.setFeatureState({ source: shotsSource, id: featureId }, { anchored: false });
      } catch { /* feature may not exist */ }
    }

    this.anchoredSectionIds = sectionIds;
    const newAnchoredFeatureIds = new Set<number>();

    if (sectionIds.size > 0) {
      // Find all features belonging to anchored sections and set feature-state
      for (const source of [stationsSource, shotsSource]) {
        try {
          const features = this.map.querySourceFeatures(source);
          for (const f of features) {
            if (f.properties?.sectionId != null && sectionIds.has(f.properties.sectionId as number) && f.id != null) {
              const featureId = typeof f.id === 'number' ? f.id : parseInt(String(f.id), 10);
              if (!isNaN(featureId)) {
                this.map.setFeatureState({ source, id: featureId }, { anchored: true });
                newAnchoredFeatureIds.add(featureId);
              }
            }
          }
        } catch { /* source may not be loaded */ }
      }
    }

    this.prevAnchoredFeatureIds = newAnchoredFeatureIds;

    // Update label layer opacity via setPaintProperty (labels use separate sources
    // without promoteId, so feature-state isn't available — use data-driven expressions)
    this.updateLabelAnchoredOpacity(sectionIds);

    // Update loop closure line opacity — gray out closures where both endpoints are anchored
    this.updateClosureAnchoredOpacity(sectionIds);

    // Refresh main layer opacity so anchored sections dim consistently with current set.
    this.updateImmovableLayerOpacity(this.immovableStationFeatureIds, this.immovableShotFeatureIds);
  }

  // Set text-opacity on label layers: 0.25 for features in anchored sections, normal otherwise
  private updateLabelAnchoredOpacity(anchoredIds: Set<number>): void {
    const idsArray = [...anchoredIds];
    const anchoredCheck: maplibregl.ExpressionSpecification =
      ['in', ['get', 'sectionId'], ['literal', idsArray]] as maplibregl.ExpressionSpecification;

    // Zoom-interpolated base opacity for shot/station labels
    const zoomOpacity: maplibregl.ExpressionSpecification = [
      'interpolate', ['linear'], ['zoom'], 14, 0.7, 18, 1,
    ] as maplibregl.ExpressionSpecification;

    if (idsArray.length > 0) {
      // Shot labels: anchored → 0.25, else zoom-interpolated
      this.map.setPaintProperty(this.shotLabelsLayerId, 'text-opacity', [
        'case', anchoredCheck, 0.25, zoomOpacity,
      ] as maplibregl.ExpressionSpecification);
      // Section name labels: anchored → 0.25, else 1
      this.map.setPaintProperty(this.labelsLayerId, 'text-opacity', [
        'case', anchoredCheck, 0.25, 1,
      ] as maplibregl.ExpressionSpecification);
      // Station index labels: anchored → 0.25, else zoom-interpolated
      this.map.setPaintProperty(this.stationLabelsLayerId, 'text-opacity', [
        'case', anchoredCheck, 0.25, zoomOpacity,
      ] as maplibregl.ExpressionSpecification);
    } else {
      // Restore original opacity (no anchored sections)
      this.map.setPaintProperty(this.shotLabelsLayerId, 'text-opacity', zoomOpacity);
      this.map.setPaintProperty(this.labelsLayerId, 'text-opacity', 1);
      this.map.setPaintProperty(this.stationLabelsLayerId, 'text-opacity', zoomOpacity);
    }
  }

  // Set line-opacity on loop closures layer: 0.25 when both endpoints are in anchored sections
  private updateClosureAnchoredOpacity(anchoredIds: Set<number>): void {
    const idsArray = [...anchoredIds];

    if (idsArray.length > 0) {
      // Both endpoints must be anchored to gray out the closure line
      const bothAnchored: maplibregl.ExpressionSpecification = ['all',
        ['in', ['get', 'sectionIdA'], ['literal', idsArray]],
        ['in', ['get', 'sectionIdB'], ['literal', idsArray]],
      ] as maplibregl.ExpressionSpecification;

      this.map.setPaintProperty(this.loopClosuresLayerId, 'line-opacity', [
        'case', bothAnchored, 0.25, 0.8,
      ] as maplibregl.ExpressionSpecification);
    } else {
      this.map.setPaintProperty(this.loopClosuresLayerId, 'line-opacity', 0.8);
    }
  }

  /**
   * Set individual feature-level immovable state for move_station / move_shot tools.
   * Uses setPaintProperty with data-driven expressions to dim immovable features.
   * Unlike setAnchoredSections (which uses setFeatureState), this approach is reliable
   * on initial tool activation because it doesn't depend on feature tiling state.
   */
  setImmovableFeatures(stationIds: Set<number>, shotIds: Set<number>): void {
    this.immovableStationFeatureIds = stationIds;
    this.immovableShotFeatureIds = shotIds;

    // Update main layer paint properties (stations + shots)
    this.updateImmovableLayerOpacity(stationIds, shotIds);

    // Update label and closure opacity
    this.updateImmovableLabelOpacity(stationIds, shotIds);
    this.updateImmovableClosureOpacity(stationIds);
  }

  // Set circle-opacity/line-opacity on main layers using data-driven expressions.
  // Uses setPaintProperty (not setFeatureState) for reliable initial-activation dimming.
  private updateImmovableLayerOpacity(stationIds: Set<number>, shotIds: Set<number>): void {
    const anchoredCheck: maplibregl.ExpressionSpecification = this.anchoredSectionIds.size > 0
      ? ['in', ['get', 'sectionId'], ['literal', [...this.anchoredSectionIds]]]
      : (false as unknown as maplibregl.ExpressionSpecification);

    if (stationIds.size > 0 || shotIds.size > 0) {
      // Station circles: dim immovable stations
      if (stationIds.size > 0) {
        const stationIdsArray = [...stationIds];
        const immovableCheck: maplibregl.ExpressionSpecification = [
          'in', ['get', 'featureId'], ['literal', stationIdsArray],
        ] as maplibregl.ExpressionSpecification;
        this.map.setPaintProperty(this.stationsLayerId, 'circle-opacity', [
          'case',
          immovableCheck, 0.25,
          anchoredCheck, 0.25,
          1,
        ] as maplibregl.ExpressionSpecification);
        this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-opacity', [
          'case',
          immovableCheck, 0.25,
          anchoredCheck, 0.25,
          1,
        ] as maplibregl.ExpressionSpecification);
      } else {
        // Restore default (feature-state only)
        this.map.setPaintProperty(this.stationsLayerId, 'circle-opacity', [
          'case',
          anchoredCheck, 0.25,
          1,
        ] as maplibregl.ExpressionSpecification);
        this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-opacity', [
          'case',
          anchoredCheck, 0.25,
          1,
        ] as maplibregl.ExpressionSpecification);
      }

      // Shot lines: dim immovable shots
      if (shotIds.size > 0) {
        const shotIdsArray = [...shotIds];
        const immovableCheck: maplibregl.ExpressionSpecification = [
          'in', ['get', 'featureId'], ['literal', shotIdsArray],
        ] as maplibregl.ExpressionSpecification;
        this.map.setPaintProperty(this.shotsLayerId, 'line-opacity', [
          'case',
          immovableCheck, 0.25,
          anchoredCheck, 0.25,
          ['get', 'isVirtual'], 0.5,
          1,
        ] as maplibregl.ExpressionSpecification);
      } else {
        // Restore default (feature-state only)
        this.map.setPaintProperty(this.shotsLayerId, 'line-opacity', [
          'case',
          anchoredCheck, 0.25,
          ['get', 'isVirtual'], 0.5,
          1,
        ] as maplibregl.ExpressionSpecification);
      }
    } else {
      // No immovable features — restore original paint properties
      this.map.setPaintProperty(this.stationsLayerId, 'circle-opacity', [
        'case',
        anchoredCheck, 0.25,
        1,
      ] as maplibregl.ExpressionSpecification);
      this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-opacity', [
        'case',
        anchoredCheck, 0.25,
        1,
      ] as maplibregl.ExpressionSpecification);
      this.map.setPaintProperty(this.shotsLayerId, 'line-opacity', [
        'case',
        anchoredCheck, 0.25,
        ['get', 'isVirtual'], 0.5,
        1,
      ] as maplibregl.ExpressionSpecification);
    }
  }

  // Set text-opacity on label layers: 0.25 for immovable features, normal otherwise.
  // Uses per-feature ID matching (sectionId * 100000 + stationIndex/shotId) since
  // immovable features are per-station, not per-section.
  private updateImmovableLabelOpacity(
    stationIds: Set<number>,
    shotIds: Set<number>
  ): void {
    const zoomOpacity: maplibregl.ExpressionSpecification = [
      'interpolate', ['linear'], ['zoom'], 14, 0.7, 18, 1,
    ] as maplibregl.ExpressionSpecification;

    if (stationIds.size > 0 || shotIds.size > 0) {
      // Station labels: compute featureId from sectionId * 100000 + stationIndex
      if (stationIds.size > 0) {
        const stationIdsArray = [...stationIds];
        const stationAnchoredCheck: maplibregl.ExpressionSpecification = [
          'in',
          ['+', ['*', ['get', 'sectionId'], 100000], ['get', 'stationIndex']],
          ['literal', stationIdsArray],
        ] as maplibregl.ExpressionSpecification;
        this.map.setPaintProperty(this.stationLabelsLayerId, 'text-opacity', [
          'case', stationAnchoredCheck, 0.25, zoomOpacity,
        ] as maplibregl.ExpressionSpecification);
      } else {
        this.map.setPaintProperty(this.stationLabelsLayerId, 'text-opacity', zoomOpacity);
      }

      // Shot labels: compute featureId from sectionId * 100000 + shotId
      if (shotIds.size > 0) {
        const shotIdsArray = [...shotIds];
        const shotAnchoredCheck: maplibregl.ExpressionSpecification = [
          'in',
          ['+', ['*', ['get', 'sectionId'], 100000], ['get', 'shotId']],
          ['literal', shotIdsArray],
        ] as maplibregl.ExpressionSpecification;
        this.map.setPaintProperty(this.shotLabelsLayerId, 'text-opacity', [
          'case', shotAnchoredCheck, 0.25, zoomOpacity,
        ] as maplibregl.ExpressionSpecification);
      } else {
        this.map.setPaintProperty(this.shotLabelsLayerId, 'text-opacity', zoomOpacity);
      }

      // Section name labels: leave at full opacity (not meaningful to dim per-station)
      this.map.setPaintProperty(this.labelsLayerId, 'text-opacity', 1);
    } else {
      // Restore original opacity
      this.map.setPaintProperty(this.shotLabelsLayerId, 'text-opacity', zoomOpacity);
      this.map.setPaintProperty(this.labelsLayerId, 'text-opacity', 1);
      this.map.setPaintProperty(this.stationLabelsLayerId, 'text-opacity', zoomOpacity);
    }
  }

  // Set line-opacity on loop closures layer: 0.25 when either endpoint is immovable
  private updateImmovableClosureOpacity(immovableStationIds: Set<number>): void {
    if (immovableStationIds.size > 0) {
      // Build station key strings matching closure feature "sectionId:stationIndex" format
      const immovableKeyStrings: string[] = [];
      for (const fid of immovableStationIds) {
        const sectionId = Math.floor(fid / 100000);
        const stationIndex = fid % 100000;
        immovableKeyStrings.push(`${sectionId}:${stationIndex}`);
      }

      // Dim closure if either endpoint is immovable
      const eitherImmovable: maplibregl.ExpressionSpecification = ['any',
        ['in', ['get', 'stationA'], ['literal', immovableKeyStrings]],
        ['in', ['get', 'stationB'], ['literal', immovableKeyStrings]],
      ] as maplibregl.ExpressionSpecification;

      this.map.setPaintProperty(this.loopClosuresLayerId, 'line-opacity', [
        'case', eitherImmovable, 0.25, 0.8,
      ] as maplibregl.ExpressionSpecification);
    } else {
      this.map.setPaintProperty(this.loopClosuresLayerId, 'line-opacity', 0.8);
    }
  }

  /**
   * Begin drag preview — hides connected section features from main layers via filter,
   * then creates temporary layers (same sources) that show only those features with a
   * *-translate paint property. Per-frame cost becomes just setPaintProperty (shader
   * uniform update) instead of rebuilding 5 GeoJSON sources.
   */
  beginDragPreview(connectedSectionIds: Set<number>): void {
    if (this.dragPreviewActive) this.endDragPreview();
    if (connectedSectionIds.size === 0) return;

    const idsArray = [...connectedSectionIds];
    const exclusion: maplibregl.FilterSpecification = ['!', ['in', ['get', 'sectionId'], ['literal', idsArray]]];
    const inclusion: maplibregl.FilterSpecification = ['in', ['get', 'sectionId'], ['literal', idsArray]];

    for (const def of SurveyLayer.DRAG_LAYER_DEFS) {
      // Save and compose exclusion filter on main layer
      const existing = this.map.getFilter(def.mainLayerId);
      this.dragSavedFilters.set(def.mainLayerId, existing ?? undefined);
      // Compose exclusion with existing filter. If existing is trivial (null/boolean), use
      // exclusion alone. Cast needed because MapLibre's TS types don't fully cover ['all',...].
      const composed: maplibregl.FilterSpecification = (existing && typeof existing === 'object')
        ? (['all', existing, exclusion] as unknown as maplibregl.FilterSpecification)
        : exclusion;
      this.map.setFilter(def.mainLayerId, composed);

      // Create temp layer from same source, filtered to connected sections only
      const paintBase: Record<string, unknown> = {
        [def.translateProp]: [0, 0] as [number, number],
        [def.translateAnchorProp]: 'viewport',
        // Disable the default 300ms paint transition — makes translate instant
        [`${def.translateProp}-transition`]: { duration: 0, delay: 0 },
      };

      if (def.type === 'line') {
        this.map.addLayer({
          id: def.tempLayerId,
          type: 'line',
          source: def.sourceId,
          filter: inclusion,
          paint: {
            'line-color': ['get', 'color'],
            'line-width': this.getShotSelectionWidth(),
            'line-opacity': 0.85,
            ...paintBase,
          },
        });
      } else if (def.type === 'circle') {
        this.map.addLayer({
          id: def.tempLayerId,
          type: 'circle',
          source: def.sourceId,
          filter: inclusion,
          paint: {
            'circle-color': ['get', 'color'],
            'circle-radius': this.getStationSelectionRadius(),
            'circle-stroke-color': this.themeColors.selectHighlight,
            'circle-stroke-width': 2.5,
            'circle-opacity': 0.85,
            ...paintBase,
          },
        });
      } else if (def.type === 'symbol') {
        // Copy layout properties from main layer so labels keep their position/size
        const vis = this.map.getLayoutProperty(def.mainLayerId, 'visibility') ?? 'visible';
        const textSize = this.map.getLayoutProperty(def.mainLayerId, 'text-size') ?? 11;
        const textOffset = this.map.getLayoutProperty(def.mainLayerId, 'text-offset');
        const textAnchor = this.map.getLayoutProperty(def.mainLayerId, 'text-anchor');
        const layoutProps: Record<string, unknown> = {
          'text-field': def.sourceId.includes('section') ? ['get', 'name'] : ['get', 'label'],
          'text-font': ['Open Sans Regular'],
          'text-size': textSize,
          'text-allow-overlap': true,
          'visibility': vis as 'visible' | 'none',
        };
        if (textOffset != null) layoutProps['text-offset'] = textOffset;
        if (textAnchor != null) layoutProps['text-anchor'] = textAnchor;
        this.map.addLayer({
          id: def.tempLayerId,
          type: 'symbol',
          source: def.sourceId,
          filter: inclusion,
          layout: layoutProps as NonNullable<maplibregl.SymbolLayerSpecification['layout']>,
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': this.themeColors.textHalo,
            'text-halo-width': 1.5,
            'text-opacity': 0.85,
            ...paintBase,
          },
        });
      }
    }

    // Loop closures: hide closures that have ANY endpoint in the connected set from
    // the main layer, then create a temp layer for closures with BOTH endpoints in the
    // set (those translate uniformly). Closures bridging dragged/stationary sections are
    // hidden during drag and reappear with correct geometry after commit.
    {
      const closureSourceId = this.sourceId + '-loop-closures';
      const existingFilter = this.map.getFilter(this.loopClosuresLayerId);
      this.dragSavedFilters.set(this.loopClosuresLayerId, existingFilter ?? undefined);

      // Hide closures where EITHER endpoint is in the connected set
      const eitherEndpointExclusion: maplibregl.FilterSpecification = ['!', ['any',
        ['in', ['get', 'sectionIdA'], ['literal', idsArray]],
        ['in', ['get', 'sectionIdB'], ['literal', idsArray]],
      ]] as unknown as maplibregl.FilterSpecification;
      const composedClosure: maplibregl.FilterSpecification = (existingFilter && typeof existingFilter === 'object')
        ? (['all', existingFilter, eitherEndpointExclusion] as unknown as maplibregl.FilterSpecification)
        : eitherEndpointExclusion;
      this.map.setFilter(this.loopClosuresLayerId, composedClosure);

      // Temp layer: closures where BOTH endpoints are in connected set (translate together)
      const bothEndpointInclusion: maplibregl.FilterSpecification = ['all',
        ['in', ['get', 'sectionIdA'], ['literal', idsArray]],
        ['in', ['get', 'sectionIdB'], ['literal', idsArray]],
      ] as unknown as maplibregl.FilterSpecification;

      this.map.addLayer({
        id: this.dragClosuresLayerId,
        type: 'line',
        source: closureSourceId,
        filter: bothEndpointInclusion,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 3,
          'line-opacity': 0.85,
          'line-dasharray': [6, 4],
          'line-translate': [0, 0] as [number, number],
          'line-translate-anchor': 'viewport',
          'line-translate-transition': { duration: 0, delay: 0 },
        },
      });
    }

    this.dragPreviewActive = true;
  }

  /**
   * Begin station drag preview — finds all co-located stations (merged/closured),
   * hides them and their connected shots from main layers, then creates:
   *   1. Translate-based temp layers for station circles + labels (GPU-efficient)
   *   2. Dynamic GeoJSON sources + layers for connected shots + shot labels
   *      (geometry is rebuilt per-frame since only one endpoint of each shot moves)
   *
   * Returns the list of co-located StationRefs so MapCanvas can batch-move them.
   */
  beginStationDragPreview(sectionId: number, stationIndex: number, additionalSeeds?: StationRef[]): StationRef[] {
    if (this.dragPreviewActive) this.endDragPreview();

    // 1. Find clicked station and all co-located stations via BFS:
    //    - merged_with: always co-located
    //    - closures_with: co-located only if the closure strategy is NOT KeepRaw
    //    additionalSeeds allows shot drag to seed from both endpoints simultaneously
    const stationByKey = new Map(
      this.cachedStations.map(s => [`${s.station_ref.section_id}:${s.station_ref.station_index}`, s])
    );
    const clickedKey = `${sectionId}:${stationIndex}`;
    const clickedStation = stationByKey.get(clickedKey);
    if (!clickedStation) return [];

    // Build closure strategy lookup (closure_id → strategy)
    const closureStrategyById = new Map<number, string>();
    for (const lc of this.cachedLoopClosures ?? []) {
      closureStrategyById.set(lc.id, lc.strategy);
    }

    // Seed BFS from primary station + any additional seeds (e.g., shot's other endpoint)
    const seedKeys = [clickedKey];
    if (additionalSeeds) {
      for (const seed of additionalSeeds) {
        const key = `${seed.section_id}:${seed.station_index}`;
        if (stationByKey.has(key)) seedKeys.push(key);
      }
    }

    const movingRefKeys = new Set<string>();
    const queue: string[] = [...seedKeys];
    while (queue.length > 0) {
      const key = queue.pop()!;
      if (movingRefKeys.has(key)) continue;
      movingRefKeys.add(key);
      const st = stationByKey.get(key);
      if (!st) continue;
      for (const ref of st.merged_with) {
        queue.push(`${ref.section_id}:${ref.station_index}`);
      }
      for (const cr of st.closures_with ?? []) {
        const strategy = closureStrategyById.get(cr.closure_id);
        if (strategy && strategy !== 'KeepRaw') {
          queue.push(`${cr.station_ref.section_id}:${cr.station_ref.station_index}`);
        }
      }
    }
    const movingStations = this.cachedStations.filter(
      s => movingRefKeys.has(`${s.station_ref.section_id}:${s.station_ref.station_index}`)
    );

    // 2. Build station inclusion/exclusion filters (covers all co-located stations)
    const stationInclusion: maplibregl.FilterSpecification = (movingStations.length === 1
      ? ['all',
          ['==', ['get', 'sectionId'], sectionId],
          ['==', ['get', 'stationIndex'], stationIndex],
        ]
      : ['any',
          ...movingStations.map(s => ['all',
            ['==', ['get', 'sectionId'], s.station_ref.section_id],
            ['==', ['get', 'stationIndex'], s.station_ref.station_index],
          ]),
        ]
    ) as unknown as maplibregl.FilterSpecification;
    const stationExclusion: maplibregl.FilterSpecification =
      ['!', stationInclusion] as unknown as maplibregl.FilterSpecification;

    // 3. Find connected shots for all moving stations
    type ShotInfo = typeof this.stationDragShots extends (infer T)[] | null ? T : never;
    const shotInfos: ShotInfo[] = [];
    const seenShotKeys = new Set<string>();

    for (const movingSt of movingStations) {
      const section = this.cachedSections.find(s => s.id === movingSt.station_ref.section_id);
      if (!section) continue;

      const sectionStations = this.cachedStations
        .filter(s => s.station_ref.section_id === section.id)
        .sort((a, b) => a.station_ref.station_index - b.station_ref.station_index);

      for (let i = 0; i < section.shots.length; i++) {
        const fromSt = sectionStations[i];
        const toSt = sectionStations[i + 1];
        if (!fromSt || !toSt) continue;

        const fromKey = `${fromSt.station_ref.section_id}:${fromSt.station_ref.station_index}`;
        const toKey = `${toSt.station_ref.section_id}:${toSt.station_ref.station_index}`;
        const fromIsMoving = movingRefKeys.has(fromKey);
        const toIsMoving = movingRefKeys.has(toKey);
        if (!fromIsMoving && !toIsMoving) continue;

        const shot = section.shots[i];
        if (!shot) continue;
        const shotKey = `${section.id}:${shot.id}`;
        if (seenShotKeys.has(shotKey)) continue;
        seenShotKeys.add(shotKey);

        const fromCoord = metersToMapCoords(
          fromSt.coordinates.x, fromSt.coordinates.y, this.gpsOrigin
        ) as [number, number];
        const toCoord = metersToMapCoords(
          toSt.coordinates.x, toSt.coordinates.y, this.gpsOrigin
        ) as [number, number];

        shotInfos.push({
          properties: {
            sectionId: section.id,
            shotId: shot.id,
            color: section.color,
            isVirtual: shot.is_virtual,
          },
          fromCoord,
          toCoord,
          movingEnd: fromIsMoving && toIsMoving ? 'both' : fromIsMoving ? 'from' : 'to',
          shotLabelProperties: {
            label: `${shot.azimuth_in.toFixed(0)}° ${shot.length.toFixed(1)}m`,
            sectionId: section.id,
            shotId: shot.id,
            color: section.color,
          },
        });
      }
    }

    // 4. Create translate-based temp layers for stations + station labels
    const stationDefs = SurveyLayer.DRAG_LAYER_DEFS.filter(
      d => d.mainLayerId === 'survey-stations' || d.mainLayerId === 'survey-station-labels'
    );

    for (const def of stationDefs) {
      const existing = this.map.getFilter(def.mainLayerId);
      this.dragSavedFilters.set(def.mainLayerId, existing ?? undefined);
      const composed: maplibregl.FilterSpecification = (existing && typeof existing === 'object')
        ? (['all', existing, stationExclusion] as unknown as maplibregl.FilterSpecification)
        : stationExclusion;
      this.map.setFilter(def.mainLayerId, composed);

      const paintBase: Record<string, unknown> = {
        [def.translateProp]: [0, 0] as [number, number],
        [def.translateAnchorProp]: 'viewport',
        [`${def.translateProp}-transition`]: { duration: 0, delay: 0 },
      };

      if (def.type === 'circle') {
        this.map.addLayer({
          id: def.tempLayerId,
          type: 'circle',
          source: def.sourceId,
          filter: stationInclusion,
          paint: {
            'circle-color': ['get', 'color'],
            'circle-radius': this.getStationSelectionRadius(),
            'circle-stroke-color': this.themeColors.selectHighlight,
            'circle-stroke-width': 2.5,
            'circle-opacity': 0.85,
            ...paintBase,
          },
        });
      } else if (def.type === 'symbol') {
        const vis = this.map.getLayoutProperty(def.mainLayerId, 'visibility') ?? 'visible';
        const textSize = this.map.getLayoutProperty(def.mainLayerId, 'text-size') ?? 11;
        const textOffset = this.map.getLayoutProperty(def.mainLayerId, 'text-offset');
        const textAnchor = this.map.getLayoutProperty(def.mainLayerId, 'text-anchor');
        const layoutProps: Record<string, unknown> = {
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Regular'],
          'text-size': textSize,
          'text-allow-overlap': true,
          'visibility': vis as 'visible' | 'none',
        };
        if (textOffset != null) layoutProps['text-offset'] = textOffset;
        if (textAnchor != null) layoutProps['text-anchor'] = textAnchor;
        this.map.addLayer({
          id: def.tempLayerId,
          type: 'symbol',
          source: def.sourceId,
          filter: stationInclusion,
          layout: layoutProps as NonNullable<maplibregl.SymbolLayerSpecification['layout']>,
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': this.themeColors.textHalo,
            'text-halo-width': 1.5,
            'text-opacity': 0.85,
            ...paintBase,
          },
        });
      }
    }

    // 5. Create dynamic sources + layers for connected shots + shot labels
    if (shotInfos.length > 0) {
      // Build shot exclusion filter and apply to main shot + shot-label layers
      const firstShot = shotInfos[0]!;
      const shotInclusion: maplibregl.FilterSpecification = (shotInfos.length === 1
        ? ['all',
            ['==', ['get', 'sectionId'], firstShot.properties.sectionId],
            ['==', ['get', 'shotId'], firstShot.properties.shotId],
          ]
        : ['any',
            ...shotInfos.map(s => ['all',
              ['==', ['get', 'sectionId'], s.properties.sectionId],
              ['==', ['get', 'shotId'], s.properties.shotId],
            ]),
          ]
      ) as unknown as maplibregl.FilterSpecification;
      const shotExclusion: maplibregl.FilterSpecification =
        ['!', shotInclusion] as unknown as maplibregl.FilterSpecification;

      for (const layerId of ['survey-shots', 'survey-shot-labels']) {
        const existing = this.map.getFilter(layerId);
        this.dragSavedFilters.set(layerId, existing ?? undefined);
        const composed: maplibregl.FilterSpecification = (existing && typeof existing === 'object')
          ? (['all', existing, shotExclusion] as unknown as maplibregl.FilterSpecification)
          : shotExclusion;
        this.map.setFilter(layerId, composed);
      }

      // Build initial GeoJSON for shots
      const shotFeatures: GeoJSON.Feature[] = shotInfos.map(s => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: [s.fromCoord, s.toCoord] },
        properties: s.properties,
      }));

      this.map.addSource(SurveyLayer.STATION_DRAG_SHOT_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: shotFeatures },
      });
      this.map.addLayer({
        id: SurveyLayer.STATION_DRAG_SHOT_LAYER,
        type: 'line',
        source: SurveyLayer.STATION_DRAG_SHOT_SOURCE,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': this.getShotSelectionWidth(),
          'line-opacity': 0.85,
        },
      });

      // Build initial GeoJSON for shot labels
      const shotLabelFeatures: GeoJSON.Feature[] = shotInfos.map(s => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [(s.fromCoord[0] + s.toCoord[0]) / 2, (s.fromCoord[1] + s.toCoord[1]) / 2],
        },
        properties: s.shotLabelProperties,
      }));

      this.map.addSource(SurveyLayer.STATION_DRAG_SHOT_LABEL_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: shotLabelFeatures },
      });
      const shotLabelVis = this.map.getLayoutProperty('survey-shot-labels', 'visibility') ?? 'visible';
      const shotLabelSize = this.map.getLayoutProperty('survey-shot-labels', 'text-size') ?? 11;
      this.map.addLayer({
        id: SurveyLayer.STATION_DRAG_SHOT_LABEL_LAYER,
        type: 'symbol',
        source: SurveyLayer.STATION_DRAG_SHOT_LABEL_SOURCE,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Regular'],
          'text-size': shotLabelSize as number,
          'text-allow-overlap': true,
          'visibility': shotLabelVis as 'visible' | 'none',
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': this.themeColors.textHalo,
          'text-halo-width': 1.5,
          'text-opacity': 0.85,
        },
      });
    }

    this.stationDragShots = shotInfos.length > 0 ? shotInfos : null;

    // 6. Find closure indicator lines with at least one endpoint in the moving set
    type ClosureInfo = NonNullable<typeof this.stationDragClosures>[number];
    const closureInfos: ClosureInfo[] = [];
    if (this.cachedLoopClosures && this.cachedLoopClosures.length > 0) {
      for (const lc of this.cachedLoopClosures) {
        const keyA = `${lc.station_a.section_id}:${lc.station_a.station_index}`;
        const keyB = `${lc.station_b.section_id}:${lc.station_b.station_index}`;
        const aMoving = movingRefKeys.has(keyA);
        const bMoving = movingRefKeys.has(keyB);
        if (!aMoving && !bMoving) continue;

        const stA = stationByKey.get(keyA);
        const stB = stationByKey.get(keyB);
        if (!stA || !stB) continue;

        const fromCoord = metersToMapCoords(
          stA.coordinates.x, stA.coordinates.y, this.gpsOrigin
        ) as [number, number];
        const toCoord = metersToMapCoords(
          stB.coordinates.x, stB.coordinates.y, this.gpsOrigin
        ) as [number, number];

        closureInfos.push({
          properties: {
            stationA: keyA,
            stationB: keyB,
            sectionIdA: lc.station_a.section_id,
            sectionIdB: lc.station_b.section_id,
            errorPercentage: lc.error_percentage,
            misclosureDistance: lc.misclosure_distance,
            pathLength: lc.path_length,
            color: getErrorColor(lc.error_percentage),
          },
          fromCoord,
          toCoord,
          movingEnd: aMoving && bMoving ? 'both' : aMoving ? 'from' : 'to',
        });
      }
    }

    if (closureInfos.length > 0) {
      // Build exclusion filter for closures with ANY endpoint in moving set
      const closureExclusion: maplibregl.FilterSpecification = ['!', ['any',
        ...closureInfos.map(c => ['all',
          ['==', ['get', 'stationA'], c.properties.stationA],
          ['==', ['get', 'stationB'], c.properties.stationB],
        ]),
      ]] as unknown as maplibregl.FilterSpecification;

      const existingClosureFilter = this.map.getFilter(this.loopClosuresLayerId);
      this.dragSavedFilters.set(this.loopClosuresLayerId, existingClosureFilter ?? undefined);
      const composedClosure: maplibregl.FilterSpecification = (existingClosureFilter && typeof existingClosureFilter === 'object')
        ? (['all', existingClosureFilter, closureExclusion] as unknown as maplibregl.FilterSpecification)
        : closureExclusion;
      this.map.setFilter(this.loopClosuresLayerId, composedClosure);

      // Create dynamic GeoJSON source + layer for closure lines
      const closureFeatures: GeoJSON.Feature[] = closureInfos.map(c => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: [c.fromCoord, c.toCoord] },
        properties: c.properties,
      }));

      this.map.addSource(SurveyLayer.STATION_DRAG_CLOSURE_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: closureFeatures },
      });
      this.map.addLayer({
        id: SurveyLayer.STATION_DRAG_CLOSURE_LAYER,
        type: 'line',
        source: SurveyLayer.STATION_DRAG_CLOSURE_SOURCE,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 3,
          'line-opacity': 0.85,
          'line-dasharray': [6, 4],
        },
      });
    }

    this.stationDragClosures = closureInfos.length > 0 ? closureInfos : null;
    this.dragPreviewActive = true;
    return movingStations.map(s => s.station_ref);
  }

  /**
   * Update station drag preview — translates station circles/labels AND
   * rebuilds connected shot geometries so they stretch to follow the cursor.
   * Shot geometry rebuild is cheap (typically 1-5 features).
   */
  updateStationDragPreview(dx: number, dy: number): void {
    if (!this.dragPreviewActive) return;

    // Update station circles + labels via translate (GPU shader uniform)
    const offset: [number, number] = [dx, dy];
    for (const def of SurveyLayer.DRAG_LAYER_DEFS) {
      if (this.map.getLayer(def.tempLayerId)) {
        this.map.setPaintProperty(def.tempLayerId, def.translateProp, offset);
      }
    }

    // Rebuild connected shot geometries
    if (!this.stationDragShots) return;

    const shotFeatures: GeoJSON.Feature[] = [];
    const shotLabelFeatures: GeoJSON.Feature[] = [];

    for (const s of this.stationDragShots) {
      let fromLng = s.fromCoord[0], fromLat = s.fromCoord[1];
      let toLng = s.toCoord[0], toLat = s.toCoord[1];

      if (s.movingEnd === 'from' || s.movingEnd === 'both') {
        const p = this.map.project([fromLng, fromLat]);
        const np = this.map.unproject([p.x + dx, p.y + dy]);
        fromLng = np.lng;
        fromLat = np.lat;
      }
      if (s.movingEnd === 'to' || s.movingEnd === 'both') {
        const p = this.map.project([toLng, toLat]);
        const np = this.map.unproject([p.x + dx, p.y + dy]);
        toLng = np.lng;
        toLat = np.lat;
      }

      shotFeatures.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[fromLng, fromLat], [toLng, toLat]] },
        properties: s.properties,
      });

      shotLabelFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [(fromLng + toLng) / 2, (fromLat + toLat) / 2],
        },
        properties: s.shotLabelProperties,
      });
    }

    const shotSource = this.map.getSource(SurveyLayer.STATION_DRAG_SHOT_SOURCE);
    if (shotSource && 'setData' in shotSource) {
      (shotSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection', features: shotFeatures,
      });
    }
    const shotLabelSource = this.map.getSource(SurveyLayer.STATION_DRAG_SHOT_LABEL_SOURCE);
    if (shotLabelSource && 'setData' in shotLabelSource) {
      (shotLabelSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection', features: shotLabelFeatures,
      });
    }

    // Rebuild closure indicator line geometries
    if (this.stationDragClosures) {
      const closureFeatures: GeoJSON.Feature[] = [];
      for (const c of this.stationDragClosures) {
        let fromLng = c.fromCoord[0], fromLat = c.fromCoord[1];
        let toLng = c.toCoord[0], toLat = c.toCoord[1];

        if (c.movingEnd === 'from' || c.movingEnd === 'both') {
          const p = this.map.project([fromLng, fromLat]);
          const np = this.map.unproject([p.x + dx, p.y + dy]);
          fromLng = np.lng;
          fromLat = np.lat;
        }
        if (c.movingEnd === 'to' || c.movingEnd === 'both') {
          const p = this.map.project([toLng, toLat]);
          const np = this.map.unproject([p.x + dx, p.y + dy]);
          toLng = np.lng;
          toLat = np.lat;
        }

        closureFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[fromLng, fromLat], [toLng, toLat]] },
          properties: c.properties,
        });
      }

      const closureSource = this.map.getSource(SurveyLayer.STATION_DRAG_CLOSURE_SOURCE);
      if (closureSource && 'setData' in closureSource) {
        (closureSource as maplibregl.GeoJSONSource).setData({
          type: 'FeatureCollection', features: closureFeatures,
        });
      }
    }
  }

  /**
   * Update drag preview offset — just updates *-translate paint properties.
   * This is a shader uniform update (essentially free, no GeoJSON rebuild).
   * Guards against missing layers so it works for both full segment drag
   * (5 temp layers) and single station drag (2 temp layers).
   */
  updateDragPreview(dx: number, dy: number): void {
    if (!this.dragPreviewActive) return;
    const offset: [number, number] = [dx, dy];
    for (const def of SurveyLayer.DRAG_LAYER_DEFS) {
      if (this.map.getLayer(def.tempLayerId)) {
        this.map.setPaintProperty(def.tempLayerId, def.translateProp, offset);
      }
    }
    // Update closure drag layer
    if (this.map.getLayer(this.dragClosuresLayerId)) {
      this.map.setPaintProperty(this.dragClosuresLayerId, 'line-translate', offset);
    }
  }

  /**
   * Commit drag preview — removes temp layers but keeps exclusion filters on main
   * layers so connected sections stay hidden. Call this before the backend commit,
   * then call endDragPreview() after React re-renders with new positions.
   * This prevents a blink where features briefly appear at newPosition + dragOffset.
   */
  commitDragPreview(): void {
    if (!this.dragPreviewActive) return;
    for (const def of SurveyLayer.DRAG_LAYER_DEFS) {
      if (this.map.getLayer(def.tempLayerId)) {
        this.map.removeLayer(def.tempLayerId);
      }
    }
    if (this.map.getLayer(this.dragClosuresLayerId)) {
      this.map.removeLayer(this.dragClosuresLayerId);
    }
    // Station drag dynamic layers + sources
    this.removeStationDragLayers();
  }

  /**
   * End drag preview — removes temporary layers (if still present) and restores
   * original filters so connected sections are visible again.
   */
  endDragPreview(): void {
    if (!this.dragPreviewActive) return;

    for (const def of SurveyLayer.DRAG_LAYER_DEFS) {
      // Remove temp layer if commitDragPreview wasn't called first
      if (this.map.getLayer(def.tempLayerId)) {
        this.map.removeLayer(def.tempLayerId);
      }

      // Restore original filter on main layer — only if we saved one
      // (station drag only modifies 2 of 5 layers)
      if (this.dragSavedFilters.has(def.mainLayerId)) {
        const saved = this.dragSavedFilters.get(def.mainLayerId);
        this.map.setFilter(def.mainLayerId, saved ?? null);
      }
    }

    // Remove closure temp layer and restore filter
    if (this.map.getLayer(this.dragClosuresLayerId)) {
      this.map.removeLayer(this.dragClosuresLayerId);
    }
    if (this.dragSavedFilters.has(this.loopClosuresLayerId)) {
      const savedClosureFilter = this.dragSavedFilters.get(this.loopClosuresLayerId);
      this.map.setFilter(this.loopClosuresLayerId, savedClosureFilter ?? null);
    }

    // Station drag dynamic layers + sources
    this.removeStationDragLayers();

    // Restore shot/shot-label filters if saved (station drag modifies these)
    for (const layerId of ['survey-shots', 'survey-shot-labels']) {
      if (this.dragSavedFilters.has(layerId)) {
        const saved = this.dragSavedFilters.get(layerId);
        this.map.setFilter(layerId, saved ?? null);
      }
    }

    this.stationDragShots = null;
    this.stationDragClosures = null;
    this.dragSavedFilters.clear();
    this.dragPreviewActive = false;
  }

  /** Remove station drag dynamic layers and sources (idempotent). */
  private removeStationDragLayers(): void {
    for (const layerId of [
      SurveyLayer.STATION_DRAG_SHOT_LAYER,
      SurveyLayer.STATION_DRAG_SHOT_LABEL_LAYER,
      SurveyLayer.STATION_DRAG_CLOSURE_LAYER,
    ]) {
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    }
    for (const sourceId of [
      SurveyLayer.STATION_DRAG_SHOT_SOURCE,
      SurveyLayer.STATION_DRAG_SHOT_LABEL_SOURCE,
      SurveyLayer.STATION_DRAG_CLOSURE_SOURCE,
    ]) {
      if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
    }
  }

  /**
   * Set ghost section data for merge preview visualization.
   * Pass null to clear the ghost section.
   */
  setGhostSection(data: GhostSectionData | null) {
    const { shotFeatures, stationFeatures, mergeStationFeatures } = buildGhostFeatures(
      data,
      this.gpsOrigin
    );

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
        features: mergeStationFeatures,
      });
    }
  }

  update(
    sections: Section[],
    stations: Station[],
    loopClosures?: LoopClosure[],
    gpsOrigin?: GpsOrigin | null,
    showDepthGradient: boolean = false,
    depthRange: DepthRange = { min: 0, max: 50 }
  ) {
    // Store gpsOrigin for coordinate transforms
    this.gpsOrigin = gpsOrigin ?? null;
    // Store depth mode parameters for use in feature color calculation
    this.showDepthGradient = showDepthGradient;
    this.depthRange = normalizeDepthRange(depthRange);

    // Cache input data for feature rebuild on theme change
    this.cachedSections = sections;
    this.cachedStations = stations;
    this.cachedLoopClosures = loopClosures;

    const {
      shotFeatures,
      shotLabelFeatures,
      stationFeatures,
      sectionLabelFeatures,
      stationLabelFeatures,
      loopClosureFeatures,
    } = buildSurveyFeatures(
      sections,
      stations,
      loopClosures,
      this.gpsOrigin,
      this.showDepthGradient,
      this.depthRange,
      this.themeColors
    );

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

    const loopClosuresSource = this.map.getSource(this.sourceId + '-loop-closures');
    if (loopClosuresSource && 'setData' in loopClosuresSource) {
      (loopClosuresSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: loopClosureFeatures,
      });
    }

    // setData() clears all feature-state — reset tracking and re-apply
    // Guard: only re-apply if map style is still live (avoids crash during teardown)
    if (!hasLiveStyle(this.map)) return;
    this.prevHoveredStationFeatureId = null;
    this.prevHoveredShotFeatureId = null;
    this.prevSelectedStationFeatureId = null;
    this.prevSelectedShotFeatureId = null;
    this.prevHoveredSectionShotIds = new Set();
    this.prevHoveredSectionStationIds = new Set();
    this.prevSelectedSectionShotIds = new Set();
    this.prevSelectedSectionStationIds = new Set();
    this.invalidateSectionCaches();
    this.updateVisualState();

    // Fire one-shot callback (used by drag commit to restore filters in the same
    // synchronous block as setData, ensuring no paint gap between them).
    if (this.onNextUpdateCallback) {
      const cb = this.onNextUpdateCallback;
      this.onNextUpdateCallback = null;
      cb();
    }
  }

  /**
   * Register a one-shot callback to run at the end of the next update() call,
   * after all setData() calls have completed. Used to restore drag preview filters
   * in the same synchronous block as the data update (no paint gap).
   */
  onNextUpdate(callback: () => void): void {
    this.onNextUpdateCallback = callback;
  }

  /**
   * Apply new theme colors to all MapLibre paint/layout properties
   * AND rebuild features (because buildSurveyFeatures embeds theme colors in GeoJSON properties).
   * Called from MapCanvas when resolvedTheme changes.
   */
  applyThemeColors(colors: MapThemeColors): void {
    this.themeColors = colors;

    if (!hasLiveStyle(this.map)) return;

    // Update paint properties that use constant theme colors
    // Section label halo
    if (this.map.getLayer(this.labelsLayerId)) {
      this.map.setPaintProperty(this.labelsLayerId, 'text-halo-color', colors.textHalo);
    }
    // Shot label halo
    if (this.map.getLayer(this.shotLabelsLayerId)) {
      this.map.setPaintProperty(this.shotLabelsLayerId, 'text-halo-color', colors.textHaloAlt);
    }
    // Station label halo
    if (this.map.getLayer(this.stationLabelsLayerId)) {
      this.map.setPaintProperty(this.stationLabelsLayerId, 'text-halo-color', colors.textHaloAlt);
    }
    // Ghost station stroke
    if (this.map.getLayer(this.ghostStationsLayerId)) {
      this.map.setPaintProperty(this.ghostStationsLayerId, 'circle-stroke-color', colors.strokeColor);
    }
    // Ghost merge station
    if (this.map.getLayer(this.ghostMergeLayerId)) {
      this.map.setPaintProperty(this.ghostMergeLayerId, 'circle-color', colors.selectHighlight);
      this.map.setPaintProperty(this.ghostMergeLayerId, 'circle-stroke-color', colors.strokeColor);
    }
    // Station highlight (snap color)
    if (this.map.getLayer(this.stationsHighlightLayerId)) {
      this.map.setPaintProperty(this.stationsHighlightLayerId, 'circle-color', colors.snapColor);
      this.map.setPaintProperty(this.stationsHighlightLayerId, 'circle-stroke-color', colors.snapColor);
    }
    // Station stroke-color expression (hover/selected colors)
    if (this.map.getLayer(this.stationsLayerId)) {
      this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-color', [
        'case',
        ['boolean', ['feature-state', 'hover'], false], colors.hoverHighlight,
        ['boolean', ['feature-state', 'selected'], false], colors.selectHighlight,
        ['get', 'strokeColor'],
      ]);
    }

    // Rebuild features with new theme colors (colors are embedded in GeoJSON properties)
    if (this.cachedSections.length > 0 || this.cachedStations.length > 0) {
      this.update(
        this.cachedSections,
        this.cachedStations,
        this.cachedLoopClosures,
        this.gpsOrigin,
        this.showDepthGradient,
        this.depthRange
      );
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
