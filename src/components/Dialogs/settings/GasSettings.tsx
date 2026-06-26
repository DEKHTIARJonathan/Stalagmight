import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';
import { defaultConfig } from '../../../types/config';

/**
 * Gas & route-planning settings category (#38). Persisted personal defaults a plan is
 * seeded from:
 *  - swim speed — the exit-leg (and symmetric survey-in) speed, default 10 m/min;
 *  - jump RMV multiplier — gas bump on reference/jump legs (tying in a jump is extra
 *    work), >= 1.0, default 1.0; 1.5 is a useful value.
 * Both are clamped server-side in GasConfig::normalize; validated here so an invalid
 * entry blocks Save with a friendly message rather than silently snapping back.
 */
export function GasSettings({
  config,
  onChange,
  changedFields,
  onValidationError,
  panelIdBase,
}: SettingsCategoryProps) {
  const { t } = useTranslation();
  const hasErrorRef = useRef(false);

  useEffect(() => {
    const swim = config.gas.swim_speed_m_per_min;
    const jump = config.gas.jump_rmv_multiplier;
    const hasError = !Number.isFinite(swim) || swim <= 0 || !Number.isFinite(jump) || jump < 1;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('gas', hasError);
    }
  }, [config.gas, onValidationError]);

  const setGas = (patch: Partial<typeof config.gas>) =>
    onChange({ gas: { ...config.gas, ...patch } });

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'gas')}
      aria-labelledby={getTabId(panelIdBase, 'gas')}
      data-testid="settings-panel-gas"
    >
      <h2 className="text-lg font-medium mb-4">{t('settings.gas.title')}</h2>

      <SettingsSection title={t('settings.gas.sections.planning')} data-testid="section-gas-planning">
        <SettingRow
          label={t('settings.gas.swimSpeed.label')}
          helpText={t('settings.gas.swimSpeed.help')}
          isChanged={isFieldChanged(changedFields, 'gas.swim_speed_m_per_min')}
          onReset={() => setGas({ swim_speed_m_per_min: defaultConfig.gas.swim_speed_m_per_min })}
          isDefault={config.gas.swim_speed_m_per_min === defaultConfig.gas.swim_speed_m_per_min}
          data-testid="setting-gas-swim-speed"
        >
          <input
            type="number"
            inputMode="decimal"
            min={1}
            step={1}
            value={config.gas.swim_speed_m_per_min}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (Number.isFinite(n)) setGas({ swim_speed_m_per_min: n });
            }}
            className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.gas.swimSpeed.aria')}
            data-testid="input-gas-swim-speed"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.gas.jumpMultiplier.label')}
          helpText={t('settings.gas.jumpMultiplier.help')}
          isChanged={isFieldChanged(changedFields, 'gas.jump_rmv_multiplier')}
          onReset={() => setGas({ jump_rmv_multiplier: defaultConfig.gas.jump_rmv_multiplier })}
          isDefault={config.gas.jump_rmv_multiplier === defaultConfig.gas.jump_rmv_multiplier}
          data-testid="setting-gas-jump-multiplier"
        >
          <input
            type="number"
            inputMode="decimal"
            min={1}
            step={0.1}
            value={config.gas.jump_rmv_multiplier}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (Number.isFinite(n)) setGas({ jump_rmv_multiplier: n });
            }}
            className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.gas.jumpMultiplier.aria')}
            data-testid="input-gas-jump-multiplier"
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
