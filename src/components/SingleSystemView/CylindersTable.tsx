import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useGasPlanStore } from '../../store/gasPlanStore';
import { PositiveNumberField } from '../common/PositiveNumberField';
import { isBudgetRole } from '../../utils/gasRoles';
import { pressureFromDisplay, pressureToDisplay } from '../../utils/formatGas';
import { TANK_PRESETS, cylinderFromPreset } from '../../utils/tankPresets';
import type { CylRole } from '../../types/ipc.generated';

const CYL_ROLES: readonly CylRole[] = ['back_gas', 'stage', 'dil_out', 'bailout', 'deco'];

/**
 * The diver's cylinder set — the "Cylinders" tab of the Plan-mode bottom panel (#38).
 * Add tanks from presets, edit fill pressure + role, remove. Budget-role rows (back
 * gas / stage) are emphasised; the rest are dimmed (they don't count toward the swim-in
 * budget — PRD §5.3). Edits flow to gasPlanStore, which nulls the cached reach field so
 * the map overlay refetches. Tank water *capacity* stays in litres regardless of units
 * (it's a tank spec, not a gas volume); only the fill pressure flips bar↔psi.
 */
export function CylindersTable() {
  const { t } = useTranslation();
  const { cylinders, gasConfig, reachField, setCylinders, setGasConfig } = useGasPlanStore(
    useShallow((s) => ({
      cylinders: s.cylinders,
      gasConfig: s.gasConfig,
      reachField: s.reachField,
      setCylinders: s.setCylinders,
      setGasConfig: s.setGasConfig,
    }))
  );
  const units = gasConfig.units;
  // Free (#245) lets the diver set each cylinder's usable gas by hand; every other strategy
  // COMPUTES it, so the column is read-only and shows the engine's per-row value.
  const isFree = gasConfig.default_reserve === 'free';
  // Engine-computed usable bar per input row (aligned 1:1 with `cylinders`); the single source of
  // truth for the read-only column, so it can never drift from the budget/gauges.
  const usableBars = reachField?.cylinder_usable_bars;

  const setFill = (idx: number, fillBar: number) =>
    setCylinders(cylinders.map((c, i) => (i === idx ? { ...c, fill_bar: fillBar } : c)));
  const setRole = (idx: number, role: CylRole) =>
    setCylinders(cylinders.map((c, i) => (i === idx ? { ...c, role } : c)));
  const setEnabled = (idx: number, enabled: boolean) =>
    setCylinders(cylinders.map((c, i) => (i === idx ? { ...c, enabled } : c)));
  const setUsable = (idx: number, usableBar: number) =>
    setCylinders(cylinders.map((c, i) => (i === idx ? { ...c, usable_gas_bar: usableBar } : c)));
  const removeCylinder = (idx: number) => setCylinders(cylinders.filter((_, i) => i !== idx));
  const addPreset = (presetId: string) => {
    const preset = TANK_PRESETS.find((p) => p.id === presetId);
    if (preset) setCylinders([...cylinders, cylinderFromPreset(preset)]);
  };

  return (
    <div className="h-full overflow-auto p-3 text-sm text-text-primary" data-testid="cylinders-table">
      <table className="w-full text-left">
        <thead className="text-xs uppercase tracking-wide opacity-60">
          <tr>
            <th className="py-1 pr-2 font-semibold">{t('gasPanel.tanks.colEnabled')}</th>
            <th className="py-1 pr-3 font-semibold">{t('gasPanel.tanks.colTank')}</th>
            <th className="py-1 pr-3 font-semibold">{t('gasPanel.tanks.colWater')}</th>
            <th className="py-1 pr-3 font-semibold">
              {t(units === 'imperial' ? 'gasPanel.tanks.colFillPsi' : 'gasPanel.tanks.colFillBar')}
            </th>
            <th className="py-1 pr-3 font-semibold" title={t('gasPanel.tanks.usableHint')}>
              {t(units === 'imperial' ? 'gasPanel.tanks.colUsablePsi' : 'gasPanel.tanks.colUsableBar')}
            </th>
            <th className="py-1 pr-3 font-semibold">{t('gasPanel.tanks.colRole')}</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {cylinders.map((cyl, idx) => {
            // A row is dimmed when it doesn't count toward the swim-in budget: either the
            // tank is switched off for this dive (#245) or its role isn't a budget role.
            const dimmed = !cyl.enabled || !isBudgetRole(cyl.role);
            const dimReason = !cyl.enabled
              ? t('gasPanel.tanks.disabledHint')
              : isBudgetRole(cyl.role)
                ? undefined
                : t('gasPanel.tanks.notCounted');
            // Screen-reader name for the row's controls: the same label the Tank column shows,
            // falling back to the water volume so an unnamed tank isn't announced as a blank.
            const tankName = cyl.label ?? `${cyl.water_volume_l}L`;
            return (
            <tr
              key={idx}
              className={`border-t border-border ${dimmed ? 'opacity-50' : ''}`}
              title={dimReason}
              data-testid="gas-cylinder-row"
              data-enabled={cyl.enabled}
            >
              <td className="py-1 pr-2">
                <input
                  type="checkbox"
                  checked={cyl.enabled}
                  onChange={(e) => setEnabled(idx, e.target.checked)}
                  aria-label={t('gasPanel.tanks.enabledAria', { tank: tankName })}
                  data-testid="gas-cylinder-enabled"
                />
              </td>
              <td className="py-1 pr-3 font-medium">{cyl.label ?? `${cyl.water_volume_l}L`}</td>
              <td className="py-1 pr-3 opacity-70">{cyl.water_volume_l} L</td>
              <td className="py-1 pr-3">
                <PositiveNumberField
                  value={pressureToDisplay(cyl.fill_bar, units)}
                  onCommit={(n) => setFill(idx, pressureFromDisplay(n, units))}
                  step={units === 'imperial' ? 50 : 5}
                  displayPrecision={0}
                  className="w-20 bg-transparent border border-border rounded px-1 py-0.5"
                  ariaLabel={t('gasPanel.tanks.fillAria', { tank: tankName })}
                  testId="gas-cylinder-fill"
                />
              </td>
              <td className="py-1 pr-3">
                {isFree && isBudgetRole(cyl.role) && cyl.enabled ? (
                  <PositiveNumberField
                    value={pressureToDisplay(cyl.usable_gas_bar, units)}
                    // Clamp on commit to the tank's usable ceiling (the conservative-capped fill the
                    // engine budgets against), so the field can't display more usable gas than the
                    // cylinder actually credits (#245); the backend clamps too, this keeps the UI honest.
                    onCommit={(n) => {
                      const basis =
                        gasConfig.conservative_tank_gas !== false
                          ? Math.min(cyl.fill_bar, cyl.rated_pressure_bar)
                          : cyl.fill_bar;
                      setUsable(idx, Math.min(pressureFromDisplay(n, units), basis));
                    }}
                    step={units === 'imperial' ? 50 : 5}
                    displayPrecision={0}
                    allowZero
                    className="w-20 bg-transparent border border-border rounded px-1 py-0.5"
                    ariaLabel={t('gasPanel.tanks.usableAria', { tank: tankName })}
                    testId="gas-cylinder-usable"
                  />
                ) : (
                  // Read-only: the engine's per-row usable bar (`0` for disabled / non-budget rows
                  // shows as a dash). Falls back to a dash until the first reach field lands.
                  <span className="opacity-70" data-testid="gas-cylinder-usable-readonly">
                    {usableBars && usableBars[idx] !== undefined && usableBars[idx] > 0
                      ? Math.round(pressureToDisplay(usableBars[idx], units))
                      : '—'}
                  </span>
                )}
              </td>
              <td className="py-1 pr-3">
                <select
                  value={cyl.role}
                  onChange={(e) => setRole(idx, e.target.value as CylRole)}
                  className="text-xs bg-transparent border border-border rounded px-1 py-0.5"
                  data-testid="gas-cylinder-role"
                >
                  {CYL_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {t(`gasPanel.roles.${role}`)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-1">
                <button
                  type="button"
                  className="text-xs px-1 opacity-60 hover:opacity-100"
                  onClick={() => removeCylinder(idx)}
                  aria-label={t('gasPanel.tanks.removeAria', { tank: tankName })}
                  data-testid="gas-cylinder-remove"
                >
                  ✕
                </button>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex items-center gap-4 mt-3">
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
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={gasConfig.conservative_tank_gas}
            onChange={(e) => setGasConfig({ ...gasConfig, conservative_tank_gas: e.target.checked })}
            data-testid="gas-conservative-checkbox"
          />
          <span>{t('gasPanel.tanks.conservative')}</span>
        </label>
      </div>
    </div>
  );
}
