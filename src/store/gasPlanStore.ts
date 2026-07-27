import { create } from 'zustand';

import { defaultConfig } from '../types/config';
import { TANK_PRESETS, cylinderFromPreset } from '../utils/tankPresets';
import type {
  Cylinder,
  Diver,
  DivePlanSnapshot,
  GasConfig,
  GasReachField,
  MarkedPoint,
  PlanSegment,
} from '../types/ipc.generated';
import type { StationRef } from '../types/project';
import { divePlanSnapshotOf, divePlanSnapshotsEqual } from '../utils/divePlan';

/**
 * Mirror the Rust caps (`core/state/dive_plan.rs`), the same way `GasPlanPanel` mirrors
 * `MAX_MARKED_LABEL_CHARS`. The backend enforces these on save (reject), on load (truncate) and on
 * the compute command (reject); mirroring them at the point of creation is what keeps a diver from
 * building a plan the app will later refuse to store.
 */
const MAX_WAYPOINTS = 64;
/**
 * Upper bound on a plan's per-span pace/propulsion segments (#317), mirroring the Rust
 * `MAX_SEGMENTS` (`core/state/dive_plan.rs`). Not independently enforced anywhere below:
 * `segments` is always exactly `waypoints.length + 1` (the length-sync invariant the
 * setters below maintain), so the `MAX_WAYPOINTS` cap on way points already caps this too.
 * Kept as its own named constant so a reader doesn't have to re-derive the relationship.
 */
export const MAX_SEGMENTS = MAX_WAYPOINTS + 1;
const MAX_MARKED_POINTS = 500;

/**
 * Gas & route-planning sub-mode state (#38, Phase 1). Runtime-only - never
 * persisted. The store's intrinsic default is the compiled `defaultConfig.gas`;
 * on sub-mode entry `GasPlanPanel` overwrites `gasConfig` with the live PERSISTED
 * `projectStore.config.gas` (the user's saved gas prefs), and `uiStore.exitGasPlan`
 * resets it. Mirrors the distance-gradient pattern: every input setter nulls the
 * cached `reachField` so a stale reachable overlay never shows under changed inputs
 * while the new field is in flight.
 *
 * Phase 1 is single-diver open-circuit; the `Vec<Cylinder>` shape is kept so the
 * later CCR/team phases add no migration (PRD §5).
 */

/** Canonical starting rig: a matched twin AL80 back-gas set - the "call-it-an-80"
 *  baseline every cave diver recognizes (≈2295 L usable each at 207 bar). */
const DEFAULT_DIVER: Diver = { rmv_l_per_min: 20, label: null };

function defaultCylinders(): Cylinder[] {
  // Single source of truth: the canonical AL80 preset (tankPresets), as a twin set.
  const al80 = TANK_PRESETS.find((p) => p.id === 'al80');
  return al80 ? [cylinderFromPreset(al80), cylinderFromPreset(al80)] : [];
}

/** A fresh span's default pace/propulsion (#317): the configured swim speed, no scooter -
 *  the same assumption the engine already made about every leg before segments existed. */
function defaultSegment(): PlanSegment {
  return { speed_m_per_min: defaultConfig.gas.swim_speed_m_per_min, on_scooter: false };
}

interface GasPlanState {
  /** Penetration origin; `null` = the zero-datum entrance default. */
  origin: StationRef | null;
  /** Chosen route endpoint (the lead being planned); `null` = the deepest in-budget point. */
  endpoint: StationRef | null;
  /** #298: ordered intermediate points the dive must visit, in order, between origin and
   *  endpoint. The engine re-bases the whole reach field through them, so adding one costs
   *  real gas rather than only re-drawing the route line. */
  waypoints: StationRef[];
  /** #317: per-span pace/propulsion, one entry per span between way points - always exactly
   *  `waypoints.length + 1` (span 0 runs from the origin, the last covers the open field past
   *  the final way point). A GAS INPUT like way points themselves: the engine derates in-leg gas
   *  consumption while `on_scooter`, so every setter nulls `reachField` the same way. */
  segments: PlanSegment[];
  /** #298: arbitrary map annotations saved with the plan (a photo stop, a lead, a restriction).
   *  Never sent to the gas engine - marking a station cannot change the route or the budget. */
  markedPoints: MarkedPoint[];
  diver: Diver;
  cylinders: Cylinder[];
  /** Working gas config; seeded from `Config.gas`, edited in-mode (units/speeds/reserve). */
  gasConfig: GasConfig;
  /** Latest reachability field from the backend (null until fetched / after any input change). */
  reachField: GasReachField | null;
  /**
   * The last NON-null field, kept across the refetch window that `reachField` nulls.
   *
   * Every input setter blanks `reachField` so stale colours are not painted under new inputs, and
   * in Plan a plain left-click is an input (it sets the endpoint). So the ordinary
   * click-then-right-click gesture opens the context menu while `reachField` is null, and a menu
   * built from the live field would silently drop its stage-drop entries and treat every station
   * as off-route. This is what the menu reads instead: the plan the map is still drawing.
   *
   * Only ever consumed for MENU SHAPE, never for a number the diver acts on. A route point picked
   * off a route that has since moved is safe by construction - the engine keeps a stage drop only
   * when the pinned station is on (or extends) the route it recomputes, and otherwise falls back to
   * the strategy default.
   */
  lastReachField: GasReachField | null;
  /** Per-stage drop overrides (#246), aligned by drop index with the field's `stage_drop_refs`:
   *  the route station the diver dragged each ▼ marker to (`null` = strategy default). Cleared
   *  whenever the rig / config / origin / endpoint changes (which reshuffles the drops), exactly
   *  like `reachField`. Passed to `compute_gas_reach_field` so the backend recomputes the plan. */
  stageDropOverrides: (StationRef | null)[];
  /** #244: id of the currently-loaded saved plan, or null when the working inputs are an
   *  unsaved exploration. Set on load; cleared on reset and when the loaded plan is deleted. */
  loadedPlanId: number | null;
  /** #244: the snapshot as loaded / as of the last successful Save. The baseline the dirty
   *  check compares the live inputs against (see `selectIsPlanDirty`). */
  loadedPlanBaseline: DivePlanSnapshot | null;
  /** Session-only: the user accepted the advanced (staged) reserve presets. Cleared by
   *  `reset()` on every project load (`applyDisplaySettings`), so a fresh project re-prompts.
   *  Never persisted. */
  pushyAck: boolean;
  /** #244: the working gas config has been seeded from the persisted app config for this
   *  session. Gates the panel's one-time seed so re-ENTERING Plan mode does not re-seed and
   *  clobber a loaded plan / working inputs. Cleared by `reset()` (project load / new session). */
  hydrated: boolean;

  setOrigin: (origin: StationRef | null) => void;
  setEndpoint: (endpoint: StationRef | null) => void;
  /** #298: append a way point to the end of the visit order. */
  addWaypoint: (ref: StationRef) => void;
  /** #298: drop way point `index`; a stray index is a no-op. */
  removeWaypoint: (index: number) => void;
  /** #298: swap way point `index` with its neighbour (`-1` earlier, `+1` later). Out-of-range
   *  moves are a no-op, so the panel's arrows need no bounds logic of their own. */
  moveWaypoint: (index: number, delta: number) => void;
  /** #317: replace the whole segment list (the Segments-tab idiom - mirrors `setCylinders`: the
   *  caller computes the new array, the store just nulls the stale gas-dependent state). */
  setSegments: (segments: PlanSegment[]) => void;
  /** #298: drop a marked point on `ref`. */
  addMarkedPoint: (ref: StationRef) => void;
  /** #298: remove marked point `index`. */
  removeMarkedPoint: (index: number) => void;
  /** #298: set (or clear, with an empty string) marked point `index`'s label. */
  setMarkedPointLabel: (index: number, label: string) => void;
  /**
   * #24: re-point every plan pin after a section reverse renumbered its stations.
   *
   * Every pin here is a positional `StationRef`, so a reverse leaves it in range
   * while it starts naming the opposite physical station - the plan would
   * silently re-price a different route. The caller supplies the already-mirrored
   * pins (see `utils/reverseAftermath`); this only installs them, and blanks the
   * cached field the way every other route-input setter does.
   */
  applyReversedPins: (
    pins: {
      origin: StationRef | null;
      endpoint: StationRef | null;
      waypoints: StationRef[];
      markedPoints: MarkedPoint[];
      stageDropOverrides: (StationRef | null)[];
    },
    baseline: DivePlanSnapshot | null
  ) => void;
  setDiver: (diver: Diver) => void;
  setCylinders: (cylinders: Cylinder[]) => void;
  setGasConfig: (gasConfig: GasConfig) => void;
  setReachField: (reachField: GasReachField | null) => void;
  setPushyAck: (ack: boolean) => void;
  /** #244: mark the gas config seeded for this session (see `hydrated`). */
  markHydrated: () => void;
  /** Pin (or, with `null`, reset) stage `index`'s drop to a route station. Does NOT null
   *  `reachField`, so the existing drop markers stay put during the ms-fast refetch instead of
   *  flickering; the fetch effect depends on `stageDropOverrides` and swaps the field in on arrival. */
  setStageDropOverride: (index: number, ref: StationRef | null) => void;
  /** #244: apply a loaded plan's snapshot to the inputs and mark it the clean baseline.
   *  Sets all six gas inputs at once (the reach-field effect recomputes) and nulls the
   *  cached field so a stale overlay never shows under the new plan. */
  applyLoadedPlan: (planId: number, snapshot: DivePlanSnapshot) => void;
  /** #244: after a successful Save / Save as, rebind the baseline to the EXACT snapshot that
   *  was persisted (passed in, not re-derived - so an edit made during the async save can't
   *  read clean-but-stale) under the given plan id. */
  markPlanSaved: (planId: number, baseline: DivePlanSnapshot) => void;
  /** #244: forget the loaded plan (e.g. it was deleted) without touching the inputs. */
  clearLoadedPlan: () => void;
  /** Restore defaults. Called from `applyDisplaySettings` on project load / new session
   *  (NOT on a mode switch - the plan persists across mode switches now, #244). */
  reset: () => void;
}

const initialState = (): Pick<
  GasPlanState,
  | 'origin'
  | 'endpoint'
  | 'waypoints'
  | 'segments'
  | 'markedPoints'
  | 'diver'
  | 'cylinders'
  | 'gasConfig'
  | 'reachField'
  | 'lastReachField'
  | 'stageDropOverrides'
  | 'loadedPlanId'
  | 'loadedPlanBaseline'
  | 'pushyAck'
  | 'hydrated'
> => ({
  origin: null,
  endpoint: null,
  waypoints: [],
  segments: [defaultSegment()],
  markedPoints: [],
  diver: DEFAULT_DIVER,
  cylinders: defaultCylinders(),
  // Deep-clone so editing the working config (incl. nested reserve_profile / dpv) never
  // mutates the shared compiled default through an aliased object reference.
  gasConfig: structuredClone(defaultConfig.gas),
  reachField: null,
  lastReachField: null,
  stageDropOverrides: [],
  loadedPlanId: null,
  loadedPlanBaseline: null,
  pushyAck: false,
  hydrated: false,
});

export const useGasPlanStore = create<GasPlanState>((set) => ({
  ...initialState(),

  // Each input setter clears the cached field so stale reachable colors aren't
  // shown under the new inputs' legend while the refetch is in flight (mirrors
  // setDistanceGradientOrigin).
  // These inputs reshuffle the drops (a different rig / route / budget), so any pinned drop
  // overrides no longer line up, clear them alongside the stale field.
  // The pins moved because the SURVEY was renumbered, not because the diver
  // changed an input, so the drop overrides are kept (mirrored by the caller)
  // rather than cleared - the route is the same physical route.
  // `lastReachField` goes too, even though it is only ever read for MENU SHAPE:
  // its route refs are positional and pre-reverse, and with `reachField` nulled
  // here the ContextMenu's `reachField ?? lastReachField` fallback is GUARANTEED
  // to be taken. A stale route set would then mark the mirrored stations
  // off-route and hide the stage-drop entries (or offer them on a station that
  // is no longer on the route - the unsafe direction). Blank, not mirrored: the
  // field's refs are re-derived by the refetch this same set() triggers.
  applyReversedPins: (pins, baseline) =>
    set({
      ...pins,
      reachField: null,
      lastReachField: null,
      // The saved-plan baseline is mirrored WITH the pins. It is positional too, so leaving it
      // behind would make `selectIsPlanDirty` compare mirrored pins against pre-reverse indices
      // and report a plan the diver never edited as unsaved - nagging a save, or blocking a plan
      // switch, over a route that is still the same physical route. Nothing needs re-saving: the
      // `.plnx` names stations by the shots they sit between, so a reverse does not move them.
      ...(baseline === null ? {} : { loadedPlanBaseline: baseline }),
    }),

  setOrigin: (origin) => set({ origin, reachField: null, stageDropOverrides: [] }),
  setEndpoint: (endpoint) => set({ endpoint, reachField: null, stageDropOverrides: [] }),
  // Way points are a ROUTE input: every edit re-bases the whole field, so they clear the cached
  // field and the pinned drops exactly like setEndpoint. Marked points are pure annotation and
  // deliberately do NOT - clearing the field there would flash the overlay off for nothing.
  // Capped, and a repeat of a station already on the list is a no-op. Both mirror the backend:
  // `save_dive_plan` REFUSES an over-long list, so without the cap here the diver could build a plan
  // in the UI - paying an extra Dijkstra per way point on every keystroke - and only discover the
  // wall at save time, on a message that names neither the limit nor which entry to drop. The
  // label field is already capped for exactly this reason. A duplicate is separately meaningless:
  // it burns a slot, adds a second identical panel row, and makes the panel's per-way-point gas
  // read the LATER cumulative while the overlay paints the earlier pass.
  addWaypoint: (ref) =>
    set((s) => {
      const dup = s.waypoints.some(
        (w) => w.section_id === ref.section_id && w.station_index === ref.station_index,
      );
      if (dup || s.waypoints.length >= MAX_WAYPOINTS) return {};
      // A new way point is always appended at the end of the visit order, so it always splits
      // the LAST span (the open field past the previous final way point) into two: the leg
      // leading up to it and the leg leading on from it. Both inherit the split segment's
      // pace/propulsion - the diver hasn't said anything different about either half yet.
      const splitSeg = s.segments[s.segments.length - 1] ?? defaultSegment();
      return {
        waypoints: [...s.waypoints, ref],
        segments: [...s.segments.slice(0, -1), splitSeg, { ...splitSeg }],
        reachField: null,
        stageDropOverrides: [],
      };
    }),
  removeWaypoint: (index) =>
    set((s) => {
      if (index < 0 || index >= s.waypoints.length) return {};
      // Dropping way point `index` collapses the two spans it used to separate - segment
      // `index` (leading into it) and segment `index + 1` (leading on from it) - into one.
      // The merge takes the SLOWER of the two speeds and requires BOTH halves to have been
      // scootered: the safe direction, mirroring the backend's own reconciliation of a stale
      // way point on load (`merge_segments_for_surviving_waypoints`, core/state/dive_plan.rs).
      // Either half taken alone would understate the gas the merged span actually costs.
      const before = s.segments[index];
      const after = s.segments[index + 1];
      const merged: PlanSegment =
        before && after
          ? {
              speed_m_per_min: Math.min(before.speed_m_per_min, after.speed_m_per_min),
              on_scooter: before.on_scooter && after.on_scooter,
            }
          : (before ?? after ?? defaultSegment());
      return {
        waypoints: s.waypoints.filter((_w, i) => i !== index),
        segments: [...s.segments.slice(0, index), merged, ...s.segments.slice(index + 2)],
        reachField: null,
        stageDropOverrides: [],
      };
    }),
  moveWaypoint: (index, delta) =>
    set((s) => {
      const to = index + delta;
      if (index < 0 || index >= s.waypoints.length || to < 0 || to >= s.waypoints.length) {
        return {};
      }
      const next = s.waypoints.slice();
      const moved = next[index]!;
      next[index] = next[to]!;
      next[to] = moved;
      // `segments` is deliberately NOT permuted (#317). A segment is bounded by TWO way points, so
      // there is no segment that "belongs to" the one being moved and could travel with it. The
      // pace pattern is therefore POSITIONAL: span 1 keeps its speed and propulsion whatever the
      // diver reorders the route into. Length-sync holds trivially since a swap changes no counts.
      return { waypoints: next, reachField: null, stageDropOverrides: [] };
    }),
  // A segment is a GAS INPUT: its speed divides straight into every edge cost on that span
  // (`gas = rmv x ata(depth) x length / speed`), so a slower span costs more gas and reaches less
  // far. `on_scooter` spends the rig's range but does NOT derate the breathing rate - scootering
  // gets no reduced-RMV credit (PRD section 10), which is the conservative direction. Either way
  // the field is stale, so this nulls `reachField` and clears `stageDropOverrides` exactly like
  // `setCylinders`/`setGasConfig`.
  setSegments: (segments) => set({ segments, reachField: null, stageDropOverrides: [] }),
  addMarkedPoint: (ref) =>
    set((s) =>
      s.markedPoints.length >= MAX_MARKED_POINTS
        ? {}
        : { markedPoints: [...s.markedPoints, { station: ref, label: null }] },
    ),
  removeMarkedPoint: (index) =>
    set((s) =>
      index < 0 || index >= s.markedPoints.length
        ? {}
        : { markedPoints: s.markedPoints.filter((_m, i) => i !== index) },
    ),
  setMarkedPointLabel: (index, label) =>
    set((s) => {
      if (index < 0 || index >= s.markedPoints.length) return {};
      const next = s.markedPoints.slice();
      // Store the RAW value. Trimming here would fight the controlled input this feeds: the panel
      // renders `value={m.label ?? ''}`, so typing a space produces "photo ", the setter would store
      // "photo", and React would restore the shorter value into the DOM - eating the space on every
      // keystroke and making a multi-word label untypable by hand. (`fill()` in an e2e dispatches
      // one event with the whole string, so it never sees this.) Normalising a keystroke against a
      // controlled value is the same trap as the signed-decimal fields.
      //
      // The trim happens once, at the boundary that needs it: `divePlanSnapshotOf` before the save.
      next[index] = { ...next[index]!, label: label === '' ? null : label };
      return { markedPoints: next };
    }),
  setDiver: (diver) => set({ diver, reachField: null, stageDropOverrides: [] }),
  setCylinders: (cylinders) => set({ cylinders, reachField: null, stageDropOverrides: [] }),
  setGasConfig: (gasConfig) => set({ gasConfig, reachField: null, stageDropOverrides: [] }),
  // `lastReachField` only ever moves forward to a real field - it is never nulled here, so it
  // survives the refetch window. `reset()` clears both, so it cannot leak across a project switch.
  setReachField: (reachField) =>
    set(reachField ? { reachField, lastReachField: reachField } : { reachField }),
  setPushyAck: (pushyAck) => set({ pushyAck }),
  markHydrated: () => set({ hydrated: true }),
  setStageDropOverride: (index, ref) => {
    // Guard BEFORE set so a stray negative index is a true no-op (returning {} from the updater
    // would still merge a fresh state object and wake subscribers for nothing).
    if (index < 0) return;
    set((s) => {
      const next = s.stageDropOverrides.slice();
      while (next.length <= index) next.push(null);
      next[index] = ref;
      return { stageDropOverrides: next };
    });
  },

  applyLoadedPlan: (planId, snapshot) =>
    set({
      origin: snapshot.origin,
      endpoint: snapshot.endpoint,
      waypoints: snapshot.waypoints,
      markedPoints: snapshot.marked_points,
      diver: snapshot.diver,
      cylinders: snapshot.cylinders,
      gasConfig: snapshot.gas_config,
      stageDropOverrides: snapshot.stage_drop_overrides,
      segments: snapshot.segments,
      reachField: null,
      loadedPlanId: planId,
      loadedPlanBaseline: snapshot,
    }),
  markPlanSaved: (planId, baseline) =>
    set({ loadedPlanId: planId, loadedPlanBaseline: baseline }),
  clearLoadedPlan: () => set({ loadedPlanId: null, loadedPlanBaseline: null }),

  reset: () => set(initialState()),
}));

/** #244: true when a plan is loaded and the live inputs diverge from its saved
 *  baseline. A never-saved exploration (`loadedPlanId === null`) is never dirty. */
export function selectIsPlanDirty(s: GasPlanState): boolean {
  if (s.loadedPlanId === null || s.loadedPlanBaseline === null) return false;
  return !divePlanSnapshotsEqual(divePlanSnapshotOf(s), s.loadedPlanBaseline);
}
