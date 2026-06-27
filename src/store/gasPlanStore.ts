import { create } from 'zustand';

import { defaultConfig } from '../types/config';
import { TANK_PRESETS, cylinderFromPreset } from '../utils/tankPresets';
import type { Cylinder, Diver, GasConfig, GasReachField } from '../types/ipc.generated';
import type { StationRef } from '../types/project';

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
  /** Session-only: the user accepted the advanced (staged) reserve presets. Cleared by
   *  `reset()` — on Plan sub-mode exit AND on every project load (`applyDisplaySettings`) — so
   *  a fresh project (or a re-entry) re-prompts. Never persisted. */
  pushyAck: boolean;

  setOrigin: (origin: StationRef | null) => void;
  setEndpoint: (endpoint: StationRef | null) => void;
  setDiver: (diver: Diver) => void;
  setCylinders: (cylinders: Cylinder[]) => void;
  setGasConfig: (gasConfig: GasConfig) => void;
  setReachField: (reachField: GasReachField | null) => void;
  setPushyAck: (ack: boolean) => void;
  /** Restore defaults (called from uiStore.exitGasPlan on sub-mode exit). */
  reset: () => void;
}

const initialState = (): Pick<
  GasPlanState,
  'origin' | 'endpoint' | 'diver' | 'cylinders' | 'gasConfig' | 'reachField' | 'pushyAck'
> => ({
  origin: null,
  endpoint: null,
  diver: DEFAULT_DIVER,
  cylinders: defaultCylinders(),
  // Deep-clone so editing the working config (incl. nested reserve_profile / dpv) never
  // mutates the shared compiled default through an aliased object reference.
  gasConfig: structuredClone(defaultConfig.gas),
  reachField: null,
  pushyAck: false,
});

export const useGasPlanStore = create<GasPlanState>((set) => ({
  ...initialState(),

  // Each input setter clears the cached field so stale reachable colors aren't
  // shown under the new inputs' legend while the refetch is in flight (mirrors
  // setDistanceGradientOrigin).
  setOrigin: (origin) => set({ origin, reachField: null }),
  setEndpoint: (endpoint) => set({ endpoint, reachField: null }),
  setDiver: (diver) => set({ diver, reachField: null }),
  setCylinders: (cylinders) => set({ cylinders, reachField: null }),
  setGasConfig: (gasConfig) => set({ gasConfig, reachField: null }),
  setReachField: (reachField) => set({ reachField }),
  setPushyAck: (pushyAck) => set({ pushyAck }),

  reset: () => set(initialState()),
}));
