import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';
import { defaultConfig } from '../../../types/config';
import type { DpvRig, DpvUnit } from '../../../types/ipc.generated';
import { PositiveNumberField } from '../../common/PositiveNumberField';
import { Toggle } from '../../common/Toggle';
import { ChevronRightIcon } from '../../common/icons';
import { formatGasLength } from '../../../utils/formatGas';

/** Mirrors `default_dpv_range_reserve_fraction()` in `src-tauri/src/config/gas.rs` (0.1). */
const DEFAULT_DPV_RANGE_RESERVE_FRACTION = 0.1;

/**
 * Mirrors `MAX_DPV_RANGE_RESERVE_FRACTION` in `src-tauri/src/config/gas.rs` (0.9). Above this,
 * `GasConfig::normalize` clamps the fraction down to the cap rather than repairing it another
 * way (the cap would zero the whole usable range, which is useless but not unsafe, so it's
 * capped rather than reset like a negative fraction is).
 */
const MAX_DPV_RANGE_RESERVE_FRACTION = 0.9;

/**
 * A sensible starting rig for the "enable" toggle. There is no backend default to seed from
 * (a rig is either fully specified or absent), so these are just plausible cave-DPV numbers -
 * immediately editable, and the "primary" and "backup" reset targets below.
 */
function makeDefaultDpvRig(): DpvRig {
  return {
    primary: { speed_m_per_min: 45, burn_minutes: 60 },
    backup: { speed_m_per_min: 45, burn_minutes: 45 },
    range_reserve_fraction: DEFAULT_DPV_RANGE_RESERVE_FRACTION,
  };
}
const DEFAULT_DPV_RIG = makeDefaultDpvRig();

/** A unit with no meaningful range (mirrors `dpv_unit_is_valid` in gas.rs). */
function dpvUnitInvalid(unit: DpvUnit): boolean {
  return (
    !Number.isFinite(unit.speed_m_per_min) ||
    unit.speed_m_per_min <= 0 ||
    !Number.isFinite(unit.burn_minutes) ||
    unit.burn_minutes <= 0
  );
}

/**
 * Usable one-way range (metres): `min(primary.range, backup.range) x (1 - reserve)`, the weaker
 * unit by line covered (not by burn time), not halved (primary flies in, backup flies out).
 * Mirrors `DpvRig::usable_range_m` in `src-tauri/src/config/gas.rs` exactly - read it before
 * changing this.
 *
 * The reserve fraction is clamped into the backend's accepted domain ([0, `MAX_DPV_RANGE_
 * RESERVE_FRACTION`]) before it is used, the same way `GasConfig::normalize` clamps it on save:
 * this previews the LIVE (not-yet-saved) working config, and Save is blocked outside that domain
 * (see the validation effect below) - but a value the diver is mid-typing must never preview a
 * number the backend would not actually honor once saved (a 0.95 entry previewing 5% of range
 * while the backend would clamp to 0.9 and give 10% is exactly that drift, the #233 gauge class).
 */
function dpvUsableRangeM(rig: DpvRig): number {
  const weaker = Math.min(
    rig.primary.speed_m_per_min * rig.primary.burn_minutes,
    rig.backup.speed_m_per_min * rig.backup.burn_minutes
  );
  const reserve = Math.max(0, Math.min(rig.range_reserve_fraction, MAX_DPV_RANGE_RESERVE_FRACTION));
  return Math.max(weaker * (1 - reserve), 0);
}

/**
 * Gas & route-planning settings category (#38). Persisted personal defaults a plan is
 * seeded from:
 *  - swim speed - the exit-leg (and symmetric survey-in) speed, default 10 m/min;
 *  - jump RMV multiplier - gas bump on reference/jump legs (tying in a jump is extra
 *    work), >= 1.0, default 1.0; 1.5 is a useful value.
 *  - optional DPV rig (#317) - primary + mandatory backup scooter, each speed (m/min) and
 *    burn (min), plus a range reserve fraction; `null` = no scooter.
 * Swim speed / jump multiplier are clamped server-side in GasConfig::normalize; an invalid DPV
 * unit (speed or burn <= 0) drops the WHOLE rig server-side rather than repairing one field, so
 * it is blocked here instead. Client-side, PositiveNumberField rejects a non-positive entry at
 * the field itself (it reverts to the last valid value on blur, no error message); a
 * sub-minimum positive jump multiplier (0 < jump < 1) still commits and is caught by the
 * validation effect below, which blocks Save via the error indicator instead.
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
  const [dpvDetailsExpanded, setDpvDetailsExpanded] = useState(true);
  const dpvDetailsRegionId = useId();

  useEffect(() => {
    const swim = config.gas.swim_speed_m_per_min;
    const jump = config.gas.jump_rmv_multiplier;
    const rig = config.gas.dpv;
    const rigInvalid =
      rig != null &&
      (dpvUnitInvalid(rig.primary) ||
        dpvUnitInvalid(rig.backup) ||
        !Number.isFinite(rig.range_reserve_fraction) ||
        rig.range_reserve_fraction < 0 ||
        rig.range_reserve_fraction > MAX_DPV_RANGE_RESERVE_FRACTION);
    const hasError =
      !Number.isFinite(swim) || swim <= 0 || !Number.isFinite(jump) || jump < 1 || rigInvalid;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('gas', hasError);
    }
  }, [config.gas, onValidationError]);

  const setGas = (patch: Partial<typeof config.gas>) =>
    onChange({ gas: { ...config.gas, ...patch } });

  const rig = config.gas.dpv;
  const setRig = (patch: Partial<DpvRig>) => {
    if (!rig) return;
    setGas({ dpv: { ...rig, ...patch } });
  };
  const setPrimary = (patch: Partial<DpvUnit>) => {
    if (!rig) return;
    setRig({ primary: { ...rig.primary, ...patch } });
  };
  const setBackup = (patch: Partial<DpvUnit>) => {
    if (!rig) return;
    setRig({ backup: { ...rig.backup, ...patch } });
  };

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
          <PositiveNumberField
            value={config.gas.swim_speed_m_per_min}
            onCommit={(n) => setGas({ swim_speed_m_per_min: n })}
            step={1}
            className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            ariaLabel={t('settings.gas.swimSpeed.aria')}
            testId="input-gas-swim-speed"
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
          <PositiveNumberField
            value={config.gas.jump_rmv_multiplier}
            onCommit={(n) => setGas({ jump_rmv_multiplier: n })}
            step={0.1}
            className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            ariaLabel={t('settings.gas.jumpMultiplier.aria')}
            testId="input-gas-jump-multiplier"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.gas.includeReferenceLegs.label')}
          helpText={t('settings.gas.includeReferenceLegs.help')}
          isChanged={isFieldChanged(changedFields, 'gas.include_reference_legs')}
          onReset={() => setGas({ include_reference_legs: defaultConfig.gas.include_reference_legs })}
          isDefault={config.gas.include_reference_legs === defaultConfig.gas.include_reference_legs}
          data-testid="setting-gas-include-reference-legs"
        >
          <Toggle
            checked={config.gas.include_reference_legs}
            onChange={(v) => setGas({ include_reference_legs: v })}
            aria-label={t('settings.gas.includeReferenceLegs.aria')}
            data-testid="toggle-gas-include-reference-legs"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.gas.dpv.enabled.label')}
          helpText={t('settings.gas.dpv.enabled.help')}
          isChanged={isFieldChanged(changedFields, 'gas.dpv')}
          onReset={() => setGas({ dpv: defaultConfig.gas.dpv })}
          isDefault={config.gas.dpv === defaultConfig.gas.dpv}
          data-testid="setting-gas-dpv-enabled"
        >
          <Toggle
            checked={rig != null}
            onChange={(v) => setGas({ dpv: v ? makeDefaultDpvRig() : null })}
            aria-label={t('settings.gas.dpv.enabled.aria')}
            data-testid="toggle-gas-dpv-enabled"
          />
        </SettingRow>

        {rig && (
          <div>
            <button
              type="button"
              onClick={() => setDpvDetailsExpanded(!dpvDetailsExpanded)}
              className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary w-full text-left"
              data-testid="gas-dpv-details-toggle"
              aria-expanded={dpvDetailsExpanded}
              aria-controls={dpvDetailsRegionId}
            >
              <ChevronRightIcon
                size={12}
                className={dpvDetailsExpanded ? 'rotate-90 transition-transform' : 'transition-transform'}
              />
              <span>{t('settings.gas.dpv.title')}</span>
            </button>
            {dpvDetailsExpanded && (
              <div className="mt-2 space-y-1" id={dpvDetailsRegionId} data-testid="gas-dpv-details-content">
                <SettingRow
                  label={t('settings.gas.dpv.primarySpeed.label')}
                  helpText={t('settings.gas.dpv.primarySpeed.help')}
                  isChanged={isFieldChanged(changedFields, 'gas.dpv.primary.speed_m_per_min')}
                  onReset={() => setPrimary({ speed_m_per_min: DEFAULT_DPV_RIG.primary.speed_m_per_min })}
                  isDefault={rig.primary.speed_m_per_min === DEFAULT_DPV_RIG.primary.speed_m_per_min}
                  data-testid="setting-gas-dpv-primary-speed"
                >
                  <PositiveNumberField
                    value={rig.primary.speed_m_per_min}
                    onCommit={(n) => setPrimary({ speed_m_per_min: n })}
                    step={1}
                    className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
                    ariaLabel={t('settings.gas.dpv.primarySpeed.aria')}
                    testId="input-gas-dpv-primary-speed"
                  />
                </SettingRow>

                <SettingRow
                  label={t('settings.gas.dpv.primaryBurn.label')}
                  helpText={t('settings.gas.dpv.primaryBurn.help')}
                  isChanged={isFieldChanged(changedFields, 'gas.dpv.primary.burn_minutes')}
                  onReset={() => setPrimary({ burn_minutes: DEFAULT_DPV_RIG.primary.burn_minutes })}
                  isDefault={rig.primary.burn_minutes === DEFAULT_DPV_RIG.primary.burn_minutes}
                  data-testid="setting-gas-dpv-primary-burn"
                >
                  <PositiveNumberField
                    value={rig.primary.burn_minutes}
                    onCommit={(n) => setPrimary({ burn_minutes: n })}
                    step={1}
                    className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
                    ariaLabel={t('settings.gas.dpv.primaryBurn.aria')}
                    testId="input-gas-dpv-primary-burn"
                  />
                </SettingRow>

                <SettingRow
                  label={t('settings.gas.dpv.backupSpeed.label')}
                  helpText={t('settings.gas.dpv.backupSpeed.help')}
                  isChanged={isFieldChanged(changedFields, 'gas.dpv.backup.speed_m_per_min')}
                  onReset={() => setBackup({ speed_m_per_min: DEFAULT_DPV_RIG.backup.speed_m_per_min })}
                  isDefault={rig.backup.speed_m_per_min === DEFAULT_DPV_RIG.backup.speed_m_per_min}
                  data-testid="setting-gas-dpv-backup-speed"
                >
                  <PositiveNumberField
                    value={rig.backup.speed_m_per_min}
                    onCommit={(n) => setBackup({ speed_m_per_min: n })}
                    step={1}
                    className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
                    ariaLabel={t('settings.gas.dpv.backupSpeed.aria')}
                    testId="input-gas-dpv-backup-speed"
                  />
                </SettingRow>

                <SettingRow
                  label={t('settings.gas.dpv.backupBurn.label')}
                  helpText={t('settings.gas.dpv.backupBurn.help')}
                  isChanged={isFieldChanged(changedFields, 'gas.dpv.backup.burn_minutes')}
                  onReset={() => setBackup({ burn_minutes: DEFAULT_DPV_RIG.backup.burn_minutes })}
                  isDefault={rig.backup.burn_minutes === DEFAULT_DPV_RIG.backup.burn_minutes}
                  data-testid="setting-gas-dpv-backup-burn"
                >
                  <PositiveNumberField
                    value={rig.backup.burn_minutes}
                    onCommit={(n) => setBackup({ burn_minutes: n })}
                    step={1}
                    className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
                    ariaLabel={t('settings.gas.dpv.backupBurn.aria')}
                    testId="input-gas-dpv-backup-burn"
                  />
                </SettingRow>

                <SettingRow
                  label={t('settings.gas.dpv.rangeReserve.label')}
                  helpText={t('settings.gas.dpv.rangeReserve.help')}
                  isChanged={isFieldChanged(changedFields, 'gas.dpv.range_reserve_fraction')}
                  onReset={() => setRig({ range_reserve_fraction: DEFAULT_DPV_RANGE_RESERVE_FRACTION })}
                  isDefault={rig.range_reserve_fraction === DEFAULT_DPV_RANGE_RESERVE_FRACTION}
                  data-testid="setting-gas-dpv-range-reserve"
                >
                  <PositiveNumberField
                    value={rig.range_reserve_fraction * 100}
                    onCommit={(n) => setRig({ range_reserve_fraction: n / 100 })}
                    step={1}
                    allowZero
                    className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
                    ariaLabel={t('settings.gas.dpv.rangeReserve.aria')}
                    testId="input-gas-dpv-range-reserve"
                  />
                </SettingRow>

                <SettingRow
                  label={t('settings.gas.dpv.usableRange.label')}
                  helpText={t('settings.gas.dpv.usableRange.help')}
                  data-testid="setting-gas-dpv-usable-range"
                >
                  <span className="font-mono text-sm" data-testid="gas-dpv-usable-range-value">
                    {formatGasLength(dpvUsableRangeM(rig), config.gas.units, 0)}
                  </span>
                </SettingRow>
              </div>
            )}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
