import type { Map as MaplibreMap, MapMouseEvent, ExpressionSpecification, VectorTileSource } from 'maplibre-gl';
import type maplibregl from 'maplibre-gl';
import type {
  LoopClosure,
  Section,
  SectionId,
  ShotId,
  Station,
  StationRef,
} from '../../types/project';
import type { Config, GpsOrigin, DecimalPrecision } from '../../types/config';
import type { RouteLeg } from '../../types/ipc.generated';
import { isNonInteractiveTool } from '../../utils/toolUtils';
import type { ToolType } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { selectActiveSurveyData } from '../../store/geometrySelectors';
import { surveyDataFromLegacy } from '../../types/survey-data';
import { hasLiveStyle } from './mapUtils';
import {
  buildGhostFeatures,
  buildSurveyFeatures,
  normalizeDepthRange,
  resolveShotDisplayColor,
  resolveStationDisplayColor,
  SURVEY_FEATURE_GROUP_ORDER,
  type DepthRange,
  type DisplayColorContext,
  type GhostSectionData,
  type SurveyFeatureGroupKey,
} from './surveyLayer/features';
import { SurveyGeometryIndex } from './surveyLayer/geometryIndex';
import {
  offsetOverlayPoint,
  offsetOverlayShot,
  type DragPreviewFeature,
  type DragPreviewSet,
  type MovingEnd,
  type Projector,
} from './surveyLayer/dragPreviewSource';
import { DRAG_PREVIEW_SOURCE, type DragPreviewLayerCtx } from './surveyLayer/dragPreviewLayers';
import { DragGhostController } from './surveyLayer/dragGhostController';
import type { GhostRenderData } from './surveyLayer/customRender/surveyGhostLayer';
import { buildGhostRenderData } from './surveyLayer/dragGhostData';
import { padProbeBox, type ProbeGeometry } from './surveyLayer/hitProbe';
import { computeIssueSeverity, type IssueSeverity } from './surveyLayer/severity';
import { dimmedZoomOpacity } from './surveyLayer/opacityExpressions';
import { decideLabelBuild, skippedBuildForCamera } from './surveyLayer/labelBuildDecision';
import { SurveyCustomController, type CustomRenderExclusion } from './surveyLayer/customRender/controller';
import { SurveyLabelController } from './surveyLayer/customRender/labelController';
import { overlayInputFrom } from './surveyLayer/customRender/overlayColor';
import type { SurveyData } from '../../types/survey-data';
import type { ProjectWarning } from '../../types/commands';
import { getMapThemeColors, type MapThemeColors } from '../../utils/themeColors';
import {
  distanceColorExpression,
  DISTANCE_NEAR,
  DISTANCE_FAR,
  type DistanceFeatureState,
} from '../../utils/distanceGradient';
import {
  gasReachColorExpression,
  GAS_NEAR,
  GAS_FAR,
  type GasReachFeatureState,
} from '../../utils/gasReach';
import { metersToMapCoords } from '../../utils/coordinates';
import { getErrorColor } from '../../utils/colors';
import { trackNav } from '../../utils/telemetry';
import { FEATURE_ID_STRIDE } from '../../utils/ids';
import { MEASURE_TINT } from '../../utils/measurePath';
import { recordFeatureCount, clearFeatureCountsForPrefix, recordPerfTiming } from '../../utils/memoryProbe';
import { buildSurveyFeaturesStreamed, buildGranularitySwapStreamed } from './surveyLayer/featuresWorkerClient';
import { ensureVtProtocol, setVtLayerData, vtTileUrl, clearVtLayerData, reloadVtSource, shouldSuppressMapError, type MapErrorEventLike } from './surveyLayer/vectorTileRegistry';
import {
  LABEL_VT_GROUPS,
  partitionDragFilters,
  diffRemovedSectionIds,
  LabelRestoreController,
} from './surveyLayer/labelRestore';
import {
  InteractOverlayHideController,
  overlayTouchesRemovedSections,
} from './surveyLayer/interactOverlayHide';
import {
  vtLinesFromFeatures,
  vtPointsFromFeatures,
  vtGroupCount,
  VT_SOURCE_LAYER,
  type VtFeatureChunk,
  type VtLayerData,
} from './surveyLayer/vectorTileData';
// Note: buildPriorityExpression, compositeIdEquals, inSection no longer needed
// after switching to setFeatureState for hover/selection highlighting

/**
 * Build a MapLibre `match` expression that maps a numeric palette index
 * (`indexInput`, e.g. `['get', 'colorIndex']`) to its color string. Shot /
 * gradient / station features carry the index instead of the color, so the
 * per-feature payload is a small integer and the exact color is reproduced by
 * this literal lookup (#B). With an empty palette (no features yet) it returns a
 * constant color so the paint value stays valid.
 */
function paletteMatchExpression(
  indexInput: ExpressionSpecification,
  palette: string[],
): ExpressionSpecification | string {
  if (palette.length === 0) return '#000000';
  // ['match', input, 0, palette[0], 1, palette[1], …, fallback]
  const expr: unknown[] = ['match', indexInput];
  for (let i = 0; i < palette.length; i++) {
    expr.push(i, palette[i]);
  }
  // Fallback is unreachable (indices are always in range) but `match` requires it.
  expr.push(palette[0]);
  return expr as unknown as ExpressionSpecification;
}

/** Comment-label halo width (#52): the plain base width and the wider,
 *  more-readable width while `move_comment` is tinting the labels. Shared by
 *  the initial layer defs and the tool-transition restore path so they can't
 *  drift apart. */
const COMMENT_HALO_WIDTH_BASE = 1.5;
const COMMENT_HALO_WIDTH_TINTED = 2.5;

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
  private shotGradientsLayerId = 'survey-shot-gradients';
  // Measure along-line tint overlay (#26): the measured path's shots redrawn ABOVE
  // the depth-gradient sub-segments so the tint is never occluded by them.
  private measurePathLayerId = 'survey-measure-path';
  private stationsLayerId = 'survey-stations';
  private labelsLayerId = 'survey-labels';
  private shotLabelsLayerId = 'survey-shot-labels';
  private stationLabelsLayerId = 'survey-station-labels';
  private stationCommentsLayerId = 'survey-station-comments';
  private shotCommentsLayerId = 'survey-shot-comments';
  private loopClosuresLayerId = 'survey-loop-closures';
  private ghostShotsLayerId = 'survey-ghost-shots';
  private ghostStationsLayerId = 'survey-ghost-stations';
  private ghostMergeLayerId = 'survey-ghost-merge';
  private stationsHighlightLayerId = 'survey-stations-highlight';
  // Interact overlay (#mem): a tiny GeoJSON source holding ONLY the currently
  // hovered / selected / snapped shot(s)/station(s) as individual features.
  // With merged bulk features, per-item hover/selection can no longer use
  // per-feature feature-state; instead these few features are redrawn above
  // the bulk layers with the same resolved paint values, so pixels match.
  private interactSourceId = 'survey-interact';
  private interactShotsLayerId = 'survey-interact-shots';
  private interactShotsMeasuredLayerId = 'survey-interact-shots-measured';
  private interactStationsLayerId = 'survey-interact-stations';
  // NOTE: the former dedicated survey-shots-hitbox / survey-stations-hitbox
  // layers were removed (#mem budget). Each was a full unfiltered duplicate
  // vertex bucket of its bulk source (~75k line segments / ~90k points) built
  // solely to gate hit-testing. The candidate-section gate now queries the
  // VISIBLE shots/stations layers with a padded probe box that reproduces the
  // old hit tolerance exactly — see hitCandidateSections().
  // Gas route highlight (#233): the picked penetration route drawn over the survey — one line
  // layer, swum legs at full opacity and jump legs faded via a data-driven line-opacity (#243).
  private gasRouteLayerId = 'survey-gas-route';

  // Base zoom-density filters for label layers (set at init, restored when clearing reference filter)
  private shotLabelsBaseFilter: maplibregl.FilterSpecification | null = null;
  private stationLabelsBaseFilter: maplibregl.FilterSpecification | null = null;
  private ghostStationsHitboxLayerId = 'survey-ghost-stations-hitbox';
  private ghostShotsHitboxLayerId = 'survey-ghost-shots-hitbox';
  private callbacks: SurveyLayerCallbacks;

  // Config storage with fallback defaults for when config is null (initial load)
  private config: Config | null = null;
  // Constant-false MapLibre filter: no feature passes, so a layer carrying it
  // builds an EMPTY vertex bucket (used to park the measure-path overlay off in
  // the steady state, #mem budget).
  private static readonly MATCH_NOTHING_FILTER: maplibregl.FilterSpecification = [
    '==',
    ['literal', 1],
    ['literal', 0],
  ];
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
  private highlightedStationIds: string[] = [];
  // Multi-section hover for Move Segment tool (highlights all connected sections)
  private hoveredSegmentSectionIds: string[] = [];

  // Hidden comment during move_comment pickup (visually hides without backend mutation)
  private hiddenComment: { type: 'station' | 'shot'; sectionId: number; id: number } | null = null;
  // Cached reference-shots visibility for recomputing comment filters
  private showReferenceShotsCached = true;

  // Comment tool override: when comment/move_comment tool is active, force both
  // comment layers visible with text-allow-overlap so comments win over other labels.
  private commentToolActive = false;
  private cachedShowStationComments = false;
  private cachedShowShotComments = false;

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

  /**
   * setData coalescer: if multiple update() calls land in the same microtask
   * (typical of React effect cascades — depthRange/gpsOrigin/precision refs
   * changing in lockstep on project load), we batch them into a single
   * buildSurveyFeatures + setData pass. This was measured at 6× call count
   * per survey load before coalescing; collapsing it ~6× the GC churn.
   *
   * Microtask boundary matters: useLayoutEffect callers expect setData to
   * have run before paint, and microtasks drain before paint. A later
   * deadline (rAF / setTimeout) would break drag-commit's same-frame
   * guarantee documented on the useLayoutEffect site in MapCanvas.
   */
  private pendingUpdateArgs: {
    sections: Section[];
    stations: Station[];
    loopClosures: LoopClosure[] | undefined;
    gpsOrigin: GpsOrigin | null;
    showDepthGradient: boolean;
    depthRange: DepthRange;
    precision: DecimalPrecision | undefined;
    showIssueSeverity: boolean;
    warnings: ProjectWarning[];
  } | null = null;
  private updateScheduled = false;
  /** Coalesced-call counter, surfaced to memory probe for instrumentation. */
  private coalescedUpdateCallsSinceLastFlush = 0;
  /** Monotonic id incremented on every update() flush start. Async worker
   *  builds compare against this on resolve to bail if a newer update
   *  invalidated them mid-flight. */
  private lastUpdateToken = 0;
  // Segment drag hides these bulk layers' real features (excluded by sectionId)
  // while the moving copy renders from the preview source. Shots + stations are
  // re-rendered as moving geometry; the text layers (shot / station labels and
  // section names) are hidden with no preview copy - attached text is dropped for
  // the drag duration and restored on commit-settle / Escape.
  private static readonly SEGMENT_DRAG_MAIN_LAYERS = [
    'survey-shots',
    'survey-shot-gradients',
    'survey-stations',
    'survey-shot-labels',
    'survey-station-labels',
    'survey-labels',
  ];

  // Unified drag-preview source (#mem drag fixes): ONE GeoJSON source holding
  // every moving GEOMETRY feature for the active drag — stations (points), shots
  // (lines), loop-closure indicator lines — rebuilt from captured originals each
  // frame and pushed via a SINGLE setData. Real moved coordinates (not
  // `*-translate`) so the tiler clips moved geometry — no background wedges at
  // large offsets (BUG A); one setData so stations/shots can't skew apart (BUG B).
  // Attached text is not previewed (it is hidden from the stock text layers).
  // The moving ghost is owned by {@link DragGhostController}; DRAG_PREVIEW_SOURCE
  // is imported only for setDragExclusionWhenPreviewReady's stock-preview load gate.
  /** Captured moving geometry for the active drag (originals + movingEnd). */
  private dragPreviewSet: DragPreviewSet | null = null;
  /** rAF coalescer for the per-frame interact-overlay follow: MapCanvas may push
   *  several offsets per frame (pointermove + the map-'move' re-apply), but the
   *  overlay only needs the latest — one small setData per frame. (The GHOST is
   *  driven synchronously by {@link DragGhostController}, decoupled from this rAF.) */
  private dragUpdateRaf: number | null = null;
  private pendingDragOffset: { dx: number; dy: number } | null = null;
  /** Drag ghost (#mem drag latency): owns the moving-geometry preview and drives
   *  it from a live screen-px offset. The CUSTOM path renders a WebGL layer whose
   *  drag delta is a single vertex-shader uniform (no worker, no re-bake, so no
   *  overshoot); the STOCK fallback is the historical GeoJSON preview +
   *  single-flight {@link GhostFollow} bake / `line-translate` machine. See
   *  {@link DragGhostController}. Constructed once, reused across drags. */
  private dragGhost!: DragGhostController;
  /** Interact-overlay follow (#C): a hover/selected highlight on a moving
   *  station/shot is re-emitted at the drag offset each frame so it tracks the
   *  cursor. Stationary overlay features (snap ring, highlightedStationIds,
   *  unrelated selections) keep their true coordinates. */
  private dragMovingStationKeys = new Set<string>();
  private dragMovingShots = new Map<string, MovingEnd>();
  private dragOverlayOffset: { dx: number; dy: number } | null = null;
  /** Set by commitDragPreview at placement: the follow-offset (dragOverlayOffset +
   *  moving sets) is deliberately KEPT applied across the IPC + flush window so the
   *  grabbed highlight stays on the cursor instead of snapping back to the OLD
   *  coords. endApplyFeatures drops it atomically, right before the post-commit
   *  overlay refresh reads the freshly installed geometry (no snap-back, and no
   *  old+offset overshoot). */
  private dragCommitPending = false;
  /** Deferred custom-render drag-hide (START-flash fix). The moving originals are
   *  hidden from the custom WebGL layer only once the drag-preview GeoJSON source
   *  has parsed and drawn its first frame - the preview's setData is async (~5
   *  frames on a real project) while setDragHide is a synchronous GPU upload, so
   *  hiding eagerly leaves a window where the geometry is in NEITHER the custom
   *  layer nor the (not-yet-parsed) preview: a blank flash. Stored so it can be
   *  force-applied at commit and torn down on end; `dragGeneration` is bumped per
   *  drag so a late sourcedata callback from a superseded drag is ignored. */
  private dragGeneration = 0;
  private pendingDragHide: {
    exclusion: CustomRenderExclusion;
    listener: (e: maplibregl.MapSourceDataEvent) => void;
  } | null = null;
  /** Label-source VT reload promises produced by the current apply/flush (reset
   *  in beginApplyFeatures, pushed in applyFeatureChunk for label groups). Fed to
   *  endDragPreview so a drag-commit restore of the moved sections' TEXT filters
   *  waits for the label tiles to carry post-move coordinates (FINISH label-flash
   *  fix). */
  private labelReloadsThisFlush: Promise<unknown>[] = [];
  /** Non-null only for the synchronous span of the onNextUpdate callback fired by
   *  endApplyFeatures: the just-committed flush's label reloads, so a drag-commit
   *  endDragPreview can defer its text-filter restore behind them. Null for a
   *  direct endDragPreview (Escape / rejected move) -> restore immediately. */
  private pendingDragCommitLabelReloads: Promise<unknown>[] | null = null;
  /** Deferred text-label filter machinery shared by the drag-commit FINISH fix
   *  (moved labels wait for the tiles to reload) and the delete/undo removal fix
   *  (removed sections' labels are hidden in the flush that drops their geometry
   *  and released once the label tiles reload without them). See labelRestore.ts. */
  private readonly labelRestore: LabelRestoreController;
  /** Hides the interact-overlay layers across a removal flush's async re-tile so a
   *  deleted feature's hover/selection highlight drops in the geometry frame
   *  instead of lingering on the stale GeoJSON tile. See interactOverlayHide.ts. */
  private readonly interactHide: InteractOverlayHideController;

  // Visibility state (for hidden feature detection)
  private stationsVisible: boolean = true;
  private shotsVisible: boolean = true;

  // GPS origin for coordinate transforms (enables satellite tile alignment)
  private gpsOrigin: GpsOrigin | null = null;

  // Depth gradient mode state (used during update() for feature color calculation)
  private showDepthGradient: boolean = false;
  private depthRange: DepthRange = { min: 0, max: 50 };

  // Issue-severity coloring mode (#22). Like showDepthGradient, cached so the
  // lazy-labels zoom rebuild and theme rebuild re-fire with the same mode.
  private showIssueSeverity: boolean = false;
  private cachedWarnings: ProjectWarning[] = [];

  // Distance-gradient overlay (#34). feature-state based so re-root needs no
  // feature rebuild; re-applied after source rebuilds because endApplyFeatures
  // clears state before tile IDs can be reused for different merged groups.
  private distanceMode: boolean = false;
  private distanceState: DistanceFeatureState | null = null;
  // Gas reachable-frontier overlay (#38). Same feature-state mechanics as the
  // distance gradient (own `gasReach` key); mutually exclusive with it (both own
  // the shots/stations color paint), enforced upstream in uiStore.
  private gasReachMode: boolean = false;
  private gasReachState: GasReachFeatureState | null = null;
  // Gas route highlight (#233): the current picked-route legs. Re-applied after every source
  // rebuild (its own GeoJSON source survives setData, but a feature rebuild re-pushes the data).
  private gasRouteLegs: RouteLeg[] = [];
  // Measured along-line path (#26): the path's shots AND stations are tinted via
  // a `measured` feature-state + a paint `case` on shots line-color / stations
  // circle-color, in a user-configurable color. Re-applied after source rebuilds,
  // and suppressed while the distance gradient owns color.
  private measuredPathIds: Set<number> | null = null;
  private measuredPathStationIds: Set<number> | null = null;
  private measureTintColor: string = MEASURE_TINT;

  // Theme colors for MapLibre paint properties (MapLibre cannot read CSS vars)
  // Seeded at construction so first paint uses current theme, not legacy fallbacks
  private themeColors: MapThemeColors = getMapThemeColors();

  // Deduplicated color palette from the last feature build (#B). Shot / gradient
  // / station features carry a numeric `colorIndex` (stations also
  // `strokeColorIndex`) instead of a per-feature hex string; the shots/gradients/
  // stations paint resolves it via a `match` expression built from this palette.
  // Refreshed and re-applied on every build (theme / depth / severity / edits can
  // change the colors), so the paint's `match` always matches the source indices.
  // `colorIndex` and `strokeColorIndex` both index this one palette.
  private colorPalette: string[] = [];

  // Cached input data for feature rebuild on theme change
  private cachedSections: Section[] = [];
  private cachedStations: Station[] = [];
  private cachedLoopClosures: LoopClosure[] | undefined;
  private cachedPrecision: DecimalPrecision | undefined;

  // Lazy label sources. shot-labels and station-labels both have minzoom 14
  // (so do the comment-overlay layers that share those sources). Building
  // ~75k+89k label features at lower zooms wastes ~100 MB main+worker on
  // the load path. We track the last built state with hysteresis to avoid
  // thrashing if the user zooms across the threshold rapidly.
  private static readonly LABEL_BUILD_ZOOM = 13.5;
  private static readonly LABEL_DROP_ZOOM = 13;
  /** Whether label features are currently materialized in the sources.
   *  Starts false — nothing is built yet — so the FIRST build uses the
   *  BUILD threshold (13.5), not the drop threshold. With the old `true`
   *  initial value, a project whose restored camera sat in [13, 13.5)
   *  materialized ~165k label features on load that a single zoom crossing
   *  would never have rebuilt (#mem). */
  private labelsCurrentlyBuilt = false;
  /** One-shot 'idle' recheck armed when a flush ran during camera motion
   *  (labels were skipped against the transient zoom). */
  private labelIdleRecheckArmed = false;
  /** Bound handler for map.on('zoomend') — kept for proper off() in destroy. */
  private boundZoomEndForLabels: (() => void) | null = null;

  // Bound event handlers stored for proper cleanup in destroy()
  private boundMouseMove: ((e: maplibregl.MapMouseEvent) => void) | null = null;
  private boundMapLeave: (() => void) | null = null;

  // Touch long-press state for context menu
  private touchLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  private touchStartPos: { x: number; y: number } | null = null;
  private boundTouchStart: ((e: TouchEvent) => void) | null = null;
  private boundTouchMove: ((e: TouchEvent) => void) | null = null;
  private boundTouchEnd: ((e: TouchEvent) => void) | null = null;

  // Hover update batching - only process latest mouse position per frame
  private pendingHoverEvent: maplibregl.MapMouseEvent | null = null;
  private hoverRafId: number | null = null;

  // Interact-overlay dedupe key: per-frame hover updates only touch the
  // overlay source when its content actually changes. Reset to '' whenever
  // styling inputs change (rebuild, config, theme, overlay modes).
  private lastInteractKey: string | null = null;

  // SoA survey data + geometry resolver for the last applied build (#mem).
  // The resolver serves per-item hit-testing over merged features and the
  // interact overlay's geometry/color lookups. `cachedIssueSeverity` mirrors
  // the severity arrays the build used so overlay colors match exactly.
  private cachedSurveyData: SurveyData | null = null;
  private geoIndex: SurveyGeometryIndex | null = null;
  private cachedIssueSeverity: IssueSeverity | undefined;

  // Flag-gated custom WebGL render prototype (#customRender). No-op unless the
  // `stalagmight_custom_render` gate is on; see surveyLayer/customRender/.
  private customRender: SurveyCustomController | null = null;
  // Flag-gated custom WebGL LABEL layer (#customRender labels). No-op unless BOTH
  // the render gate AND `stalagmight_custom_labels` are on. Draws all five label
  // kinds, VIEWPORT-SCOPED with screen-space collision, rebuilding on camera
  // settle (its own moveend/zoomend listener); suppresses the five stock text
  // layers while active.
  private customLabels: SurveyLabelController | null = null;

  /**
   * True while the custom WebGL layer is drawing and has taken over the bulk
   * shots / stations / shot-gradients (#customRender / #mem). When set, those
   * dedicated `stalx://` vector-tile sources stop building payloads, cutting
   * tiles, and holding registry/tile caches — the biggest steady-state hold on
   * 92.stalx — because nothing stock consumes them (the survey-shots /
   * survey-stations / survey-shot-gradients layers are hidden, hit-testing runs
   * off the SoA geometry index, and hover/selection render from the interact
   * overlay). Flipped by the controller's onActiveChange callback; a transition
   * to `false` (gate off / fail-safe self-disable) re-publishes them from cache.
   */
  private customBulkSuppressed = false;
  /** Bulk geometry groups the custom layer replaces. Their dedicated sources are
   *  the ones suppressed while {@link customBulkSuppressed}. */
  private static readonly BULK_GEOMETRY_GROUPS: readonly SurveyFeatureGroupKey[] = [
    'shotFeatures',
    'stationFeatures',
    'shotGradientFeatures',
  ];

  /**
   * True while the custom WebGL LABEL layer is drawing and has taken over the
   * three label VT groups (#customRender labels / #mem). Those dedicated
   * `stalx://` sources then stop building payloads + holding registry / tile
   * caches — nothing stock consumes them (the five stock text layers are hidden,
   * the custom layer draws every label AND comment). Flipped by the label
   * controller's onActiveChange callback; a transition to `false` (gate opt-out /
   * fail-safe self-disable) re-publishes them from cache. INDEPENDENT of
   * {@link customBulkSuppressed}: custom labels over STOCK geometry is the default
   * shipping combo (labels gate default-on, geometry gate default-off). */
  private customLabelsSuppressed = false;
  /** Label VT groups the custom label layer replaces. Comments ride the shot /
   *  station label sources, so dropping these three covers comments too. */
  private static readonly BULK_LABEL_GROUPS: readonly SurveyFeatureGroupKey[] = [
    'sectionLabelFeatures',
    'shotLabelFeatures',
    'stationLabelFeatures',
  ];
  /** The label groups whose VT sources the stock comment layers ride (see the
   *  comment-layer `source:` bindings). The double-draw guarantee requires each to
   *  be dropped by BULK_LABEL_GROUPS when custom labels take over. */
  private static readonly COMMENT_SOURCE_GROUPS: readonly SurveyFeatureGroupKey[] = [
    'stationLabelFeatures',
    'shotLabelFeatures',
  ];
  private static commentCouplingChecked = false;
  /** Dev tripwire: prove every stock comment source is among the label sources
   *  BULK_LABEL_GROUPS drops, so comments can't double-draw once the custom label
   *  layer takes over. Runs once; a future change that breaks the coupling (a new
   *  comment source not in the drop set) throws loudly in dev. */
  private static assertCommentSourcesCovered(): void {
    if (SurveyLayer.commentCouplingChecked || !import.meta.env.DEV) return;
    SurveyLayer.commentCouplingChecked = true;
    const dropped = new Set(SurveyLayer.BULK_LABEL_GROUPS);
    for (const group of SurveyLayer.COMMENT_SOURCE_GROUPS) {
      if (!dropped.has(group)) {
        throw new Error(
          `[SurveyLayer] comment source group "${group}" is not in BULK_LABEL_GROUPS; ` +
            'comments would double-draw under custom labels.',
        );
      }
    }
  }
  /** Monotonic tile-URL version for force-emptying a dropped bulk source. Kept
   *  far above any registry version so a bump never collides with a live one. */
  private bulkDropSeq = 1_000_000_000;

  // Feature granularity of the bulk sources (#mem). Merged groups are the
  // steady state; per-feature modes (distance / gas-reach / measured path /
  // move_station / move_shot) need per-item feature-state or filters, so
  // entering one rebuilds the sources with per-feature content and leaving
  // rebuilds merged. `requestedPerFeature` is what the latest flush asked
  // for (dedupes rebuild triggers); `contentPerFeature` is what the sources
  // actually hold right now (guards drag-preview filters).
  private requestedPerFeature = false;
  private contentPerFeature = false;
  /** How many async full builds (`flushUpdateViaWorker`) are between their token
   *  bump and completion. A narrow granularity swap rebuilds ONLY shots +
   *  stations, so it is safe only when NO full build is mid-flight — otherwise
   *  that build's not-yet-landed labels / gradients / section-labels /
   *  loop-closures would be stranded when the swap supersedes it by token.
   *  A counter (not a bool) stays > 0 across overlapping builds. */
  private fullUpdateInFlightCount = 0;

  // Previous section-level feature IDs for setFeatureState (to clear state when section hover/selection changes)
  private prevHoveredSectionShotIds: Set<number> = new Set();
  private prevHoveredSectionStationIds: Set<number> = new Set();
  private prevSelectedSectionShotIds: Set<number> = new Set();
  private prevSelectedSectionStationIds: Set<number> = new Set();

  // Pre-built section→featureId lookup maps, populated once in update() from feature data.
  // Eliminates O(N) querySourceFeatures calls during hover (the main perf bottleneck).
  private sectionShotFeatureIds: Map<number, Set<number>> = new Map();
  private sectionStationFeatureIds: Map<number, Set<number>> = new Map();

  // Cached section feature IDs to avoid re-scanning on every updateVisualState()
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
    this.labelRestore = new LabelRestoreController(map);
    this.interactHide = new InteractOverlayHideController(map, this.interactSourceId, [
      this.interactShotsLayerId,
      this.interactShotsMeasuredLayerId,
      this.interactStationsLayerId,
      this.stationsHighlightLayerId,
    ]);
    this.initializeSources();
    this.initializeLayers();
    this.initializeEventHandlers();
    this.customRender = new SurveyCustomController(map, undefined, {
      resync: () => this.resyncCustomRenderFromStore(),
      onActiveChange: (active) => this.onCustomActiveChange(active),
    });
    // resyncCustomRenderFromStore syncs BOTH controllers, so one hook covers both.
    this.customLabels = new SurveyLabelController(map, undefined, {
      resync: () => this.resyncCustomRenderFromStore(),
      onActiveChange: (active) => this.onCustomLabelsActiveChange(active),
    });
    this.dragGhost = new DragGhostController(map, {
      ghostData: (set) => this.dragGhostData(set),
      layerCtx: () => this.dragPreviewLayerCtx(),
      projector: () => this.dragProjector(),
      dpr: () => (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
      scheduleRestore: (fn) =>
        typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 0),
    });
  }

  setCallbacks(callbacks: SurveyLayerCallbacks) {
    this.callbacks = callbacks;
  }

  // Config setter - triggers layer updates when config changes
  public setConfig(config: Config): void {
    this.config = config;
    this.updateHitboxLayers();
    this.updateGhostVisualLayers();
    // Overlay features carry config-derived widths/radii — force a rebuild.
    this.lastInteractKey = null;
    this.updateVisualState();
    this.updateDebugVisualization();
  }

  /**
   * Set the active tool. When switching to a non-interactive tool (pan/zoom),
   * clears hover state and notifies callbacks to sync MapCanvas state.
   * Self-healing: also clears stale hover if already in a non-interactive tool.
   */
  public setActiveTool(tool: ToolType): void {
    const wasMoveComment = this.activeTool === 'move_comment';
    this.activeTool = tool;

    const isNonInteractive = isNonInteractiveTool(tool);

    // Clear hover when in non-interactive tool AND there's stale hover state
    // This is self-healing: handles both transitions (interactive→non-interactive)
    // and missed initial syncs or future refactors
    if (isNonInteractive && (this.hoveredStationId || this.hoveredShotId || this.hoveredSectionId)) {
      this.hoveredStationId = null;
      this.hoveredShotId = null;
      this.hoveredSectionId = null;
      this.customRender?.setSectionHover([]);
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

    // Comment tool override: force comment layers visible + overlap priority
    const isCommentTool = tool === 'comment' || tool === 'move_comment';
    if (isCommentTool && !this.commentToolActive) {
      this._enableCommentToolOverride();
    } else if (!isCommentTool && this.commentToolActive) {
      this._disableCommentToolOverride();
    }

    // move_station / move_shot need per-feature source content (per-item
    // drag-exclusion filters + immovable dimming expressions); leaving them
    // returns to merged groups (#mem).
    this.ensureFeatureGranularity();

    // Move-comment palette tint (#52): exactly `move_comment` (not the plain
    // `comment` tool) tints each comment label and its owning shot/station.
    // Re-derive the paint expressions only on transition in/out.
    const isMoveComment = tool === 'move_comment';
    if (isMoveComment !== wasMoveComment) {
      this.applyOverlayPaint();
      this.applyCommentToolTint();
      // Custom renderer (no feature-state / commentColor property): rebuild so the
      // shot/station tint appears or clears, mirroring distance/gas mode changes.
      this.resyncCustomRenderFromStore();
    }
  }

  /**
   * Whether the bulk shot/station sources need PER-FEATURE content right now
   * (#mem). Steady state is merged groups; these modes rely on per-item
   * feature-state or per-item filter/paint expressions:
   *   - distance gradient / gas reach: per-shot `dist`/`gasReach` feature-state,
   *   - measured path: per-shot/station `measured` feature-state,
   *   - move_station / move_shot: per-item drag-exclusion filters and
   *     immovable-dimming `featureId` paint expressions.
   * Mode RSS is transient: leaving the mode rebuilds merged content and the
   * WebKit pressure hooks reclaim the burst.
   */
  private desiredPerFeature(): boolean {
    return (
      this.distanceMode ||
      this.gasReachMode ||
      this.measuredPathIds !== null ||
      this.measuredPathStationIds !== null ||
      this.activeTool === 'move_station' ||
      this.activeTool === 'move_shot'
    );
  }

  /**
   * Rebuild the bulk sources when the desired feature granularity changed
   * (mode entry/exit). Dedupes via `requestedPerFeature` so repeated mode-setter
   * calls don't re-trigger.
   *
   * Steady state (nothing else rebuilding): use the NARROW swap
   * (`flushGranularitySwap`) — it rebuilds ONLY shots + stations (the merge
   * granularity does not touch labels / gradients / section-labels /
   * loop-closures), so mode entry is near-instant (#mem). Only when a full
   * rebuild is queued or mid-flight do we ride a full `update()` instead: the
   * swap would supersede that build by token and strand its not-yet-landed
   * non-shot/station groups.
   */
  private ensureFeatureGranularity(): void {
    if (!hasLiveStyle(this.map)) return;
    if (this.desiredPerFeature() === this.requestedPerFeature) return;
    if (this.cachedSections.length === 0 && this.cachedStations.length === 0) return;

    // A full rebuild is already queued (coalescer): it reads desiredPerFeature()
    // at flush time and rebuilds ALL sources at the new granularity, so leave it
    // to do the work (and don't clobber its possibly-newer pending args).
    if (this.updateScheduled || this.pendingUpdateArgs !== null) return;

    // A full rebuild is mid-flight at the OLD granularity; its non-shot/station
    // groups haven't landed. Re-run a full update so everything lands at the new
    // granularity (cachedSections is current — no newer pending args exist).
    if (this.fullUpdateInFlightCount > 0) {
      this.rebuildFromCache();
      return;
    }

    this.flushGranularitySwap();
  }

  /**
   * Narrow rebuild of ONLY the shots + stations sources at the currently-desired
   * granularity (#mem). Streams the two vt chunks through the SAME
   * begin/chunk/end apply path the full build uses, so hover maps, feature-state
   * (distance / gas / measured), color paint and interact overlay all refresh —
   * but the ~178k labels / gradients / section-labels / loop-closures are left
   * resident (they are invariant to merged-vs-per-feature). The worker seeds its
   * interner with `this.colorPalette` (the resident palette), so the emitted
   * palette is a superset (identical on a pure toggle): adopting it never shrinks
   * and keeps gradient/label colorIndex valid.
   */
  private flushGranularitySwap(): void {
    if (!hasLiveStyle(this.map) || !this.cachedSurveyData) return;
    const perFeature = this.desiredPerFeature();
    this.requestedPerFeature = perFeature;
    const myToken = ++this.lastUpdateToken;
    const stillCurrent = (): boolean => myToken === this.lastUpdateToken && hasLiveStyle(this.map);
    let began = false;
    const tSwapStart = performance.now();
    void buildGranularitySwapStreamed(
      {
        surveyData: this.cachedSurveyData,
        gpsOrigin: this.gpsOrigin,
        showDepthGradient: this.showDepthGradient,
        depthRange: this.depthRange,
        themeColors: this.themeColors,
        showIssueSeverity: this.showIssueSeverity,
        issueSeverity: this.cachedIssueSeverity,
        mergeFeatures: !perFeature,
        seedPalette: this.colorPalette,
      },
      {
        begin: () => {
          if (!stillCurrent()) return;
          began = true;
          this.beginApplyFeatures();
          this.contentPerFeature = perFeature;
        },
        chunk: (group, payload, palette) => {
          if (!began || !stillCurrent()) return;
          this.applyFeatureChunk(group, payload, palette);
        },
        end: () => {
          if (!began || !stillCurrent()) return;
          this.endApplyFeatures();
          recordPerfTiming('granularity swap', performance.now() - tSwapStart);
        },
        error: (e) => {
          // The client already falls back inline when the Worker can't be
          // constructed; a genuine worker/stream error is rare. Fall back to a
          // full update() (simplest correct option) so every source is rebuilt
          // consistently — but only if we're still the current request.
          console.error('[SurveyLayer] granularity swap failed, falling back to full update:', e);
          if (myToken !== this.lastUpdateToken || !hasLiveStyle(this.map)) return;
          this.rebuildFromCache();
        },
      },
    );
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

  /**
   * Screen-space "reach" of the (now-removed) hitbox layers — the maximum px
   * distance from a geometry's center at which a point still registered a hit,
   * i.e. the tolerance the candidate gate + SoA resolver must reproduce.
   *
   * MapLibre's point-in-feature test buffers a LINE by half its rendered width
   * and a CIRCLE by its radius. The old hitboxes rendered the shot line at
   * width `hit_area` (reach = hit_area / 2) and the station circle at radius
   * `hit_area` (reach = hit_area). These are also passed to the SoA resolver
   * as the point-query `maxDistance`, so gate and resolver agree exactly.
   */
  private getShotHitReach(): number {
    return this.getShotHitArea() / 2;
  }

  private getStationHitReach(): number {
    return this.getStationHitArea();
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
    // Bulk sources are on-demand vector tiles (#mem): SurveyLayer keeps each
    // layer's geometry as flat typed arrays in the vt registry and MapLibre
    // pulls compact MVT bytes per tile through the `stalx://` protocol. See
    // surveyLayer/vectorTileData.ts for why the GeoJSON path was replaced.
    // Feature ids are first-class in MVT (no promoteId needed for
    // feature-state), and the cutter's clip buffer supplies the headroom the
    // geojson sources got from `buffer: dragBuffer`.
    ensureVtProtocol();
    const vtSourceSpec = (sourceId: string): maplibregl.VectorSourceSpecification => ({
      type: 'vector',
      tiles: [vtTileUrl(sourceId, 0)],
      minzoom: 0,
      maxzoom: 22,
    });

    // Shots line source - promoteId enables setFeatureState for hover/selection
    this.map.addSource(this.sourceId + '-shots', vtSourceSpec(this.sourceId + '-shots'));

    // Stations point source - promoteId enables setFeatureState for hover/selection
    this.map.addSource(this.sourceId + '-stations', vtSourceSpec(this.sourceId + '-stations'));

    // Shot gradient segment source (visual-only overlay for per-shot depth transitions)
    this.map.addSource(this.sourceId + '-shot-gradients', vtSourceSpec(this.sourceId + '-shot-gradients'));

    // Loop closures line source
    this.map.addSource(this.sourceId + '-loop-closures', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Gas route highlight line source (#233): one LineString per route leg, `isJump` flagged.
    this.map.addSource(this.sourceId + '-gas-route', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Shot labels point source (midpoint of each shot)
    this.map.addSource(this.sourceId + '-shot-labels', vtSourceSpec(this.sourceId + '-shot-labels'));

    // Section name labels point source (first station of each section)
    this.map.addSource(this.sourceId + '-section-labels', vtSourceSpec(this.sourceId + '-section-labels'));

    // Station index labels point source (at each station)
    this.map.addSource(this.sourceId + '-station-labels', vtSourceSpec(this.sourceId + '-station-labels'));

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

    // Interact overlay source (#mem): holds only the handful of currently
    // hovered / selected / snapped features as individual GeoJSON features
    // (see refreshInteractOverlay). Bounded by interaction state, not survey
    // size, so its retained cost is negligible.
    this.map.addSource(this.interactSourceId, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });
  }

  private initializeLayers() {
    // === HIT-TEST GATING ===
    // The dedicated survey-shots-hitbox / survey-stations-hitbox layers were
    // removed (#mem budget): each was a full unfiltered duplicate vertex bucket
    // of its bulk source. Hit-testing now queries the VISIBLE shots/stations
    // layers with a padded probe box (see hitCandidateSections). The ghost
    // hitbox layers below stay — they live on the tiny ghost sources and drive
    // the merge-preview debug visualization only.
    //
    // Layer order (bottom to top):
    // 1. survey-ghost-shots-hitbox (debug only)
    // 2. survey-ghost-stations-hitbox (debug only)
    // Then visual layers follow...

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
      'source-layer': VT_SOURCE_LAYER,
      paint: {
        // Palette match on `colorIndex` (#B). Empty at init (no features yet);
        // applyColorPaint() re-applies with the real palette after each build.
        'line-color': this.colorExpr(),
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
          ['get', 'isReference'], 0.5,
          1,
        ],
      },
    });

    // Gradient overlay (composed of tiny line segments) for true in->out shot depth transitions.
    // Uses a slightly smaller width so hover/selection states on the main shots layer remain visible.
    this.map.addLayer({
      id: this.shotGradientsLayerId,
      type: 'line',
      source: this.sourceId + '-shot-gradients',
      'source-layer': VT_SOURCE_LAYER,
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': this.colorExpr(),
        'line-width': Math.max(1, baseWidth - 0.35),
        'line-opacity': [
          'case',
          ['get', 'isReference'], 0.5,
          1,
        ],
      },
    });

    // Measure along-line tint overlay (#26): the measured path's shots, drawn on
    // top of the depth-gradient sub-segments so the highlight is never occluded by
    // them. Visibility is driven by the same `measured` feature-state as the main
    // shots layer (opacity 1 when measured, else 0), so non-path shots stay
    // invisible here and keep their normal/gradient color underneath. Width matches
    // the main shots line so it fully covers the (narrower) gradient.
    this.map.addLayer({
      id: this.measurePathLayerId,
      type: 'line',
      source: this.sourceId + '-shots',
      'source-layer': VT_SOURCE_LAYER,
      // #mem budget: when no path is measured (the steady state, always in
      // merged mode) this filter excludes every feature, so MapLibre builds an
      // EMPTY vertex bucket instead of a full duplicate of the ~75k-segment
      // shots geometry. The tint only ever renders in per-feature mode with a
      // measured path set (setMeasuredPath restores the filter). See
      // measurePathFilter(). At init there is no path, so this is the
      // constant-false (empty-bucket) filter.
      filter: SurveyLayer.MATCH_NOTHING_FILTER,
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': this.measureTintColor,
        'line-width': [
          'case',
          ['boolean', ['feature-state', 'hover'], false], hoverWidth,
          ['boolean', ['feature-state', 'selected'], false], selectionWidth,
          baseWidth,
        ],
        'line-opacity': [
          'case',
          ['boolean', ['feature-state', 'measured'], false], 1,
          0,
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
      'source-layer': VT_SOURCE_LAYER,
      paint: {
        // Radius: hover > selected > zeroDatum > base (uses feature-state)
        'circle-radius': [
          'case',
          ['boolean', ['feature-state', 'hover'], false], hoverRadius,
          ['boolean', ['feature-state', 'selected'], false], selectionRadius,
          ['get', 'isZeroDatum'], baseRadius * 2,
          baseRadius,
        ],
        // Color from feature property (palette match on `colorIndex`, #B)
        'circle-color': this.colorExpr(),
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
        // Stroke color: hover=highlight, selected=select, else per-feature palette
        // stroke color (match on `strokeColorIndex`, #B).
        'circle-stroke-color': this.stationsStrokeColor(),
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
    // Reads the interact overlay (#mem): snapped stations are pushed there as
    // individual `kind: 'snap'` features (setSnappedStation /
    // setHighlightedStations), so the merged bulk source needs no per-station
    // feature-state. The tiny setData is as instant as feature-state was.
    this.map.addLayer({
      id: this.stationsHighlightLayerId,
      type: 'circle',
      source: this.interactSourceId,
      filter: ['==', ['get', 'kind'], 'snap'],
      paint: {
        'circle-radius': this.getStationRadius() + 3, // Snapped state: radius + 3
        'circle-color': this.themeColors.snapColor,
        'circle-stroke-width': 4,
        'circle-stroke-color': this.themeColors.snapColor,
        // Disable default 300ms paint transitions — snap indicator must appear/disappear instantly
        'circle-opacity-transition': { duration: 0, delay: 0 },
        'circle-stroke-opacity-transition': { duration: 0, delay: 0 },
      },
    });

    // Shot data labels layer - shows azimuth, length, depth at shot midpoint
    // Visibility controlled by showShotLabels toggle and zoom-based density
    this.map.addLayer({
      id: this.shotLabelsLayerId,
      type: 'symbol',
      source: this.sourceId + '-shot-labels',
      'source-layer': VT_SOURCE_LAYER,
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
      filter: this.shotLabelsBaseFilter = [
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

    // Gas route highlight (#233): the picked route drawn over the survey. Jump legs are
    // faded rather than dashed (#243) — the same half-opacity treatment reference shots
    // get — and unlike `line-dasharray`, `line-opacity` IS data-driven, so one layer
    // covers both leg kinds.
    this.map.addLayer({
      id: this.gasRouteLayerId,
      type: 'line',
      source: this.sourceId + '-gas-route',
      paint: {
        'line-color': '#22d3ee',
        'line-width': 4,
        'line-opacity': ['case', ['==', ['get', 'isJump'], true], 0.45, 0.9],
      },
    });

    // Section name labels layer - shows section name at first station
    // Visibility controlled by showSectionNames toggle
    this.map.addLayer({
      id: this.labelsLayerId,
      type: 'symbol',
      source: this.sourceId + '-section-labels',
      'source-layer': VT_SOURCE_LAYER,
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
      'source-layer': VT_SOURCE_LAYER,
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
      filter: this.stationLabelsBaseFilter = [
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

    // Station comments layer - shows comment text near each station
    // Uses the same source as station labels, filtered to only show stations with comments
    SurveyLayer.assertCommentSourcesCovered();
    this.map.addLayer({
      id: this.stationCommentsLayerId,
      type: 'symbol',
      // Ride the station-label VT source (derived from GROUP_SOURCE, the same map
      // BULK_LABEL_GROUPS drops) so custom labels empty this too -> no double-draw.
      source: this.sourceId + SurveyLayer.GROUP_SOURCE.stationLabelFeatures.suffix,
      'source-layer': VT_SOURCE_LAYER,
      minzoom: 14,
      layout: {
        'text-field': ['get', 'comment'],
        'text-font': ['Open Sans Regular'],
        'text-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14, 8,
          18, 10,
        ],
        'text-offset': [0, 1.5], // Below station dot
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-max-width': 12,
        'visibility': 'none', // Start hidden, controlled by setShowStationComments
      },
      paint: {
        'text-color': this.commentTextColor(),
        'text-halo-color': this.themeColors.textHaloAlt,
        'text-halo-width': COMMENT_HALO_WIDTH_BASE,
        'text-opacity': 0.85,
      },
      filter: ['!=', ['get', 'comment'], null],
    });

    // Shot comments layer - shows comment text near each shot midpoint
    // Uses the same source as shot labels, filtered to only show shots with comments
    this.map.addLayer({
      id: this.shotCommentsLayerId,
      type: 'symbol',
      // Ride the shot-label VT source (see the station-comments note above).
      source: this.sourceId + SurveyLayer.GROUP_SOURCE.shotLabelFeatures.suffix,
      'source-layer': VT_SOURCE_LAYER,
      minzoom: 14,
      layout: {
        'text-field': ['get', 'comment'],
        'text-font': ['Open Sans Regular'],
        'text-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14, 8,
          18, 10,
        ],
        'text-offset': [0, 1.5], // Below shot midpoint
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-max-width': 12,
        'visibility': 'none', // Start hidden, controlled by setShowShotComments
      },
      paint: {
        'text-color': this.commentTextColor(),
        'text-halo-color': this.themeColors.textHaloAlt,
        'text-halo-width': COMMENT_HALO_WIDTH_BASE,
        'text-opacity': 0.85,
      },
      filter: ['!=', ['get', 'comment'], null],
    });

    // === INTERACT OVERLAY LAYERS (#mem) ===
    // Individual hover/selection highlights, drawn from the tiny interact
    // source at the exact z-positions the old per-feature feature-state
    // effects rendered at:
    //   - interact-shots sits between the bulk shots layer and the depth
    //     gradient (the old hover widened the shots layer itself, below the
    //     gradient segments),
    //   - interact-shots-measured sits above the measure tint layer (the old
    //     hover widened survey-measure-path itself; round caps match it),
    //   - interact-stations sits between stations and the snap highlight.
    // Colors are resolved per feature at overlay-build time (same helpers as
    // the bulk build) or via the same ramp expressions in overlay modes, so
    // pixels match the bulk layers exactly.
    this.map.addLayer({
      id: this.interactShotsLayerId,
      type: 'line',
      source: this.interactSourceId,
      filter: ['==', ['get', 'kind'], 'shot'],
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['get', 'width'],
        'line-opacity': ['get', 'opacity'],
      },
    }, this.shotGradientsLayerId);

    this.map.addLayer({
      id: this.interactShotsMeasuredLayerId,
      type: 'line',
      source: this.interactSourceId,
      filter: ['==', ['get', 'kind'], 'shotMeasured'],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['get', 'width'],
        'line-opacity': 1,
      },
    }, this.stationsLayerId);

    this.map.addLayer({
      id: this.interactStationsLayerId,
      type: 'circle',
      source: this.interactSourceId,
      filter: ['==', ['get', 'kind'], 'station'],
      paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': ['get', 'opacity'],
        'circle-stroke-width': ['get', 'strokeWidth'],
        'circle-stroke-color': ['get', 'strokeColor'],
        'circle-stroke-opacity': ['get', 'opacity'],
      },
    }, this.stationsHighlightLayerId);
  }

  private initializeEventHandlers() {
    // UNIFIED click handler - gates candidates via the visible layers with
    // station priority. Replaces per-layer click handlers for nearest-to-click.
    this.map.on('click', this.handleMapClick);

    // Boundary filter for the residual VT reload-removed ErrorEvents that
    // MapLibre fires from its own _loadTile catch, upstream of the registry's
    // guards (see handleMapError). Installed once here; removed in destroy().
    this.map.on('error', this.handleMapError);

    // Note: Per-layer click handlers removed - unified handler handles all click logic

    // Process hover update for a given mouse event
    const processHoverUpdate = (e: maplibregl.MapMouseEvent) => {
      // Padded visible-layer query gates the candidate sections (the layers
      // already apply visibility + reference filters); the SoA resolver picks
      // the exact shot/station with the same tolerances the old hitbox had (#mem).
      const { stationSections, shotSections } = this.hitCandidateSections(e.point);

      // Resolve nearest of each type within the hit reach the old hitbox
      // layers gave (station circle radius / shot half line width).
      const stationHitReach = this.getStationHitReach();
      const shotHitReach = this.getShotHitReach();
      const nearestStation = this.resolveStationAt(e.point.x, e.point.y, stationSections, stationHitReach);
      const nearestShot = this.resolveShotAt(e.point.x, e.point.y, shotSections, shotHitReach);

      // Determine what to highlight (stations take priority unless suppressed by tool)
      let newHoveredStationId: string | null = null;
      let newHoveredShotId: string | null = null;

      // Tool-specific hover suppression:
      // - move_station: only stations hover (suppress shot hover)
      // - move_shot: only shots hover (suppress station hover)
      const suppressStationHover = this.activeTool === 'move_shot';
      const suppressShotHover = this.activeTool === 'move_station';

      if (nearestStation && !suppressStationHover) {
        newHoveredStationId = `${nearestStation.ref.section_id}:${nearestStation.ref.station_index}`;
      }
      // Show shot hover when no station is hovered (or station was suppressed) and shots not suppressed.
      if (!newHoveredStationId && nearestShot && !suppressShotHover) {
        newHoveredShotId = `${nearestShot.sectionId}:${nearestShot.shotId}`;
      }

      // Update state only if changed
      const stationChanged = newHoveredStationId !== this.hoveredStationId;
      const shotChanged = newHoveredShotId !== this.hoveredShotId;

      if (stationChanged || shotChanged) {
        if (this.shouldLogInteraction()) {
          console.debug('[HitDetection] Hover update', {
            activeTool: this.activeTool,
            newHoveredStationId,
            newHoveredShotId,
            suppressStationHover,
            suppressShotHover,
            stationHitReach,
            shotHitReach,
            stationCandidateSections: stationSections.size,
            shotCandidateSections: shotSections.size,
          });
        }
        this.hoveredStationId = newHoveredStationId;
        this.hoveredShotId = newHoveredShotId;

        // Update cursor - suppress for anchored/immovable features
        let showPointer = Boolean(newHoveredStationId || newHoveredShotId);
        let suppressReason: string | null = null;
        if (showPointer && this.activeTool === 'move_segment' && this.anchoredSectionIds.size > 0) {
          // Check if hovered feature belongs to an anchored section
          const hoveredId = newHoveredStationId || newHoveredShotId;
          if (hoveredId) {
            const sectionId = parseInt(hoveredId.split(':')[0]!, 10);
            if (this.anchoredSectionIds.has(sectionId)) {
              showPointer = false;
              suppressReason = 'anchored_section';
            }
          }
        }
        // Suppress cursor for immovable features in Move Station / Move Shot tools
        if (showPointer && (this.activeTool === 'move_station' || this.activeTool === 'move_shot')) {
          if (newHoveredStationId) {
            const [secStr, idxStr] = newHoveredStationId.split(':');
            const featureId = Number(secStr) * FEATURE_ID_STRIDE + Number(idxStr);
            if (this.isStationImmovable(featureId)) {
              showPointer = false;
              suppressReason = 'immovable_station';
            }
          } else if (newHoveredShotId) {
            const [secStr, idxStr] = newHoveredShotId.split(':');
            const featureId = Number(secStr) * FEATURE_ID_STRIDE + Number(idxStr);
            if (this.isShotImmovable(featureId)) {
              showPointer = false;
              suppressReason = 'immovable_shot';
            }
          }
        }
        // Move Station/Shot tools: use arrow cursor when not over a movable feature
        // (prevents MapLibre's default grab cursor from showing through)
        const useArrowFallback = this.activeTool === 'move_station' || this.activeTool === 'move_shot';
        this.map.getCanvas().style.cursor = showPointer ? 'pointer' : (useArrowFallback ? 'default' : '');
        if (this.shouldLogInteraction() && suppressReason) {
          console.debug('[HitDetection] Hover suppressed', {
            activeTool: this.activeTool,
            suppressReason,
            newHoveredStationId,
            newHoveredShotId,
          });
        }

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
        if (this.shouldLogInteraction()) {
          console.debug('[HitDetection] Hover cleared on map leave', {
            previousHoveredStationId: this.hoveredStationId,
            previousHoveredShotId: this.hoveredShotId,
          });
        }
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

    // UNIFIED context menu handler - gates candidates via the visible layers
    this.map.on('contextmenu', this.handleContextMenu);

    // Touch long-press → context menu (raw touch listeners on canvas)
    const canvas = this.map.getCanvas();
    this.boundTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0]!;
      this.touchStartPos = { x: touch.clientX, y: touch.clientY };
      this.touchLongPressTimer = setTimeout(() => {
        this.touchLongPressTimer = null;
        if (!this.touchStartPos) return;
        // Hit-test at touch position
        const rect = canvas.getBoundingClientRect();
        const point: [number, number] = [
          this.touchStartPos.x - rect.left,
          this.touchStartPos.y - rect.top,
        ];
        const fakeEvent = {
          point: { x: point[0], y: point[1] },
          lngLat: this.map.unproject(point),
          originalEvent: new MouseEvent('contextmenu', {
            clientX: this.touchStartPos.x,
            clientY: this.touchStartPos.y,
          }),
        } as maplibregl.MapMouseEvent;
        this.handleContextMenu(fakeEvent);
        // Prevent subsequent click
        this.touchStartPos = null;
      }, 500);
    };
    this.boundTouchMove = (e: TouchEvent) => {
      if (!this.touchStartPos || !this.touchLongPressTimer) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dx = touch.clientX - this.touchStartPos.x;
      const dy = touch.clientY - this.touchStartPos.y;
      if (dx * dx + dy * dy > 100) { // 10px threshold
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

    // Track user-initiated map navigation (zoom & pan) for telemetry
    this.map.on('zoomend', this.handleZoomEndTelemetry);
    this.map.on('moveend', this.handleMoveEndTelemetry);

    // When the camera crosses the lazy-labels threshold, re-fire update()
    // so the labels source picks up (or sheds) its features. Cheap: the
    // public update() coalesces into the next microtask and only runs the
    // build once even if zoom changes again before flush.
    this.boundZoomEndForLabels = () => {
      if (!hasLiveStyle(this.map)) return;
      const zoom = this.map.getZoom();
      const shouldBuild = this.labelsCurrentlyBuilt
        ? zoom >= SurveyLayer.LABEL_DROP_ZOOM
        : zoom >= SurveyLayer.LABEL_BUILD_ZOOM;
      if (shouldBuild !== this.labelsCurrentlyBuilt
          && (this.cachedSections.length > 0 || this.cachedStations.length > 0)) {
        this.update(
          this.cachedSections,
          this.cachedStations,
          this.cachedLoopClosures,
          this.gpsOrigin,
          this.showDepthGradient,
          this.depthRange,
          this.cachedPrecision,
          this.showIssueSeverity,
          this.cachedWarnings,
        );
      }
    };
    this.map.on('zoomend', this.boundZoomEndForLabels);
  }

  /**
   * Re-evaluate the lazy-label zoom decision from a clean slate (#mem).
   * Called by MapCanvas right after the programmatic snap fit-to-bounds on
   * project load: the load's first feature build can run against the pre-fit
   * camera, and when that transient zoom sits above the build threshold while
   * the fitted camera lands inside the hysteresis band [13, 13.5), the ~165k
   * label features would otherwise persist even though a load at the final
   * camera never builds them. Rebuilds (coalesced) only when the clean-slate
   * decision differs from what is currently materialized.
   */
  /** Arm a one-shot recheck of the label decision at the settled camera.
   *  Used when a flush ran mid-animation and skipped labels (#mem). */
  private armLabelIdleRecheck(): void {
    if (this.labelIdleRecheckArmed || !hasLiveStyle(this.map)) return;
    this.labelIdleRecheckArmed = true;
    this.map.once('idle', () => {
      this.labelIdleRecheckArmed = false;
      this.resetLabelZoomHysteresis();
    });
  }

  resetLabelZoomHysteresis(): void {
    if (!hasLiveStyle(this.map)) return;
    const shouldBuild = this.map.getZoom() >= SurveyLayer.LABEL_BUILD_ZOOM;
    if (shouldBuild === this.labelsCurrentlyBuilt) return;
    this.labelsCurrentlyBuilt = shouldBuild;
    if (this.cachedSections.length === 0 && this.cachedStations.length === 0) return;
    this.update(
      this.cachedSections,
      this.cachedStations,
      this.cachedLoopClosures,
      this.gpsOrigin,
      this.showDepthGradient,
      this.depthRange,
      this.cachedPrecision,
      this.showIssueSeverity,
      this.cachedWarnings,
    );
  }

  /** Track user-initiated zoom (scroll wheel, pinch, double-click). Skip programmatic zooms. */
  private handleZoomEndTelemetry = (e: maplibregl.MapLibreEvent): void => {
    const orig = e.originalEvent;
    if (!orig) return; // programmatic — already tracked by trigger functions
    if (orig instanceof WheelEvent) {
      trackNav('zoom', 'mouse');
    } else if (typeof TouchEvent !== 'undefined' && orig instanceof TouchEvent) {
      trackNav('zoom', 'touch');
    } else if (orig instanceof MouseEvent) {
      trackNav('zoom', 'dblclick');
    }
  };

  /** Track user-initiated pan (click-drag, touch-drag). Skip programmatic pans and zoom-induced moves. */
  private handleMoveEndTelemetry = (e: maplibregl.MapLibreEvent): void => {
    const orig = e.originalEvent;
    if (!orig) return; // programmatic — already tracked by trigger functions
    if (orig instanceof WheelEvent) return; // zoom gesture — tracked by zoomend
    if (orig instanceof MouseEvent) {
      trackNav('pan', 'mouse');
    } else if (typeof TouchEvent !== 'undefined' && orig instanceof TouchEvent) {
      trackNav('pan', 'touch');
    }
  };

  /**
   * UNIFIED click handler - gates candidates via the visible layers and resolves priority.
   * Stations take priority over shots unless the active tool suppresses one type
   * (move_shot suppresses stations, move_station suppresses shots).
   */
  // Boundary filter for the residual VT reload-removed noise MapLibre fires from
  // its own _loadTile catch, upstream of the registry guards (rationale on
  // shouldSuppressMapError). Suppress exactly that message for this survey's
  // stalx:// sources; re-log every other error, since MapLibre only console.errors
  // an ErrorEvent when it has NO listener (verified vs maplibre-gl 5.16
  // Evented.fire), so registering this listener would otherwise silence the map's
  // default logging for ALL errors.
  private handleMapError = (evt: MapErrorEventLike): void => {
    if (shouldSuppressMapError(evt, this.sourceId)) return;
    console.error(evt?.error ?? evt);
  };

  private handleMapClick = (e: MapMouseEvent): void => {
    // Ctrl+click in move tools is for panning, not interacting with features
    if (e.originalEvent.ctrlKey &&
        (this.activeTool === 'move_station' || this.activeTool === 'move_shot' || this.activeTool === 'move_segment')) {
      return;
    }

    // Tool-specific suppression (consistent with hover in processHoverUpdate)
    const suppressStationClick = this.activeTool === 'move_shot';
    const suppressShotClick = this.activeTool === 'move_station';

    // Padded visible-layer query gates candidate sections; SoA resolver picks
    // the exact item (#mem) — same targets/tolerances as the per-feature path.
    const { stationSections, shotSections } = this.hitCandidateSections(e.point);

    const stationHitReach = this.getStationHitReach();
    const shotHitReach = this.getShotHitReach();

    // Stations take priority - resolve nearest station first
    const nearestStation = !suppressStationClick
      ? this.resolveStationAt(e.point.x, e.point.y, stationSections, stationHitReach)
      : null;
    if (nearestStation) {
      const ref: StationRef = nearestStation.ref;
      // Debug logging - only on click, NOT hover (prevents console spam)
      if (this.config?.debug?.map?.log_hit_detection) {
        console.log('[HitDetection] Station click', {
          layer: this.stationsLayerId,
          featureId: `${ref.section_id}:${ref.station_index}`,
          coordinates: e.lngLat,
          candidateSections: stationSections.size,
        });
      }
      this.callbacks.onStationClick?.(ref, e);
      return;
    }

    // Then shots - resolve nearest shot
    const nearestShot = !suppressShotClick
      ? this.resolveShotAt(e.point.x, e.point.y, shotSections, shotHitReach)
      : null;
    if (nearestShot) {
      // Debug logging - only on click, NOT hover (prevents console spam)
      if (this.config?.debug?.map?.log_hit_detection) {
        console.log('[HitDetection] Shot click', {
          layer: this.shotsLayerId,
          featureId: `${nearestShot.sectionId}:${nearestShot.shotId}`,
          coordinates: e.lngLat,
          candidateSections: shotSections.size,
        });
      }
      this.callbacks.onShotClick?.(nearestShot.sectionId, nearestShot.shotId, e);
      return;
    }

    // Empty click - check for hidden features before firing empty callback
    this.handleEmptyClick(e);
  };

  /**
   * UNIFIED context menu handler - queries the visible layers and resolves priority.
   * Same pattern as click handler: stations take priority, uses nearest resolution.
   */
  private handleContextMenu = (e: MapMouseEvent): void => {
    // Same candidate-section gating + SoA resolution as the click handler.
    const { stationSections, shotSections } = this.hitCandidateSections(e.point);

    const stationHitReach = this.getStationHitReach();
    const shotHitReach = this.getShotHitReach();

    // Stations take priority
    const nearestStation = this.resolveStationAt(e.point.x, e.point.y, stationSections, stationHitReach);
    if (nearestStation) {
      const ref: StationRef = nearestStation.ref;
      // Debug logging - only on contextmenu, NOT hover (prevents console spam)
      if (this.config?.debug?.map?.log_hit_detection) {
        console.log('[HitDetection] Station context menu', {
          layer: this.stationsLayerId,
          featureId: `${ref.section_id}:${ref.station_index}`,
          coordinates: e.lngLat,
          candidateSections: stationSections.size,
        });
      }
      this.callbacks.onContextMenu?.({ type: 'station', ref }, e);
      return;
    }

    // Then shots
    const nearestShot = this.resolveShotAt(e.point.x, e.point.y, shotSections, shotHitReach);
    if (nearestShot) {
      // Debug logging - only on contextmenu, NOT hover (prevents console spam)
      if (this.config?.debug?.map?.log_hit_detection) {
        console.log('[HitDetection] Shot context menu', {
          layer: this.shotsLayerId,
          featureId: `${nearestShot.sectionId}:${nearestShot.shotId}`,
          coordinates: e.lngLat,
          candidateSections: shotSections.size,
        });
      }
      this.callbacks.onContextMenu?.(
        { type: 'shot', sectionId: nearestShot.sectionId, shotId: nearestShot.shotId },
        e
      );
      return;
    }

    // Empty context menu
    this.callbacks.onContextMenu?.(null, e);
  };

  /**
   * Candidate sections under a point/box, from the SoA geometry index
   * (#customRender / #mem). Candidate discovery no longer depends on stock-layer
   * residency: the endgame renders the survey via the custom WebGL layer, which
   * hides the stock shots/stations layers (visibility:none), and MapLibre returns
   * nothing from hidden layers. So instead of `queryRenderedFeatures` we ask the
   * geometry index for sections whose world-space bounds, projected to screen,
   * intersect the probe box padded by the type's hit reach. That padded-box query
   * is a SUPERSET of the sections whose geometry can be within tolerance; the SoA
   * resolver (`resolveStationAt` / `resolveShotAt` / `geoIndex.stationsInBox`)
   * then trims it to the exact pick. Per-type padding preserves the two old
   * queries' semantics (shot vs station reach differ); the pad is the FULL reach
   * because we test the true geometry, not a thin rendered mark. See
   * `hitProbe.ts` (`padProbeBox`) and `geometryIndex.ts`
   * (`sectionsIntersectingBox`), both unit tested.
   *
   * A type is gated by the USER visibility flags (`stationsVisible` /
   * `shotsVisible`, set by setStationsVisibility / setShotsVisibility): a
   * user-hidden type yields no candidates, exactly as the old query returned
   * nothing for a hidden layer, so clicks fall through to the hidden-feature
   * toast in `handleEmptyClick`. These flags are NOT raw layer visibility: the
   * custom renderer hiding the stock layers (visibility:none) leaves the survey
   * fully interactive, while a user "hide stations/shots" toggle still suppresses
   * hits.
   */
  private hitCandidateSections(
    geometry: maplibregl.PointLike | [maplibregl.PointLike, maplibregl.PointLike],
  ): { stationSections: Set<number>; shotSections: Set<number> } {
    let stationSections = new Set<number>();
    let shotSections = new Set<number>();
    if (!this.geoIndex || !hasLiveStyle(this.map)) return { stationSections, shotSections };
    const project = this.projector();
    // One camera snapshot for both probes: the geometry index reuses its
    // projected per-section AABBs across probes of the same camera, so a static
    // hover reprojects the 14k+ sections once, not once per probe (#customRender).
    const camera = this.cameraSnapshot();
    if (this.shotsVisible) {
      const [[minX, minY], [maxX, maxY]] = padProbeBox(
        geometry as ProbeGeometry,
        this.getShotHitReach(),
      );
      shotSections = this.geoIndex.sectionsIntersectingBox(project, minX, minY, maxX, maxY, camera);
    }
    if (this.stationsVisible) {
      const [[minX, minY], [maxX, maxY]] = padProbeBox(
        geometry as ProbeGeometry,
        this.getStationHitReach(),
      );
      stationSections = this.geoIndex.sectionsIntersectingBox(project, minX, minY, maxX, maxY, camera);
    }
    return { stationSections, shotSections };
  }

  /** Cheap camera snapshot keying the geometry index's projected-AABB cache.
   *  The key changes iff `map.project` would move a lng/lat to a new pixel;
   *  axisAligned (no bearing/pitch) enables the 2-corner reprojection fast path. */
  private cameraSnapshot(): { key: string; axisAligned: boolean } {
    const c = this.map.getCenter();
    const cv = this.map.getCanvas();
    const bearing = this.map.getBearing();
    const pitch = this.map.getPitch();
    const zoom = this.map.getZoom();
    // Quantize the center to ~pixel resolution so sub-pixel inertial-pan drift
    // does not invalidate the projected-AABB cache on every probe. `degPerPx` is
    // the Web-Mercator degrees-per-pixel at this zoom (512px tiles); a center
    // shift below one pixel cannot move any geometry by a pixel, and the cached
    // AABB is only tested against a hit radius of a few px. Zoom stays
    // full-precision (a zoom change genuinely rescales every projection).
    const degPerPx = 360 / (512 * 2 ** zoom);
    const qx = Math.round(c.lng / degPerPx);
    const qy = Math.round(c.lat / degPerPx);
    const key = `${zoom}|${qx}|${qy}|${bearing}|${pitch}|${cv.width}|${cv.height}`;
    return { key, axisAligned: bearing === 0 && pitch === 0 };
  }

  /** Screen projection closure for the geometry resolver. */
  private projector(): (c: [number, number]) => { x: number; y: number } {
    return (c) => this.map.project(c);
  }

  /** Nearest visible station among candidate sections, within maxDistance px. */
  private resolveStationAt(
    x: number,
    y: number,
    sections: Set<number>,
    maxDistance: number,
  ): ReturnType<SurveyGeometryIndex['nearestStation']> {
    if (sections.size === 0 || !this.geoIndex) return null;
    return this.geoIndex.nearestStation(this.projector(), x, y, sections, maxDistance, {
      includeReference: this.showReferenceShotsCached,
    });
  }

  /** Nearest visible shot among candidate sections, within maxDistance px. */
  private resolveShotAt(
    x: number,
    y: number,
    sections: Set<number>,
    maxDistance: number,
  ): ReturnType<SurveyGeometryIndex['nearestShot']> {
    if (sections.size === 0 || !this.geoIndex) return null;
    return this.geoIndex.nearestShot(this.projector(), x, y, sections, maxDistance, {
      includeReference: this.showReferenceShotsCached,
    });
  }

  /**
   * Stations whose rendered hit circle intersects the screen-space box —
   * MapCanvas box-select. Candidate sections come from the padded visible-layer
   * query (visibility-aware); exact membership from the SoA resolver with
   * the same circle-box semantics `queryRenderedFeatures(bbox)` had (#mem).
   */
  queryStationsInBox(minX: number, minY: number, maxX: number, maxY: number): StationRef[] {
    if (!this.geoIndex || !hasLiveStyle(this.map)) return [];
    const { stationSections } = this.hitCandidateSections([
      [minX, minY],
      [maxX, maxY],
    ]);
    if (stationSections.size === 0) return [];
    return this.geoIndex.stationsInBox(
      this.projector(),
      minX,
      minY,
      maxX,
      maxY,
      stationSections,
      this.getStationHitArea(),
      { includeReference: this.showReferenceShotsCached },
    );
  }

  /**
   * Handle empty click - check for hidden features before firing empty callback.
   * This provides toast feedback when clicking near hidden stations/shots.
   */
  private handleEmptyClick(e: MapMouseEvent): void {
    const HIDDEN_CLICK_THRESHOLD_PX = 15;

    // Probe hidden features through the SoA geometry index, not
    // querySourceFeatures: when the custom geometry layer is active the stock
    // `-stations` / `-shots` VT sources are dropped and serve empty tiles, so a
    // source query returns nothing and the "clicked near a hidden feature" toast
    // is silently lost. `geoIndex` holds every station/shot regardless of the
    // display toggle. Stations take priority over shots (matches prior behavior).
    const allSections = this.geoIndex ? new Set(this.cachedSections.map((s) => s.id)) : null;

    if (allSections && !this.stationsVisible && this.callbacks.onHiddenStationClick) {
      if (this.resolveStationAt(e.point.x, e.point.y, allSections, HIDDEN_CLICK_THRESHOLD_PX)) {
        this.callbacks.onHiddenStationClick();
        return;
      }
    }

    if (allSections && !this.shotsVisible && this.callbacks.onHiddenShotClick) {
      if (this.resolveShotAt(e.point.x, e.point.y, allSections, HIDDEN_CLICK_THRESHOLD_PX)) {
        this.callbacks.onHiddenShotClick();
        return;
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
    return sectionId! * FEATURE_ID_STRIDE + index!;
  }

  // Collect all feature IDs belonging to a section from a given source.
  // Uses pre-built lookup maps (O(1)) instead of querySourceFeatures (O(N)).
  private getSectionFeatureIds(source: string, sectionIdStr: string): Set<number> {
    const sectionIdNum = Number(sectionIdStr);
    const isShots = source.endsWith('-shots');
    const map = isShots ? this.sectionShotFeatureIds : this.sectionStationFeatureIds;
    return map.get(sectionIdNum) ?? new Set();
  }

  // Get the effective section IDs for hover highlighting.
  // Segment hover (multi-section) takes priority over single-section hover.
  private getEffectiveHoverSectionIds(): string[] {
    if (this.hoveredSegmentSectionIds.length > 0) return this.hoveredSegmentSectionIds;
    if (this.hoveredSectionId) return [this.hoveredSectionId];
    return [];
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

  // Check if a feature belongs to an anchored section (suppresses hover/interaction)
  private isFeatureAnchored(featureId: number): boolean {
    return this.anchoredSectionIds.size > 0 &&
      this.anchoredSectionIds.has(Math.floor(featureId / FEATURE_ID_STRIDE));
  }

  // Check if a station feature is individually immovable (zero-datum or transitively connected)
  private isStationImmovable(featureId: number): boolean {
    return this.immovableStationFeatureIds.has(featureId);
  }

  // Check if a shot feature is individually immovable (endpoint is zero-datum or transitively connected)
  private isShotImmovable(featureId: number): boolean {
    return this.immovableShotFeatureIds.has(featureId);
  }

  private shouldLogInteraction(): boolean {
    return this.config?.debug?.map?.log_hit_detection ?? false;
  }

  // Update visual state. Section-level highlights stay feature-state based:
  // with merged sources the ids are GROUP ids and a section's groups cover
  // exactly its members, so group granularity is pixel-identical; with
  // per-feature content (overlay modes) the ids are per-feature, as before.
  // Individual hover/selection/snap render via the interact overlay (#mem)
  // in both modes — see refreshInteractOverlay.
  private updateVisualState() {
    const stationsSource = this.sourceId + '-stations';
    const shotsSource = this.sourceId + '-shots';

    // --- Section hover (shots + stations) ---
    {
      const { shots: newHoveredShotIds, stations: newHoveredStationIds } =
        this.getCachedHoveredSectionIds(shotsSource, stationsSource);

      // Clear previous section-hovered shots not in new set
      for (const id of this.prevHoveredSectionShotIds) {
        if (!newHoveredShotIds.has(id)) {
          this.map.setFeatureState({ source: shotsSource, sourceLayer: VT_SOURCE_LAYER, id }, { hover: false });
        }
      }
      // Set new section-hovered shots not in prev set.
      // During move_segment: always re-apply hover on all section shots to ensure visual
      // consistency (individual hover interactions can leave stale feature-state).
      const forceReapply = this.activeTool === 'move_segment';
      for (const id of newHoveredShotIds) {
        if (forceReapply || !this.prevHoveredSectionShotIds.has(id)) {
          this.map.setFeatureState({ source: shotsSource, sourceLayer: VT_SOURCE_LAYER, id }, { hover: true });
        }
      }
      this.prevHoveredSectionShotIds = newHoveredShotIds;

      // Clear previous section-hovered stations not in new set
      for (const id of this.prevHoveredSectionStationIds) {
        if (!newHoveredStationIds.has(id)) {
          this.map.setFeatureState({ source: stationsSource, sourceLayer: VT_SOURCE_LAYER, id }, { hover: false });
        }
      }
      // Set new section-hovered stations not in prev set
      for (const id of newHoveredStationIds) {
        if (forceReapply || !this.prevHoveredSectionStationIds.has(id)) {
          this.map.setFeatureState({ source: stationsSource, sourceLayer: VT_SOURCE_LAYER, id }, { hover: true });
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
        if (!newSelectedShotIds.has(id)) {
          this.map.setFeatureState({ source: shotsSource, sourceLayer: VT_SOURCE_LAYER, id }, { selected: false });
        }
      }
      // Set new section-selected shots not in prev set
      for (const id of newSelectedShotIds) {
        if (!this.prevSelectedSectionShotIds.has(id)) {
          this.map.setFeatureState({ source: shotsSource, sourceLayer: VT_SOURCE_LAYER, id }, { selected: true });
        }
      }
      this.prevSelectedSectionShotIds = newSelectedShotIds;

      // Clear previous section-selected stations not in new set
      for (const id of this.prevSelectedSectionStationIds) {
        if (!newSelectedStationIds.has(id)) {
          this.map.setFeatureState({ source: stationsSource, sourceLayer: VT_SOURCE_LAYER, id }, { selected: false });
        }
      }
      // Set new section-selected stations not in prev set
      for (const id of newSelectedStationIds) {
        if (!this.prevSelectedSectionStationIds.has(id)) {
          this.map.setFeatureState({ source: stationsSource, sourceLayer: VT_SOURCE_LAYER, id }, { selected: true });
        }
      }
      this.prevSelectedSectionStationIds = newSelectedStationIds;
    }

    // --- Individual hover / selection / snap: interact overlay (#mem) ---
    this.refreshInteractOverlay();
  }

  /**
   * Rebuild the interact overlay source from the current individual
   * interaction state (hovered/selected shot + station, snapped/highlighted
   * stations). A handful of features per update; geometry and colors come
   * from the SoA resolver + the same helpers the bulk build used, so the
   * overlay renders pixel-identical to what per-feature feature-state
   * rendered. Skipped when the composed state key is unchanged.
   */
  private refreshInteractOverlay(): void {
    if (!hasLiveStyle(this.map)) return;
    const source = this.map.getSource(this.interactSourceId);
    if (!source || source.type !== 'geojson') return;

    const key = [
      this.hoveredShotId,
      this.selectedShotId,
      this.hoveredStationId,
      this.selectedStationId,
      this.snappedStationId,
      this.highlightedStationIds.join(','),
    ].join('§');
    // During a drag the feature IDs are unchanged but their coordinates move, so
    // the id-based cache would wrongly short-circuit — bypass it while following.
    if (this.dragOverlayOffset === null && key === this.lastInteractKey) return;
    this.lastInteractKey = key;

    const features: GeoJSON.Feature[] = [];

    // While the custom ghost is active, the grabbed MOVING feature's highlight is
    // drawn IN the ghost (shares its offset uniform, no lag), so suppress the
    // per-frame overlay copy for moving features; non-moving overlay state stays.
    const suppress = this.dragGhost.isCustom();
    const keepShot = (id: string | null): string | null =>
      suppress && id && this.dragMovingShots.has(id) ? null : id;
    const keepStation = (id: string | null): string | null =>
      suppress && id && this.dragMovingStationKeys.has(id) ? null : id;

    // Shots: hover wins over selection on the same shot (matches the old
    // paint case order: hover width > selected width).
    const hoveredShot = keepShot(this.hoveredShotId);
    const selectedShot = keepShot(this.selectedShotId !== this.hoveredShotId ? this.selectedShotId : null);
    if (hoveredShot) {
      const fid = this.parseFeatureId(hoveredShot);
      // Old behavior: no hover feedback for anchored/immovable shots.
      if (fid === null || (!this.isFeatureAnchored(fid) && !this.isShotImmovable(fid))) {
        const f = this.shotOverlayFeature(hoveredShot, this.getShotHoverWidth());
        if (f) features.push(f);
      }
    }
    if (selectedShot) {
      const f = this.shotOverlayFeature(selectedShot, this.getShotSelectionWidth());
      if (f) features.push(f);
    }

    // Stations: hover wins over selection on the same station.
    const hoveredStation = keepStation(this.hoveredStationId);
    const selectedStation =
      keepStation(this.selectedStationId !== this.hoveredStationId ? this.selectedStationId : null);
    if (hoveredStation) {
      const fid = this.parseFeatureId(hoveredStation);
      if (fid === null || (!this.isFeatureAnchored(fid) && !this.isStationImmovable(fid))) {
        const f = this.stationOverlayFeature(hoveredStation, 'hover');
        if (f) features.push(f);
      }
    }
    if (selectedStation) {
      const f = this.stationOverlayFeature(selectedStation, 'selected');
      if (f) features.push(f);
    }

    // Snap indicator + highlighted stations (both use the snap ring layer).
    const snapIds = new Set<string>(this.highlightedStationIds);
    if (this.snappedStationId) snapIds.add(this.snappedStationId);
    for (const id of snapIds) {
      const [secStr, idxStr] = id.split(':');
      const coords = this.geoIndex?.stationCoords({
        section_id: Number(secStr),
        station_index: Number(idxStr),
      });
      if (coords) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: coords },
          properties: { kind: 'snap' },
        });
      }
    }

    (source as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  /** The color context matching the last build (see features.ts helpers). */
  private displayColorContext(): DisplayColorContext {
    return {
      showDepthGradient: this.showDepthGradient,
      depthRange: this.depthRange,
      themeColors: this.themeColors,
      showIssueSeverity: this.showIssueSeverity && !!this.cachedIssueSeverity,
      issueSeverity: this.cachedIssueSeverity,
    };
  }

  /**
   * One interact-overlay feature for a shot ("sectionId:shotId"), drawn at
   * `width`. Kind `shotMeasured` (measure tint, round caps, above the tint
   * layer) when the shot is on the measured path, else `shot` (its exact bulk
   * color; the ramp expressions take over in distance/gas modes via the
   * carried dist/gasReach values).
   */
  private shotOverlayFeature(idStr: string, width: number): GeoJSON.Feature | null {
    if (!this.geoIndex || !this.cachedSurveyData) return null;
    const [secStr, shotStr] = idStr.split(':');
    const sectionId = Number(secStr);
    const shotId = Number(shotStr);
    if (Number.isNaN(sectionId) || Number.isNaN(shotId)) return null;
    const geo = this.geoIndex.shotGeometry(sectionId, shotId);
    if (!geo) return null;
    // Hidden reference shots must not surface via the overlay either.
    if (geo.isReference && !this.showReferenceShotsCached) return null;

    const fid = this.parseFeatureId(idStr);
    const measured = fid !== null && this.measuredPathIds?.has(fid);
    const section = this.geoIndex.section(sectionId);
    const color = measured
      ? this.measureTintColor
      : resolveShotDisplayColor(
          this.cachedSurveyData,
          section?.color ?? this.themeColors.stationDefault,
          geo.globalIdx,
          this.displayColorContext(),
        );
    const opacity = fid !== null && this.isFeatureAnchored(fid) ? 0.25 : geo.isReference ? 0.5 : 1;
    const properties: Record<string, unknown> = {
      kind: measured ? 'shotMeasured' : 'shot',
      color,
      width,
      opacity,
    };
    // Overlay modes read these via the same ramp expressions as the bulk
    // layers (GPU-identical colors). -1 = unreachable (renders grey).
    if (this.distanceMode && fid !== null) {
      properties.dist = this.distanceState?.shots.get(fid) ?? -1;
    }
    if (this.gasReachMode && fid !== null) {
      properties.gasReach = this.gasReachState?.shots.get(fid) ?? -1;
    }
    // Follow an active drag: stretch this shot's moving endpoint(s) by the offset
    // so a selected/hovered highlight tracks the preview (#C).
    const off = this.dragOverlayOffset;
    const { from, to } = off
      ? offsetOverlayShot(geo.from, geo.to, this.dragMovingShots.get(idStr), this.dragProjector(), off.dx, off.dy)
      : { from: geo.from, to: geo.to };
    return {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [from, to] },
      properties,
    };
  }

  /**
   * One interact-overlay feature for a station ("sectionId:stationIndex") in
   * hover or selected style — the same radius/stroke the old feature-state
   * paint cases produced.
   */
  private stationOverlayFeature(idStr: string, style: 'hover' | 'selected'): GeoJSON.Feature | null {
    if (!this.geoIndex || !this.cachedSurveyData) return null;
    const [secStr, idxStr] = idStr.split(':');
    const ref = { section_id: Number(secStr), station_index: Number(idxStr) };
    if (Number.isNaN(ref.section_id) || Number.isNaN(ref.station_index)) return null;
    const coords = this.geoIndex.stationCoords(ref);
    const g = this.geoIndex.stationGlobalIndex(ref);
    if (!coords || g === null) return null;
    // A station hidden by the reference-shots toggle must not surface via a
    // highlight (matches the old stations-layer filter swallowing the ring).
    if (!this.showReferenceShotsCached && this.geoIndex.isAllReferenceStation(ref)) return null;

    const fid = this.parseFeatureId(idStr);
    const section = this.geoIndex.section(ref.section_id);
    const ctx = this.displayColorContext();
    const measured = fid !== null && this.measuredPathStationIds?.has(fid);
    const color = measured
      ? this.measureTintColor
      : resolveStationDisplayColor(
          this.cachedSurveyData,
          section?.color ?? this.themeColors.stationDefault,
          g,
          ctx,
        );
    const properties: Record<string, unknown> = {
      kind: 'station',
      color,
      radius: style === 'hover' ? this.getStationHoverRadius() : this.getStationSelectionRadius(),
      strokeWidth: style === 'hover' ? 4 : 2.5,
      strokeColor:
        style === 'hover' ? this.themeColors.hoverHighlight : this.themeColors.selectHighlight,
      opacity: fid !== null && this.isFeatureAnchored(fid) ? 0.25 : 1,
    };
    if (this.distanceMode && fid !== null) {
      properties.dist = this.distanceState?.stations.get(fid) ?? -1;
    }
    if (this.gasReachMode && fid !== null) {
      properties.gasReach = this.gasReachState?.stations.get(fid) ?? -1;
    }
    // Follow an active drag: offset this station's highlight if it is moving (#C).
    const off = this.dragOverlayOffset;
    const point = off
      ? offsetOverlayPoint(coords, this.dragMovingStationKeys.has(idStr), this.dragProjector(), off.dx, off.dy)
      : coords;
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: point },
      properties,
    };
  }

  /**
   * Apply the distance-gradient overlay (#34). `enabled` swaps the shots/stations
   * color paint to the distance ramp (or restores section/depth color); `state`
   * carries per-feature `dist` (feature-id → distance, -1 = unreachable).
   * Re-rooting just calls this again — no feature rebuild.
   */
  setDistanceGradient(enabled: boolean, state: DistanceFeatureState | null): void {
    this.distanceMode = enabled;
    this.distanceState = state;
    if (!this.map || !hasLiveStyle(this.map)) return;
    // Distance is a per-shot overlay: switch the bulk sources to per-feature
    // content while it's active (merged groups can't carry per-shot `dist`).
    // The rebuild's endApplyFeatures re-applies the feature-state below.
    this.ensureFeatureGranularity();
    this.applyOverlayPaint();
    this.applyDistanceFeatureState();
    // Custom renderer (no feature-state): rebuild with the new overlay colors.
    this.resyncCustomRenderFromStore();
  }

  /**
   * Apply the gas reachable-frontier overlay (#38). Mirrors
   * {@link setDistanceGradient}: `enabled` swaps the shots/stations color to the
   * gas ramp (gold near the origin → purple at the turn budget, grey =
   * unreachable); `state` carries per-feature `gasReach` (litres-to-reach).
   * Re-running on an input change just calls this again — no feature rebuild.
   */
  setGasReach(enabled: boolean, state: GasReachFeatureState | null): void {
    this.gasReachMode = enabled;
    this.gasReachState = state;
    if (!this.map || !hasLiveStyle(this.map)) return;
    // Per-shot overlay mode: needs per-feature source content (see
    // setDistanceGradient).
    this.ensureFeatureGranularity();
    this.applyOverlayPaint();
    this.applyGasReachFeatureState();
    // Custom renderer (no feature-state): rebuild with the new overlay colors.
    this.resyncCustomRenderFromStore();
  }

  /**
   * Apply the gas route highlight (#233): the picked penetration route drawn over the survey —
   * swum legs at full opacity, jump legs faded (#243). Has its own GeoJSON source (survives
   * `setData()`); the legs are stored so `applyFeaturesToSources` re-pushes them after a feature
   * rebuild. `[]` clears it.
   */
  setGasRoute(legs: RouteLeg[]): void {
    this.gasRouteLegs = legs;
    this.applyGasRoute();
  }

  /** Build one LineString per route leg (with `isJump` flagged) from `cachedStations` and push them
   *  to the gas-route source. No-op without a live style or the source. */
  private applyGasRoute(): void {
    if (!this.map || !hasLiveStyle(this.map)) return;
    const source = this.map.getSource(this.sourceId + '-gas-route');
    if (!source || source.type !== 'geojson') return;
    const geojsonSource = source as maplibregl.GeoJSONSource;
    // Index the stations once (keyed by section:index) so the per-leg endpoint lookups are O(1) —
    // the route can be long and this re-runs after every setData() rebuild, so a linear scan per
    // endpoint would be quadratic on large surveys.
    const coordByRef = new Map<string, [number, number]>();
    for (const s of this.cachedStations) {
      coordByRef.set(
        `${s.station_ref.section_id}:${s.station_ref.station_index}`,
        metersToMapCoords(s.coordinates.x, s.coordinates.y, this.gpsOrigin) as [number, number],
      );
    }
    const coordFor = (ref: StationRef): [number, number] | null =>
      coordByRef.get(`${ref.section_id}:${ref.station_index}`) ?? null;
    const features = this.gasRouteLegs.flatMap((leg) => {
      const from = coordFor(leg.from);
      const to = coordFor(leg.to);
      if (!from || !to) return [];
      return [
        {
          type: 'Feature' as const,
          geometry: { type: 'LineString' as const, coordinates: [from, to] },
          properties: { isJump: leg.is_jump },
        },
      ];
    });
    geojsonSource.setData({ type: 'FeatureCollection', features });
  }

  /** The distance-gradient color ramp, shared by the shots line-color and the
   *  stations circle-color so the two can't drift. */
  private distanceRampExpression(): ExpressionSpecification {
    return distanceColorExpression(
      DISTANCE_NEAR,
      DISTANCE_FAR,
      this.distanceState?.max ?? 0,
      this.themeColors.grayLine,
    );
  }

  /** The gas reachable-frontier ramp, shared by the shots line-color and the
   *  stations circle-color so the two can't drift. */
  private gasReachRampExpression(): ExpressionSpecification {
    return gasReachColorExpression(
      GAS_NEAR,
      GAS_FAR,
      this.gasReachState?.max ?? 0,
      this.themeColors.grayLine,
    );
  }

  /** The per-feature "plain" color, resolved from the numeric `colorIndex` via a
   *  `match` over the last build's palette (#B). Replaces the old `['get','color']`
   *  everywhere the shots/gradients/stations base color was read. Exact-color: it's
   *  a literal lookup of the same string the builder produced. */
  private colorExpr(): ExpressionSpecification | string {
    return paletteMatchExpression(['get', 'colorIndex'], this.colorPalette);
  }

  /** The stations' per-feature stroke color, resolved from `strokeColorIndex` via
   *  the same palette (#B). Replaces the old `['get','strokeColor']`. */
  private strokeColorExpr(): ExpressionSpecification | string {
    return paletteMatchExpression(['get', 'strokeColorIndex'], this.colorPalette);
  }

  /** The stations layer's full `circle-stroke-color`: hover/selected highlight
   *  states win, else the per-feature palette stroke color. */
  private stationsStrokeColor(): ExpressionSpecification {
    return [
      'case',
      ['boolean', ['feature-state', 'hover'], false], this.themeColors.hoverHighlight,
      ['boolean', ['feature-state', 'selected'], false], this.themeColors.selectHighlight,
      this.strokeColorExpr(),
    ] as ExpressionSpecification;
  }

  /** A `measured` feature-state tint case (#26) over the plain per-feature color,
   *  or just the plain color when no path is set. Shared by shots/stations. */
  private measuredTintExpression(measuredIds: Set<number> | null): ExpressionSpecification | string {
    if (measuredIds && measuredIds.size > 0) {
      return [
        'case',
        ['boolean', ['feature-state', 'measured'], false],
        this.measureTintColor,
        this.colorExpr(),
      ] as ExpressionSpecification;
    }
    return this.colorExpr();
  }

  /** Wrap `base` with a move-comment palette tint (#52): features carrying a
   *  `commentColor` property (the comment's own shot/station) render in that
   *  color; everything else falls through to `base` unchanged. Only called
   *  from the plain/measured branch of shots/stations color - the distance
   *  and gas-reach overlays own color outright while active, so the tint
   *  yields to them rather than fighting for the same paint property. */
  private commentToolTintExpression(base: ExpressionSpecification | string): ExpressionSpecification {
    return ['coalesce', ['get', 'commentColor'], base] as ExpressionSpecification;
  }

  /** The shots layer's `line-color`: distance ramp when active, else the measured
   *  along-line tint (#26), else plain. (The `measurePathLayerId` overlay redraws
   *  the tint on top of the depth gradient; this keeps it correct when the gradient
   *  is off and centralizes the distance-vs-tint precedence.) */
  private shotsLineColor(): ExpressionSpecification | string {
    if (this.distanceMode) return this.distanceRampExpression();
    if (this.gasReachMode) return this.gasReachRampExpression();
    const base = this.measuredTintExpression(this.measuredPathIds);
    return this.activeTool === 'move_comment' ? this.commentToolTintExpression(base) : base;
  }

  /** The stations layer's `circle-color`: distance ramp when active, else the
   *  measured-path tint for the path's stations (#26), else plain. */
  private stationsCircleColor(): ExpressionSpecification | string {
    if (this.distanceMode) return this.distanceRampExpression();
    if (this.gasReachMode) return this.gasReachRampExpression();
    const base = this.measuredTintExpression(this.measuredPathStationIds);
    return this.activeTool === 'move_comment' ? this.commentToolTintExpression(base) : base;
  }

  /** Re-apply the palette-driven color paint to the shots, shot-gradient and
   *  stations layers after a feature build (the palette can change with theme /
   *  depth / severity / edits). Overlay modes (distance / gas) still win via
   *  shotsLineColor/stationsCircleColor. */
  private applyColorPaint(): void {
    if (!this.map || !hasLiveStyle(this.map)) return;
    if (this.map.getLayer(this.shotsLayerId)) {
      this.map.setPaintProperty(this.shotsLayerId, 'line-color', this.shotsLineColor());
    }
    if (this.map.getLayer(this.shotGradientsLayerId)) {
      this.map.setPaintProperty(this.shotGradientsLayerId, 'line-color', this.colorExpr());
    }
    if (this.map.getLayer(this.stationsLayerId)) {
      this.map.setPaintProperty(this.stationsLayerId, 'circle-color', this.stationsCircleColor());
      this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-color', this.stationsStrokeColor());
    }
    this.applyInteractPaint();
  }

  /**
   * Keep the interact overlay's color inputs in step with the active overlay
   * mode (#mem): plain state reads the resolved per-feature `color` property;
   * distance / gas-reach modes read the carried `dist` / `gasReach` value
   * through the SAME ramp expressions the bulk layers use, so the overlay's
   * colors are GPU-identical to what feature-state produced.
   */
  private applyInteractPaint(): void {
    if (!this.map || !hasLiveStyle(this.map)) return;
    const colorProp: ExpressionSpecification = ['get', 'color'] as ExpressionSpecification;
    const shotColor = this.distanceMode
      ? distanceColorExpression(
          DISTANCE_NEAR,
          DISTANCE_FAR,
          this.distanceState?.max ?? 0,
          this.themeColors.grayLine,
          ['get', 'dist'] as ExpressionSpecification,
        )
      : this.gasReachMode
        ? gasReachColorExpression(
            GAS_NEAR,
            GAS_FAR,
            this.gasReachState?.max ?? 0,
            this.themeColors.grayLine,
            ['get', 'gasReach'] as ExpressionSpecification,
          )
        : colorProp;
    if (this.map.getLayer(this.interactShotsLayerId)) {
      this.map.setPaintProperty(this.interactShotsLayerId, 'line-color', shotColor);
    }
    if (this.map.getLayer(this.interactStationsLayerId)) {
      this.map.setPaintProperty(this.interactStationsLayerId, 'circle-color', shotColor);
    }
  }

  /** Swap shots/stations color to whichever analytical overlay is active (the
   *  distance gradient or the gas reachable-frontier), or restore, and suspend the
   *  depth sub-segment layer so the overlay - or the move-comment palette tint
   *  (#52) - wins cleanly. */
  private applyOverlayPaint(): void {
    if (!this.map) return;
    if (this.map.getLayer(this.shotsLayerId)) {
      this.map.setPaintProperty(this.shotsLayerId, 'line-color', this.shotsLineColor());
    }
    if (this.map.getLayer(this.stationsLayerId)) {
      this.map.setPaintProperty(this.stationsLayerId, 'circle-color', this.stationsCircleColor());
    }
    // The interact overlay's color inputs follow the same mode swap; its
    // features also need rebuilding (they carry mode-scoped dist/gasReach).
    this.applyInteractPaint();
    this.lastInteractKey = null;
    this.refreshInteractOverlay();
    // Depth's per-segment gradient renders above the main shot line; hide it while
    // distance/gas-reach is active so it can't cover their colors, and while
    // move_comment is active so it can't cover the comment tint (#52 - it draws
    // on the same shots line but ABOVE it, so the coalesce in commentToolTintExpression
    // isn't enough on its own). The measure tint overlay (#26) is intentionally NOT
    // suspended here — the ruler highlight must always sit on top of whatever owns
    // the shot color. When restoring the gradient, match the main shots layer's
    // visibility rather than forcing 'visible' — the user may have Shots hidden
    // (then depth segments must stay hidden too).
    if (this.map.getLayer(this.shotGradientsLayerId)) {
      const shotsVisibility =
        (this.map.getLayoutProperty(this.shotsLayerId, 'visibility') as string | undefined) ??
        'visible';
      this.map.setLayoutProperty(
        this.shotGradientsLayerId,
        'visibility',
        this.distanceMode || this.gasReachMode || this.activeTool === 'move_comment'
          ? 'none'
          : shotsVisibility,
      );
    }
  }

  /** Push per-feature `dist` into feature-state (no-op when the overlay is off). */
  private applyDistanceFeatureState(): void {
    if (!this.map || !this.distanceMode || !this.distanceState) return;
    const shotsSource = this.sourceId + '-shots';
    const stationsSource = this.sourceId + '-stations';
    for (const [id, dist] of this.distanceState.shots) {
      this.map.setFeatureState({ source: shotsSource, sourceLayer: VT_SOURCE_LAYER, id }, { dist });
    }
    for (const [id, dist] of this.distanceState.stations) {
      this.map.setFeatureState({ source: stationsSource, sourceLayer: VT_SOURCE_LAYER, id }, { dist });
    }
  }

  /** Push per-feature `gasReach` into feature-state (no-op when the overlay is off). */
  private applyGasReachFeatureState(): void {
    if (!this.map || !this.gasReachMode || !this.gasReachState) return;
    const shotsSource = this.sourceId + '-shots';
    const stationsSource = this.sourceId + '-stations';
    for (const [id, gasReach] of this.gasReachState.shots) {
      this.map.setFeatureState({ source: shotsSource, sourceLayer: VT_SOURCE_LAYER, id }, { gasReach });
    }
    for (const [id, gasReach] of this.gasReachState.stations) {
      this.map.setFeatureState({ source: stationsSource, sourceLayer: VT_SOURCE_LAYER, id }, { gasReach });
    }
  }

  /** Tint the measured along-cave-line path's shots AND stations (#26) in `color`,
   *  or clear with empty/null sets. Mirrors the distance-gradient overlay: a
   *  `measured` feature-state + a paint `case` (see `shotsLineColor` /
   *  `stationsCircleColor`). The distance gradient still wins on color while it's
   *  active; the tint resurfaces when it turns off. */
  setMeasuredPath(shotIds: Set<number> | null, stationIds: Set<number> | null, color: string): void {
    const shotsSource = this.sourceId + '-shots';
    const stationsSource = this.sourceId + '-stations';
    // Clear any previous tint feature-state.
    if (this.map && this.measuredPathIds) {
      for (const id of this.measuredPathIds) {
        this.map.setFeatureState({ source: shotsSource, sourceLayer: VT_SOURCE_LAYER, id }, { measured: false });
      }
    }
    if (this.map && this.measuredPathStationIds) {
      for (const id of this.measuredPathStationIds) {
        this.map.setFeatureState({ source: stationsSource, sourceLayer: VT_SOURCE_LAYER, id }, { measured: false });
      }
    }
    this.measuredPathIds = shotIds && shotIds.size > 0 ? shotIds : null;
    this.measuredPathStationIds = stationIds && stationIds.size > 0 ? stationIds : null;
    this.measureTintColor = color;
    if (!this.map || !hasLiveStyle(this.map)) return;
    // The tint is a per-shot feature-state: needs per-feature source content
    // while a path is set (endApplyFeatures re-applies the state after the
    // rebuild). Clearing the path returns to merged content.
    this.ensureFeatureGranularity();
    // Overlay features carry the tint decision — rebuild them.
    this.lastInteractKey = null;
    this.refreshInteractOverlay();
    if (this.map.getLayer(this.shotsLayerId)) {
      this.map.setPaintProperty(this.shotsLayerId, 'line-color', this.shotsLineColor());
    }
    if (this.map.getLayer(this.stationsLayerId)) {
      this.map.setPaintProperty(this.stationsLayerId, 'circle-color', this.stationsCircleColor());
    }
    // The on-top tint overlay (#26) reads the same `measured` feature-state; only
    // its color needs updating here. Its filter toggles between "match nothing"
    // (no path -> empty bucket, #mem) and the active/reference filter.
    if (this.map.getLayer(this.measurePathLayerId)) {
      this.map.setPaintProperty(this.measurePathLayerId, 'line-color', this.measureTintColor);
      this.map.setFilter(this.measurePathLayerId, this.measurePathFilter());
    }
    this.applyMeasuredPathFeatureState();
  }

  /**
   * Filter for the survey-measure-path overlay layer (#mem budget). When no
   * path is measured — the steady state, always in merged mode — this excludes
   * every feature so MapLibre builds an EMPTY vertex bucket instead of a full
   * duplicate of the ~75k-segment shots geometry (a fully-filtered-out layer
   * retains no vertices/GL buffers). When a path IS set the source is switched
   * to per-feature content and the tint renders via the `measured`
   * feature-state, so we restore the active filter (mirroring the shots layer:
   * null, or exclude reference legs while reference shots are hidden).
   */
  private measurePathFilter(): maplibregl.FilterSpecification | null {
    if (this.measuredPathIds === null && this.measuredPathStationIds === null) {
      return SurveyLayer.MATCH_NOTHING_FILTER;
    }
    return this.showReferenceShotsCached ? null : ['!=', ['get', 'isReference'], true];
  }

  /** Push the `measured` feature-state for the tinted path shots + stations (no-op
   *  when empty). Re-applied after source rebuilds clear feature-state. */
  private applyMeasuredPathFeatureState(): void {
    if (!this.map) return;
    if (this.measuredPathIds) {
      const shotsSource = this.sourceId + '-shots';
      for (const id of this.measuredPathIds) {
        this.map.setFeatureState({ source: shotsSource, sourceLayer: VT_SOURCE_LAYER, id }, { measured: true });
      }
    }
    if (this.measuredPathStationIds) {
      const stationsSource = this.sourceId + '-stations';
      for (const id of this.measuredPathStationIds) {
        this.map.setFeatureState({ source: stationsSource, sourceLayer: VT_SOURCE_LAYER, id }, { measured: true });
      }
    }
  }

  // Update ghost hitbox layer sizes from config. The main shots/stations hit
  // areas are no longer layer paint (the dedicated hitbox layers were removed,
  // #mem budget); they are read live per query in hitCandidateSections via
  // getShot/StationHitReach(), so config changes take effect with no layer edit.
  private updateHitboxLayers(): void {
    if (!this.map) return;

    const stationHitArea = this.getStationHitArea();
    const shotHitArea = this.getShotHitArea();

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

  // Update debug visualization based on config.
  // The main shots/stations hitbox layers were removed (#mem budget), so the
  // show_hitboxes debug toggle no longer paints a visible outline for the main
  // hit areas (hit-testing is a padded query on the visible layers now). The
  // ghost hitbox layers still honor it for merge-preview debugging.
  private updateDebugVisualization(): void {
    if (!this.map) return;

    const showHitboxes = this.config?.debug?.map?.show_hitboxes ?? false;
    const debugColor = 'rgba(255, 0, 0, 0.3)'; // Semi-transparent red for debug
    const opaqueColor = '#000000'; // OPAQUE color for normal mode (opacity controls visibility)

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
    const newId = ref ? `${ref.section_id}:${ref.station_index}` : null;
    if (this.shouldLogInteraction() && newId !== this.selectedStationId) {
      console.debug('[Selection] Selected station changed', {
        previous: this.selectedStationId,
        next: newId,
      });
    }
    this.selectedStationId = newId;
    this.updateVisualState();
  }

  // Set selected shot (called from outside to sync with uiStore)
  setSelectedShot(sectionId: SectionId | null, shotId: ShotId | null) {
    const newId = sectionId !== null && shotId !== null ? `${sectionId}:${shotId}` : null;
    if (this.shouldLogInteraction() && newId !== this.selectedShotId) {
      console.debug('[Selection] Selected shot changed', {
        previous: this.selectedShotId,
        next: newId,
      });
    }
    this.selectedShotId = newId;
    this.updateVisualState();
  }

  // Set snapped station (called from outside for snap indicator)
  // Uses setFeatureState for instant GPU-side update (same mechanism as hover).
  setSnappedStation(ref: StationRef | null) {
    const newId = ref ? `${ref.section_id}:${ref.station_index}` : null;
    if (this.snappedStationId === newId) return;
    this.snappedStationId = newId;

    // During a live move drag EVERY interact refresh is funneled through the
    // per-frame renderOverlayFollow pass, so the snap ring and the grabbed
    // highlight update together in the SAME rAF tick. A snap-target change is
    // driven by the same pointer move that schedules that frame, so the ring
    // lands one frame later at most; outside a drag, refresh immediately as
    // before. (The moving ghost follows synchronously via its own translate.)
    if (this.dragPreviewActive && !this.dragCommitPending) return;

    // Snap ring renders from the interact overlay (#mem): pushing one small
    // feature is as instant as the old per-feature feature-state was.
    this.refreshInteractOverlay();
  }

  /**
   * Query the nearest station to a screen point. The padded visible-layer query
   * (MapLibre's spatial index) gates the candidate sections; the SoA resolver
   * picks the exact station with a circular `threshold` (the old post-check
   * for corner candidates is inherent in the resolver's maxDistance) (#mem).
   */
  queryNearestStation(
    screenX: number,
    screenY: number,
    threshold: number
  ): StationRef | null {
    const bbox: [[number, number], [number, number]] = [
      [screenX - threshold, screenY - threshold],
      [screenX + threshold, screenY + threshold],
    ];
    const { stationSections } = this.hitCandidateSections(bbox);
    const nearest = this.resolveStationAt(screenX, screenY, stationSections, threshold);
    return nearest ? nearest.ref : null;
  }

  /**
   * Nearest shot to a screen point, plus the fractional position `t` ∈ [0,1]
   * along that shot's line (#26 ruler snap-to-shot). The caller interpolates the
   * 3D coords at `t` from the active stations (the 2D shot geometry has no z).
   * Returns null when no shot is within `threshold` pixels (circular — the
   * old corner post-check is inherent in the resolver's maxDistance).
   *
   * The SoA resolver computes `t` and the snap point from the TRUE shot
   * endpoints (#mem), which also fixes the previously-documented edge case
   * where tile-clipped rendered geometry skewed `t` for long shots.
   */
  queryNearestShotPoint(
    screenX: number,
    screenY: number,
    threshold: number
  ): { section_id: number; shot_id: number; t: number; lng: number; lat: number } | null {
    const bbox: [[number, number], [number, number]] = [
      [screenX - threshold, screenY - threshold],
      [screenX + threshold, screenY + threshold],
    ];
    const { shotSections } = this.hitCandidateSections(bbox);
    const nearest = this.resolveShotAt(screenX, screenY, shotSections, threshold);
    if (!nearest) return null;

    const lng = nearest.from[0] + nearest.t * (nearest.to[0] - nearest.from[0]);
    const lat = nearest.from[1] + nearest.t * (nearest.to[1] - nearest.from[1]);

    return {
      section_id: nearest.sectionId,
      shot_id: nearest.shotId,
      t: nearest.t,
      lng,
      lat,
    };
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
    if (this.shouldLogInteraction()) {
      console.debug('[Highlight] Hovered section changed', {
        previous: this.hoveredSectionId,
        next: stringId,
      });
    }
    this.hoveredSectionId = stringId;
    // Custom renderer ignores feature-state; drive its per-vertex highlight flag
    // at hover level (the stock section hover used the same `hover` state).
    this.customRender?.setSectionHover(sectionId !== null ? [sectionId] : []);
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
    if (this.shouldLogInteraction()) {
      console.debug('[Highlight] Hovered segment changed', {
        previous: this.hoveredSegmentSectionIds,
        next: stringIds,
      });
    }
    this.hoveredSegmentSectionIds = stringIds;
    // Custom renderer ignores feature-state; drive its per-vertex highlight flag
    // so the whole connected segment is emphasized under the custom layer too.
    this.customRender?.setHighlight(sectionIds);
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
    if (this.shouldLogInteraction()) {
      console.debug('[Highlight] Hovered shot changed', {
        previous: this.hoveredShotId,
        next: stringId,
      });
    }
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
    if (this.shouldLogInteraction()) {
      console.debug('[Highlight] Hovered station changed', {
        previous: this.hoveredStationId,
        next: stringId,
      });
    }
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
    if (this.shouldLogInteraction()) {
      console.debug('[Selection] Selected section changed', {
        previous: this.selectedSectionId,
        next: stringId,
      });
    }
    this.selectedSectionId = stringId;
    // Custom renderer ignores feature-state; drive its per-vertex highlight flag
    // at selection level (smaller bump than hover, matching stock `selected`).
    this.customRender?.setSectionSelect(sectionId !== null ? [sectionId] : []);
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

  // Control shot data labels visibility. Custom label layer active: drive its
  // uniform, leave stock suppressed (else labels double). Off: stock as before.
  setShowShotLabels(show: boolean) {
    this.customLabels?.setShotLabelsVisible(show);
    if (this.customLabels?.isActive()) return;
    this.map.setLayoutProperty(
      this.shotLabelsLayerId,
      'visibility',
      show ? 'visible' : 'none'
    );
  }

  // Control section name labels visibility (custom uniform when active, else stock).
  setShowSectionNames(show: boolean) {
    this.customLabels?.setSectionNamesVisible(show);
    if (this.customLabels?.isActive()) return;
    this.map.setLayoutProperty(
      this.labelsLayerId,
      'visibility',
      show ? 'visible' : 'none'
    );
  }

  // Control station index labels visibility. When the custom label layer is
  // active it owns station labels: drive its shader uniform and leave the stock
  // layer suppressed (setting stock 'visible' would double the labels). Off / not
  // active: the stock visibility toggle as before (byte-identical gate-OFF path).
  setShowStationLabels(show: boolean) {
    this.customLabels?.setStationLabelsVisible(show);
    if (this.customLabels?.isActive()) return;
    this.map.setLayoutProperty(
      this.stationLabelsLayerId,
      'visibility',
      show ? 'visible' : 'none'
    );
  }

  // Control station comments visibility. Effective visibility folds in the
  // comment-tool override (forces visible); the custom uniform mirrors it.
  setShowStationComments(show: boolean) {
    this.cachedShowStationComments = show;
    this.customLabels?.setStationCommentsVisible(this.commentToolActive || show);
    // Skip if comment tool override is forcing visibility on
    if (this.commentToolActive) return;
    if (this.customLabels?.isActive()) return;
    this.map.setLayoutProperty(
      this.stationCommentsLayerId,
      'visibility',
      show ? 'visible' : 'none'
    );
  }

  // Control shot comments visibility (custom uniform mirrors the effective state).
  setShowShotComments(show: boolean) {
    this.cachedShowShotComments = show;
    this.customLabels?.setShotCommentsVisible(this.commentToolActive || show);
    // Skip if comment tool override is forcing visibility on
    if (this.commentToolActive) return;
    if (this.customLabels?.isActive()) return;
    this.map.setLayoutProperty(
      this.shotCommentsLayerId,
      'visibility',
      show ? 'visible' : 'none'
    );
  }

  // Control stations visibility (also hides loop closures). Hiding the visible
  // survey-stations layer also removes it as a hit-test candidate (the gate
  // queries that layer now), so hidden stations stay non-interactive.
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
    this.customRender?.setStationsVisible(visible);
    this.map.setLayoutProperty(this.loopClosuresLayerId, 'visibility', visibility);
    // Interact overlay tracks the stations layer: a hover/selection highlight
    // must not surface a hidden station (#mem).
    this.map.setLayoutProperty(this.interactStationsLayerId, 'visibility', visibility);
    // Note: stationsHighlightLayerId intentionally NOT hidden - it shows only
    // snapped/origin stations (interact `kind: 'snap'` features) even when the
    // main stations layer is hidden
  }

  // Control shots visibility. Hiding the visible survey-shots layer also removes
  // it as a hit-test candidate (the gate queries that layer now), so hidden
  // shots stay non-interactive.
  setShowShots(visible: boolean): void {
    if (!this.map) return;
    this.shotsVisible = visible;
    const visibility = visible ? 'visible' : 'none';
    // Clear hover state FIRST when hiding to prevent any race conditions
    if (!visible) {
      this.clearShotHover();
    }
    this.map.setLayoutProperty(this.shotsLayerId, 'visibility', visibility);
    this.customRender?.setShotsVisible(visible);
    this.map.setLayoutProperty(this.measurePathLayerId, 'visibility', visibility);
    // Interact overlay tracks the shots layers (#mem).
    this.map.setLayoutProperty(this.interactShotsLayerId, 'visibility', visibility);
    this.map.setLayoutProperty(this.interactShotsMeasuredLayerId, 'visibility', visibility);
    // The depth-gradient sublayer's visibility is owned by applyOverlayPaint: it
    // matches the shots layer EXCEPT while distance/gas-reach or the move_comment
    // tint is active, when it must stay hidden. Re-derive it here (rather than
    // forcing it to `visibility` above) so toggling Shots can't re-show the
    // gradient over an active overlay/tint (#52).
    this.applyOverlayPaint();
  }

  // Control reference shots visibility via filter (while keeping regular shots visible)
  // Also hides reference-only stations, their labels, reference shot labels, and
  // section names whose stations are all reference.
  setShowReferenceShots(visible: boolean): void {
    if (!this.map) return;
    this.showReferenceShotsCached = visible;
    this.customRender?.setReferenceShotsVisible(visible);
    this.customLabels?.setReferenceShotsVisible(visible);
    const notReference: maplibregl.FilterSpecification = ['!=', ['get', 'isReference'], true];
    const notAllReference: maplibregl.FilterSpecification = ['!=', ['get', 'allShotsReference'], true];
    if (visible) {
      // Restore original filters (label layers have zoom-based density filters).
      // The visible shots/stations layers double as the hit-test candidate
      // source now, so clearing their filter also re-enables interaction.
      this.map.setFilter(this.shotsLayerId, null);
      this.map.setFilter(this.shotGradientsLayerId, null);
      this.map.setFilter(this.measurePathLayerId, this.measurePathFilter());
      this.map.setFilter(this.stationsLayerId, null);
      this.map.setFilter(this.shotLabelsLayerId, this.shotLabelsBaseFilter);
      this.map.setFilter(this.stationLabelsLayerId, this.stationLabelsBaseFilter);
      this.map.setFilter(this.labelsLayerId, null);
    } else {
      // Hide reference shots and their labels. Filtering the VISIBLE shots layer
      // also removes hidden reference legs from the hit-test candidate set
      // (e.g. the ruler can't snap to an invisible reference leg) (#26, Codex).
      this.map.setFilter(this.shotsLayerId, notReference);
      this.map.setFilter(this.shotGradientsLayerId, notReference);
      this.map.setFilter(this.measurePathLayerId, this.measurePathFilter());
      this.map.setFilter(this.shotLabelsLayerId,
        this.shotLabelsBaseFilter
          ? ['all', this.shotLabelsBaseFilter, notReference] as maplibregl.FilterSpecification
          : notReference
      );
      // Hide stations that only connect to reference shots (and their labels)
      this.map.setFilter(this.stationsLayerId, notAllReference);
      this.map.setFilter(this.stationLabelsLayerId,
        this.stationLabelsBaseFilter
          ? ['all', this.stationLabelsBaseFilter, notAllReference] as maplibregl.FilterSpecification
          : notAllReference
      );
      // Hide section names when all stations in the section are reference
      this.map.setFilter(this.labelsLayerId, ['!=', ['get', 'allStationsReference'], true]);
    }
    // Recompute comment filters (respects both reference-shots and hidden-comment)
    this._applyCommentFilters();
    // Overlay features honor the reference filter (hidden reference shots /
    // all-reference stations produce no highlight) — rebuild them.
    this.lastInteractKey = null;
    this.refreshInteractOverlay();
  }

  /**
   * Hide/show the source comment marker during move_comment pickup.
   * Composes with the reference-shots filter so both constraints are respected.
   */
  setHiddenComment(hidden: { type: 'station' | 'shot'; sectionId: number; id: number } | null): void {
    this.hiddenComment = hidden;
    this._applyCommentFilters();
  }

  /**
   * Recompute comment layer filters combining base filter, reference-shot filter,
   * and hidden-comment filter into one expression.
   */
  private _applyCommentFilters(): void {
    if (!this.map) return;
    const commentBase: maplibregl.FilterSpecification = ['!=', ['get', 'comment'], null];
    const notReference: maplibregl.FilterSpecification = ['!=', ['get', 'isReference'], true];
    const notAllReference: maplibregl.FilterSpecification = ['!=', ['get', 'allShotsReference'], true];

    // Station comments filter
    const stationParts: maplibregl.FilterSpecification[] = [commentBase];
    if (!this.showReferenceShotsCached) stationParts.push(notAllReference);
    if (this.hiddenComment?.type === 'station') {
      stationParts.push(['any',
        ['!=', ['get', 'sectionId'], this.hiddenComment.sectionId],
        ['!=', ['get', 'stationIndex'], this.hiddenComment.id],
      ] as maplibregl.FilterSpecification);
    }
    this.map.setFilter(
      this.stationCommentsLayerId,
      stationParts.length === 1 ? stationParts[0]! : ['all', ...stationParts] as maplibregl.FilterSpecification
    );

    // Shot comments filter
    const shotParts: maplibregl.FilterSpecification[] = [commentBase];
    if (!this.showReferenceShotsCached) shotParts.push(notReference);
    if (this.hiddenComment?.type === 'shot') {
      shotParts.push(['any',
        ['!=', ['get', 'sectionId'], this.hiddenComment.sectionId],
        ['!=', ['get', 'shotId'], this.hiddenComment.id],
      ] as maplibregl.FilterSpecification);
    }
    this.map.setFilter(
      this.shotCommentsLayerId,
      shotParts.length === 1 ? shotParts[0]! : ['all', ...shotParts] as maplibregl.FilterSpecification
    );
  }

  /** Force both comment layers visible with overlap priority (comment/move_comment tool) */
  private _enableCommentToolOverride(): void {
    this.commentToolActive = true;
    // Force visible (custom uniforms mirror the forced-visible override)
    this.customLabels?.setStationCommentsVisible(true);
    this.customLabels?.setShotCommentsVisible(true);
    this.map.setLayoutProperty(this.stationCommentsLayerId, 'visibility', 'visible');
    this.map.setLayoutProperty(this.shotCommentsLayerId, 'visibility', 'visible');
    // Allow overlap so comments always render on top of other labels
    this.map.setLayoutProperty(this.stationCommentsLayerId, 'text-allow-overlap', true);
    this.map.setLayoutProperty(this.shotCommentsLayerId, 'text-allow-overlap', true);
  }

  /** Restore comment layer visibility and overlap from cached display settings */
  private _disableCommentToolOverride(): void {
    this.commentToolActive = false;
    // Restore visibility from cached display state (custom uniforms mirror it)
    this.customLabels?.setStationCommentsVisible(this.cachedShowStationComments);
    this.customLabels?.setShotCommentsVisible(this.cachedShowShotComments);
    this.map.setLayoutProperty(
      this.stationCommentsLayerId, 'visibility',
      this.cachedShowStationComments ? 'visible' : 'none'
    );
    this.map.setLayoutProperty(
      this.shotCommentsLayerId, 'visibility',
      this.cachedShowShotComments ? 'visible' : 'none'
    );
    // Restore default overlap behavior
    this.map.setLayoutProperty(this.stationCommentsLayerId, 'text-allow-overlap', false);
    this.map.setLayoutProperty(this.shotCommentsLayerId, 'text-allow-overlap', false);
  }

  /** Comment-label `text-color` (#52): palette tint from the feature's
   *  `commentColor` while `move_comment` is the exact active tool, else the
   *  plain theme label color. Shared by both comment layers. Reuses
   *  `commentToolTintExpression` so the shots/stations color tint and the
   *  label text tint can't drift apart. */
  private commentTextColor(): string | ExpressionSpecification {
    return this.activeTool === 'move_comment'
      ? this.commentToolTintExpression(this.themeColors.labelColor)
      : this.themeColors.labelColor;
  }

  /** Set `text-color` from {@link commentTextColor} on both comment layers.
   *  Shared by `applyCommentToolTint` (tool transitions) and `applyThemeColors`
   *  (theme changes) so the two callers can't diverge. */
  private applyCommentTextColor(): void {
    if (!this.map) return;
    const color = this.commentTextColor();
    if (this.map.getLayer(this.stationCommentsLayerId)) {
      this.map.setPaintProperty(this.stationCommentsLayerId, 'text-color', color);
    }
    if (this.map.getLayer(this.shotCommentsLayerId)) {
      this.map.setPaintProperty(this.shotCommentsLayerId, 'text-color', color);
    }
  }

  /** Apply (or restore) the move-comment palette tint on the comment text layers.
   *  A wider halo keeps the vivid palette colors readable over the map while
   *  tinted; restores the normal halo width on exit. Called on tool-transition;
   *  `applyThemeColors` calls `applyCommentTextColor` directly (it does not touch
   *  halo width, only the theme-driven halo color) so a theme change while the
   *  tool is active keeps the tint instead of reverting to the plain label color. */
  private applyCommentToolTint(): void {
    if (!this.map) return;
    this.applyCommentTextColor();
    const haloWidth = this.activeTool === 'move_comment' ? COMMENT_HALO_WIDTH_TINTED : COMMENT_HALO_WIDTH_BASE;
    if (this.map.getLayer(this.stationCommentsLayerId)) {
      this.map.setPaintProperty(this.stationCommentsLayerId, 'text-halo-width', haloWidth);
    }
    if (this.map.getLayer(this.shotCommentsLayerId)) {
      this.map.setPaintProperty(this.shotCommentsLayerId, 'text-halo-width', haloWidth);
    }
  }

  // Set highlighted stations by their string IDs (format: "sectionId:stationIndex")
  setHighlightedStations(stationIds: string[]): void {
    if (!this.map) return;
    this.highlightedStationIds = stationIds;
    // Highlights render as snap-ring features from the interact overlay (#mem).
    this.refreshInteractOverlay();
  }

  // Clear station hover state
  clearStationHover(): void {
    if (this.shouldLogInteraction() && this.hoveredStationId) {
      console.debug('[Highlight] Clearing station hover', {
        previous: this.hoveredStationId,
      });
    }
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
    if (this.shouldLogInteraction() && this.hoveredShotId) {
      console.debug('[Highlight] Clearing shot hover', {
        previous: this.hoveredShotId,
      });
    }
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
    // Custom renderer: drop every section-emphasis source in one refresh.
    this.customRender?.clearHighlights();
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
        this.map.setFeatureState({ source: stationsSource, sourceLayer: VT_SOURCE_LAYER, id: featureId }, { anchored: false });
      } catch { /* feature may not exist */ }
      try {
        this.map.setFeatureState({ source: shotsSource, sourceLayer: VT_SOURCE_LAYER, id: featureId }, { anchored: false });
      } catch { /* feature may not exist */ }
    }

    this.anchoredSectionIds = sectionIds;
    const newAnchoredFeatureIds = new Set<number>();

    if (sectionIds.size > 0) {
      // Find all features belonging to anchored sections and set feature-state
      for (const source of [stationsSource, shotsSource]) {
        try {
          const features = this.map.querySourceFeatures(source, { sourceLayer: VT_SOURCE_LAYER });
          for (const f of features) {
            if (f.properties?.sectionId != null && sectionIds.has(f.properties.sectionId as number) && f.id != null) {
              const featureId = typeof f.id === 'number' ? f.id : parseInt(String(f.id), 10);
              if (!isNaN(featureId)) {
                this.map.setFeatureState({ source, sourceLayer: VT_SOURCE_LAYER, id: featureId }, { anchored: true });
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
    this.syncCustomDimming();
  }

  /** Push the current anchored + immovable dim set to the custom-render layers so
   *  they dim the same features the stock paint expressions do (#customRender).
   *  Both geometry AND labels take the same {@link CustomDimState}; the label
   *  controller reproduces the stock LABEL dim rules (anchored dims shot/station/
   *  section labels, immovable dims individual shot/station labels; comments and
   *  section-name immovable are left bright, matching stock). */
  private syncCustomDimming(): void {
    const dim = {
      anchoredSectionIds: this.anchoredSectionIds,
      immovableStationFeatureIds: this.immovableStationFeatureIds,
      immovableShotFeatureIds: this.immovableShotFeatureIds,
    };
    this.customRender?.setDimming(dim);
    this.customLabels?.setDimming(dim);
  }

  /** True while the custom LABEL layer is drawing (stock text layers suppressed).
   *  When set, the stock `labelRestore.ts` setFilter/settle/defer machinery is
   *  skipped: it exists only to hide the async label-tile reload flash, which the
   *  synchronous custom label layer does not have (its labels converge in the same
   *  flush as the geometry). Gate-off keeps every labelRestore call byte-identical. */
  private labelsCustomActive(): boolean {
    return this.customLabels?.isActive() === true;
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
      this.map.setPaintProperty(this.shotLabelsLayerId, 'text-opacity', dimmedZoomOpacity(anchoredCheck));
      // Section name labels: anchored → 0.25, else 1
      this.map.setPaintProperty(this.labelsLayerId, 'text-opacity', [
        'case', anchoredCheck, 0.25, 1,
      ] as maplibregl.ExpressionSpecification);
      // Station index labels: anchored → 0.25, else zoom-interpolated
      this.map.setPaintProperty(this.stationLabelsLayerId, 'text-opacity', dimmedZoomOpacity(anchoredCheck));
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
    this.syncCustomDimming();
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
          ['get', 'isReference'], 0.5,
          1,
        ] as maplibregl.ExpressionSpecification);
        this.map.setPaintProperty(this.shotGradientsLayerId, 'line-opacity', [
          'case',
          immovableCheck, 0.25,
          anchoredCheck, 0.25,
          ['get', 'isReference'], 0.5,
          1,
        ] as maplibregl.ExpressionSpecification);
      } else {
        // Restore default (feature-state only)
        this.map.setPaintProperty(this.shotsLayerId, 'line-opacity', [
          'case',
          anchoredCheck, 0.25,
          ['get', 'isReference'], 0.5,
          1,
        ] as maplibregl.ExpressionSpecification);
        this.map.setPaintProperty(this.shotGradientsLayerId, 'line-opacity', [
          'case',
          anchoredCheck, 0.25,
          ['get', 'isReference'], 0.5,
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
        ['get', 'isReference'], 0.5,
        1,
      ] as maplibregl.ExpressionSpecification);
      this.map.setPaintProperty(this.shotGradientsLayerId, 'line-opacity', [
        'case',
        anchoredCheck, 0.25,
        ['get', 'isReference'], 0.5,
        1,
      ] as maplibregl.ExpressionSpecification);
    }
  }

  // Set text-opacity on label layers: 0.25 for immovable features, normal otherwise.
  // Uses per-feature ID matching (sectionId * FEATURE_ID_STRIDE + stationIndex/shotId) since
  // immovable features are per-station, not per-section.
  private updateImmovableLabelOpacity(
    stationIds: Set<number>,
    shotIds: Set<number>
  ): void {
    const zoomOpacity: maplibregl.ExpressionSpecification = [
      'interpolate', ['linear'], ['zoom'], 14, 0.7, 18, 1,
    ] as maplibregl.ExpressionSpecification;

    if (stationIds.size > 0 || shotIds.size > 0) {
      // Station labels: compute featureId from sectionId * FEATURE_ID_STRIDE + stationIndex
      if (stationIds.size > 0) {
        const stationIdsArray = [...stationIds];
        const stationAnchoredCheck: maplibregl.ExpressionSpecification = [
          'in',
          ['+', ['*', ['get', 'sectionId'], FEATURE_ID_STRIDE], ['get', 'stationIndex']],
          ['literal', stationIdsArray],
        ] as maplibregl.ExpressionSpecification;
        this.map.setPaintProperty(this.stationLabelsLayerId, 'text-opacity', dimmedZoomOpacity(stationAnchoredCheck));
      } else {
        this.map.setPaintProperty(this.stationLabelsLayerId, 'text-opacity', zoomOpacity);
      }

      // Shot labels: compute featureId from sectionId * FEATURE_ID_STRIDE + shotId
      if (shotIds.size > 0) {
        const shotIdsArray = [...shotIds];
        const shotAnchoredCheck: maplibregl.ExpressionSpecification = [
          'in',
          ['+', ['*', ['get', 'sectionId'], FEATURE_ID_STRIDE], ['get', 'shotId']],
          ['literal', shotIdsArray],
        ] as maplibregl.ExpressionSpecification;
        this.map.setPaintProperty(this.shotLabelsLayerId, 'text-opacity', dimmedZoomOpacity(shotAnchoredCheck));
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
        const sectionId = Math.floor(fid / FEATURE_ID_STRIDE);
        const stationIndex = fid % FEATURE_ID_STRIDE;
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

  /** The drag preview's shot/station color paint. Plain mode reads the resolved
   *  per-feature `color` property (baked at capture time, like the interact
   *  overlay); distance / gas-reach modes read the carried `dist` / `gasReach`
   *  through the SAME ramp expressions the bulk layers use, so colors match. */
  private dragPreviewColorExpr(): ExpressionSpecification {
    if (this.distanceMode) {
      return distanceColorExpression(
        DISTANCE_NEAR,
        DISTANCE_FAR,
        this.distanceState?.max ?? 0,
        this.themeColors.grayLine,
        ['get', 'dist'] as ExpressionSpecification,
      );
    }
    if (this.gasReachMode) {
      return gasReachColorExpression(
        GAS_NEAR,
        GAS_FAR,
        this.gasReachState?.max ?? 0,
        this.themeColors.grayLine,
        ['get', 'gasReach'] as ExpressionSpecification,
      );
    }
    return ['get', 'color'] as ExpressionSpecification;
  }

  /** Build the layer-spec context for the drag-preview layers module: shots +
   *  stations color / size / highlight (see surveyLayer/dragPreviewLayers.ts). */
  private dragPreviewLayerCtx(): DragPreviewLayerCtx {
    return {
      colorExpr: this.dragPreviewColorExpr(),
      shotWidth: this.getShotSelectionWidth(),
      stationRadius: this.getStationSelectionRadius(),
      selectHighlight: this.themeColors.selectHighlight,
    };
  }

  /** Install the captured drag preview geometry (shots / stations / closures) as
   *  the moving ghost, and hide the moving originals. Attached text is not
   *  previewed - it is hidden from the stock text layers for the drag duration by
   *  the begin methods. Shared by the segment and station/shot begins.
   *
   *  The ghost is a custom WebGL layer whose live drag delta is a single
   *  vertex-shader uniform (no worker, no re-bake -> no overshoot). It draws
   *  synchronously on the next frame, so the moving originals are hidden NOW (they
   *  overlap the ghost at offset 0). If the custom ghost is not the active path
   *  (bulk geometry stock, or the ghost layer failed / self-disabled), the STOCK
   *  GeoJSON preview stands in and its async setData means the hide waits for the
   *  first source load (START-flash fix). See {@link DragGhostController}. */
  private installDragPreview(features: DragPreviewFeature[], exclusion: CustomRenderExclusion): void {
    // New drag generation: invalidates any still-pending deferred drag-hide from
    // a superseded drag (guards the sourcedata callback in
    // setDragExclusionWhenPreviewReady).
    this.dragGeneration += 1;
    this.dragPreviewSet = { features };
    this.dragPreviewActive = true;
    if (this.dragGhost.begin(this.dragPreviewSet) === 'custom') this.setDragExclusion(exclusion);
    else this.setDragExclusionWhenPreviewReady(exclusion);
    this.renderOverlayFollow(0, 0);
  }

  /** Build the custom-ghost render data (buffers + device-px sizes) for a captured
   *  set: colors resolved at capture time the same way the bulk geometry shows
   *  them (base / severity / depth from the feature's own `color`, or the
   *  analytical overlay ramp), the preview's 0.85 line/fill opacity baked into
   *  alpha. Sizes mirror {@link dragPreviewLayerCtx} (selection width/radius,
   *  2.5px stroke) scaled to device px, matching the custom bulk layer's dpr. */
  private dragGhostData(set: DragPreviewSet): GhostRenderData {
    return buildGhostRenderData(set, {
      dpr: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
      themeColors: this.themeColors,
      overlay: overlayInputFrom(this.distanceMode, this.distanceState, this.gasReachMode, this.gasReachState),
      shotsVisible: this.shotsVisible,
      stationsVisible: this.stationsVisible,
      selShotWidth: this.getShotSelectionWidth(),
      hoverShotWidth: this.getShotHoverWidth(),
      selRadius: this.getStationSelectionRadius(),
      hoverRadius: this.getStationHoverRadius(),
      hoveredShotId: this.hoveredShotId,
      selectedShotId: this.selectedShotId,
      hoveredStationId: this.hoveredStationId,
      selectedStationId: this.selectedStationId,
      movingEndForShot: (id) => this.dragMovingShots.get(id),
      isMovingStation: (id) => this.dragMovingStationKeys.has(id),
      parseFid: (id) => this.parseFeatureId(id),
      isAnchored: (fid) => this.isFeatureAnchored(fid),
      isShotImmovable: (fid) => this.isShotImmovable(fid),
      isStationImmovable: (fid) => this.isStationImmovable(fid),
      shotFeature: (id, w) => this.shotOverlayFeature(id, w),
      stationFeature: (id, s) => this.stationOverlayFeature(id, s),
    });
  }

  /** Re-emit any hover/selected highlight on a moving feature at the drag offset
   *  so it tracks the cursor instead of sticking at the committed position (#C).
   *  A small setData, coalesced one-per-frame by the rAF (see scheduleDragRender).
   *  Kept separate from the ghost bake so the highlight stays as responsive as
   *  before while the ghost bakes single-flight. */
  private renderOverlayFollow(dx: number, dy: number): void {
    if (!this.dragPreviewActive) return;
    this.dragOverlayOffset = { dx, dy };
    this.refreshInteractOverlay();
  }

  /** The map-backed projector used for the preview + overlay offset transforms. */
  private dragProjector(): Projector {
    return {
      project: (lngLat) => this.map.project(lngLat),
      unproject: (pt) => this.map.unproject(pt),
    };
  }

  /** Stop the interact overlay following the drag and snap it back to committed
   *  coordinates (called on commit / end). */
  private clearDragOverlayFollow(): void {
    this.dragOverlayOffset = null;
    this.dragCommitPending = false;
    this.dragMovingStationKeys.clear();
    this.dragMovingShots.clear();
    this.lastInteractKey = null;
    this.refreshInteractOverlay();
  }

  /** The per-feature analytical-overlay props (dist / gas-reach) a moving feature
   *  must carry so the preview's ramp paint matches the bulk layers. Keyed the
   *  same way the interact overlay keys them ("sec:idx" / "sec:shotId"). */
  private dragOverlayProps(idStr: string, kind: 'station' | 'shot'): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    if (!this.distanceMode && !this.gasReachMode) return props;
    const fid = this.parseFeatureId(idStr);
    if (fid === null) return props;
    const map = kind === 'station'
      ? { dist: this.distanceState?.stations, gas: this.gasReachState?.stations }
      : { dist: this.distanceState?.shots, gas: this.gasReachState?.shots };
    if (this.distanceMode) props.dist = map.dist?.get(fid) ?? -1;
    if (this.gasReachMode) props.gasReach = map.gas?.get(fid) ?? -1;
    return props;
  }

  /**
   * Begin SEGMENT drag preview — hide the connected sections' real features from
   * the bulk layers (excluded by sectionId), capture every moving station / shot
   * / label / closure ONCE with its original coordinates, and render the moving
   * copy from the unified preview source. All geometry moves uniformly, so a
   * later per-frame offset is applied to every captured vertex.
   */
  beginDragPreview(connectedSectionIds: Set<number>): void {
    if (this.dragPreviewActive) this.endDragPreview();
    // Restore any prior drag's still-deferred text filters NOW so this drag
    // captures the true base filters, not a stale hidden state (its own late
    // settle then no-ops via the generation guard).
    this.labelRestore.flushPending();
    if (connectedSectionIds.size === 0) return;
    if (!this.geoIndex || !this.cachedSurveyData) return;

    const idsArray = [...connectedSectionIds];
    const exclusion: maplibregl.FilterSpecification =
      ['!', ['in', ['get', 'sectionId'], ['literal', idsArray]]];

    // Hide the connected sections' real features from the bulk layers (compose
    // with any existing filter so reference/zoom gating is preserved).
    for (const mainLayerId of SurveyLayer.SEGMENT_DRAG_MAIN_LAYERS) {
      const existing = this.map.getFilter(mainLayerId);
      this.dragSavedFilters.set(mainLayerId, existing ?? undefined);
      const composed: maplibregl.FilterSpecification = (existing && typeof existing === 'object')
        ? (['all', existing, exclusion] as unknown as maplibregl.FilterSpecification)
        : exclusion;
      this.map.setFilter(mainLayerId, composed);
    }

    // Hide closures with EITHER endpoint in the connected set. Closures with BOTH
    // endpoints inside move uniformly (captured below); closures bridging a
    // dragged and a stationary section are hidden during the drag and reappear
    // with correct geometry on commit.
    const existingClosureFilter = this.map.getFilter(this.loopClosuresLayerId);
    this.dragSavedFilters.set(this.loopClosuresLayerId, existingClosureFilter ?? undefined);
    const eitherEndpointExclusion: maplibregl.FilterSpecification = ['!', ['any',
      ['in', ['get', 'sectionIdA'], ['literal', idsArray]],
      ['in', ['get', 'sectionIdB'], ['literal', idsArray]],
    ]] as unknown as maplibregl.FilterSpecification;
    this.map.setFilter(this.loopClosuresLayerId, (existingClosureFilter && typeof existingClosureFilter === 'object')
      ? (['all', existingClosureFilter, eitherEndpointExclusion] as unknown as maplibregl.FilterSpecification)
      : eitherEndpointExclusion);

    // Also hide the moving sections' comments (they carry sectionId) so no stale
    // text lingers at the old position; restored via dragSavedFilters.
    for (const layerId of [this.stationCommentsLayerId, this.shotCommentsLayerId]) {
      if (this.map.getLayoutProperty(layerId, 'visibility') !== 'visible') continue;
      const existing = this.map.getFilter(layerId);
      this.dragSavedFilters.set(layerId, existing ?? undefined);
      this.map.setFilter(layerId, (existing && typeof existing === 'object')
        ? (['all', existing, exclusion] as unknown as maplibregl.FilterSpecification)
        : exclusion);
    }

    // Capture the moving geometry once. Everything in the segment moves uniformly.
    // Attached text (labels / comments / section names) is not captured - it is
    // hidden from the stock layers above, not previewed.
    const features: DragPreviewFeature[] = [];
    const ctx = this.displayColorContext();
    const stationDefault = this.themeColors.stationDefault;

    for (const section of this.cachedSections) {
      if (!connectedSectionIds.has(section.id)) continue;
      const sectionStations = this.cachedStations
        .filter(s => s.station_ref.section_id === section.id)
        .sort((a, b) => a.station_ref.station_index - b.station_ref.station_index);
      const sectionColor = section.color ?? stationDefault;

      // Stations (points).
      for (const st of sectionStations) {
        const ref = st.station_ref;
        const coord = metersToMapCoords(st.coordinates.x, st.coordinates.y, this.gpsOrigin) as [number, number];
        const idStr = `${ref.section_id}:${ref.station_index}`;
        this.dragMovingStationKeys.add(idStr);
        const g = this.geoIndex.stationGlobalIndex(ref);
        const color = g === null
          ? stationDefault
          : resolveStationDisplayColor(this.cachedSurveyData, sectionColor, g, ctx);
        features.push({
          emit: 'point',
          coords: [coord],
          movingEnd: 'uniform',
          properties: { kind: 'station', color, ...this.dragOverlayProps(idStr, 'station') },
        });
      }

      // Shots (lines).
      for (let i = 0; i < section.shots.length; i++) {
        const fromSt = sectionStations[i];
        const toSt = sectionStations[i + 1];
        const shot = section.shots[i];
        if (!fromSt || !toSt || !shot) continue;
        const fromCoord = metersToMapCoords(fromSt.coordinates.x, fromSt.coordinates.y, this.gpsOrigin) as [number, number];
        const toCoord = metersToMapCoords(toSt.coordinates.x, toSt.coordinates.y, this.gpsOrigin) as [number, number];
        const geo = this.geoIndex.shotGeometry(section.id, shot.id);
        const color = geo
          ? resolveShotDisplayColor(this.cachedSurveyData, sectionColor, geo.globalIdx, ctx)
          : sectionColor;
        this.dragMovingShots.set(`${section.id}:${shot.id}`, 'both');
        features.push({
          emit: 'line',
          coords: [fromCoord, toCoord],
          movingEnd: 'uniform',
          properties: { kind: 'shot', color, ...this.dragOverlayProps(`${section.id}:${shot.id}`, 'shot') },
        });
      }
    }

    // Loop closures with BOTH endpoints in the moving set (move uniformly).
    for (const lc of this.cachedLoopClosures ?? []) {
      if (!connectedSectionIds.has(lc.station_a.section_id) || !connectedSectionIds.has(lc.station_b.section_id)) continue;
      const a = this.geoIndex.stationCoords(lc.station_a);
      const b = this.geoIndex.stationCoords(lc.station_b);
      if (!a || !b) continue;
      features.push({
        emit: 'line',
        coords: [a, b],
        movingEnd: 'uniform',
        properties: { kind: 'closure', color: getErrorColor(lc.error_percentage) },
      });
    }

    // Segment drag hides whole connected sections (shots + stations) in the
    // custom layer, mirroring the sectionId exclusion applied to the stock layers.
    this.installDragPreview(features, { sectionIds: new Set(idsArray) });
  }

  /**
   * Begin station / shot drag preview — finds all co-located stations
   * (merged/closured), hides them and their connected shots/labels/closures from
   * the bulk layers, captures that moving geometry (with per-shot movingEnd so a
   * shot stretches around its fixed endpoint), and renders the moving copy from
   * the unified preview source. Everything moves through ONE per-frame setData.
   *
   * Returns the list of co-located StationRefs so MapCanvas can batch-move them.
   */
  beginStationDragPreview(sectionId: number, stationIndex: number, additionalSeeds?: StationRef[]): StationRef[] {
    if (this.dragPreviewActive) this.endDragPreview();
    // Restore any prior drag's still-deferred text filters before capturing this
    // drag's base (see beginDragPreview).
    this.labelRestore.flushPending();

    // The per-item exclusion/inclusion filters below need per-feature source
    // content. The tool switch requested it (ensureFeatureGranularity), but a
    // very fast mousedown can win the async worker rebuild — force a
    // synchronous flush in that rare race so the drag preview is correct.
    if (
      this.desiredPerFeature() &&
      !this.contentPerFeature &&
      (this.cachedSections.length > 0 || this.cachedStations.length > 0)
    ) {
      this.flushUpdateSync(
        this.cachedSections,
        this.cachedStations,
        this.cachedLoopClosures,
        this.gpsOrigin,
        this.showDepthGradient,
        this.depthRange,
        this.cachedPrecision,
        this.showIssueSeverity,
        this.cachedWarnings,
      );
    }

    // 1. Find clicked station and all co-located stations via BFS:
    //    - merged_with: always co-located
    //    - closures_with: only when the closure has been aligned
    //    additionalSeeds allows shot drag to seed from both endpoints simultaneously
    const stationByKey = new Map(
      this.cachedStations.map(s => [`${s.station_ref.section_id}:${s.station_ref.station_index}`, s])
    );
    const alignedClosureIds = new Set<bigint>(
      (this.cachedLoopClosures ?? [])
        .filter((closure) => closure.is_aligned)
        .map((closure) => closure.id)
    );
    const clickedKey = `${sectionId}:${stationIndex}`;
    const clickedStation = stationByKey.get(clickedKey);
    if (!clickedStation) return [];

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
        if (!alignedClosureIds.has(cr.closure_id)) continue;
        queue.push(`${cr.station_ref.section_id}:${cr.station_ref.station_index}`);
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

    // 3. Capture the moving geometry once (originals + movingEnd). The bulk
    // features are hidden by filters below; the moving copy renders from the
    // preview source. Attached text is hidden from the stock text layers, not
    // previewed. Only endpoints in the moving set follow the offset, so a shot
    // stretches around a fixed end instead of translating whole.
    if (!this.geoIndex || !this.cachedSurveyData) return movingStations.map(s => s.station_ref);
    const ctx = this.displayColorContext();
    const stationDefault = this.themeColors.stationDefault;
    const showStComments = this.map.getLayoutProperty(this.stationCommentsLayerId, 'visibility') === 'visible';
    const showShComments = this.map.getLayoutProperty(this.shotCommentsLayerId, 'visibility') === 'visible';
    const features: DragPreviewFeature[] = [];
    // Custom-render exclusion mirrors the stock filters below: the SAME moving
    // stations + shots, keyed by global SoA index for O(1) skip in tessellate.
    const excludedStationGlobals = new Set<number>();
    const excludedShotGlobals = new Set<number>();
    // Sections owning any moved station / shot: their NAME label drag-hides too
    // (custom label layer), so it does not sit pinned at the old anchor while the
    // partial geometry moves. Whole-section segment drags carry the name via
    // `sectionIds` instead (see beginDragPreview).
    const affectedSectionIds = new Set<number>();

    // Hide the moving stations from the bulk station + station-label (+ station-
    // comment, when shown) layers; the labels / comments are dropped for the drag.
    const stationHideLayers = [this.stationsLayerId, this.stationLabelsLayerId];
    if (showStComments) stationHideLayers.push(this.stationCommentsLayerId);
    for (const layerId of stationHideLayers) {
      const existing = this.map.getFilter(layerId);
      this.dragSavedFilters.set(layerId, existing ?? undefined);
      const composed: maplibregl.FilterSpecification = (existing && typeof existing === 'object')
        ? (['all', existing, stationExclusion] as unknown as maplibregl.FilterSpecification)
        : stationExclusion;
      this.map.setFilter(layerId, composed);
    }

    // Moving stations (points) — all uniform.
    for (const st of movingStations) {
      const ref = st.station_ref;
      const coord = metersToMapCoords(st.coordinates.x, st.coordinates.y, this.gpsOrigin) as [number, number];
      const idStr = `${ref.section_id}:${ref.station_index}`;
      this.dragMovingStationKeys.add(idStr);
      const section = this.geoIndex.section(ref.section_id);
      const g = this.geoIndex.stationGlobalIndex(ref);
      if (g !== null) excludedStationGlobals.add(g);
      affectedSectionIds.add(ref.section_id);
      const color = g === null
        ? stationDefault
        : resolveStationDisplayColor(this.cachedSurveyData, section?.color ?? stationDefault, g, ctx);
      features.push({
        emit: 'point',
        coords: [coord],
        movingEnd: 'uniform',
        properties: { kind: 'station', color, ...this.dragOverlayProps(idStr, 'station') },
      });
    }

    // 4. Connected shots (lines) + shot labels; build the shot exclusion filter.
    const shotExclusions: maplibregl.FilterSpecification[] = [];
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
        const shot = section.shots[i];
        if (!fromSt || !toSt || !shot) continue;

        const fromKey = `${fromSt.station_ref.section_id}:${fromSt.station_ref.station_index}`;
        const toKey = `${toSt.station_ref.section_id}:${toSt.station_ref.station_index}`;
        const fromIsMoving = movingRefKeys.has(fromKey);
        const toIsMoving = movingRefKeys.has(toKey);
        if (!fromIsMoving && !toIsMoving) continue;

        const shotKey = `${section.id}:${shot.id}`;
        if (seenShotKeys.has(shotKey)) continue;
        seenShotKeys.add(shotKey);

        const movingEnd: MovingEnd = fromIsMoving && toIsMoving ? 'both' : fromIsMoving ? 'from' : 'to';
        this.dragMovingShots.set(shotKey, movingEnd);
        const fromCoord = metersToMapCoords(fromSt.coordinates.x, fromSt.coordinates.y, this.gpsOrigin) as [number, number];
        const toCoord = metersToMapCoords(toSt.coordinates.x, toSt.coordinates.y, this.gpsOrigin) as [number, number];
        const geo = this.geoIndex.shotGeometry(section.id, shot.id);
        if (geo) excludedShotGlobals.add(geo.globalIdx);
        affectedSectionIds.add(section.id);
        const color = geo
          ? resolveShotDisplayColor(this.cachedSurveyData, section.color ?? stationDefault, geo.globalIdx, ctx)
          : (section.color ?? stationDefault);
        features.push({
          emit: 'line',
          coords: [fromCoord, toCoord],
          movingEnd,
          properties: { kind: 'shot', color, ...this.dragOverlayProps(shotKey, 'shot') },
        });
        shotExclusions.push(['all',
          ['==', ['get', 'sectionId'], section.id],
          ['==', ['get', 'shotId'], shot.id],
        ] as unknown as maplibregl.FilterSpecification);
      }
    }

    // Hide the moving shots from the bulk shot / gradient / shot-label (+ shot-
    // comment, when shown) layers; the labels / comments are dropped for the drag.
    if (shotExclusions.length > 0) {
      const shotExclusion: maplibregl.FilterSpecification = ['!',
        shotExclusions.length === 1 ? shotExclusions[0]! : ['any', ...shotExclusions],
      ] as unknown as maplibregl.FilterSpecification;
      const shotHideLayers = ['survey-shots', 'survey-shot-gradients', 'survey-shot-labels'];
      if (showShComments) shotHideLayers.push(this.shotCommentsLayerId);
      for (const layerId of shotHideLayers) {
        const existing = this.map.getFilter(layerId);
        this.dragSavedFilters.set(layerId, existing ?? undefined);
        const composed: maplibregl.FilterSpecification = (existing && typeof existing === 'object')
          ? (['all', existing, shotExclusion] as unknown as maplibregl.FilterSpecification)
          : shotExclusion;
        this.map.setFilter(layerId, composed);
      }
    }

    // 5. Closure indicator lines with >= 1 endpoint in the moving set; hide those
    // from the bulk closures layer (they render in the preview, stretched).
    const closureExclusions: maplibregl.FilterSpecification[] = [];
    for (const lc of this.cachedLoopClosures ?? []) {
      const keyA = `${lc.station_a.section_id}:${lc.station_a.station_index}`;
      const keyB = `${lc.station_b.section_id}:${lc.station_b.station_index}`;
      const aMoving = movingRefKeys.has(keyA);
      const bMoving = movingRefKeys.has(keyB);
      if (!aMoving && !bMoving) continue;

      const stA = stationByKey.get(keyA);
      const stB = stationByKey.get(keyB);
      if (!stA || !stB) continue;

      const fromCoord = metersToMapCoords(stA.coordinates.x, stA.coordinates.y, this.gpsOrigin) as [number, number];
      const toCoord = metersToMapCoords(stB.coordinates.x, stB.coordinates.y, this.gpsOrigin) as [number, number];
      features.push({
        emit: 'line',
        coords: [fromCoord, toCoord],
        movingEnd: aMoving && bMoving ? 'both' : aMoving ? 'from' : 'to',
        properties: { kind: 'closure', color: getErrorColor(lc.error_percentage) },
      });
      closureExclusions.push(['all',
        ['==', ['get', 'stationA'], keyA],
        ['==', ['get', 'stationB'], keyB],
      ] as unknown as maplibregl.FilterSpecification);
    }
    if (closureExclusions.length > 0) {
      const closureExclusion: maplibregl.FilterSpecification = ['!',
        ['any', ...closureExclusions],
      ] as unknown as maplibregl.FilterSpecification;
      const existingClosureFilter = this.map.getFilter(this.loopClosuresLayerId);
      this.dragSavedFilters.set(this.loopClosuresLayerId, existingClosureFilter ?? undefined);
      const composedClosure: maplibregl.FilterSpecification = (existingClosureFilter && typeof existingClosureFilter === 'object')
        ? (['all', existingClosureFilter, closureExclusion] as unknown as maplibregl.FilterSpecification)
        : closureExclusion;
      this.map.setFilter(this.loopClosuresLayerId, composedClosure);
    }

    // Hide the moving originals from the custom layer. installDragPreview applies
    // this now for the custom ghost (draws next frame) or defers it behind the
    // async stock preview's first load (START-flash fix).
    this.installDragPreview(features, {
      stationGlobalIndices: excludedStationGlobals,
      shotGlobalIndices: excludedShotGlobals,
      affectedSectionIds,
    });
    return movingStations.map(s => s.station_ref);
  }

  /** Point the custom-render layer at (or off, with null) the active drag's
   *  hidden feature set, so the originals vanish at drag begin and reappear at
   *  drag end — matching the stock bulk layers' setFilter exclusions the custom
   *  layer cannot see. Cheap: recomputes + re-uploads only the per-vertex hide
   *  flag (no buffer rebuild). No-op unless the custom render gate is on. */
  private setDragExclusion(exclusion: CustomRenderExclusion | null): void {
    this.customRender?.setDragHide(exclusion);
    // Labels mirror the SAME exclusion: the dragged features' labels collapse via
    // the DRAG_HIDE flag (synchronous GPU upload), replacing the stock text-layer
    // filter drop. On drag commit the synchronous sync() rebuild reflows them at
    // the new positions and setDragExclusion(null) clears the flag — labels never
    // lag the geometry (the anti-flicker payoff).
    this.customLabels?.setDragHide(exclusion);
  }

  /**
   * Apply the custom-render drag-hide only once the drag-preview source has
   * parsed and drawn its first frame (START-flash fix). setDragHide is a
   * synchronous GPU upload that takes effect on the very next frame, but the
   * preview's GeoJSON setData is async (worker parse + retile, ~5 frames on a
   * real project). Hiding the originals eagerly therefore blanks the geometry
   * for those frames - it is in neither the custom layer nor the not-yet-drawn
   * preview. Deferring the hide to the source's first `sourcedata`-loaded event
   * keeps the originals visible until the preview stands in for them (at offset
   * ~0 they overlap, so there is no visible double either), then swaps to the
   * preview atomically.
   */
  private setDragExclusionWhenPreviewReady(exclusion: CustomRenderExclusion): void {
    this.clearPendingDragHide();
    // If the source is already parsed (rare - typically false right after the
    // begin's setData), hide immediately; nothing to wait for.
    if (this.map.isSourceLoaded(DRAG_PREVIEW_SOURCE)) {
      this.setDragExclusion(exclusion);
      return;
    }
    const gen = this.dragGeneration;
    const listener = (e: maplibregl.MapSourceDataEvent): void => {
      if (e.sourceId !== DRAG_PREVIEW_SOURCE) return;
      if (!this.map.isSourceLoaded(DRAG_PREVIEW_SOURCE)) return;
      this.map.off('sourcedata', listener);
      if (this.pendingDragHide?.listener === listener) this.pendingDragHide = null;
      // Ignore a stale callback from a drag that has since ended or been replaced.
      if (gen !== this.dragGeneration || !this.dragPreviewActive) return;
      this.setDragExclusion(exclusion);
    };
    this.pendingDragHide = { exclusion, listener };
    this.map.on('sourcedata', listener);
  }

  /** Tear down a still-pending deferred drag-hide without applying it (on end). */
  private clearPendingDragHide(): void {
    if (!this.pendingDragHide) return;
    this.map.off('sourcedata', this.pendingDragHide.listener);
    this.pendingDragHide = null;
  }

  /** Force-apply a still-pending deferred drag-hide immediately (on commit). If a
   *  very fast drag commits before the async preview ever loaded, the originals
   *  must be hidden NOW so they cannot show through the preview that is kept alive
   *  across the IPC window (see commitDragPreview). No-op once already applied. */
  private flushPendingDragHide(): void {
    const pending = this.pendingDragHide;
    if (!pending) return;
    this.map.off('sourcedata', pending.listener);
    this.pendingDragHide = null;
    if (this.dragPreviewActive) this.setDragExclusion(pending.exclusion);
  }

  /** Drive both followers from a pointermove offset. The GHOST is driven
   *  SYNCHRONOUSLY by the controller (custom path: one shader-uniform write +
   *  triggerRepaint, no worker; stock fallback: the single-flight bake / translate
   *  machine). The interact overlay follow stays rAF-coalesced (one small setData
   *  per frame). */
  private scheduleDragRender(dx: number, dy: number): void {
    this.dragGhost.move(dx, dy);
    this.pendingDragOffset = { dx, dy };
    if (this.dragUpdateRaf !== null) return;
    this.dragUpdateRaf = requestAnimationFrame(() => {
      this.dragUpdateRaf = null;
      const off = this.pendingDragOffset;
      this.pendingDragOffset = null;
      if (off) this.renderOverlayFollow(off.dx, off.dy);
    });
  }

  /** Cancel any pending coalesced render (on commit / end). */
  private cancelDragRender(): void {
    if (this.dragUpdateRaf !== null) {
      cancelAnimationFrame(this.dragUpdateRaf);
      this.dragUpdateRaf = null;
    }
    this.pendingDragOffset = null;
  }

  /**
   * Update the station / shot drag preview — one setData over the unified source
   * (stations, shots, labels, closures all move together, no skew).
   */
  updateStationDragPreview(dx: number, dy: number): void {
    this.scheduleDragRender(dx, dy);
  }

  /**
   * Update the segment drag preview — one setData over the unified source. The
   * whole segment moves uniformly, so every captured vertex takes the offset.
   */
  updateDragPreview(dx: number, dy: number): void {
    this.scheduleDragRender(dx, dy);
  }

  /**
   * Commit drag preview — removes the preview layers but keeps the exclusion
   * filters on the bulk layers so the moved features stay hidden until React
   * re-renders with their new positions. Call this before the backend commit,
   * then endDragPreview() after the re-render. This prevents a blink where
   * features briefly appear at newPosition + dragOffset.
   */
  commitDragPreview(): void {
    if (!this.dragPreviewActive) return;
    this.cancelDragRender();
    // FINISH-flash fix: do NOT remove the preview here. cancelDragRender above
    // freezes it at the placement offset (its last setData), which is where the
    // committed geometry will land. The committed geometry does not exist
    // client-side until the post-IPC flush installs it (~100ms), and the
    // custom-render drag-hide stays applied until endDragPreview - so removing
    // the preview now would leave the moved geometry in NEITHER the preview nor
    // the custom layer for the whole IPC window: a blank hole where the user just
    // placed it. Instead endDragPreview (sequenced via onNextUpdate, firing in the
    // same synchronous flush block that installs the committed geometry and clears
    // the hide) removes the preview and swaps to the committed geometry atomically.
    // Force-apply any still-deferred hide now so a very fast drag's stale
    // originals cannot show through the kept preview during the window.
    this.flushPendingDragHide();
    // Keep the interact overlay following (dragOverlayOffset + moving sets) across
    // the IPC + flush window so the grabbed highlight stays glued to the cursor
    // instead of snapping back to the OLD coords for the ~100ms until the committed
    // geometry lands. endApplyFeatures drops the offset atomically, right before the
    // post-commit overlay refresh reads the installed geometry — so the overlay
    // never renders old+offset after the install (no 2x flash) nor plain old coords
    // during the window (no snap-back). It must survive until the geometry swaps,
    // hence the dragCommitPending handoff. (dragPreviewSet is nulled by the
    // endDragPreview that MapCanvas sequences right after this via onNextUpdate.)
    this.dragCommitPending = true;
  }

  /**
   * End drag preview — removes the preview layers (if still present) and restores
   * every saved bulk-layer filter so the real features are visible again.
   */
  endDragPreview(): void {
    if (!this.dragPreviewActive) return;

    this.cancelDragRender();
    // Tear down the ghost (custom layer or stock follow machine + preview layers).
    // This is the single removal point for the preview now that commitDragPreview
    // keeps it alive across the IPC window.
    this.dragGhost.end();
    // Drop any deferred drag-hide that never fired (drag ended before the stock
    // preview loaded).
    this.clearPendingDragHide();
    // Restore geometry filters immediately, but hold the moved sections' TEXT
    // (label + comment) filters until the label tiles reload with post-move
    // coordinates. The geometry is custom-rendered (its exclusion is dropped
    // synchronously below), so it lands at the new position at once; the text
    // layers read the async-reloading `stalx://` label sources whose resident
    // tiles still hold PRE-move coords, so restoring them in this synchronous
    // flush block would paint the moved labels at their OLD position for the
    // ~200ms until the tiles reload (FINISH label-flash fix).
    const { geometry, text } = partitionDragFilters(this.dragSavedFilters);
    for (const [layerId, saved] of geometry) {
      if (this.map.getLayer(layerId)) this.map.setFilter(layerId, saved ?? null);
    }
    // On a real commit that reloaded label tiles, defer the text restore behind
    // them (else the moved labels flash at the old position); a direct
    // endDragPreview (Escape / rejected move / no-op) passes null -> restore now.
    // Skip the stock text-restore defer when the custom label layer draws — its
    // labels already reflowed to post-move coords in the synchronous commit sync().
    if (!this.labelsCustomActive()) this.labelRestore.deferRestore(text, this.pendingDragCommitLabelReloads);
    this.clearDragOverlayFollow();

    this.dragPreviewSet = null;
    this.dragSavedFilters.clear();
    this.dragPreviewActive = false;
    // Drop the custom-render exclusion and rebuild full buffers so the moved
    // features reappear at their committed positions (mirrors the filter restore).
    this.setDragExclusion(null);
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

  /**
   * Public update entry point. Captures the args and schedules a single
   * synchronous flush at the next microtask boundary, collapsing any
   * additional calls that arrive in the same tick.
   *
   * Callers that *need* the data on the source synchronously (e.g. drag
   * commit using onNextUpdate) get it because microtasks drain before
   * paint and before any rAF that the drag handler uses to finalize.
   */
  update(
    sections: Section[],
    stations: Station[],
    loopClosures?: LoopClosure[],
    gpsOrigin?: GpsOrigin | null,
    showDepthGradient: boolean = false,
    depthRange: DepthRange = { min: 0, max: 50 },
    precision?: DecimalPrecision,
    showIssueSeverity: boolean = false,
    warnings: ProjectWarning[] = []
  ) {
    // Overwrite the pending args — last-call-wins is correct because the
    // builder is deterministic in its inputs; coalescing equivalent calls
    // is the whole point.
    this.pendingUpdateArgs = {
      sections,
      stations,
      loopClosures,
      gpsOrigin: gpsOrigin ?? null,
      showDepthGradient,
      depthRange,
      precision,
      showIssueSeverity,
      warnings,
    };
    this.coalescedUpdateCallsSinceLastFlush += 1;

    // Drag-commit short-circuit: callers that registered onNextUpdate
    // (e.g. MapCanvas.endDragPreview) expect the setData and the
    // callback to land in the same frame — they're restoring filters
    // that hide the dragged preview while the real geometry catches
    // up.  The default async-worker path delays the callback by the
    // worker round-trip (~100 ms on a 14 k-section project), leaving
    // the user looking at the preview hanging on top of stale features.
    // When a one-shot callback is pending, flush synchronously instead.
    if (this.onNextUpdateCallback) {
      this.updateScheduled = false;
      const args = this.pendingUpdateArgs;
      this.pendingUpdateArgs = null;
      this.flushUpdateSync(
        args.sections,
        args.stations,
        args.loopClosures,
        args.gpsOrigin,
        args.showDepthGradient,
        args.depthRange,
        args.precision,
        args.showIssueSeverity,
        args.warnings,
      );
      return;
    }

    if (this.updateScheduled) return;
    this.updateScheduled = true;
    queueMicrotask(() => {
      this.updateScheduled = false;
      const args = this.pendingUpdateArgs;
      this.pendingUpdateArgs = null;
      if (!args) return;
      // Off-thread build for the normal (non-drag-commit) path. Falls
      // back to in-line build inside the worker client if Worker can't
      // be constructed (test envs).
      void this.flushUpdateViaWorker(
        args.sections,
        args.stations,
        args.loopClosures,
        args.gpsOrigin,
        args.showDepthGradient,
        args.depthRange,
        args.precision,
        args.showIssueSeverity,
        args.warnings,
      );
    });
  }

  /**
   * Prototype hook (#customRender): mirror the just-built bulk geometry into the
   * flag-gated custom WebGL layer. No-op unless the gate is on. Reads the caches
   * the flush already populated (surveyData / severity / modes / theme / origin),
   * so it adds nothing to the hot path when the flag is off.
   */
  private syncCustomRender(surveyData: SurveyData): void {
    if (!this.customRender) return;
    const colorCtx: DisplayColorContext = {
      showDepthGradient: this.showDepthGradient,
      depthRange: this.depthRange,
      themeColors: this.themeColors,
      showIssueSeverity: this.showIssueSeverity,
      issueSeverity: this.cachedIssueSeverity,
      // Analytical overlay ramp colors (distance #34 / gas-reach #38): the custom
      // layer has no feature-state, so it resolves them per feature at build time.
      overlay: overlayInputFrom(this.distanceMode, this.distanceState, this.gasReachMode, this.gasReachState),
      // Move-comment palette tint (#52): custom features carry no commentColor
      // property, so the resolvers recompute it (only while move_comment is active).
      commentTint: this.activeTool === 'move_comment',
    };
    this.customRender.sync({
      surveyData,
      gpsOrigin: this.gpsOrigin,
      colorCtx,
      shotWidthPx: this.getShotWidth(),
      stationRadiusPx: this.getStationRadius(),
      stationStrokePx: 1,
    });
    // Custom LABEL layer (#customRender labels). Shares surveyData + theme; its
    // own composed gate no-ops when off. Builds all five kinds, viewport-scoped
    // with collision; a synchronous rebuild here keeps the edit path immediate.
    this.customLabels?.sync({
      surveyData,
      gpsOrigin: this.gpsOrigin,
      themeColors: this.themeColors,
      showDepthGradient: this.showDepthGradient,
      depthRange: this.depthRange,
      precision: this.cachedPrecision,
      commentTint: this.activeTool === 'move_comment',
    });
  }

  /**
   * Re-sync the custom-render prototype from CURRENT store geometry
   * (#customRender). Backs the runtime `__stalagmightSyncCustomRender` hook: the
   * controller's own snapshot is a previous project's geometry after a switch,
   * so read fresh geometry here (measured fallback, like every flush) rather
   * than replaying the stale snapshot. Falls back to the last flush's cached
   * geometry only when the store has no active geometry (e.g. mid-close).
   */
  private resyncCustomRenderFromStore(): void {
    if (!this.customRender || !hasLiveStyle(this.map)) return;
    const surveyData =
      selectActiveSurveyData(useProjectStore.getState(), useUIStore.getState().geometryMode) ??
      this.cachedSurveyData;
    if (surveyData) this.syncCustomRender(surveyData);
  }

  /**
   * Whether a bulk group's stock `stalx://` source should be DROPPED right now
   * (#customRender / #mem) — true only while the matching custom layer suppresses
   * stock AND nothing stock still consumes the source:
   *   - label groups (section / shot / station labels): droppable while the custom
   *     LABEL layer is active. Comments ride the shot/station label sources, so
   *     dropping those covers them too — the custom layer draws every label AND
   *     comment. Keyed on {@link customLabelsSuppressed}, INDEPENDENT of the
   *     geometry suppression (custom labels + stock geometry is the default combo).
   *   - shot-gradients: always droppable (the custom layer draws the gradient).
   *   - shots / stations: droppable EXCEPT while a measured path is set — the
   *     stock survey-measure-path overlay (not hidden by the controller) reads
   *     the `-shots` source, and its per-feature measure content spans both.
   * Loop closures keep the GeoJSON path and are never dropped.
   */
  private shouldDropBulkSource(group: SurveyFeatureGroupKey): boolean {
    if (
      group === 'sectionLabelFeatures' ||
      group === 'shotLabelFeatures' ||
      group === 'stationLabelFeatures'
    ) {
      return this.customLabelsSuppressed;
    }
    if (!this.customBulkSuppressed) return false;
    if (group === 'shotGradientFeatures') return true;
    if (group === 'shotFeatures' || group === 'stationFeatures') {
      return this.measuredPathIds === null && this.measuredPathStationIds === null;
    }
    return false;
  }

  /** The bulk + label groups to skip building + publishing now. Passed to the
   *  worker so it never converts their vt payload; also drives applyFeatureChunk's
   *  drop for the sync / inline / granularity-swap paths. */
  private suppressedBulkGroups(): SurveyFeatureGroupKey[] {
    return [...SurveyLayer.BULK_GEOMETRY_GROUPS, ...SurveyLayer.BULK_LABEL_GROUPS].filter((g) =>
      this.shouldDropBulkSource(g),
    );
  }

  /**
   * Drop a suppressed bulk source's registry payload and force any resident
   * tiles to refetch as empty (#mem). The registry hold (compact typed arrays +
   * one props object per group — ~8.5 MB + ~104k objects on 92.stalx) is the
   * steady-state cost the custom layer makes redundant. The measure-path overlay
   * keeps the `-shots` tiles resident even filtered to nothing, so bump the tile
   * URL to re-request them; the cleared key then serves empty tiles.
   */
  private dropBulkSource(group: SurveyFeatureGroupKey): void {
    const { suffix, kind } = SurveyLayer.GROUP_SOURCE[group];
    const sourceId = this.sourceId + suffix;
    // The source stays resident (only its registry payload + tiles are emptied),
    // so a later reactivation must force a full reload to evict pre-drop
    // out-of-view tiles rather than a bounded one. See vectorTileRegistry.
    clearVtLayerData(sourceId, { sourceStaysResident: true });
    recordFeatureCount(kind, 0);
    const source = this.map.getSource(sourceId) as VectorTileSource | undefined;
    if (source && source.tiles?.[0] && source.tiles[0] !== vtTileUrl(sourceId, 0)) {
      source.setTiles([vtTileUrl(sourceId, this.bulkDropSeq++)]);
    }
    // Drop the section->featureId hover-lookup for a dropped source (rebuilt if
    // the source is re-published; the interact overlay handles hover meanwhile).
    if (group === 'shotFeatures') this.sectionShotFeatureIds = new Map();
    if (group === 'stationFeatures') this.sectionStationFeatureIds = new Map();
  }

  /**
   * The custom layer's drawing state flipped (#customRender / #mem). ON: drop the
   * stock bulk sources it replaces so they stop holding registry + tile caches.
   * OFF (gate flip / fail-safe self-disable): the stock pipeline must come back
   * completely — re-publish from cached SoA, unless a flush is already in flight
   * that will publish them (a flush calls syncCustomRender first, so its own
   * applyFeatureChunk runs after suppression cleared).
   */
  private onCustomActiveChange(active: boolean): void {
    if (active === this.customBulkSuppressed) return;
    this.customBulkSuppressed = active;
    if (!hasLiveStyle(this.map)) return;
    if (active) {
      for (const group of SurveyLayer.BULK_GEOMETRY_GROUPS) {
        if (this.shouldDropBulkSource(group)) this.dropBulkSource(group);
      }
    } else {
      // Synchronous: the controller removes the custom layer right after this
      // returns, so stock geometry must be back in the same frame or the survey
      // blanks. See controller.teardown / rebuildFromCacheIfIdle.
      this.rebuildFromCacheIfIdle(true);
    }
  }

  /**
   * The custom LABEL layer's drawing state flipped (#customRender labels / #mem).
   * The mirror of {@link onCustomActiveChange} for the three label VT groups,
   * driven independently by the label controller's onActiveChange. ON: drop the
   * stock label sources (comments ride shot/station labels, so those cover them).
   * OFF (gate opt-out / fail-safe self-disable): re-publish from cache so the
   * stock label path comes back completely — unless a flush is already in flight
   * that will re-consult suppression and publish them.
   */
  private onCustomLabelsActiveChange(active: boolean): void {
    if (active === this.customLabelsSuppressed) return;
    this.customLabelsSuppressed = active;
    if (!hasLiveStyle(this.map)) return;
    if (active) {
      for (const group of SurveyLayer.BULK_LABEL_GROUPS) {
        if (this.shouldDropBulkSource(group)) this.dropBulkSource(group);
      }
    } else {
      // Synchronous for the same reason as onCustomActiveChange: the label
      // controller removes its custom layer right after this, so the stock label
      // sources must be republished in the same frame to avoid a blank.
      this.rebuildFromCacheIfIdle(true);
    }
  }

  /** Re-publish every source from cached geometry, but only when no full build
   *  is already scheduled / in flight. Shared by both custom-render restore paths
   *  (geometry + labels).
   *
   *  The bail condition: a flush STARTED AFTER suppression cleared re-consults it
   *  (syncCustomRender runs first, then applyFeatureChunk sees the cleared flag),
   *  so a pending/scheduled update will republish the dropped bulk groups for us.
   *  CAVEAT: a full build that was ALREADY IN FLIGHT when we bail captured its
   *  suppressed group set before the clear, so it will NOT republish those groups
   *  when it lands — the survey stays blank until the next real update(). That is
   *  a rare, pre-existing edge (a GL self-disable coinciding with an in-flight
   *  large-project build); not introduced here, and not worth forcing a redundant
   *  synchronous rebuild for. TODO(#follow-up): schedule a token-bumping republish
   *  once the in-flight build settles.
   *
   *  `sync`: republish in the SAME frame (via flushUpdateSync) instead of the
   *  async worker path. The disable path passes this so the stock geometry is
   *  back before the controller removes the custom layer, leaving no blank frame.
   *  Disable is rare (gate opt-out / fail-safe self-disable), so the one-time
   *  synchronous build is an acceptable cost. */
  private rebuildFromCacheIfIdle(sync = false): void {
    // Don't republish stale cached geometry when the store has no active project
    // geometry right now (mid-close, or a project switch where the incoming
    // project has not landed yet): the legacy-cache fallback inside flushUpdate
    // (`selectActiveSurveyData(store) ?? surveyDataFromLegacy(cached)`) would
    // paint the PREVIOUS project's geometry into the new context for a frame.
    // The next real flush republishes the current project. Restore-path only;
    // theme / granularity callers use rebuildFromCache directly (store is live
    // there). When the store IS live, the flush prefers it over the cache, so
    // the passed cached args can never be the stale ones that actually render.
    // INVARIANT: a null here means "no project open", never "open project with
    // renderable geometry": the loader types result.surveyData as non-null
    // (loadProjectBinary), and projectStore only nulls surveyData on init/close
    // (:513/:1153) - a loaded project always has it (real / empty / legacy-built).
    // So this bail can never wrongly skip a republish for an open project.
    if (selectActiveSurveyData(useProjectStore.getState(), useUIStore.getState().geometryMode) === null) {
      return;
    }
    if (
      !this.updateScheduled &&
      this.pendingUpdateArgs === null &&
      this.fullUpdateInFlightCount === 0 &&
      (this.cachedSections.length > 0 || this.cachedStations.length > 0)
    ) {
      if (sync) this.rebuildFromCacheSync();
      else this.rebuildFromCache();
    }
  }

  /** Synchronous sibling of {@link rebuildFromCache}: republishes every source
   *  in the current frame. Only the custom-render disable path uses it (see
   *  {@link rebuildFromCacheIfIdle}); the hot edit path stays on the worker. */
  private rebuildFromCacheSync(): void {
    this.flushUpdateSync(
      this.cachedSections, this.cachedStations, this.cachedLoopClosures, this.gpsOrigin,
      this.showDepthGradient, this.depthRange, this.cachedPrecision, this.showIssueSeverity,
      this.cachedWarnings,
    );
  }

  /** Re-run a full `update()` from the cached inputs. Shared by theme change,
   *  granularity mismatch, worker-swap fallback, and custom-render restore — all
   *  of which need every source rebuilt from the last-known geometry. */
  private rebuildFromCache(): void {
    this.update(
      this.cachedSections, this.cachedStations, this.cachedLoopClosures, this.gpsOrigin,
      this.showDepthGradient, this.depthRange, this.cachedPrecision, this.showIssueSeverity,
      this.cachedWarnings,
    );
  }

  /**
   * Decide whether label features should materialize for this flush, and
   * record the decision in `labelsCurrentlyBuilt`. Shared by the async
   * (worker) and sync (drag-commit) flush paths.
   *
   * Hysteresis: build past LABEL_BUILD_ZOOM, drop only when zoomed out
   * below LABEL_DROP_ZOOM — prevents thrashing at the threshold.
   *
   * While the camera is animating (the load fit-to-bounds, easeTo, ...) the
   * current zoom is transient — a build against it can materialize ~165k
   * label features the settled camera never shows, and that burst sizes the
   * (non-decommitting) JSC heap for the session (#mem). Skip labels during
   * camera motion and re-evaluate once idle (resetLabelZoomHysteresis
   * rebuilds only on a mismatch).
   *
   * A *pending* fit-to-bounds request is the same situation one step
   * earlier: on project load the store arms requestFitToBounds before
   * MapCanvas even mounts, and the first feature build runs against the
   * stale pre-fit camera (uiStore's default z=15 — above the label build
   * threshold) before the fit effect's deferred fitToBounds() starts the
   * animation. Without this guard that first build materialized ~165k
   * shot/station label features the fitted camera (z<13.5 on large
   * projects) never shows, and the mismatch then forced a SECOND full
   * rebuild via resetLabelZoomHysteresis — two overlapping full-graph
   * builds that dominated the load's committed-heap burst (#mem).
   * MapCanvas's fit effect owns the post-fit label recheck (it calls
   * resetLabelZoomHysteresis once the fit settles), so we must NOT arm
   * our own idle recheck for a pending fit: an 'idle' can fire in the gap
   * before the deferred fit starts and would re-evaluate the label
   * decision at the transient camera.
   *
   * `hasData` guards the recorded flag: it means "label features are
   * materialized", so an empty-project flush (app start, project close)
   * must not arm the drop-threshold hysteresis, or a later data load in
   * [13, 13.5) inherits built=true and materializes ~165k labels the
   * build threshold would have skipped.
   */
  private decideBuildLabels(hasData: boolean): boolean {
    const zoom = hasLiveStyle(this.map) ? this.map.getZoom() : 0;
    const fitPending = useUIStore.getState().requestFitToBounds !== false;
    const cameraSettled = !hasLiveStyle(this.map) || (!this.map.isMoving() && !fitPending);
    const input = {
      currentlyBuilt: this.labelsCurrentlyBuilt,
      zoom,
      cameraSettled,
      buildZoom: SurveyLayer.LABEL_BUILD_ZOOM,
      dropZoom: SurveyLayer.LABEL_DROP_ZOOM,
    };
    // Already-built labels are KEPT through transient camera motion: the
    // camera-settle guard only blocks a fresh build against a transient zoom.
    // Tearing built labels down here would blank the whole population, because a
    // move-commit re-flushes through the synchronous drag-commit path, which
    // publishes empty label groups when this returns false (the "all labels
    // flash" bug). See labelBuildDecision.ts.
    const buildLabels = decideLabelBuild(input);
    // Arm a settled-camera recheck only when a fresh build was skipped for camera
    // motion (never for a pending fit — MapCanvas owns that recheck).
    if (!fitPending && skippedBuildForCamera(input)) this.armLabelIdleRecheck();
    this.labelsCurrentlyBuilt = buildLabels && hasData;
    return buildLabels;
  }

  /**
   * Async path: feed inputs to the features worker, await the result,
   * then apply via the shared `applyFeaturesToSources` helper. The
   * synchronous `flushUpdate` is kept for drag-commit / sync callers.
   */
  private async flushUpdateViaWorker(
    sections: Section[],
    stations: Station[],
    loopClosures: LoopClosure[] | undefined,
    gpsOrigin: GpsOrigin | null,
    showDepthGradient: boolean,
    depthRange: DepthRange,
    precision: DecimalPrecision | undefined,
    showIssueSeverity: boolean = false,
    warnings: ProjectWarning[] = [],
  ): Promise<void> {
    if (!hasLiveStyle(this.map)) return;
    // Mark a full build as in flight for the whole async window (token bump ->
    // completion) so a concurrent narrow granularity swap knows the
    // labels/gradients/etc are not yet consistent and rides a full update
    // instead (#mem). Counter, not bool, so overlapping builds stay > 0.
    this.fullUpdateInFlightCount++;
    try {
      this.coalescedUpdateCallsSinceLastFlush = 0;
      this.gpsOrigin = gpsOrigin;
      this.showDepthGradient = showDepthGradient;
      this.depthRange = normalizeDepthRange(depthRange);
      this.showIssueSeverity = showIssueSeverity;
      this.cachedWarnings = warnings;
      // Sections this flush removes (delete / undo-of-add), read BEFORE the cache
      // overwrite. Under the custom renderer their geometry vanishes synchronously
      // below (syncCustomRender), so their stale labels + highlights are dropped in
      // the same frame rather than lingering (#customRender delete straggler).
      const removedSectionIds = diffRemovedSectionIds(this.cachedSections, sections);
      this.cachedSections = sections;
      this.cachedStations = stations;
      this.cachedLoopClosures = loopClosures;
      if (precision !== undefined) this.cachedPrecision = precision;

      const buildLabels = this.decideBuildLabels(sections.length > 0 || stations.length > 0);

      // Tag the call so a later flush invalidates an in-flight build —
      // protects against a fast cascade where the user fires update() again
      // while the worker is still building from the previous args.
      const myToken = ++this.lastUpdateToken;

      // Convert to SurveyData once before posting to the worker. Doing
      // this here (rather than at the call boundary in MapCanvas) lets
      // the existing cached `sections`/`stations` continue to feed
      // drag-preview / theme-rebuild paths inside SurveyLayer that
      // haven't been migrated yet. The conversion is bounded by N (one
      // pass over shots + stations); for the 75k-shot project it's
      // ~10 ms on a single tight loop and the result is a typed-array
      // bundle that structured-clones to the worker far cheaper than
      // 75k+89k JS objects ever would.
      const surveyData = selectActiveSurveyData(
        useProjectStore.getState(),
        useUIStore.getState().geometryMode
      ) ?? surveyDataFromLegacy(sections, stations);

      // Issue-severity arrays are computed against this exact surveyData so the
      // per-shot/per-station indices align with what the builder iterates.
      const issueSeverity = showIssueSeverity
        ? computeIssueSeverity(surveyData, warnings)
        : undefined;
      // Merged groups unless a per-feature mode is active (#mem). Cache the
      // build inputs the hit-test resolver and interact overlay read.
      const perFeature = this.desiredPerFeature();
      this.requestedPerFeature = perFeature;
      this.cachedSurveyData = surveyData;
      this.cachedIssueSeverity = issueSeverity;
      // INVARIANT: geoIndex is re-created (never mutated in place) on every
      // flush. SurveyGeometryIndex holds per-instance lazy caches (projected
      // AABBs, non-reference station sets) that it never invalidates, so their
      // correctness rests entirely on a fresh instance per geometry change. A
      // future "reuse the index across an in-place SoA edit" optimization would
      // silently strand those caches — keep this a fresh `new` per flush.
      this.geoIndex = new SurveyGeometryIndex(surveyData, this.gpsOrigin);
      // Pass the flush's freshly-derived `surveyData` (which prefers the live
      // store over the cached args, so it is never a stale project's geometry).
      // Do NOT switch this to `this.cachedSurveyData` or the raw args or the
      // custom layer could paint stale geometry after an undo / project switch.
      this.syncCustomRender(surveyData);
      // Custom-render delete straggler: the custom layer just dropped the removed
      // geometry, but the async worker build below only refreshes the label sources
      // and the interact overlay in endApplyFeatures (~a worker round-trip later).
      // Close both gaps in THIS frame. Gated on the custom layer actually
      // suppressing stock (the stock path updates geometry and labels together in
      // endApplyFeatures, so it has no such gap) and skipped mid-drag (the drag
      // paths own the overlay follow + label filters).
      if (this.customBulkSuppressed && !this.dragPreviewActive) {
        // Keep the removed sections' labels excluded until they are re-added (undo)
        // - a persistent, tile-timing-independent hide derived from this flush's
        // removals + the surviving sections; no-op until a first removal.
        // Skipped under the custom label layer: it rebuilds the (viewport) label
        // set synchronously from the post-delete SoA in syncCustomRender above, so
        // there is no async label tile lag to paper over.
        if (!this.labelsCustomActive()) this.labelRestore.applyRemovedExclusion(removedSectionIds, sections, surveyData);
        // Rebuild the interact overlay against the new geometry so a selected /
        // hovered / snapped feature this flush removed (a deleted shot / station /
        // section member) is dropped now instead of lingering until the async
        // refresh or the store-driven selection clear. Only when something is
        // actually highlighted - an empty overlay needs no rebuild.
        if (
          this.selectedShotId || this.hoveredShotId || this.selectedStationId ||
          this.hoveredStationId || this.snappedStationId || this.highlightedStationIds.length > 0
        ) {
          // Did the overlay paint a feature this flush deleted? (checked BEFORE the
          // rebuild, which resolves the removed feature to nothing.)
          const stale = overlayTouchesRemovedSections(
            [this.selectedShotId, this.hoveredShotId, this.selectedStationId,
              this.hoveredStationId, this.snappedStationId, ...this.highlightedStationIds],
            removedSectionIds,
          );
          this.lastInteractKey = null;
          this.refreshInteractOverlay();
          // refreshInteractOverlay's setData drops the removed feature from the
          // overlay DATA now, but the GeoJSON source's stale tile keeps painting its
          // highlight until the async re-tile lands (~250ms under the delete's worker
          // load). Hide the interact layers (a pure render-skip) until that re-tile
          // settles so the highlight drops in the geometry frame, like the custom
          // geometry does. Only when a deleted feature was actually highlighted.
          if (stale) this.interactHide.hideUntilRetile();
        }
      }
      const buildOptions = {
        buildLabels,
        showIssueSeverity,
        issueSeverity,
        mergeFeatures: !perFeature,
      };
      // syncCustomRender may have just enabled/disabled the custom layer, so read
      // suppression AFTER it: the worker then skips converting + posting the vt
      // payload for any bulk group the custom layer covers (#customRender / #mem).
      const suppressedBulkGroups = this.suppressedBulkGroups();

      const tBuildStart = performance.now();
      // Stream the built groups to the sources as they arrive (#mem). The sink
      // applies + drops each group, so the main thread never holds the full
      // ~178k-feature set live in addition to MapLibre's retained copy. Each
      // callback re-checks `myToken`/live-style so a newer update or a teardown
      // that landed mid-stream discards the remaining groups.
      let began = false;
      let errored = false;
      const stillCurrent = (): boolean => myToken === this.lastUpdateToken && hasLiveStyle(this.map);
      await buildSurveyFeaturesStreamed(
        {
          surveyData,
          loopClosures,
          gpsOrigin: this.gpsOrigin,
          showDepthGradient: this.showDepthGradient,
          depthRange: this.depthRange,
          themeColors: this.themeColors,
          precision: this.cachedPrecision,
          options: buildOptions,
          suppressedBulkGroups,
        },
        {
          begin: () => {
            if (!stillCurrent()) return;
            began = true;
            this.beginApplyFeatures();
            this.contentPerFeature = perFeature;
          },
          chunk: (group, payload, palette) => {
            if (!began || !stillCurrent()) return;
            this.applyFeatureChunk(group, payload, palette);
          },
          end: () => {
            if (!began || !stillCurrent()) return;
            this.endApplyFeatures();
          },
          error: (e) => {
            errored = true;
            console.error('[SurveyLayer] feature worker failed, falling back to inline build:', e);
          },
        },
      );
      recordPerfTiming('buildFeatures (async)', performance.now() - tBuildStart);

      // Inline fallback on a worker/stream error, if still the current update.
      if (errored && myToken === this.lastUpdateToken && hasLiveStyle(this.map)) {
        const features = buildSurveyFeatures(
          surveyData,
          loopClosures,
          this.gpsOrigin,
          this.showDepthGradient,
          this.depthRange,
          this.themeColors,
          this.cachedPrecision,
          buildOptions,
        );
        this.applyFeaturesToSources(features);
        this.contentPerFeature = perFeature;
      }
    } finally {
      this.fullUpdateInFlightCount--;
    }
  }

  /**
   * Synchronous body of update(). Use this when you genuinely need the
   * setData calls to land in the current stack frame (drag-commit path);
   * normal callers go through the coalescing public `update()` above.
   */
  flushUpdateSync(
    sections: Section[],
    stations: Station[],
    loopClosures?: LoopClosure[],
    gpsOrigin?: GpsOrigin | null,
    showDepthGradient: boolean = false,
    depthRange: DepthRange = { min: 0, max: 50 },
    precision?: DecimalPrecision,
    showIssueSeverity: boolean = false,
    warnings: ProjectWarning[] = [],
  ): void {
    // Cancel any pending coalesced flush so we don't re-run with stale args.
    this.updateScheduled = false;
    this.pendingUpdateArgs = null;
    // Bump the token so any in-flight `flushUpdateViaWorker` (started by
    // an earlier update before this sync flush kicked in) discards its
    // result via the `myToken !== this.lastUpdateToken` guard.  Without
    // this the older worker could land its stale features on top of the
    // freshly-applied sync data — most visibly during a drag commit
    // that arrives between the user's last zoom rebuild and the worker
    // finishing.
    this.lastUpdateToken += 1;
    this.flushUpdate(
      sections,
      stations,
      loopClosures,
      gpsOrigin ?? null,
      showDepthGradient,
      depthRange,
      precision,
      showIssueSeverity,
      warnings,
    );
  }

  private flushUpdate(
    sections: Section[],
    stations: Station[],
    loopClosures: LoopClosure[] | undefined,
    gpsOrigin: GpsOrigin | null,
    showDepthGradient: boolean,
    depthRange: DepthRange,
    precision: DecimalPrecision | undefined,
    showIssueSeverity: boolean = false,
    warnings: ProjectWarning[] = [],
  ): void {
    // Early bail when the map is gone or its style has been torn down — the
    // coalescer's queueMicrotask can race with MapCanvas unmount → map.remove(),
    // and setData on a removed source throws. We have to check this BEFORE
    // hitting getSource/setData below.
    if (!hasLiveStyle(this.map)) return;

    // Reset the call counter so the probe can show calls/tick coherently.
    this.coalescedUpdateCallsSinceLastFlush = 0;
    // Store gpsOrigin for coordinate transforms
    this.gpsOrigin = gpsOrigin;
    // Store depth mode parameters for use in feature color calculation
    this.showDepthGradient = showDepthGradient;
    this.depthRange = normalizeDepthRange(depthRange);
    this.showIssueSeverity = showIssueSeverity;
    this.cachedWarnings = warnings;

    // Cache input data for feature rebuild on theme change
    this.cachedSections = sections;
    this.cachedStations = stations;
    this.cachedLoopClosures = loopClosures;
    if (precision !== undefined) this.cachedPrecision = precision;

    const buildLabels = this.decideBuildLabels(sections.length > 0 || stations.length > 0);

    // Synchronous (drag-commit) path: convert to SurveyData inline
    // before building. See the async counterpart for the rationale.
    const surveyData = selectActiveSurveyData(
      useProjectStore.getState(),
      useUIStore.getState().geometryMode
    ) ?? surveyDataFromLegacy(sections, stations);

    const issueSeverity = showIssueSeverity
      ? computeIssueSeverity(surveyData, warnings)
      : undefined;

    // Merged groups unless a per-feature mode is active (#mem); cache the
    // inputs the hit-test resolver and interact overlay read.
    const perFeature = this.desiredPerFeature();
    this.requestedPerFeature = perFeature;
    this.cachedSurveyData = surveyData;
    this.cachedIssueSeverity = issueSeverity;
    this.geoIndex = new SurveyGeometryIndex(surveyData, this.gpsOrigin);
    this.syncCustomRender(surveyData);

    const features = buildSurveyFeatures(
      surveyData,
      loopClosures,
      this.gpsOrigin,
      this.showDepthGradient,
      this.depthRange,
      this.themeColors,
      this.cachedPrecision,
      { buildLabels, showIssueSeverity, issueSeverity, mergeFeatures: !perFeature }
    );
    this.applyFeaturesToSources(features);
    this.contentPerFeature = perFeature;
  }

  /**
   * Push a built `SurveyFeatureSets` to MapLibre sources and refresh the
   * derived state (hover/selection lookup maps, feature-state, etc.).
   * Synchronous callers (drag commit, theme rebuild fallback) hand the whole
   * set here; it replays through the same begin/chunk/end helpers the streamed
   * worker path uses so both paths behave identically.
   */
  private applyFeaturesToSources(features: ReturnType<typeof buildSurveyFeatures>): void {
    if (!hasLiveStyle(this.map)) return;
    this.beginApplyFeatures();
    for (const group of SURVEY_FEATURE_GROUP_ORDER) {
      this.applyFeatureChunk(group, { features: features[group] }, features.colorPalette);
    }
    this.endApplyFeatures();
  }

  /** MapLibre source suffix + memory-probe kind for each streamed group. */
  private static readonly GROUP_SOURCE: Record<
    SurveyFeatureGroupKey,
    { suffix: string; kind: Parameters<typeof recordFeatureCount>[0] }
  > = {
    shotFeatures: { suffix: '-shots', kind: 'survey-shots' },
    stationFeatures: { suffix: '-stations', kind: 'survey-stations' },
    sectionLabelFeatures: { suffix: '-section-labels', kind: 'survey-section-labels' },
    shotGradientFeatures: { suffix: '-shot-gradients', kind: 'survey-shot-gradients' },
    shotLabelFeatures: { suffix: '-shot-labels', kind: 'survey-shot-labels' },
    stationLabelFeatures: { suffix: '-station-labels', kind: 'survey-station-labels' },
    loopClosureFeatures: { suffix: '-loop-closures', kind: 'survey-loop-closures' },
  };

  /** Source suffixes served as on-demand vector tiles (registry keys are
   *  `sourceId + suffix`). Derived from VT_GROUP_KIND; used for teardown. */
  private static readonly VT_SOURCE_SUFFIXES = [
    '-shots',
    '-stations',
    '-shot-gradients',
    '-section-labels',
    '-shot-labels',
    '-station-labels',
  ] as const;

  /** Groups served as on-demand vector tiles (#mem). Loop closures (small)
   *  keep the GeoJSON path. Keep in sync with featuresWorker.VT_GROUP_KIND. */
  private static readonly VT_GROUP_KIND: Partial<Record<SurveyFeatureGroupKey, 'line' | 'point'>> = {
    shotFeatures: 'line',
    shotGradientFeatures: 'line',
    stationFeatures: 'point',
    sectionLabelFeatures: 'point',
    shotLabelFeatures: 'point',
    stationLabelFeatures: 'point',
  };

  /**
   * Start applying a build: reset the section->featureId hover-lookup maps that
   * the shot/station chunks repopulate. The palette is adopted per-chunk (it is
   * append-only, so each snapshot is a superset of the last).
   */
  private beginApplyFeatures(): void {
    this.sectionShotFeatureIds = new Map();
    this.sectionStationFeatureIds = new Map();
    // Fresh flush: collect this flush's label-source reloads so a drag commit can
    // defer its text-filter restore behind them (FINISH label-flash fix).
    this.labelReloadsThisFlush = [];
  }

  /**
   * Apply one streamed feature group to its MapLibre source and (for shots /
   * stations) repopulate the O(1) section->featureId hover-lookup map. Adopts
   * this chunk's palette snapshot (#B) and refreshes the color paint so the
   * `match` over `colorIndex` lines up with the features just set — the palette
   * is append-only, so re-adopting a growing snapshot keeps every
   * already-applied group's indices valid (no color flash). The caller drops
   * its reference to `features` after this returns so the group's objects can
   * be reclaimed while later groups still stream in.
   */
  private applyFeatureChunk(
    group: SurveyFeatureGroupKey,
    chunk: VtFeatureChunk,
    colorPalette: readonly string[],
  ): void {
    if (!hasLiveStyle(this.map)) return;
    const { suffix, kind } = SurveyLayer.GROUP_SOURCE[group];
    const vtKind = SurveyLayer.VT_GROUP_KIND[group];
    // Adopt the palette snapshot before the data lands so the color `match`
    // is valid for this group, then refresh the paint expressions.
    this.colorPalette = colorPalette as string[];

    if (vtKind) {
      // Custom render suppression (#customRender / #mem): while the custom WebGL
      // layer draws these, their dedicated `stalx://` source must not build a
      // payload, cut tiles, or hold caches. Drop instead of publish. The worker
      // path already skips emitting suppressed groups; this covers the paths
      // that still emit (granularity swap, inline fallback, sync drag-commit).
      if (this.shouldDropBulkSource(group)) {
        this.dropBulkSource(group);
        return;
      }
      // Bulk group -> vector-tile registry (#mem). The worker ships the
      // compact typed-array payload; the sync/inline build paths still hand
      // us GeoJSON, so convert here in that case.
      const data: VtLayerData =
        chunk.vt ??
        (vtKind === 'line' ? vtLinesFromFeatures(chunk.features!) : vtPointsFromFeatures(chunk.features!));
      if (group === 'shotFeatures' || group === 'stationFeatures') {
        const target =
          group === 'shotFeatures' ? this.sectionShotFeatureIds : this.sectionStationFeatureIds;
        for (let gi = 0; gi < data.ids.length; gi++) {
          const sid = data.props[gi]?.sectionId;
          if (typeof sid !== 'number') continue;
          let set = target.get(sid);
          if (!set) { set = new Set(); target.set(sid, set); }
          set.add(data.ids[gi]!);
        }
      }
      const sourceId = this.sourceId + suffix;
      const { version, dirtyBounds } = setVtLayerData(sourceId, data);
      // Flash-free publication (#mem): reloadVtSource decides against the
      // resident-tile convergence watermarks, not this diff alone. A null diff
      // still reconciles tiles a superseded/abandoned earlier reload left stale
      // (#customRender label-stale fix), and no-ops when they are already
      // current; a rectangle reloads only the edited region in place, keeping
      // existing geometry renderable until each replacement lands. The very
      // first publication (source still on the v0 URL) is bootstrapped with a
      // plain setTiles. So drive it every publish, including the null one.
      const source = this.map.getSource(sourceId) as VectorTileSource | undefined;
      const reload = reloadVtSource(source, sourceId, version, dirtyBounds);
      // Track label-source reloads so a drag-commit endDragPreview can hold the
      // moved sections' text filters hidden until the tiles carry post-move
      // coordinates (else the labels flash at the old position). Only genuine
      // content-change reloads gate the restore; a background reconcile (null
      // diff) must not, so it would defer the restore behind unrelated work.
      if (dirtyBounds !== null && LABEL_VT_GROUPS.has(group)) this.labelReloadsThisFlush.push(reload);
      else void reload;
      recordFeatureCount(kind, vtGroupCount(data));
      this.applyColorPaint();
      return;
    }

    const features = chunk.features ?? [];
    const source = this.map.getSource(this.sourceId + suffix);
    if (source && 'setData' in source) {
      (source as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features });
      recordFeatureCount(kind, features.length);
    }
    this.applyColorPaint();
  }

  /**
   * Finish applying a build: clear and refresh all derived feature state
   * (feature-state trackers, section caches, color paint, hover/selection
   * visuals, distance/gas/measured overlays) and fire the one-shot callback.
   * Runs once after the last group has been applied.
   */
  private endApplyFeatures(): void {
    // Guard: only re-apply if map style is still live (avoids crash during teardown)
    if (!hasLiveStyle(this.map)) return;
    // The shots/stations sources are vector tiles now, refreshed via an in-place
    // tile reload (#mem). Unlike the old GeoJSON setData(), reloading tiles does
    // NOT wipe feature-state: MapLibre keeps it keyed by (source, feature id) at
    // the style level, independent of tile refetches. A rebuild
    // can reassign a merged-group ordinal (feature id) to a different section;
    // for example, changing depth coloring can drop groups and shift later
    // ordinals down. Remove every previously tracked ID individually so pending
    // MapLibre state writes are cancelled too, then reset tracking and re-apply.
    const shotsSource = this.sourceId + '-shots';
    const stationsSource = this.sourceId + '-stations';
    const clearIds = (source: string, groups: Iterable<Iterable<number>>): void => {
      for (const group of groups) {
        for (const id of group) {
          this.map.removeFeatureState({ source, sourceLayer: VT_SOURCE_LAYER, id });
        }
      }
    };
    clearIds(shotsSource, [
      this.prevHoveredSectionShotIds,
      this.prevSelectedSectionShotIds,
      this.prevAnchoredFeatureIds,
      this.distanceState?.shots.keys() ?? [],
      this.gasReachState?.shots.keys() ?? [],
      this.measuredPathIds ?? [],
    ]);
    clearIds(stationsSource, [
      this.prevHoveredSectionStationIds,
      this.prevSelectedSectionStationIds,
      this.prevAnchoredFeatureIds,
      this.distanceState?.stations.keys() ?? [],
      this.gasReachState?.stations.keys() ?? [],
      this.measuredPathStationIds ?? [],
    ]);
    this.prevHoveredSectionShotIds = new Set();
    this.prevHoveredSectionStationIds = new Set();
    this.prevSelectedSectionShotIds = new Set();
    this.prevSelectedSectionStationIds = new Set();
    this.invalidateSectionCaches();
    this.updateImmovableLayerOpacity(this.immovableStationFeatureIds, this.immovableShotFeatureIds);
    // Geometry/colors behind the interact overlay may have changed — rebuild
    // it (updateVisualState below refreshes with the invalidated key).
    this.lastInteractKey = null;
    // Re-apply the palette-driven color paint (#B): the palette adopted above can
    // differ from the layers' current `match` (theme / depth / severity / edits),
    // so the shots/gradient/stations color + stroke expressions must be refreshed
    // to line up with the freshly-set `colorIndex` / `strokeColorIndex`.
    this.applyColorPaint();
    // Drag-commit atomic settle: the placement kept the follow-offset applied
    // through the IPC + flush window so the grabbed highlight tracked the cursor.
    // The committed geometry is installed NOW, so drop the offset (and its moving
    // sets) BEFORE the refresh below reads it — the overlay then renders the NEW
    // coords once (final == cursor), with no old+offset overshoot and no snap-back
    // to old coords. clearDragOverlayFollow re-emits at the new coords immediately;
    // updateVisualState's own refresh is then a no-op via the lastInteractKey cache.
    if (this.dragCommitPending) this.clearDragOverlayFollow();
    this.updateVisualState();
    // The clear above wiped feature-state, so re-apply the distance-gradient
    // `dist` HERE (the rebuild path), NOT in updateVisualState(), which runs on
    // every hover where feature-state is intact and re-applying all ~N features
    // would tank FPS (60→10 on large surveys). (#34)
    if (this.distanceMode) {
      this.applyDistanceFeatureState();
    }
    // Gas reachable-frontier overlay (#38): same feature-state-wipe re-apply.
    if (this.gasReachMode) {
      this.applyGasReachFeatureState();
    }
    // Likewise re-apply the measured along-line path tint (#26).
    if (this.measuredPathIds || this.measuredPathStationIds) {
      this.applyMeasuredPathFeatureState();
    }
    // Gas route highlight (#233): re-push the route LineStrings (coords come from cachedStations,
    // which a rebuild may have refreshed).
    if (this.gasRouteLegs.length > 0) {
      this.applyGasRoute();
    }

    // Fire one-shot callback (used by drag commit to restore filters in the same
    // synchronous block as setData, ensuring no paint gap between them). Expose
    // this flush's label reloads for the callback's span so a drag-commit
    // endDragPreview defers its text-filter restore behind the label tiles
    // (FINISH label-flash fix); a direct endDragPreview sees null -> restores now.
    if (this.onNextUpdateCallback) {
      const cb = this.onNextUpdateCallback;
      this.onNextUpdateCallback = null;
      this.pendingDragCommitLabelReloads = this.labelReloadsThisFlush;
      try {
        cb();
      } finally {
        this.pendingDragCommitLabelReloads = null;
      }
    }
    // Drop any transient per-feature (single shot/station delete) label hide once
    // this flush's label tiles have reloaded truthfully (labelRestore.ts).
    // Skipped under the custom label layer (nothing was armed to settle).
    if (!this.labelsCustomActive()) this.labelRestore.settleFeatureExclusion(this.labelReloadsThisFlush);
  }

  /**
   * Register a one-shot callback to run at the end of the next update() call,
   * after all sources have been refreshed. Used to restore drag preview filters
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

    // Overlay features carry resolved theme colors — rebuild them (the
    // feature rebuild below also refreshes via endApplyFeatures, but hover
    // state between now and then should not show stale colors).
    this.lastInteractKey = null;
    this.refreshInteractOverlay();

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
    // Comments label text-color (via applyCommentTextColor() to keep the
    // move-comment palette tint (#52) if that tool is currently active)
    this.applyCommentTextColor();
    // Station comments halo
    if (this.map.getLayer(this.stationCommentsLayerId)) {
      this.map.setPaintProperty(this.stationCommentsLayerId, 'text-halo-color', colors.textHaloAlt);
    }
    // Shot comments halo
    if (this.map.getLayer(this.shotCommentsLayerId)) {
      this.map.setPaintProperty(this.shotCommentsLayerId, 'text-halo-color', colors.textHaloAlt);
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
    // Station stroke-color expression (hover/selected colors, else palette match
    // on `strokeColorIndex`, #B). The rebuild below re-applies it with the fresh
    // palette; this keeps it valid in the meantime (`this.themeColors` is already
    // `colors`).
    if (this.map.getLayer(this.stationsLayerId)) {
      this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-color', this.stationsStrokeColor());
    }

    // Rebuild features with new theme colors (colors are embedded in GeoJSON properties)
    if (this.cachedSections.length > 0 || this.cachedStations.length > 0) {
      this.rebuildFromCache();
    }
  }

  /** Drop the module-level vector-tile registry entries (the flat geometry
   *  arrays MapLibre does not own) and zero the memory-probe counts, WITHOUT
   *  the rest of destroy()'s teardown. Cheap: only clears JS maps, touching
   *  neither the map nor the worker, so it is safe on unmount right before
   *  map.remove(). The registry is keyed by a fixed source id shared across
   *  projects, so a project -> Global-View switch (which skips destroy() for
   *  unmount speed) would otherwise leave this project's ~MBs of arrays resident
   *  until the next project's first publish overwrites the slot (#mem). */
  releaseVtRegistry(): void {
    clearFeatureCountsForPrefix('survey-');
    for (const suffix of SurveyLayer.VT_SOURCE_SUFFIXES) {
      clearVtLayerData(this.sourceId + suffix);
    }
  }

  destroy() {
    // Cancel any pending coalesced update so its microtask doesn't fire on a
    // destroyed map (would throw in setData).
    this.updateScheduled = false;
    this.pendingUpdateArgs = null;

    // Clear any still-pending deferred text-filter restore timer so it cannot
    // fire on a torn-down map (the setFilter is getLayer-guarded, but drop the
    // timer to avoid a dangling handle).
    this.labelRestore.dispose();
    // Restore any interact layers left hidden by an in-flight removal re-tile and
    // drop its listener/timer so nothing fires on the torn-down map.
    this.interactHide.dispose();

    // Tear down the custom-render prototype (removes its layer, restores stock
    // layer visibility, and unregisters the runtime sync hook) (#customRender).
    this.customRender?.destroy();
    this.customRender = null;
    this.customLabels?.destroy();
    this.customLabels = null;

    // Drop the module-level VT registry entries + zero the memory-probe counts.
    this.releaseVtRegistry();

    // Cancel any pending hover RAF
    if (this.hoverRafId !== null) {
      cancelAnimationFrame(this.hoverRafId);
      this.hoverRafId = null;
    }
    this.pendingHoverEvent = null;
    this.cancelDragRender();
    // Tear down the ghost (custom layer / stock follow listener + timer) so
    // nothing fires on a torn-down map.
    this.dragGhost.end();

    // Clean up touch long-press timer
    if (this.touchLongPressTimer) {
      clearTimeout(this.touchLongPressTimer);
      this.touchLongPressTimer = null;
    }

    // Guard against map being destroyed (race condition on unmount)
    if (!hasLiveStyle(this.map)) {
      // Clear bound handler references even if map is destroyed
      this.boundMouseMove = null;
      this.boundMapLeave = null;
      this.boundTouchStart = null;
      this.boundTouchMove = null;
      this.boundTouchEnd = null;
      return;
    }

    try {
      // Unregister event handlers first (before removing layers)
      this.map.off('click', this.handleMapClick);
      this.map.off('error', this.handleMapError);
      this.map.off('contextmenu', this.handleContextMenu);

      if (this.boundMouseMove) {
        this.map.off('mousemove', this.boundMouseMove);
      }
      if (this.boundMapLeave) {
        this.map.getCanvas().removeEventListener('mouseleave', this.boundMapLeave);
      }
      // Remove touch long-press listeners
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
      this.map.off('zoomend', this.handleZoomEndTelemetry);
      this.map.off('moveend', this.handleMoveEndTelemetry);
      if (this.boundZoomEndForLabels) {
        this.map.off('zoomend', this.boundZoomEndForLabels);
        this.boundZoomEndForLabels = null;
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
      // Interact overlay layers (#mem)
      if (this.map.getLayer(this.interactShotsLayerId)) {
        this.map.removeLayer(this.interactShotsLayerId);
      }
      if (this.map.getLayer(this.interactShotsMeasuredLayerId)) {
        this.map.removeLayer(this.interactShotsMeasuredLayerId);
      }
      if (this.map.getLayer(this.interactStationsLayerId)) {
        this.map.removeLayer(this.interactStationsLayerId);
      }
      if (this.map.getLayer(this.shotsLayerId)) {
        this.map.removeLayer(this.shotsLayerId);
      }
      if (this.map.getLayer(this.shotGradientsLayerId)) {
        this.map.removeLayer(this.shotGradientsLayerId);
      }
      if (this.map.getLayer(this.measurePathLayerId)) {
        this.map.removeLayer(this.measurePathLayerId);
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
      // Remove ghost hitbox layers (the main hitbox layers were removed, #mem)
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
      if (this.map.getSource(this.sourceId + '-shot-gradients')) {
        this.map.removeSource(this.sourceId + '-shot-gradients');
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
      if (this.map.getSource(this.interactSourceId)) {
        this.map.removeSource(this.interactSourceId);
      }
    } catch {
      // Map already destroyed during unmount, cleanup not needed
    }

    // Clear bound handler references
    this.boundMouseMove = null;
    this.boundMapLeave = null;
  }
}
