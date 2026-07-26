import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useGasPlanStore } from '../../store/gasPlanStore';
import { useProjectStore } from '../../store/projectStore';
import { defaultConfig } from '../../types/config';
import { formatStationId } from '../../utils/formatters';
import {
  formatGasLength,
  formatPressure,
  formatVolume,
  pressureFromDisplay,
  pressureToDisplay,
  rmvFromDisplay,
  rmvToDisplay,
  speedFromDisplay,
  speedToDisplay,
} from '../../utils/formatGas';
import { PositiveNumberField } from '../common/PositiveNumberField';
import { DivePlanBar } from './DivePlanBar';
import type { GasUnits, ReservePreset } from '../../types/ipc.generated';

const RESERVE_PRESETS: readonly ReservePreset[] = [
  'all_thirds',
  'one_stage',
  'two_stage',
  'free',
];
const UNIT_OPTIONS: readonly GasUnits[] = ['metric', 'imperial'];

/** Stage cylinders a strategy requires in the rig - mirrors the Rust `required_stages`
 *  (gas.rs). The Half-Minus strategies are greyed until the diver carries that many stages;
 *  Free (#245) needs none (the diver sets each tank's usable gas by hand). */
const REQUIRED_STAGES: Record<ReservePreset, number> = {
  all_thirds: 0,
  one_stage: 1,
  two_stage: 2,
  free: 0,
};

/** Mirrors the Rust `MAX_MARKED_LABEL_CHARS` (core/state/dive_plan.rs). Capping the input here
 *  means a label typed in the panel can never be the reason a whole plan fails to save; the
 *  backend guard remains, for a hand-edited `.plnx`. */
const MAX_MARKED_LABEL_CHARS = 120;

// Persist the swim speed into the saved config (the same gas.swim_speed_m_per_min
// Settings edits). Reads the LATEST saved config at call time, so a debounced/flushed
// write always merges against current state rather than a stale snapshot. Module-scope
// so the debounced callbacks below stay dependency-free.
function writeSwimSpeedToDisk(v: number): void {
  const saved = useProjectStore.getState().config;
  if (saved) {
    void useProjectStore.getState().updateConfig({
      ...saved,
      gas: { ...saved.gas, swim_speed_m_per_min: v },
    });
  }
}

/**
 * Gas & route-planning setup sidebar (#38). The right Dock slot while in Plan mode:
 * origin, diver RMV, gas strategy + per-stage reserve, units, and the plan readout. The cylinder
 * rig editor lives in the bottom panel's "Cylinders" tab (see PlanTablesPanel) - this sidebar
 * reads the cylinders only to compute the turn / drop pressures. Every input nulls the cached
 * field via gasPlanStore, so MapCanvas refetches + repaints the reachable overlay. Volumes follow
 * the master units toggle; RMV flips L·min⁻¹ ↔ cuft·min⁻¹.
 */
export function GasPlanPanel() {
  const { t } = useTranslation();
  const {
    origin,
    endpoint,
    waypoints,
    markedPoints,
    diver,
    cylinders,
    gasConfig,
    reachField,
    stageDropOverrides,
    pushyAck,
    setOrigin,
    setEndpoint,
    removeWaypoint,
    moveWaypoint,
    removeMarkedPoint,
    setMarkedPointLabel,
    setDiver,
    setGasConfig,
    setPushyAck,
    setStageDropOverride,
  } = useGasPlanStore(
    useShallow((s) => ({
      origin: s.origin,
      endpoint: s.endpoint,
      waypoints: s.waypoints,
      markedPoints: s.markedPoints,
      diver: s.diver,
      cylinders: s.cylinders,
      gasConfig: s.gasConfig,
      reachField: s.reachField,
      stageDropOverrides: s.stageDropOverrides,
      pushyAck: s.pushyAck,
      setOrigin: s.setOrigin,
      setEndpoint: s.setEndpoint,
      removeWaypoint: s.removeWaypoint,
      moveWaypoint: s.moveWaypoint,
      removeMarkedPoint: s.removeMarkedPoint,
      setMarkedPointLabel: s.setMarkedPointLabel,
      setDiver: s.setDiver,
      setGasConfig: s.setGasConfig,
      setPushyAck: s.setPushyAck,
      setStageDropOverride: s.setStageDropOverride,
    }))
  );
  // A staged strategy the user selected but hasn't yet acknowledged (inline advanced gate).
  const [pendingPushy, setPendingPushy] = useState<ReservePreset | null>(null);

  // Seed the working gas config from the live PERSISTED app config the FIRST time Plan
  // mode opens this session, falling back to the compiled defaults when no config is
  // loaded. Gated on the store's `hydrated` flag: this panel remounts on every mode
  // switch, and re-seeding would clobber a loaded plan / working inputs now that the gas
  // store persists across mode switches (#244). Cleared on project load, so a new session
  // re-seeds. Display units follow the app-wide MASTER units (Settings ▸ Units): feet ⇒
  // imperial, so an imperial app opens an imperial gas panel (the in-panel toggle still
  // overrides for the session).
  useEffect(() => {
    if (useGasPlanStore.getState().hydrated) return;
    const cfg = useProjectStore.getState().config;
    const masterImperial = cfg?.units?.length === 'feet';
    // Deep-clone the seed so editing the working config never mutates the live persisted
    // config (or the compiled default) through a shared nested reference (reserve_profile / dpv).
    setGasConfig({
      ...structuredClone(cfg?.gas ?? defaultConfig.gas),
      units: masterImperial ? 'imperial' : 'metric',
    });
    useGasPlanStore.getState().markHydrated();
  }, [setGasConfig]);

  // Swim-speed disk-persist debounce (#241): the in-memory working config updates
  // immediately on every keystroke, but the disk write is trailing-debounced so a fast
  // typist doesn't fire one config save per keystroke (each save reloads config + drops
  // the LSQ solve). Cancel any pending write when a newer value arrives, so only the
  // LATEST value is ever persisted regardless of write-completion order.
  const swimSpeedPersistRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    value: number;
  } | null>(null);
  // Flush any pending write immediately (used on unmount so a value typed within the
  // debounce window right before leaving Plan mode still reaches disk -- the pre-debounce
  // code persisted every keystroke, so dropping the last one would be a regression).
  const flushSwimSpeed = useCallback(() => {
    const pending = swimSpeedPersistRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    swimSpeedPersistRef.current = null;
    writeSwimSpeedToDisk(pending.value);
  }, []);
  useEffect(() => flushSwimSpeed, [flushSwimSpeed]);
  const persistSwimSpeed = useCallback((v: number) => {
    if (swimSpeedPersistRef.current) clearTimeout(swimSpeedPersistRef.current.timer);
    const timer = setTimeout(() => {
      swimSpeedPersistRef.current = null;
      writeSwimSpeedToDisk(v);
    }, 450);
    swimSpeedPersistRef.current = { timer, value: v };
  }, []);

  const units = gasConfig.units;
  const originLabel = origin
    ? formatStationId(origin.section_id, origin.station_index)
    : t('gasPanel.origin.entrance');

  // Way-point readouts, all from the engine (#298) - the panel never re-derives a
  // budget-dependent number, or it drifts from the overlay the way #233's gauges did.
  // `waypoint_gas_litres[i]` is the cumulative gas at way point i, or null from the first one the
  // walk could not reach.
  //
  // ⚠ These are only meaningful once a field has ARRIVED. Every gas-input setter nulls
  // `reachField` for the duration of the refetch, and an absent entry reads `undefined == null`,
  // so keying "unreachable" off the value alone would flash every row red on each RMV keystroke,
  // reorder or endpoint pick. Gate on the field's presence first (same shape as the route readout
  // further down), and treat a not-yet-computed way point as "pending", not as bad news.
  const waypointGas = reachField?.waypoint_gas_litres ?? [];
  const gasKnown = reachField != null;
  const stalledIdx = gasKnown ? waypointGas.findIndex((g) => g == null) : -1;
  // Only report a stall for a way point that actually exists in the CURRENT list: the field can
  // lag a keystroke behind the store, and warning about a way point the user just removed reads
  // as a bug.
  const stalledWaypoint = stalledIdx >= 0 && stalledIdx < waypoints.length ? stalledIdx : null;
  // Over budget = the detour alone costs more gas than the diver has. Distinct from a stall
  // (which is "cannot be reached at all") and gets its own, actionable message.
  const waypointsOverBudget =
    reachField != null && waypointGas.some((g) => g != null && g > reachField.budget_litres);

  // The engine turned short of the chosen endpoint (it is out of budget, so the plan runs as far
  // toward it as the gas allows). The station it actually turns at, or null when the endpoint IS
  // the turnaround. `final_turn_ref` is the engine's own answer - never re-derived here.
  const turn = reachField?.final_turn_ref ?? null;
  const endpointOutOfReach =
    endpoint != null &&
    turn != null &&
    (turn.section_id !== endpoint.section_id || turn.station_index !== endpoint.station_index)
      ? turn
      : null;

  // Count only ENABLED stages: the engine filters disabled tanks before counting stages
  // (gas.rs `active`), so a disabled stage must not keep a staged strategy selectable here or the
  // panel would show a staged plan + its reserve control while the engine has fallen back to
  // All-thirds (#245 UI/backend parity - this drives the button-enable, isStaged, and re-check).
  const stageCount = cylinders.filter((c) => c.role === 'stage' && c.enabled).length;
  const strategy = gasConfig.default_reserve;
  // Effective staged state: a staged strategy AND the rig actually carries enough stages. Mirrors
  // the backend's stage-count fallback, so removing stages after selecting a staged strategy hides
  // the staged-only reserve control instead of leaving it stale (UI/backend parity).
  const isStaged =
    (strategy === 'one_stage' || strategy === 'two_stage') && stageCount >= REQUIRED_STAGES[strategy];
  const reserveBar = gasConfig.reserve_profile.stage_reserve_bar;

  // Three non-additive gauges, each relative to its own cylinder's start (back gas = one unit).
  // They come from the BACKEND (single source of truth): it already applies the conservative cap,
  // the normalized reserve, and the stage-count fallback, so the panel can't drift from the
  // reachable overlay. `stage_drop_bars` has one entry per counted stage of the effective strategy.
  const backgasTurn = reachField ? reachField.backgas_turn_bar : null;
  // Per-stage drops (pressure + swum distance from origin), aligned 1:1; one readout row each - any
  // number of stages (Free is uncapped). When drops exist the diver switches to back gas after
  // dropping the stages, so the back-gas gauge reads "switch pressure", not "turn pressure".
  const stageDrops = reachField
    ? reachField.stage_drop_bars.map((bar, i) => ({
        bar,
        distance: reachField.stage_drop_distances_m[i] ?? null,
        // Dragged deeper than the safe drop (#246): breathing into reserve, flagged red. The
        // engine is the single source of truth for this, same as the pressure.
        overReserve: reachField.stage_drop_over_reserve[i] === true,
        // Whether the diver moved this drop (so we offer a reset back to the strategy spot).
        overridden: stageDropOverrides[i] != null,
      }))
    : [];
  const hasStageDrops = stageDrops.length > 0;
  const anyOverReserve = stageDrops.some((d) => d.overReserve);

  // Route metrics (backend single source of truth), shown once a real route is known. Gate on the
  // route having at least one LEG - not just final_turn_ref - so a degenerate single-station route
  // (origin == turnaround when only the origin is in budget) doesn't render a meaningless
  // "Distance to turnaround: 0 m". The distance is the one-way swum line length to the turnaround;
  // depths are the route's deepest point + the distance-weighted average depth.
  // ⚠ Also require a turnaround. Since #298 a route can be drawn with NO target: when the
  // way-point chain itself is unflyable the engine still returns the committed chain so the diver
  // can see where the plan broke, but there is no turnaround, so labelling that partial line
  // "Distance to turnaround" would report a confident number for a dive that cannot be made.
  const hasRoute = (reachField?.route.length ?? 0) > 0 && reachField?.final_turn_ref != null;
  const routeMaxDepth = reachField?.route_max_depth_m ?? null;
  const routeAvgDepth = reachField?.route_avg_depth_m ?? null;

  // Advanced strategies route through an inline acknowledgment the first time per session: the
  // staged (Half-Minus) presets AND Free, which lets the diver set reserves by hand (incl. a
  // zero-reserve plan), so it's at least as advanced as the staged ones. All-thirds and an
  // already-acked strategy apply immediately.
  const isAdvancedPreset = (preset: ReservePreset) => REQUIRED_STAGES[preset] > 0 || preset === 'free';
  const selectPreset = (preset: ReservePreset) => {
    if (isAdvancedPreset(preset) && !pushyAck) {
      setPendingPushy(preset);
      return;
    }
    setGasConfig({ ...gasConfig, default_reserve: preset });
  };
  const confirmPushy = () => {
    if (!pendingPushy) return;
    // Re-check: the rig may have lost stages while the ack panel was open (the Cylinders tab is
    // visible alongside it). Only apply if the rig still satisfies the strategy - otherwise we'd
    // show a staged strategy selected on a stage-short rig while the backend falls back to
    // All-thirds (broken UI/backend parity). Insufficient → dismiss without applying.
    if (stageCount >= REQUIRED_STAGES[pendingPushy]) {
      setPushyAck(true);
      setGasConfig({ ...gasConfig, default_reserve: pendingPushy });
    }
    setPendingPushy(null);
  };
  const setReserveBar = (n: number) =>
    setGasConfig({
      ...gasConfig,
      reserve_profile: { ...gasConfig.reserve_profile, stage_reserve_bar: n },
    });
  const safetyMarginBar = gasConfig.reserve_profile.all_thirds_safety_margin_bar;
  const setSafetyMargin = (n: number) =>
    setGasConfig({
      ...gasConfig,
      reserve_profile: { ...gasConfig.reserve_profile, all_thirds_safety_margin_bar: n },
    });

  return (
    <div
      className="h-full bg-panel flex flex-col overflow-auto text-sm text-text-primary"
      data-testid="gas-panel"
    >
      <div className="px-3 py-2 border-b border-border shrink-0">
        <h2 className="font-semibold">{t('gasPanel.title')}</h2>
        <p className="text-xs opacity-70">{t('gasPanel.subtitle')}</p>
      </div>

      <div className="p-3 space-y-4">
        {/* Previous dive plans (#244): save / load / delete named plans */}
        <DivePlanBar />
        {/* Origin */}
        <section className="space-y-1">
          <SectionLabel>{t('gasPanel.origin.label')}</SectionLabel>
          <div className="flex items-center justify-between gap-2">
            <span data-testid="gas-origin-readout" className="font-mono">
              {originLabel}
            </span>
            <button
              type="button"
              className="text-xs px-2 py-0.5 rounded border border-border hover:bg-border disabled:opacity-40"
              onClick={() => setOrigin(null)}
              disabled={origin === null}
              data-testid="gas-reset-origin"
            >
              {t('gasPanel.origin.reset')}
            </button>
          </div>
          <p className="text-xs opacity-60">{t('gasPanel.origin.hint')}</p>
        </section>

        {/* Route: the endpoint plus the ordered way points (#298). The way-point rows are the only
            place the visit order can be CHANGED - the map pins can add and remove, but ordering is
            a list operation, and order is what the engine actually routes on. */}
        <section className="space-y-1" data-testid="gas-route-section">
          <SectionLabel>{t('gasPanel.route.label')}</SectionLabel>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs opacity-70">{t('gasPanel.route.endpointLabel')}</span>
            <div className="flex items-center gap-2">
              <span data-testid="gas-endpoint-readout" className="font-mono text-xs">
                {endpoint
                  ? formatStationId(endpoint.section_id, endpoint.station_index)
                  : t('gasPanel.route.endpointAuto')}
              </span>
              <button
                type="button"
                className="text-xs px-2 py-0.5 rounded border border-border hover:bg-border disabled:opacity-40"
                onClick={() => setEndpoint(null)}
                disabled={endpoint === null}
                data-testid="gas-clear-endpoint"
              >
                {t('gasPanel.route.clearEndpoint')}
              </button>
            </div>
          </div>
          {/* The pick is never silently rewritten - it stays yours, and clearing whatever put it out
              of budget restores the full reach. But the turnaround marker has moved, so say why
              rather than leaving the diver to wonder where their endpoint went. */}
          {endpointOutOfReach && (
            <p className="text-xs opacity-70" data-testid="gas-endpoint-out-of-reach">
              {t('gasPanel.route.endpointOutOfReach', {
                id: formatStationId(
                  endpointOutOfReach.section_id,
                  endpointOutOfReach.station_index
                ),
              })}
            </p>
          )}

          <div className="pt-1">
            <span className="text-xs opacity-70">{t('gasPanel.route.waypointsLabel')}</span>
            {waypoints.length === 0 ? (
              <p className="text-xs opacity-60" data-testid="gas-waypoints-empty">
                {t('gasPanel.route.waypointsEmpty')}
              </p>
            ) : (
              <ol className="space-y-0.5 mt-0.5" data-testid="gas-waypoint-list">
                {waypoints.map((w, i) => (
                  <li
                    key={`${w.section_id}:${w.station_index}:${i}`}
                    className="flex items-center gap-2 text-xs"
                    data-testid="gas-waypoint-row"
                  >
                    <span className="opacity-60 w-4 text-right">{i + 1}.</span>
                    <span className="font-mono flex-1">
                      {formatStationId(w.section_id, w.station_index)}
                    </span>
                    {/* Cumulative gas at this way point, straight from the engine - the panel must
                        never re-derive a budget-dependent number (#233 lesson). `null` means the
                        chain stalled here or before it. */}
                    <span
                      className={gasKnown && waypointGas[i] == null ? 'text-error' : 'opacity-70'}
                      data-testid="gas-waypoint-gas"
                    >
                      {!gasKnown || waypointGas.length <= i
                        ? t('gasPanel.route.pending')
                        : waypointGas[i] == null
                          ? t('gasPanel.route.unreachable')
                          : formatVolume(waypointGas[i]!, units)}
                    </span>
                    <button
                      type="button"
                      className="px-1 rounded border border-border hover:bg-border disabled:opacity-30"
                      onClick={() => moveWaypoint(i, -1)}
                      disabled={i === 0}
                      aria-label={t('gasPanel.route.moveUp')}
                      title={t('gasPanel.route.moveUp')}
                      data-testid="gas-waypoint-up"
                    >
                      &uarr;
                    </button>
                    <button
                      type="button"
                      className="px-1 rounded border border-border hover:bg-border disabled:opacity-30"
                      onClick={() => moveWaypoint(i, 1)}
                      disabled={i === waypoints.length - 1}
                      aria-label={t('gasPanel.route.moveDown')}
                      title={t('gasPanel.route.moveDown')}
                      data-testid="gas-waypoint-down"
                    >
                      &darr;
                    </button>
                    <button
                      type="button"
                      className="px-1 rounded border border-border hover:bg-border"
                      onClick={() => removeWaypoint(i)}
                      aria-label={t('gasPanel.route.remove')}
                      title={t('gasPanel.route.remove')}
                      data-testid="gas-waypoint-remove"
                    >
                      &times;
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {waypoints.length > 0 && (
              <p className="text-xs opacity-60 mt-0.5">{t('gasPanel.route.waypointsHint')}</p>
            )}
            {stalledWaypoint !== null && (
              <p className="text-xs text-error mt-1" data-testid="gas-waypoint-warning">
                {t('gasPanel.route.warnUnreachable', { n: stalledWaypoint + 1 })}
              </p>
            )}
            {stalledWaypoint === null && waypointsOverBudget && (
              <p className="text-xs text-error mt-1" data-testid="gas-waypoint-warning">
                {t('gasPanel.route.warnOverBudget')}
              </p>
            )}
          </div>
        </section>

        {/* Marked points (#298): annotation only, never a gas input. */}
        <section className="space-y-1" data-testid="gas-marked-section">
          <SectionLabel>{t('gasPanel.marked.label')}</SectionLabel>
          {markedPoints.length === 0 ? (
            <p className="text-xs opacity-60" data-testid="gas-marked-empty">
              {t('gasPanel.marked.empty')}
            </p>
          ) : (
            <ul className="space-y-0.5" data-testid="gas-marked-list">
              {markedPoints.map((m, i) => (
                <li
                  key={`${m.station.section_id}:${m.station.station_index}:${i}`}
                  className="flex items-center gap-2 text-xs"
                  data-testid="gas-marked-row"
                >
                  <span className="font-mono">
                    {formatStationId(m.station.section_id, m.station.station_index)}
                  </span>
                  <input
                    type="text"
                    value={m.label ?? ''}
                    onChange={(e) => setMarkedPointLabel(i, e.target.value)}
                    placeholder={t('gasPanel.marked.labelPlaceholder')}
                    // Mirrors the backend's MAX_MARKED_LABEL_CHARS, so a label typed here can
                    // never be long enough for the save to reject the whole plan.
                    maxLength={MAX_MARKED_LABEL_CHARS}
                    className="flex-1 min-w-0 bg-transparent border border-border rounded px-1 py-0.5"
                    data-testid="gas-marked-label-input"
                  />
                  <button
                    type="button"
                    className="px-1 rounded border border-border hover:bg-border"
                    onClick={() => removeMarkedPoint(i)}
                    aria-label={t('gasPanel.marked.remove')}
                    title={t('gasPanel.marked.remove')}
                    data-testid="gas-marked-remove"
                  >
                    &times;
                  </button>
                </li>
              ))}
            </ul>
          )}
          {markedPoints.length > 0 && (
            <p className="text-xs opacity-60">{t('gasPanel.marked.hint')}</p>
          )}
        </section>

        {/* Diver RMV */}
        <section className="space-y-1">
          <SectionLabel>{t('gasPanel.diver.rmvLabel')}</SectionLabel>
          <div className="flex items-center gap-2">
            <PositiveNumberField
              value={rmvToDisplay(diver.rmv_l_per_min, units)}
              onCommit={(n) => setDiver({ ...diver, rmv_l_per_min: rmvFromDisplay(n, units) })}
              step={units === 'imperial' ? 0.05 : 1}
              displayPrecision={units === 'imperial' ? 2 : 1}
              className="w-24 bg-transparent border border-border rounded px-2 py-1"
              testId="gas-rmv-input"
            />
            <span className="text-xs opacity-70">
              {t(units === 'imperial' ? 'gasPanel.diver.rmvUnitImperial' : 'gasPanel.diver.rmvUnit')}
            </span>
          </div>
        </section>

        {/* Swim speed - the diver's pace; feeds the in-leg gas-to-reach computation. Unlike the
            panel's other (per-session) inputs, swim speed PERSISTS: a commit updates the working
            copy (so the overlay/route refetch immediately) AND writes the value back to the saved
            config - the same gas.swim_speed_m_per_min that Settings ▸ Gas edits - so a speed set
            while planning sticks across Plan exit / restart and stays in sync with Settings (#236).
            The disk write is debounced (see persistSwimSpeed) so rapid typing doesn't fire one
            config save per keystroke; only this field is written back, reserve / units / diver
            stay per-session (#241). */}
        <section className="space-y-1">
          <SectionLabel>{t('gasPanel.swimSpeed.label')}</SectionLabel>
          <div className="flex items-center gap-2">
            <PositiveNumberField
              value={speedToDisplay(gasConfig.swim_speed_m_per_min, units)}
              onCommit={(n) => {
                const v = speedFromDisplay(n, units);
                setGasConfig({ ...gasConfig, swim_speed_m_per_min: v });
                persistSwimSpeed(v);
              }}
              step={units === 'imperial' ? 1 : 0.5}
              displayPrecision={1}
              className="w-24 bg-transparent border border-border rounded px-2 py-1"
              testId="gas-swim-speed-input"
            />
            <span className="text-xs opacity-70">
              {t(
                units === 'imperial'
                  ? 'gasPanel.swimSpeed.unitImperial'
                  : 'gasPanel.swimSpeed.unit'
              )}
            </span>
          </div>
        </section>

        {/* Gas strategy */}
        <section className="space-y-1">
          <SectionLabel>{t('gasPanel.reserve.label')}</SectionLabel>
          <div className="flex gap-1">
            {RESERVE_PRESETS.map((preset) => {
              const needs = REQUIRED_STAGES[preset];
              const disabled = stageCount < needs;
              return (
                <button
                  key={preset}
                  type="button"
                  disabled={disabled}
                  title={
                    disabled ? t('gasPanel.reserve.needsStages', { count: needs }) : undefined
                  }
                  className={`text-xs px-2 py-1 rounded border disabled:opacity-40 disabled:cursor-not-allowed ${
                    gasConfig.default_reserve === preset
                      ? 'border-accent ring-1 ring-accent'
                      : 'border-border hover:bg-border'
                  }`}
                  onClick={() => selectPreset(preset)}
                  data-testid={`gas-reserve-${preset}`}
                >
                  {t(`gasPanel.reserve.${preset}`)}
                </button>
              );
            })}
          </div>
          {pendingPushy && (
            <div
              className="mt-1 p-2 rounded border border-accent text-xs space-y-1"
              data-testid="gas-pushy-ack"
            >
              <p className="font-semibold">{t('gasPanel.reserve.advancedTitle')}</p>
              <p className="opacity-80">{t('gasPanel.reserve.advancedBody')}</p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  className="px-2 py-0.5 rounded border border-accent hover:bg-border"
                  onClick={confirmPushy}
                  data-testid="gas-pushy-ack-confirm"
                >
                  {t('gasPanel.reserve.advancedConfirm')}
                </button>
                <button
                  type="button"
                  className="px-2 py-0.5 rounded border border-border hover:bg-border"
                  onClick={() => setPendingPushy(null)}
                  data-testid="gas-pushy-ack-cancel"
                >
                  {t('gasPanel.reserve.advancedCancel')}
                </button>
              </div>
            </div>
          )}
          {isStaged && (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-xs opacity-70">{t('gasPanel.reserve.stageReserveLabel')}</span>
              <PositiveNumberField
                value={pressureToDisplay(reserveBar, units)}
                onCommit={(n) => setReserveBar(pressureFromDisplay(n, units))}
                step={units === 'imperial' ? 5 : 1}
                displayPrecision={0}
                className="w-20 bg-transparent border border-border rounded px-2 py-1"
                testId="gas-stage-reserve-input"
              />
              <span className="text-xs opacity-70">
                {t(units === 'imperial' ? 'gasPanel.tanks.psi' : 'gasPanel.tanks.bar')}
              </span>
            </div>
          )}
          {strategy === 'all_thirds' && (
            <div className="flex items-center gap-2 pt-1" title={t('gasPanel.reserve.safetyMarginHint')}>
              <span className="text-xs opacity-70">{t('gasPanel.reserve.safetyMarginLabel')}</span>
              <PositiveNumberField
                value={pressureToDisplay(safetyMarginBar, units)}
                onCommit={(n) => setSafetyMargin(pressureFromDisplay(n, units))}
                step={units === 'imperial' ? 5 : 1}
                displayPrecision={0}
                allowZero
                className="w-20 bg-transparent border border-border rounded px-2 py-1"
                testId="gas-safety-margin-input"
              />
              <span className="text-xs opacity-70">
                {t(units === 'imperial' ? 'gasPanel.tanks.psi' : 'gasPanel.tanks.bar')}
              </span>
            </div>
          )}
        </section>

        {/* Units */}
        <section className="space-y-1">
          <SectionLabel>{t('gasPanel.units.label')}</SectionLabel>
          <div className="flex gap-1">
            {UNIT_OPTIONS.map((u) => (
              <button
                key={u}
                type="button"
                className={`text-xs px-2 py-1 rounded border ${
                  units === u ? 'border-accent ring-1 ring-accent' : 'border-border hover:bg-border'
                }`}
                onClick={() => setGasConfig({ ...gasConfig, units: u })}
                data-testid={`gas-units-${u}`}
              >
                {t(`gasPanel.units.${u}`)}
              </button>
            ))}
          </div>
          <p className="text-xs opacity-60">{t('gasPanel.tanks.editHint')}</p>
        </section>

        {/* Readout */}
        <section className="space-y-1 border-t border-border pt-3" data-testid="gas-readout">
          <SectionLabel>{t('gasPanel.readout.label')}</SectionLabel>
          {reachField ? (
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
              <dt className="opacity-70">
                {t(
                  hasStageDrops
                    ? 'gasPanel.readout.backgasSwitchPressure'
                    : 'gasPanel.readout.backgasTurnPressure'
                )}
              </dt>
              <dd data-testid="gas-readout-backgas-turn" className="text-right font-mono">
                {backgasTurn != null ? formatPressure(backgasTurn, units) : '--'}
              </dd>
              {stageDrops.map((drop, i) => (
                <Fragment key={i}>
                  <dt className="opacity-70">
                    {t('gasPanel.readout.stageDropPressure', { n: i + 1 })}
                    {drop.overridden && (
                      <button
                        type="button"
                        data-testid={`gas-readout-stage${i + 1}-reset`}
                        className="ml-1 text-[10px] underline opacity-70 hover:opacity-100"
                        onClick={() => setStageDropOverride(i, null)}
                        title={t('gasPanel.readout.resetDropHint')}
                      >
                        {t('gasPanel.readout.resetDrop')}
                      </button>
                    )}
                  </dt>
                  <dd
                    data-testid={`gas-readout-stage${i + 1}-drop`}
                    data-over-reserve={String(drop.overReserve)}
                    className={`text-right font-mono ${drop.overReserve ? 'text-error' : ''}`}
                  >
                    {formatPressure(drop.bar, units)}
                    {drop.distance != null && (
                      <span className="opacity-60">
                        {' @ '}
                        {formatGasLength(drop.distance, units)}
                      </span>
                    )}
                  </dd>
                </Fragment>
              ))}
              {anyOverReserve && (
                <div
                  data-testid="gas-readout-over-reserve-warning"
                  className="col-span-2 text-error"
                >
                  {t('gasPanel.readout.overReserveWarning')}
                </div>
              )}
              <dt className="opacity-70">{t('gasPanel.readout.budget')}</dt>
              <dd data-testid="gas-readout-budget" className="text-right font-mono">
                {formatVolume(reachField.budget_litres, units)}
              </dd>
              <dt className="opacity-70" title={t('gasPanel.readout.maxPenetrationHint')}>
                {t('gasPanel.readout.maxPenetration')}
              </dt>
              <dd
                data-testid="gas-readout-max"
                className="text-right font-mono"
                title={t('gasPanel.readout.maxPenetrationHint')}
              >
                {formatVolume(reachField.max_reachable_gas, units)}
              </dd>
              {hasRoute && (
                <>
                  <dt className="opacity-70" title={t('gasPanel.readout.routeDistanceHint')}>
                    {t('gasPanel.readout.routeDistance')}
                  </dt>
                  <dd
                    data-testid="gas-readout-route-distance"
                    className="text-right font-mono"
                    title={t('gasPanel.readout.routeDistanceHint')}
                  >
                    {formatGasLength(reachField.route_line_length_m, units)}
                  </dd>
                  {routeMaxDepth != null && (
                    <>
                      <dt className="opacity-70">{t('gasPanel.readout.maxDepth')}</dt>
                      <dd data-testid="gas-readout-max-depth" className="text-right font-mono">
                        {formatGasLength(routeMaxDepth, units, 1)}
                      </dd>
                    </>
                  )}
                  {routeAvgDepth != null && (
                    <>
                      <dt className="opacity-70">{t('gasPanel.readout.avgDepth')}</dt>
                      <dd data-testid="gas-readout-avg-depth" className="text-right font-mono">
                        {formatGasLength(routeAvgDepth, units, 1)}
                      </dd>
                    </>
                  )}
                </>
              )}
            </dl>
          ) : (
            <p className="text-xs opacity-60">{t('gasPanel.readout.computing')}</p>
          )}
        </section>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wide opacity-60">{children}</h3>;
}
