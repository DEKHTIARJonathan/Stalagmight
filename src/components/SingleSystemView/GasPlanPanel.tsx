import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useGasPlanStore } from '../../store/gasPlanStore';
import { useProjectStore } from '../../store/projectStore';
import { defaultConfig } from '../../types/config';
import { formatStationId } from '../../utils/formatters';
import {
  formatPressure,
  formatVolume,
  pressureFromDisplay,
  pressureToDisplay,
  rmvFromDisplay,
  rmvToDisplay,
} from '../../utils/formatGas';
import { PositiveNumberField } from '../common/PositiveNumberField';
import type { GasUnits, ReservePreset } from '../../types/ipc.generated';

const RESERVE_PRESETS: readonly ReservePreset[] = ['all_thirds', 'one_stage', 'two_stage'];
const UNIT_OPTIONS: readonly GasUnits[] = ['metric', 'imperial'];

/** Stage cylinders a strategy requires in the rig — mirrors the Rust `required_stages`
 *  (gas.rs). The Half-Minus strategies are greyed until the diver carries that many stages. */
const REQUIRED_STAGES: Record<ReservePreset, number> = {
  all_thirds: 0,
  one_stage: 1,
  two_stage: 2,
};

/**
 * Gas & route-planning setup sidebar (#38). The right Dock slot while in Plan mode:
 * origin, diver RMV, gas strategy + per-stage reserve, units, and the plan readout. The cylinder
 * rig editor lives in the bottom panel's "Cylinders" tab (see PlanTablesPanel) — this sidebar
 * reads the cylinders only to compute the turn / drop pressures. Every input nulls the cached
 * field via gasPlanStore, so MapCanvas refetches + repaints the reachable overlay. Volumes follow
 * the master units toggle; RMV flips L·min⁻¹ ↔ cuft·min⁻¹.
 */
export function GasPlanPanel() {
  const { t } = useTranslation();
  const {
    origin,
    diver,
    cylinders,
    gasConfig,
    reachField,
    pushyAck,
    setOrigin,
    setDiver,
    setGasConfig,
    setPushyAck,
  } = useGasPlanStore(
    useShallow((s) => ({
      origin: s.origin,
      diver: s.diver,
      cylinders: s.cylinders,
      gasConfig: s.gasConfig,
      reachField: s.reachField,
      pushyAck: s.pushyAck,
      setOrigin: s.setOrigin,
      setDiver: s.setDiver,
      setGasConfig: s.setGasConfig,
      setPushyAck: s.setPushyAck,
    }))
  );
  // A staged strategy the user selected but hasn't yet acknowledged (inline advanced gate).
  const [pendingPushy, setPendingPushy] = useState<ReservePreset | null>(null);

  // Seed the working gas config from the live PERSISTED app config when Plan mode
  // opens (this panel mounts on entry), falling back to the compiled defaults when no
  // config is loaded. Mount-only so a later unrelated config change doesn't clobber
  // in-mode edits. Display units follow the app-wide MASTER units (Settings ▸ Units):
  // feet ⇒ imperial, so an imperial app opens an imperial gas panel (the in-panel
  // toggle still overrides for the session).
  useEffect(() => {
    const cfg = useProjectStore.getState().config;
    const masterImperial = cfg?.units?.length === 'feet';
    // Deep-clone the seed so editing the working config never mutates the live persisted
    // config (or the compiled default) through a shared nested reference (reserve_profile / dpv).
    setGasConfig({
      ...structuredClone(cfg?.gas ?? defaultConfig.gas),
      units: masterImperial ? 'imperial' : 'metric',
    });
  }, [setGasConfig]);

  const units = gasConfig.units;
  const originLabel = origin
    ? formatStationId(origin.section_id, origin.station_index)
    : t('gasPanel.origin.entrance');

  const turnCount = reachField ? reachField.turn_frontier.length : null;
  const stageCount = cylinders.filter((c) => c.role === 'stage').length;
  const strategy = gasConfig.default_reserve;
  const isStaged = strategy === 'one_stage' || strategy === 'two_stage';
  const reserveBar = gasConfig.reserve_profile.stage_reserve_bar;

  // Three non-additive gauges, each relative to its own cylinder's start (back gas = one unit).
  // They come from the BACKEND (single source of truth): it already applies the conservative cap,
  // the normalized reserve, and the stage-count fallback, so the panel can't drift from the
  // reachable overlay. `stage_drop_bars` has one entry per counted stage of the effective strategy.
  const backgasTurn = reachField ? reachField.backgas_turn_bar : null;
  const stage1Drop = reachField?.stage_drop_bars[0] ?? null;
  const stage2Drop = reachField?.stage_drop_bars[1] ?? null;

  // Selecting a staged strategy routes through an inline advanced acknowledgment the first time
  // per session; All-thirds and an already-acked strategy apply immediately.
  const selectPreset = (preset: ReservePreset) => {
    if (REQUIRED_STAGES[preset] > 0 && !pushyAck) {
      setPendingPushy(preset);
      return;
    }
    setGasConfig({ ...gasConfig, default_reserve: preset });
  };
  const confirmPushy = () => {
    if (!pendingPushy) return;
    // Re-check: the rig may have lost stages while the ack panel was open (the Cylinders tab is
    // visible alongside it). Only apply if the rig still satisfies the strategy — otherwise we'd
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
              <dt className="opacity-70">{t('gasPanel.readout.backgasTurnPressure')}</dt>
              <dd data-testid="gas-readout-backgas-turn" className="text-right font-mono">
                {backgasTurn != null ? formatPressure(backgasTurn, units) : '--'}
              </dd>
              {stage1Drop != null && (
                <>
                  <dt className="opacity-70">{t('gasPanel.readout.stage1DropPressure')}</dt>
                  <dd data-testid="gas-readout-stage1-drop" className="text-right font-mono">
                    {formatPressure(stage1Drop, units)}
                  </dd>
                </>
              )}
              {stage2Drop != null && (
                <>
                  <dt className="opacity-70">{t('gasPanel.readout.stage2DropPressure')}</dt>
                  <dd data-testid="gas-readout-stage2-drop" className="text-right font-mono">
                    {formatPressure(stage2Drop, units)}
                  </dd>
                </>
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
              <dt className="opacity-70">{t('gasPanel.readout.turnPoints')}</dt>
              <dd data-testid="gas-readout-turns" className="text-right font-mono">
                {turnCount}
              </dd>
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
