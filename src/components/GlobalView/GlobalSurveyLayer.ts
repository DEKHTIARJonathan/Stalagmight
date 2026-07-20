import type { Map as MaplibreMap } from 'maplibre-gl';
import type maplibregl from 'maplibre-gl';
import { extractSystemStations } from './customRender/globalTessellate';
import { GlobalCustomController } from './customRender/globalController';
import { generateSystemColor, type SystemGeometry } from './systemColor';
import { getMapThemeColors, type MapThemeColors } from '../../utils/themeColors';
import { recordFeatureCount, clearFeatureCountsForPrefix } from '../../utils/memoryProbe';
import {
  ensureVtProtocol,
  setVtLayerData,
  vtTileUrl,
  clearVtLayerData,
} from '../Map/surveyLayer/vectorTileRegistry';
import {
  vtLinesFromFeatures,
  vtPointsFromFeatures,
  vtGroupCount,
  VT_SOURCE_LAYER,
  type VtLayerData,
} from '../Map/surveyLayer/vectorTileData';
import { hasLiveStyle } from '../Map/mapUtils';
import i18n from '../../i18n';
import { formatFixed, formatNumber } from '../../i18n/format';
import type { DecimalPrecision } from '../../types/config';

// `SystemGeometry` + `generateSystemColor` moved to ./systemColor so the custom
// render buffer builder can reuse them without importing this MapLibre-bound
// layer (import-cycle avoidance). Re-exported here so existing consumers keep
// importing them from './GlobalSurveyLayer'.
export { generateSystemColor } from './systemColor';
export type { SystemGeometry } from './systemColor';

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

/** Shot LineStrings + station Points, split so each feeds its own vt source. */
export interface GlobalSurveyFeatures {
  shots: GeoJSON.Feature[];
  stations: GeoJSON.Feature[];
}

/**
 * Materialize per-system shot LineStrings + station Points, split by kind so
 * each set feeds its own homogeneous vector-tile source (#mem). Per-feature
 * props are identical to the old single-source features: the systemId-keyed
 * color/opacity/visual match expressions and the queryRenderedFeatures
 * handlers read only these scalar props (never feature.id), so they survive
 * the MVT round-trip (props become MVT tags) unchanged. `featureType` is kept
 * for parity even though each source is now homogeneous.
 */
export function buildGlobalSurveyFeatures(systems: SystemGeometry[]): GlobalSurveyFeatures {
  const shots: GeoJSON.Feature[] = [];
  const stations: GeoJSON.Feature[] = [];
  for (const system of systems) {
    for (const shot of system.geometry.shots) {
      shots.push({
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
          isReference: shot.is_reference,
        },
      });
    }

    const systemStations = extractSystemStations(system.geometry.shots);
    for (const [lng, lat, allShotsReference] of systemStations) {
      stations.push({
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
          allShotsReference,
        },
      });
    }
  }
  return { shots, stations };
}

/** Scalar tooltip fields carried by a resolved hit (name + length + station count). */
interface TooltipProps {
  name?: string | undefined;
  totalLength?: number | undefined;
  stationCount?: number | undefined;
}

/** Normalize a MapLibre `PointLike` (Point or `[x, y]`) to plain `{x, y}` for
 *  the geometry hit index. */
function pointLikeToXY(point: maplibregl.PointLike): { x: number; y: number } {
  if (Array.isArray(point)) return { x: point[0], y: point[1] };
  return { x: point.x, y: point.y };
}

/**
 * GlobalSurveyLayer renders survey geometry for multiple systems on the global map.
 *
 * This is a read-only visualization layer that shows shots as lines and stations
 * as circles. Each system has a distinct, stable color derived from its file path.
 *
 * Layer architecture (#mem):
 * - Two on-demand vector-tile sources served by the shared `stalx://`
 *   machinery: `global-survey-data-shots` (line geometry) and
 *   `global-survey-data-stations` (point geometry). This replaces the last
 *   bulk-GeoJSON map source; MapLibre only ever holds the compact MVT bytes
 *   for currently-loaded tiles instead of the whole cross-project graph.
 * - Each source is homogeneous, so layers no longer need a featureType filter
 *   (the reference-shot exclusion filter is still applied dynamically).
 * - Shot lines layer (rendered first, below stations)
 * - Station circles layer (rendered second, above shots)
 * - Hitbox layers for click detection (invisible)
 *
 * Highlighting uses filter/match expressions on the string `systemId` property
 * (not setFeatureState). MVT preserves feature properties as tags, so those
 * expressions and the queryRenderedFeatures handlers keep working unchanged.
 */
export default class GlobalSurveyLayer {
  private map: MaplibreMap;
  private callbacks: GlobalSurveyLayerCallbacks;

  // Two vector-tile sources: homogeneous line shots + point stations. The
  // distinct `global-survey-data-` prefix avoids collision with SurveyLayer's
  // `survey-data-` registry keys (the shared registry is module-level, and the
  // two layers never live at once anyway).
  private shotsSourceId = 'global-survey-data-shots';
  private stationsSourceId = 'global-survey-data-stations';

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

  // We keep no copy of the inputs here: globalViewStore.geometryData remains
  // the single retained copy of inputs, and the two vt sources hold the only
  // layer-owned derived copies (the compact typed-array payloads in the shared
  // registry). The old `cachedSystems` field existed only to rebuild features
  // on a tolerance swap; that mechanism is gone (#mem), so the field is too.

  // Tooltip element
  private tooltip: HTMLDivElement | null = null;

  // Track if context menu is open (suppress tooltip while open)
  private contextMenuOpen = false;

  // Theme colors for MapLibre paint properties
  // Seeded at construction so first paint uses current theme, not legacy fallbacks
  private themeColors: MapThemeColors = getMapThemeColors();

  // Precision settings for formatting
  private precision: DecimalPrecision | undefined;

  // Flag-gated custom WebGL render (#customRender). No-op unless the shared
  // `stalagmight_custom_render` gate is on. When active it draws the whole
  // global survey from typed-array buffers, hides the stock shots/stations
  // layers, and resolves interaction hits from the geometry index; the stock
  // vector-tile publish below is suppressed (see onCustomActiveChange).
  private customRender: GlobalCustomController | null = null;
  /** True while the custom layer draws (stock bulk vt publish suppressed). */
  private customBulkSuppressed = false;
  /** Last systems fed to update(), so a gate-off restore can republish stock. */
  private lastSystems: SystemGeometry[] | null = null;
  /** Monotonic tile-URL version to force a dropped bulk source to serve empty. */
  private bulkDropSeq = 1_000_000_000;

  // Bound event handlers for cleanup
  private boundMouseMove: ((e: maplibregl.MapMouseEvent) => void) | null = null;
  private boundMapLeave: (() => void) | null = null;
  private boundClick: ((e: maplibregl.MapMouseEvent) => void) | null = null;
  private boundDoubleClick: ((e: maplibregl.MapMouseEvent) => void) | null = null;
  private boundContextMenu: ((e: MouseEvent) => void) | null = null;

  // Touch long-press state for context menu
  private touchLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  private touchStartPos: { x: number; y: number } | null = null;
  private boundTouchStart: ((e: TouchEvent) => void) | null = null;
  private boundTouchMove: ((e: TouchEvent) => void) | null = null;
  private boundTouchEnd: ((e: TouchEvent) => void) | null = null;

  constructor(map: MaplibreMap, callbacks: GlobalSurveyLayerCallbacks = {}) {
    this.map = map;
    this.callbacks = callbacks;
    this.initializeSources();
    this.initializeLayers();
    this.initializeEventHandlers();
    this.initializeTooltip();
    this.customRender = new GlobalCustomController(map, undefined, {
      onActiveChange: (active) => this.onCustomActiveChange(active),
    });
  }

  /**
   * Update the callbacks (e.g., when props change).
   */
  setCallbacks(callbacks: GlobalSurveyLayerCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Update precision settings for formatting.
   */
  setPrecision(precision: DecimalPrecision): void {
    this.precision = precision;
  }

  private initializeSources(): void {
    // Bulk geometry is served as on-demand vector tiles via `stalx://` (#mem),
    // mirroring SurveyLayer: two homogeneous vt sources (line shots + point
    // stations) replace the single bulk-GeoJSON source. Registry keys are the
    // two source ids; the update recipe registers a VtLayerData and bumps the
    // tile version so MapLibre reloads tiles. Feature props survive as MVT
    // tags, so the systemId-based color/opacity/visual expressions and the
    // queryRenderedFeatures handlers keep working. Feature ids are unused here
    // (highlighting is filter/match-based), so no promoteId is needed.
    ensureVtProtocol();
    const vtSourceSpec = (key: string): maplibregl.VectorSourceSpecification => ({
      type: 'vector',
      tiles: [vtTileUrl(key, 0)],
      minzoom: 0,
      maxzoom: 22,
    });
    this.map.addSource(this.shotsSourceId, vtSourceSpec(this.shotsSourceId));
    this.map.addSource(this.stationsSourceId, vtSourceSpec(this.stationsSourceId));
  }

  private initializeLayers(): void {
    // === HITBOX LAYERS (invisible, for click detection) ===
    // Layer order: shots hitbox -> stations hitbox -> shots visual -> stations visual

    // Shot hitbox layer - wider hit area for easier selection
    // CRITICAL: Use opaque color with tiny opacity for queryRenderedFeatures
    // Homogeneous shots source -> no featureType filter needed.
    this.map.addLayer({
      id: this.shotsHitboxLayerId,
      type: 'line',
      source: this.shotsSourceId,
      'source-layer': VT_SOURCE_LAYER,
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
      source: this.stationsSourceId,
      'source-layer': VT_SOURCE_LAYER,
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
      source: this.shotsSourceId,
      'source-layer': VT_SOURCE_LAYER,
      paint: {
        'line-color': this.themeColors.grayLine, // Fallback, replaced by match expression on update()
        'line-width': [
          'case',
          ['boolean', ['get', 'isReference'], false],
          1,
          2,
        ],
        'line-opacity': [
          'case',
          ['boolean', ['get', 'isReference'], false],
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
      source: this.stationsSourceId,
      'source-layer': VT_SOURCE_LAYER,
      paint: {
        'circle-radius': 4,
        'circle-color': this.themeColors.grayLine, // Fallback, replaced by match expression on update()
        'circle-stroke-width': 1,
        'circle-stroke-color': this.themeColors.strokeColor,
      },
    });
  }

  /**
   * Resolve the system under a screen point (station priority, then shot). When
   * the custom WebGL layer is active it asks the geometry hit index (the stock
   * hitbox layers have no vector-tile data then); otherwise it falls back to the
   * stock `queryRenderedFeatures` on the invisible hitbox layers. Returns the
   * systemId plus the tooltip scalars, or null for empty space.
   */
  private pickSystemAt(point: maplibregl.PointLike): { systemId: string; properties: TooltipProps } | null {
    if (this.customRender?.isActive()) {
      const xy = pointLikeToXY(point);
      const hit = this.customRender.pick((c) => this.map.project(c), xy.x, xy.y);
      if (!hit) return null;
      const meta = this.customRender.getSystemMetadata(hit.systemId);
      return {
        systemId: hit.systemId,
        properties: {
          name: meta?.name,
          totalLength: meta?.total_length ?? undefined,
          stationCount: meta?.station_count ?? undefined,
        },
      };
    }
    // Stock path: query both hitbox layers, stations first.
    const feature =
      this.map.queryRenderedFeatures(point, { layers: [this.stationsHitboxLayerId] })[0] ??
      this.map.queryRenderedFeatures(point, { layers: [this.shotsHitboxLayerId] })[0];
    const systemId = feature?.properties?.systemId as string | undefined;
    if (!systemId) return null;
    return { systemId, properties: (feature?.properties ?? {}) as TooltipProps };
  }

  private initializeEventHandlers(): void {
    // Unified click handler - passes ctrlKey for multi-select
    this.boundClick = (e: maplibregl.MapMouseEvent) => {
      const hit = this.pickSystemAt(e.point);
      if (hit) {
        const ctrlKey = e.originalEvent.ctrlKey || e.originalEvent.metaKey;
        this.callbacks.onSystemClick?.(hit.systemId, e, ctrlKey);
      }
    };
    this.map.on('click', this.boundClick);

    // Double-click handler to open project
    this.boundDoubleClick = (e: maplibregl.MapMouseEvent) => {
      const hit = this.pickSystemAt(e.point);
      if (hit) this.callbacks.onSystemDoubleClick?.(hit.systemId);
    };
    this.map.on('dblclick', this.boundDoubleClick);

    // Unified mousemove handler for hover detection and tooltip
    this.boundMouseMove = (e: maplibregl.MapMouseEvent) => {
      const hit = this.pickSystemAt(e.point);
      const newHoveredSystemId = hit?.systemId ?? null;

      // Update tooltip position and content
      this.updateTooltip(newHoveredSystemId ? e.originalEvent : null, hit?.properties ?? null);

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
        // Custom layer: hover is a cheap uniform update; stock: paint expressions.
        if (this.customRender?.isActive()) this.customRender.setHover(newHoveredSystemId);
        else this.updateVisualState();
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
        if (this.customRender?.isActive()) this.customRender.setHover(null);
        else this.updateVisualState();
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
      const hit = this.pickSystemAt(point);
      if (hit) {
        // Prevent default browser context menu when we handle the event
        e.preventDefault();
        // Hide tooltip while context menu is open
        this.contextMenuOpen = true;
        this.hideTooltip();
        this.callbacks.onSystemContextMenu(hit.systemId, e);
      }
    };
    this.map.getCanvas().addEventListener('contextmenu', this.boundContextMenu);

    // Touch long-press → context menu
    const canvas = this.map.getCanvas();
    this.boundTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0]!;
      this.touchStartPos = { x: touch.clientX, y: touch.clientY };
      this.touchLongPressTimer = setTimeout(() => {
        this.touchLongPressTimer = null;
        if (!this.touchStartPos || !this.callbacks.onSystemContextMenu) return;
        const rect = canvas.getBoundingClientRect();
        const point: [number, number] = [
          this.touchStartPos.x - rect.left,
          this.touchStartPos.y - rect.top,
        ];
        // Resolve the system at the touch position (custom hit index or stock).
        const hit = this.pickSystemAt(point);
        if (hit) {
          this.contextMenuOpen = true;
          this.hideTooltip();
          const fakeEvent = new MouseEvent('contextmenu', {
            clientX: this.touchStartPos.x,
            clientY: this.touchStartPos.y,
          });
          this.callbacks.onSystemContextMenu(hit.systemId, fakeEvent);
        }
        this.touchStartPos = null;
      }, 500);
    };
    this.boundTouchMove = (e: TouchEvent) => {
      if (!this.touchStartPos || !this.touchLongPressTimer) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dx = touch.clientX - this.touchStartPos.x;
      const dy = touch.clientY - this.touchStartPos.y;
      if (dx * dx + dy * dy > 100) {
        clearTimeout(this.touchLongPressTimer);
        this.touchLongPressTimer = null;
        this.touchStartPos = null;
      }
    };
    this.boundTouchEnd = () => {
      if (this.touchLongPressTimer) {
        clearTimeout(this.touchLongPressTimer);
        this.touchLongPressTimer = null;
      }
      this.touchStartPos = null;
    };
    canvas.addEventListener('touchstart', this.boundTouchStart, { passive: false });
    canvas.addEventListener('touchmove', this.boundTouchMove, { passive: false });
    canvas.addEventListener('touchend', this.boundTouchEnd);
    canvas.addEventListener('touchcancel', this.boundTouchEnd);
  }

  /**
   * Update the layer with new system geometry data.
   */
  update(systems: SystemGeometry[]): void {
    // We keep no copy of `systems` or of the materialized features: the vt
    // registry owns the compact typed-array payloads and MapLibre holds only
    // the per-tile MVT bytes, so an extra retained copy here would just double
    // per-shot retention on dense maps.

    this.lastSystems = systems;

    // Clear and rebuild system colors
    this.systemColors.clear();
    for (const system of systems) {
      this.systemColors.set(system.metadata.file_path, generateSystemColor(system.metadata.file_path));
    }

    // Feed the custom renderer (reads the shared gate). When it takes over it
    // hides the stock layers and we skip the stock vector-tile publish entirely
    // (its onActiveChange already dropped the stock sources) — the custom layer
    // draws every system, and interaction resolves from its geometry index.
    this.customRender?.sync(systems);
    if (this.customRender?.isActive()) {
      // Re-resolve hover against the freshly rebuilt system-index map (selection
      // is baked into the rebuilt buffers by sync()).
      this.customRender.setHover(this.hoveredSystemId);
      return;
    }

    this.publishStockGeometry(systems);
  }

  /**
   * Stock vector-tile publish path (the pre-custom-render behavior). Split from
   * update() so onCustomActiveChange can re-run it verbatim when the custom
   * layer goes away (gate off / fail-safe), restoring the stock pipeline.
   */
  private publishStockGeometry(systems: SystemGeometry[]): void {
    // Split into homogeneous shot/station sets, convert to flat vt payloads,
    // and publish each to its own vector-tile source (#mem).
    const { shots, stations } = buildGlobalSurveyFeatures(systems);
    const shotsVt = vtLinesFromFeatures(shots);
    const stationsVt = vtPointsFromFeatures(stations);
    this.setVtSource(this.shotsSourceId, shotsVt);
    this.setVtSource(this.stationsSourceId, stationsVt);
    // Record the combined group count under the existing 'global-survey' kind.
    recordFeatureCount('global-survey', vtGroupCount(shotsVt) + vtGroupCount(stationsVt));

    // Update color expressions using match on systemId
    this.updateColorExpressions();

    // Reapply hover/selection styling in case selection existed before data loaded
    this.updateVisualState();
  }

  /**
   * The custom layer's drawing state flipped (#customRender). ON: drop the stock
   * shots/stations vt payloads it replaces so they stop holding registry + tile
   * caches. OFF (gate flip / fail-safe self-disable): re-publish the stock
   * pipeline from the last systems so the stock survey comes back completely.
   */
  private onCustomActiveChange(active: boolean): void {
    if (active === this.customBulkSuppressed) return;
    this.customBulkSuppressed = active;
    if (!hasLiveStyle(this.map)) return;
    if (active) {
      this.dropStockSource(this.shotsSourceId);
      this.dropStockSource(this.stationsSourceId);
      recordFeatureCount('global-survey', 0);
    } else if (this.lastSystems) {
      this.publishStockGeometry(this.lastSystems);
    }
  }

  /** Drop a stock source's registry payload and force resident tiles to refetch
   *  as empty (mirrors SurveyLayer.dropBulkSource). */
  private dropStockSource(key: string): void {
    clearVtLayerData(key);
    const source = this.map.getSource(key) as { setTiles?: (tiles: string[]) => void } | undefined;
    source?.setTiles?.([vtTileUrl(key, this.bulkDropSeq++)]);
  }

  /**
   * Register a layer's flat vt payload and point its source at the new tile
   * version so MapLibre reloads tiles (mirrors SurveyLayer's update recipe).
   */
  private setVtSource(key: string, data: VtLayerData): void {
    const { version } = setVtLayerData(key, data);
    const source = this.map.getSource(key) as { setTiles?: (tiles: string[]) => void } | undefined;
    source?.setTiles?.([vtTileUrl(key, version)]);
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
    // Always mirror to the controller so its baked selection stays current even
    // while inactive (a later gate-on rebuild bakes the right selection); the
    // re-upload only happens when active.
    this.customRender?.setSelected(this.selectedSystemIds);
    if (!this.customRender?.isActive()) this.updateVisualState();
  }

  /**
   * Set filter to hide reference shots (or show all).
   * Applies to both visual and hitbox layers to prevent hidden shots from being clickable.
   * Also hides stations that only connect to reference shots.
   */
  setShowReferenceShots(visible: boolean): void {
    // Mirror to the custom layer (shader uniform) + the hit index gating.
    this.customRender?.setReferenceShotsVisible(visible);
    // Each source is homogeneous now, so no featureType clause is needed:
    // `null` clears the filter (show all shots), otherwise exclude reference.
    const shotFilter: maplibregl.FilterSpecification | null = visible
      ? null
      : ['!=', ['get', 'isReference'], true];

    // Apply filter to visual layer
    if (this.map.getLayer(this.shotsLayerId)) {
      this.map.setFilter(this.shotsLayerId, shotFilter);
    }

    // Also apply to hitbox layer to prevent hidden shots from being clickable
    if (this.map.getLayer(this.shotsHitboxLayerId)) {
      this.map.setFilter(this.shotsHitboxLayerId, shotFilter);
    }

    // Station filter: hide reference-only stations when reference shots are hidden
    const stationFilter: maplibregl.FilterSpecification | null = visible
      ? null
      : ['!=', ['get', 'allShotsReference'], true];

    if (this.map.getLayer(this.stationsLayerId)) {
      this.map.setFilter(this.stationsLayerId, stationFilter);
    }
    if (this.map.getLayer(this.stationsHitboxLayerId)) {
      this.map.setFilter(this.stationsHitboxLayerId, stationFilter);
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
    // Mirror to the custom layer (per-vertex dim re-upload when active; stores
    // the term for a later gate-on rebuild otherwise).
    this.customRender?.setSearch(term);
    this.updateOpacityExpressions();
  }

  /**
   * Set visibility of all survey layers (shots and stations).
   * Used by view mode toggle to switch between survey and markers-only view.
   *
   * @param visible - Whether survey layers should be visible
   */
  setVisible(visible: boolean): void {
    // Mirror to the custom layer (whole-survey draw toggle + hit gating).
    this.customRender?.setVisible(visible);
    // While the custom layer is active the stock layers stay hidden (the
    // controller owns their visibility); do not un-hide them here.
    if (this.customRender?.isActive()) return;

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

  // The GeoJSON `tolerance`-swap mechanism (and its FPS-driven throttle in
  // GlobalViewMap) was removed here (#mem): the `stalx://` tile cutter does
  // bbox-clip only, with no whole-source simplification, so `tolerance` has no
  // vector-tile equivalent. Vector tiles already bound the rendered geometry to
  // the currently-visible tiles, which supersedes whole-source simplification.

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
      // No search filter - shots use default opacity (reference shots dimmed)
      shotsOpacity = [
        'case',
        ['boolean', ['get', 'isReference'], false],
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

      // Shots: full opacity if match (with reference dimming), 25% if no match
      shotsOpacity = [
        'case',
        matchExpr,
        ['case', ['boolean', ['get', 'isReference'], false], 0.5, 1],
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
      // Reference shots: thin
      ['boolean', ['get', 'isReference'], false],
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

    // Mirror the station stroke color into the custom layer (shader uniform).
    this.customRender?.setStrokeColor(colors.strokeColor);

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
    properties: TooltipProps | null
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
    const lengthPrec = this.precision?.length ?? 1;
    let lengthStr: string;
    if (length >= 1000) {
      lengthStr = `${formatFixed(length / 1000, undefined, lengthPrec)} ${i18n.t('common.units.kilometers')}`;
    } else {
      lengthStr = `${formatFixed(length, undefined, lengthPrec)} ${i18n.t('common.units.meters')}`;
    }

    // Build tooltip content using textContent to avoid XSS
    const name = properties.name ?? i18n.t('globalView.tooltip.unknown');
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
    lengthDiv.textContent = i18n.t('globalView.tooltip.length', { length: lengthStr });
    this.tooltip.appendChild(lengthDiv);

    // Station count row
    const stationDiv = document.createElement('div');
    stationDiv.style.color = grayText;
    stationDiv.textContent = i18n.t('globalView.tooltip.stations', {
      count: stationCount,
      countFormatted: formatNumber(stationCount),
    });
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
    // Tear down the custom layer (removes it + restores stock visibility) so it
    // never outlives Global View (#customRender).
    this.customRender?.destroy();
    this.customRender = null;

    // Zero memory-probe count for our source so the panel reflects teardown.
    clearFeatureCountsForPrefix('global-survey');

    // Drop the vt registry entries so the flat geometry arrays don't outlive
    // the layer in the shared registry when leaving Global View (#mem).
    clearVtLayerData(this.shotsSourceId);
    clearVtLayerData(this.stationsSourceId);

    // Clean up touch long-press timer
    if (this.touchLongPressTimer) {
      clearTimeout(this.touchLongPressTimer);
      this.touchLongPressTimer = null;
    }

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
    // Remove touch listeners
    const canvas = this.map.getCanvas();
    if (this.boundTouchStart) {
      canvas.removeEventListener('touchstart', this.boundTouchStart);
    }
    if (this.boundTouchMove) {
      canvas.removeEventListener('touchmove', this.boundTouchMove);
    }
    if (this.boundTouchEnd) {
      canvas.removeEventListener('touchend', this.boundTouchEnd);
      canvas.removeEventListener('touchcancel', this.boundTouchEnd);
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

      // Remove both vector-tile sources
      if (this.map.getSource(this.shotsSourceId)) {
        this.map.removeSource(this.shotsSourceId);
      }
      if (this.map.getSource(this.stationsSourceId)) {
        this.map.removeSource(this.stationsSourceId);
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
    this.boundTouchStart = null;
    this.boundTouchMove = null;
    this.boundTouchEnd = null;
  }
}
