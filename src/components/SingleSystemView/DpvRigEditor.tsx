import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useGasPlanStore } from '../../store/gasPlanStore';
import { useProjectStore } from '../../store/projectStore';
import { PositiveNumberField } from '../common/PositiveNumberField';
import { Toggle } from '../common/Toggle';
import { formatGasLength, speedFromDisplay, speedToDisplay } from '../../utils/formatGas';
import { MAX_DPV_RANGE_RESERVE_FRACTION, dpvUsableRangeM, makeDefaultDpvRig } from '../../utils/dpv';
import type { DpvRig, DpvUnit } from '../../types/ipc.generated';

// Persist the DPV rig into the saved config - mirrors `writeSwimSpeedToDisk` in GasPlanPanel.tsx
// (reads the LATEST saved config at call time, so a write always merges against current state
// rather than a stale snapshot). Rig edits are commit-granularity: `PositiveNumberField` only
// calls `onCommit` on blur/Enter, not per keystroke, unlike the swim-speed field which fires on
// every keystroke and needs a trailing debounce to avoid one disk write per keystroke - a rig
// edit is already at most one write per field commit, so there is nothing to debounce here.
function writeDpvRigToDisk(rig: DpvRig | null): void {
  const saved = useProjectStore.getState().config;
  if (saved) {
    void useProjectStore.getState().updateConfig({
      ...saved,
      gas: { ...saved.gas, dpv: rig },
    });
  }
}

/**
 * The optional DPV (scooter) rig editor (#317) - a block under the cylinder table in the
 * Plan-mode bottom panel's "Equipment" tab. Moved out of Settings so the rig lives alongside
 * the rest of the dive's equipment rather than in a separate dialog. Every commit updates both
 * the working `gasConfig` (via `setDpvRig`, which also resets scootered segments and nulls the
 * cached reach field so the map overlay refetches) and the persisted config on disk, the same
 * two-write shape `GasPlanPanel`'s swim-speed field uses. `PositiveNumberField` blocks a
 * non-positive speed/burn entry at the field itself (it reverts to the last valid value), so an
 * invalid rig cannot be constructed here - Settings used to police this with a Save-blocking
 * validation effect; that effect (and its rig-specific checks) is gone along with the rig UI.
 */
export function DpvRigEditor() {
  const { t } = useTranslation();
  const { gasConfig, setDpvRig } = useGasPlanStore(
    useShallow((s) => ({
      gasConfig: s.gasConfig,
      setDpvRig: s.setDpvRig,
    }))
  );
  const units = gasConfig.units;
  const rig = gasConfig.dpv;

  const applyRig = (next: DpvRig | null) => {
    setDpvRig(next);
    writeDpvRigToDisk(next);
  };
  const setRig = (patch: Partial<DpvRig>) => {
    if (!rig) return;
    applyRig({ ...rig, ...patch });
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
    <div className="p-3 border-t border-border text-sm text-text-primary" data-testid="dpv-rig-editor">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wide opacity-60 font-semibold">
          {t('gasPanel.dpv.title')}
        </h3>
        <Toggle
          checked={rig != null}
          onChange={(v) => applyRig(v ? makeDefaultDpvRig() : null)}
          aria-label={t('gasPanel.dpv.enabled.aria')}
          data-testid="toggle-dpv-enabled"
        />
      </div>

      {rig && (
        <div className="space-y-1" data-testid="dpv-rig-fields">
          <Row
            label={t(
              units === 'imperial'
                ? 'gasPanel.dpv.primarySpeed.labelImperial'
                : 'gasPanel.dpv.primarySpeed.label'
            )}
            help={t('gasPanel.dpv.primarySpeed.help')}
          >
            <PositiveNumberField
              value={speedToDisplay(rig.primary.speed_m_per_min, units)}
              onCommit={(n) => setPrimary({ speed_m_per_min: speedFromDisplay(n, units) })}
              step={units === 'imperial' ? 5 : 1}
              className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
              ariaLabel={t(
                units === 'imperial'
                  ? 'gasPanel.dpv.primarySpeed.ariaImperial'
                  : 'gasPanel.dpv.primarySpeed.aria'
              )}
              testId="input-dpv-primary-speed"
            />
          </Row>

          <Row label={t('gasPanel.dpv.primaryBurn.label')} help={t('gasPanel.dpv.primaryBurn.help')}>
            <PositiveNumberField
              value={rig.primary.burn_minutes}
              onCommit={(n) => setPrimary({ burn_minutes: n })}
              step={1}
              className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
              ariaLabel={t('gasPanel.dpv.primaryBurn.aria')}
              testId="input-dpv-primary-burn"
            />
          </Row>

          <Row
            label={t(
              units === 'imperial'
                ? 'gasPanel.dpv.backupSpeed.labelImperial'
                : 'gasPanel.dpv.backupSpeed.label'
            )}
            help={t('gasPanel.dpv.backupSpeed.help')}
          >
            <PositiveNumberField
              value={speedToDisplay(rig.backup.speed_m_per_min, units)}
              onCommit={(n) => setBackup({ speed_m_per_min: speedFromDisplay(n, units) })}
              step={units === 'imperial' ? 5 : 1}
              className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
              ariaLabel={t(
                units === 'imperial'
                  ? 'gasPanel.dpv.backupSpeed.ariaImperial'
                  : 'gasPanel.dpv.backupSpeed.aria'
              )}
              testId="input-dpv-backup-speed"
            />
          </Row>

          <Row label={t('gasPanel.dpv.backupBurn.label')} help={t('gasPanel.dpv.backupBurn.help')}>
            <PositiveNumberField
              value={rig.backup.burn_minutes}
              onCommit={(n) => setBackup({ burn_minutes: n })}
              step={1}
              className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
              ariaLabel={t('gasPanel.dpv.backupBurn.aria')}
              testId="input-dpv-backup-burn"
            />
          </Row>

          <Row label={t('gasPanel.dpv.rangeReserve.label')} help={t('gasPanel.dpv.rangeReserve.help')}>
            <PositiveNumberField
              value={rig.range_reserve_fraction * 100}
              // Clamp the committed fraction into [0, MAX_DPV_RANGE_RESERVE_FRACTION] - the field
              // itself already blocks a negative entry (allowZero, not a plain positive-only gate);
              // only the upper bound needs clamping here, mirroring `GasConfig::normalize`'s cap.
              onCommit={(n) =>
                setRig({ range_reserve_fraction: Math.min(n / 100, MAX_DPV_RANGE_RESERVE_FRACTION) })
              }
              step={1}
              allowZero
              className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
              ariaLabel={t('gasPanel.dpv.rangeReserve.aria')}
              testId="input-dpv-range-reserve"
            />
          </Row>

          <Row label={t('gasPanel.dpv.usableRange.label')} help={t('gasPanel.dpv.usableRange.help')}>
            <span className="font-mono text-sm" data-testid="dpv-usable-range-value">
              {formatGasLength(dpvUsableRangeM(rig), units, 0)}
            </span>
          </Row>
        </div>
      )}
    </div>
  );
}

function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-text-secondary" title={help}>
        {label}
      </span>
      {children}
    </div>
  );
}
