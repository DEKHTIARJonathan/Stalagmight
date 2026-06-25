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
import { TANK_PRESETS, cylinderFromPreset } from '../../utils/tankPresets';
import type { CylRole, Cylinder, GasUnits, ReservePreset } from '../../types/ipc.generated';

const RESERVE_PRESETS: readonly ReservePreset[] = ['all_thirds', 'one_stage', 'two_stage'];
const CYL_ROLES: readonly CylRole[] = ['back_gas', 'stage', 'dil_out', 'bailout', 'deco'];
const UNIT_OPTIONS: readonly GasUnits[] = ['metric', 'imperial'];

/** Roles whose gas counts toward the open-circuit penetration budget (PRD §5.3). */
function isBudgetRole(role: CylRole): boolean {
  return role === 'back_gas' || role === 'stage';
}

/**
 * The diver's gauge pressure (bar) at the turn point — the number divers actually
 * watch underwater. It's the volume-weighted average start gauge of the budget-role
 * cylinders minus the turn budget expressed as a common-gauge pressure drop
 * (`budget ÷ Σ water-volume`). Exact for a matched set (one gauge); a common-gauge
 * equivalent for mixed tanks. `null` when there's no penetration gas. (PRD §5.1.)
 */
export function turnPressureBar(cylinders: Cylinder[], budgetLitres: number): number | null {
  const budget = cylinders.filter((c) => isBudgetRole(c.role));
  const sumWaterVol = budget.reduce((s, c) => s + c.water_volume_l, 0);
  if (sumWaterVol <= 0) return null;
  const avgStartBar = budget.reduce((s, c) => s + c.fill_bar * c.water_volume_l, 0) / sumWaterVol;
  return Math.max(0, avgStartBar - budgetLitres / sumWaterVol);
}

/**
 * Gas & route-planning input panel (#38, Phase 1). Rendered in the `detail` Dock
 * slot while the sub-mode is active (see SingleSystemView). Edits the single-diver
 * open-circuit inputs in `gasPlanStore`; every change nulls the cached field, so
 * MapCanvas refetches and repaints the reachable overlay. Volumes follow the master
 * units toggle; pressures/RMV stay canonical (bar / L·min⁻¹) for Phase 1 — full
 * imperial input is the Phase-4 flip (PRD §7.2).
 */
export function GasPlanPanel() {
  const { t } = useTranslation();
  const {
    origin,
    diver,
    cylinders,
    gasConfig,
    reachField,
    setOrigin,
    setDiver,
    setCylinders,
    setGasConfig,
  } = useGasPlanStore(
    useShallow((s) => ({
      origin: s.origin,
      diver: s.diver,
      cylinders: s.cylinders,
      gasConfig: s.gasConfig,
      reachField: s.reachField,
      setOrigin: s.setOrigin,
      setDiver: s.setDiver,
      setCylinders: s.setCylinders,
      setGasConfig: s.setGasConfig,
    })),
  );

  // Seed the working gas config from the live PERSISTED app config when the sub-mode
  // opens (this panel mounts on entry), falling back to the compiled defaults when no
  // config is loaded. Mount-only so a later unrelated config change doesn't clobber
  // in-mode edits. Without this the plan would silently ignore the user's saved gas
  // preferences (units/speeds/reserve) — the migration-lens "restore from current
  // config, not a hardcoded default" rule.
  useEffect(() => {
    setGasConfig(useProjectStore.getState().config?.gas ?? defaultConfig.gas);
  }, [setGasConfig]);

  const units = gasConfig.units;
  const originLabel = origin
    ? formatStationId(origin.section_id, origin.station_index)
    : t('gasPanel.origin.entrance');

  const turnCount = reachField ? reachField.turn_frontier.length : null;
  const turnBar = reachField ? turnPressureBar(cylinders, reachField.budget_litres) : null;

  const setFill = (idx: number, fillBar: number) =>
    setCylinders(cylinders.map((c, i) => (i === idx ? { ...c, fill_bar: fillBar } : c)));
  const setRole = (idx: number, role: CylRole) =>
    setCylinders(cylinders.map((c, i) => (i === idx ? { ...c, role } : c)));
  const removeCylinder = (idx: number) =>
    setCylinders(cylinders.filter((_, i) => i !== idx));
  const addPreset = (presetId: string) => {
    const preset = TANK_PRESETS.find((p) => p.id === presetId);
    if (preset) setCylinders([...cylinders, cylinderFromPreset(preset)]);
  };

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

        {/* Reserve preset */}
        <section className="space-y-1">
          <SectionLabel>{t('gasPanel.reserve.label')}</SectionLabel>
          <div className="flex gap-1">
            {RESERVE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`text-xs px-2 py-1 rounded border ${
                  gasConfig.default_reserve === preset
                    ? 'border-accent ring-1 ring-accent'
                    : 'border-border hover:bg-border'
                }`}
                onClick={() => setGasConfig({ ...gasConfig, default_reserve: preset })}
                data-testid={`gas-reserve-${preset}`}
              >
                {t(`gasPanel.reserve.${preset}`)}
              </button>
            ))}
          </div>
        </section>

        {/* Cylinders */}
        <section className="space-y-2">
          <SectionLabel>{t('gasPanel.tanks.label')}</SectionLabel>
          <div className="space-y-2">
            {cylinders.map((cyl, idx) => (
              <div
                key={idx}
                className={`flex items-center gap-2 border border-border rounded px-2 py-1 ${
                  isBudgetRole(cyl.role) ? '' : 'opacity-50'
                }`}
                title={isBudgetRole(cyl.role) ? undefined : t('gasPanel.tanks.notCounted')}
                data-testid="gas-cylinder-row"
              >
                <span className="font-medium w-14 truncate" title={cyl.label ?? ''}>
                  {cyl.label ?? `${cyl.water_volume_l}L`}
                </span>
                <span className="text-xs opacity-60 w-16">
                  {formatVolume(cyl.water_volume_l, units, units === 'imperial' ? 2 : 1)}
                </span>
                <PositiveNumberField
                  value={pressureToDisplay(cyl.fill_bar, units)}
                  onCommit={(n) => setFill(idx, pressureFromDisplay(n, units))}
                  step={units === 'imperial' ? 50 : 5}
                  displayPrecision={0}
                  className="w-16 bg-transparent border border-border rounded px-1 py-0.5"
                  ariaLabel={t('gasPanel.tanks.fillAria', { tank: cyl.label ?? '' })}
                  testId="gas-cylinder-fill"
                />
                <span className="text-xs opacity-70">
                  {t(units === 'imperial' ? 'gasPanel.tanks.psi' : 'gasPanel.tanks.bar')}
                </span>
                <select
                  value={cyl.role}
                  onChange={(e) => setRole(idx, e.target.value as CylRole)}
                  className="text-xs bg-transparent border border-border rounded px-1 py-0.5 ml-auto"
                  data-testid="gas-cylinder-role"
                >
                  {CYL_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {t(`gasPanel.roles.${role}`)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="text-xs px-1 opacity-60 hover:opacity-100"
                  onClick={() => removeCylinder(idx)}
                  aria-label={t('gasPanel.tanks.removeAria', { tank: cyl.label ?? '' })}
                  data-testid="gas-cylinder-remove"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <select
              className="text-xs bg-transparent border border-border rounded px-2 py-1"
              value=""
              onChange={(e) => {
                if (e.target.value) addPreset(e.target.value);
              }}
              data-testid="gas-add-tank"
            >
              <option value="">{t('gasPanel.tanks.addPlaceholder')}</option>
              {TANK_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.water_volume_l}L)
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={gasConfig.conservative_tank_gas}
              onChange={(e) =>
                setGasConfig({ ...gasConfig, conservative_tank_gas: e.target.checked })
              }
              data-testid="gas-conservative-checkbox"
            />
            <span>{t('gasPanel.tanks.conservative')}</span>
          </label>
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
        </section>

        {/* Readout */}
        <section
          className="space-y-1 border-t border-border pt-3"
          data-testid="gas-readout"
        >
          <SectionLabel>{t('gasPanel.readout.label')}</SectionLabel>
          {reachField ? (
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
              <dt className="opacity-70">{t('gasPanel.readout.turnPressure')}</dt>
              <dd data-testid="gas-readout-turn-pressure" className="text-right font-mono">
                {turnBar != null ? formatPressure(turnBar, units) : '--'}
              </dd>
              <dt className="opacity-70">{t('gasPanel.readout.budget')}</dt>
              <dd data-testid="gas-readout-budget" className="text-right font-mono">
                {formatVolume(reachField.budget_litres, units)}
              </dd>
              <dt className="opacity-70">{t('gasPanel.readout.maxPenetration')}</dt>
              <dd data-testid="gas-readout-max" className="text-right font-mono">
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
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide opacity-60">{children}</h3>
  );
}

/** Round a value to `precision` decimals for display; `String(value)` when omitted. */
function formatDraft(value: number, precision?: number): string {
  if (precision == null) return String(value);
  const factor = 10 ** precision;
  return String(Math.round(value * factor) / factor);
}

/**
 * Controlled positive-number input with a local draft so the field is fully
 * deletable (no leading-0 trap): an empty/intermediate value is shown but NOT
 * committed, and only a finite, strictly-positive number reaches `onCommit`. This
 * keeps a transient blank from poisoning the gas fetch (the backend rejects a 0/NaN
 * RMV or fill, which would otherwise blank the whole overlay until re-typed).
 *
 * `value`/`onCommit` are in whatever unit the caller chooses (the RMV field passes
 * display-unit values + converts in onCommit). The draft re-syncs from an EXTERNAL
 * value change (reset / preset add / unit toggle) ONLY while not focused, so a
 * unit-toggle re-labels the field but in-progress keystrokes are never clobbered.
 */
function PositiveNumberField({
  value,
  onCommit,
  step,
  displayPrecision,
  className,
  ariaLabel,
  testId,
}: {
  value: number;
  onCommit: (n: number) => void;
  step?: number;
  displayPrecision?: number;
  className?: string;
  ariaLabel?: string;
  testId?: string;
}) {
  const [draft, setDraft] = useState(() => formatDraft(value, displayPrecision));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(formatDraft(value, displayPrecision));
  }, [value, focused, displayPrecision]);
  return (
    <input
      type="number"
      min={0}
      step={step}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setDraft(formatDraft(value, displayPrecision));
      }}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text); // allow empty / intermediate so the field stays deletable
        const n = Number(text);
        if (Number.isFinite(n) && n > 0) onCommit(n);
      }}
      className={className}
      aria-label={ariaLabel}
      data-testid={testId}
    />
  );
}
