/**
 * Screen-space label collision / decluttering for the custom-render LABEL pass
 * (#customRender labels, Phase 4).
 *
 * PURE (a projector is injected): no GL, no DOM, no MapLibre. Given the
 * viewport-scoped {@link LabelDescriptor} set + each label's shaped em
 * {@link ExtentEm} + the current zoom + a `project(relMercator) -> screenPx`
 * function, it decides which labels to HIDE so nothing piles up. The controller
 * bakes the returned indices into the fresh buffer as `LABEL_FLAG.HIDE` (§5 of
 * the design), so collision costs one flag per loser and no separate upload.
 *
 * ALGORITHM (design §5): a greedy screen-space uniform-grid sweep over the
 * candidate set, in an explicit priority order (place-first wins):
 *   (1) section names, (2) first-in-section station labels, (3) station labels,
 *   (4) shot labels, (5) comments.
 * Ties break by ordinal then by array index — deterministic, and pan-stable for
 * the surviving set (relative order of any two labels that both stay on screen
 * is preserved, so their overlap resolution does not flip frame-to-frame).
 *
 * CANDIDATE FILTER: only labels the shader would actually draw participate —
 * kind toggled on AND at/above its minzoom, not reference-hidden, not thinned by
 * the zoom-band decimation (`isLabelDecimatedOut`, the exact CPU mirror of the
 * shader's `mod(ordinal, N)`). A non-candidate is never marked HIDE (it is
 * already collapsed by the shader for its own reason), so re-showing its kind /
 * decimation band later never leaves it wrongly hidden. Only candidates that
 * LOSE an overlap get HIDE.
 *
 * TARGET is "no overlapping labels + stable", NOT pixel-exact MapLibre placement
 * (which is neither reproducible nor worth reproducing) — see the design's Risk 3.
 */
import { LABEL_KIND, LABEL_FLAG, type LabelKind } from './labelShaders';
import type { LabelDescriptor } from './labelTessellate';
import type { ExtentEm } from './labelLayout';
import { LABEL_KIND_STYLE, interpolateStops } from './labelStyle';
import { decimationModulusForKind, isLabelDecimatedOut } from './labelDecimation';

/** Screen-space axis-aligned bounding box, in CSS px (same space as `project`). */
export interface ScreenBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Inputs collision needs beyond the descriptors + their em extents. `project`
 *  maps a label's anchor-relative mercator (`desc.anchorX/anchorY`) to CSS px;
 *  the remaining fields mirror what the shader uses to gate a label so the
 *  candidate set matches what would draw. */
export interface CollisionInput {
  /** Current map zoom — drives text size (box size), decimation, minzoom gate. */
  zoom: number;
  /** Anchor-relative mercator -> screen CSS px (north-up affine or `map.project`). */
  project: (relX: number, relY: number) => readonly [number, number];
  /** Per-kind toggle state (setShow*), indexed by {@link LabelKind}. */
  kindVisible: readonly boolean[];
  /** setShowReferenceShots(false) → reference / all-reference labels don't draw. */
  hideReference: boolean;
  /** Grid cell size in CSS px (perf only; correctness is cell-size-independent).
   *  Defaults to {@link DEFAULT_CELL_PX}. */
  cellSize?: number;
}

/** Default grid cell (CSS px): a touch larger than the tallest label so a label
 *  spans only a couple of cells vertically. Perf-only; overlap results do not
 *  depend on it. */
export const DEFAULT_CELL_PX = 48;

/** Collision priority (LOWER places first / wins overlaps), per design §5. */
export function labelPriority(kind: LabelKind, firstInSection: boolean): number {
  switch (kind) {
    case LABEL_KIND.SECTION_NAME:
      return 0;
    case LABEL_KIND.STATION_LABEL:
      return firstInSection ? 1 : 2;
    case LABEL_KIND.SHOT_LABEL:
      return 3;
    default:
      return 4; // station + shot comments
  }
}

interface Candidate {
  index: number;
  priority: number;
  tiebreak: number;
  box: ScreenBox;
}

/** Strict-overlap test: boxes touching exactly at an edge do NOT collide (so two
 *  labels can sit flush without one being culled). */
function overlaps(a: ScreenBox, b: ScreenBox): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

/** The screen AABB a label would occupy: its anchor projected to px, plus the em
 *  extent scaled by the kind's (CSS-px) text size, plus the halo width. em +y is
 *  UP, screen +y is DOWN, so the vertical extent flips. */
export function labelScreenBox(
  desc: LabelDescriptor,
  extent: ExtentEm,
  input: CollisionInput,
): ScreenBox {
  const style = LABEL_KIND_STYLE[desc.kind];
  const size = interpolateStops(input.zoom, style.size); // CSS px (no DPR)
  const halo = style.haloWidth;
  const [ax, ay] = input.project(desc.anchorX, desc.anchorY);
  return {
    minX: ax + extent.minX * size - halo,
    maxX: ax + extent.maxX * size + halo,
    minY: ay - extent.maxY * size - halo,
    maxY: ay - extent.minY * size + halo,
  };
}

/** Whether a label draws at all under the current zoom + toggles (the exact CPU
 *  mirror of the shader's collapse conditions). A non-candidate is left alone. */
function isCandidate(desc: LabelDescriptor, input: CollisionInput): boolean {
  const style = LABEL_KIND_STYLE[desc.kind];
  if (!input.kindVisible[desc.kind]) return false;
  if (input.zoom < style.minzoom) return false;
  if (input.hideReference && (desc.flags & (LABEL_FLAG.REFERENCE | LABEL_FLAG.ALL_REFERENCE)) !== 0) {
    return false;
  }
  const firstInSection = (desc.flags & LABEL_FLAG.FIRST_IN_SECTION) !== 0;
  const modulus = decimationModulusForKind(desc.kind, input.zoom);
  return !isLabelDecimatedOut(desc.ordinal, modulus, firstInSection);
}

/**
 * Greedy grid placement over pre-built candidates (sorted by priority then
 * tiebreak). Returns the indices of the LOSERS (overlapped an already-placed
 * box). Exposed for focused grid/boundary unit tests; {@link collideLabels}
 * assembles the candidates.
 */
export function placeGreedy(candidates: Candidate[], cellSize: number): number[] {
  const grid = new Map<string, ScreenBox[]>();
  const hidden: number[] = [];
  const cellsFor = (b: ScreenBox): { x0: number; x1: number; y0: number; y1: number } => ({
    x0: Math.floor(b.minX / cellSize),
    x1: Math.floor(b.maxX / cellSize),
    y0: Math.floor(b.minY / cellSize),
    y1: Math.floor(b.maxY / cellSize),
  });
  for (const c of candidates) {
    const r = cellsFor(c.box);
    let collides = false;
    for (let cx = r.x0; cx <= r.x1 && !collides; cx++) {
      for (let cy = r.y0; cy <= r.y1 && !collides; cy++) {
        const bucket = grid.get(`${cx},${cy}`);
        if (bucket) {
          for (const placed of bucket) {
            if (overlaps(placed, c.box)) {
              collides = true;
              break;
            }
          }
        }
      }
    }
    if (collides) {
      hidden.push(c.index);
      continue;
    }
    for (let cx = r.x0; cx <= r.x1; cx++) {
      for (let cy = r.y0; cy <= r.y1; cy++) {
        const key = `${cx},${cy}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(c.box);
        else grid.set(key, [c.box]);
      }
    }
  }
  return hidden;
}

/**
 * Decide which labels to HIDE for a viewport-scoped build. `extents[i]` is the
 * shaped em extent of `descriptors[i]` (or `null` for an empty / whitespace-only
 * label, which never participates). Returns the indices to OR `LABEL_FLAG.HIDE`
 * into. Deterministic: the same inputs always yield the same set.
 */
export function collideLabels(
  descriptors: LabelDescriptor[],
  extents: (ExtentEm | null)[],
  input: CollisionInput,
): number[] {
  const candidates: Candidate[] = [];
  for (let i = 0; i < descriptors.length; i++) {
    const desc = descriptors[i]!;
    const extent = extents[i];
    if (extent === null || extent === undefined) continue;
    if (!isCandidate(desc, input)) continue;
    const firstInSection = (desc.flags & LABEL_FLAG.FIRST_IN_SECTION) !== 0;
    candidates.push({
      index: i,
      priority: labelPriority(desc.kind, firstInSection),
      tiebreak: desc.ordinal,
      box: labelScreenBox(desc, extent, input),
    });
  }
  // Stable, deterministic order: priority, then ordinal, then array index.
  candidates.sort(
    (a, b) => a.priority - b.priority || a.tiebreak - b.tiebreak || a.index - b.index,
  );
  const cellSize = input.cellSize && input.cellSize > 0 ? input.cellSize : DEFAULT_CELL_PX;
  return placeGreedy(candidates, cellSize);
}
