import { create } from 'zustand';

import { defaultConfig } from '../types/config';
import { TANK_PRESETS, cylinderFromPreset } from '../utils/tankPresets';
import type {
  Cylinder,
  Diver,
  DivePlanSnapshot,
  GasConfig,
  GasReachField,
} from '../types/ipc.generated';
import type { StationRef } from '../types/project';
import { divePlanSnapshotOf, divePlanSnapshotsEqual } from '../utils/divePlan';

/**
 * Gas & route-planning sub-mode state (#38, Phase 1). Runtime-only — never
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

/** Canonical starting rig: a matched twin AL80 back-gas set — the "call-it-an-80"
 *  baseline every cave diver recognizes (≈2295 L usable each at 207 bar). */
const DEFAULT_DIVER: Diver = { rmv_l_per_min: 20, label: null };

function defaultCylinders(): Cylinder[] {
  // Single source of truth: the canonical AL80 preset (tankPresets), as a twin set.
  const al80 = TANK_PRESETS.find((p) => p.id === 'al80');
  return al80 ? [cylinderFromPreset(al80), cylinderFromPreset(al80)] : [];
}

interface GasPlanState {
  /** Penetration origin; `null` = the zero-datum entrance default. */
  origin: StationRef | null;
  /** Chosen route endpoint (the lead being planned); `null` = the deepest in-budget point. */
  endpoint: StationRef | null;
  diver: Diver;
  cylinders: Cylinder[];
  /** Working gas config; seeded from `Config.gas`, edited in-mode (units/speeds/reserve). */
  gasConfig: GasConfig;
  /** Latest reachability field from the backend (null until fetched / after any input change). */
  reachField: GasReachField | null;
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
  | 'diver'
  | 'cylinders'
  | 'gasConfig'
  | 'reachField'
  | 'stageDropOverrides'
  | 'loadedPlanId'
  | 'loadedPlanBaseline'
  | 'pushyAck'
  | 'hydrated'
> => ({
  origin: null,
  endpoint: null,
  diver: DEFAULT_DIVER,
  cylinders: defaultCylinders(),
  // Deep-clone so editing the working config (incl. nested reserve_profile / dpv) never
  // mutates the shared compiled default through an aliased object reference.
  gasConfig: structuredClone(defaultConfig.gas),
  reachField: null,
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
  setOrigin: (origin) => set({ origin, reachField: null, stageDropOverrides: [] }),
  setEndpoint: (endpoint) => set({ endpoint, reachField: null, stageDropOverrides: [] }),
  setDiver: (diver) => set({ diver, reachField: null, stageDropOverrides: [] }),
  setCylinders: (cylinders) => set({ cylinders, reachField: null, stageDropOverrides: [] }),
  setGasConfig: (gasConfig) => set({ gasConfig, reachField: null, stageDropOverrides: [] }),
  setReachField: (reachField) => set({ reachField }),
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
      diver: snapshot.diver,
      cylinders: snapshot.cylinders,
      gasConfig: snapshot.gas_config,
      stageDropOverrides: snapshot.stage_drop_overrides,
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
