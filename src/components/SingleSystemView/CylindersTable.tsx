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
  const { cylinders, gasConfig, setCylinders, setGasConfig } = useGasPlanStore(
    useShallow((s) => ({
      cylinders: s.cylinders,
      gasConfig: s.gasConfig,
      setCylinders: s.setCylinders,
      setGasConfig: s.setGasConfig,
    }))
  );
  const units = gasConfig.units;

  const setFill = (idx: number, fillBar: number) =>
    setCylinders(cylinders.map((c, i) => (i === idx ? { ...c, fill_bar: fillBar } : c)));
  const setRole = (idx: number, role: CylRole) =>
    setCylinders(cylinders.map((c, i) => (i === idx ? { ...c, role } : c)));
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
            <th className="py-1 pr-3 font-semibold">{t('gasPanel.tanks.colTank')}</th>
            <th className="py-1 pr-3 font-semibold">{t('gasPanel.tanks.colWater')}</th>
            <th className="py-1 pr-3 font-semibold">
              {t(units === 'imperial' ? 'gasPanel.tanks.colFillPsi' : 'gasPanel.tanks.colFillBar')}
            </th>
            <th className="py-1 pr-3 font-semibold">{t('gasPanel.tanks.colRole')}</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {cylinders.map((cyl, idx) => (
            <tr
              key={idx}
              className={`border-t border-border ${isBudgetRole(cyl.role) ? '' : 'opacity-50'}`}
              title={isBudgetRole(cyl.role) ? undefined : t('gasPanel.tanks.notCounted')}
              data-testid="gas-cylinder-row"
            >
              <td className="py-1 pr-3 font-medium">{cyl.label ?? `${cyl.water_volume_l}L`}</td>
              <td className="py-1 pr-3 opacity-70">{cyl.water_volume_l} L</td>
              <td className="py-1 pr-3">
                <PositiveNumberField
                  value={pressureToDisplay(cyl.fill_bar, units)}
                  onCommit={(n) => setFill(idx, pressureFromDisplay(n, units))}
                  step={units === 'imperial' ? 50 : 5}
                  displayPrecision={0}
                  className="w-20 bg-transparent border border-border rounded px-1 py-0.5"
                  ariaLabel={t('gasPanel.tanks.fillAria', { tank: cyl.label ?? '' })}
                  testId="gas-cylinder-fill"
                />
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
                  aria-label={t('gasPanel.tanks.removeAria', { tank: cyl.label ?? '' })}
                  data-testid="gas-cylinder-remove"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
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
