import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { ChevronLeftIcon } from '../common/icons';
import { formatFixed } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { normalizeAzimuth, averageAzimuth } from '../../utils/azimuth';
import { setSource } from '../../utils/telemetry';
import type { Section, Shot, ShotUpdates } from '../../types/project';
import type { ProjectWarning } from '../../types/commands';

/** What a manual option needs to render as an inline editable field. */
type ManualKind =
  | 'azimuth' // single corrected azimuth, applied to both in & out
  | 'azimuthInOut' // separate in / out azimuths
  | 'length'
  | 'depth' // depth in / out
  | 'lrud'; // L R U D

interface ResolutionOption {
  id: string;
  /** Action label (e.g. "Average"); a computed value is appended in render. */
  label: string;
  /** Optional formatted preview value shown after the label, e.g. "(57.0°)". */
  detail?: string;
  /** Disabled (frozen / closure-adjusted view) — applies to data fixes. */
  disabled?: boolean;
  /** Reveals an inline editor when selected. */
  manual?: ManualKind;
  /** Selecting this navigates away instead of applying a fix. */
  navigate?: boolean;
  /** Suppress (Ignore) rather than fix the data. */
  ignore?: boolean;
}

interface WarningResolutionProps {
  warning: ProjectWarning;
  section: Section | undefined;
  shot: Shot | undefined;
  /** Present only during "Resolve all"; drives the "n of N" header + Skip. */
  position?: { index: number; total: number } | undefined;
  /** ‹ Back (single) / Exit (resolve-all). */
  onExit: () => void;
  /** A fix was applied or the warning was ignored — advance. */
  onResolved: () => void;
  /** Skip this warning without changing anything — advance. */
  onSkip: () => void;
}

const LRUD_FIELDS = ['left', 'right', 'up', 'down'] as const;
type LrudField = (typeof LRUD_FIELDS)[number];

export function WarningResolution({
  warning,
  section,
  shot,
  position,
  onExit,
  onResolved,
  onSkip,
}: WarningResolutionProps) {
  const { t } = useTranslation();
  const precision = useDecimalPrecision();
  const { updateShot, removeZeroDatum, resolveWarning, isShotFrozen } = useProjectStore(
    useShallow((s) => ({
      updateShot: s.updateShot,
      removeZeroDatum: s.removeZeroDatum,
      resolveWarning: s.resolveWarning,
      isShotFrozen: s.isShotFrozen,
    })),
  );
  const { setSelection, setDetailPanelTab, triggerCenterOnStation, showToast } = useUIStore(
    useShallow((s) => ({
      setSelection: s.setSelection,
      setDetailPanelTab: s.setDetailPanelTab,
      triggerCenterOnStation: s.triggerCenterOnStation,
      showToast: s.showToast,
    })),
  );
  const geometryReadOnly = useUIStore((s) => s.geometryMode === 'closureAdjusted');

  const frozen = isShotFrozen(warning.sectionId, warning.shotIndex);
  const geometryDisabled = geometryReadOnly || frozen;

  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  // Inline manual-edit fields (string-backed like EditShotDialog).
  const [manual, setManual] = useState<Record<string, string>>({});

  const az = (v: number) => `${formatFixed(v, undefined, precision.azimuth)}°`;
  const len = (v: number) => `${formatFixed(v, undefined, precision.length)} ${t('common.units.meters')}`;
  const dep = (v: number) => `${formatFixed(v, undefined, precision.depth)} ${t('common.units.meters')}`;

  // Which LRUD fields are negative (NEGATIVE_LRUD can flag any of them).
  const negativeLrud = useMemo<LrudField[]>(
    () => (shot ? LRUD_FIELDS.filter((f) => (shot[f] ?? 0) < 0) : []),
    [shot],
  );

  const options = useMemo<ResolutionOption[]>(() => {
    if (!shot) return [];
    const ignore: ResolutionOption = {
      id: 'ignore',
      label: t('detailPanel.warnings.resolveOptions.ignore'),
      ignore: true,
    };
    switch (warning.code) {
      case 'AZIMUTH_DEVIATION': {
        const avg = averageAzimuth(shot.azimuth_in, shot.azimuth_out);
        return [
          { id: 'use-in', label: t('detailPanel.warnings.resolveOptions.useIn'), detail: az(shot.azimuth_in), disabled: geometryDisabled },
          { id: 'use-out', label: t('detailPanel.warnings.resolveOptions.useOut'), detail: az(shot.azimuth_out), disabled: geometryDisabled },
          { id: 'average', label: t('detailPanel.warnings.resolveOptions.average'), detail: az(avg), disabled: geometryDisabled },
          { id: 'manual', label: t('detailPanel.warnings.resolveOptions.manual'), manual: 'azimuth', disabled: geometryDisabled },
          ignore,
        ];
      }
      case 'INVALID_AZIMUTH':
        return [
          { id: 'normalize', label: t('detailPanel.warnings.resolveOptions.normalize'), detail: `${az(normalizeAzimuth(shot.azimuth_in))} / ${az(normalizeAzimuth(shot.azimuth_out))}`, disabled: geometryDisabled },
          { id: 'manual', label: t('detailPanel.warnings.resolveOptions.manual'), manual: 'azimuthInOut', disabled: geometryDisabled },
          ignore,
        ];
      case 'ZERO_LENGTH':
      case 'NEGATIVE_LENGTH':
      case 'SHORT_SHOT':
      case 'LONG_SHOT':
        return [
          { id: 'manual', label: t('detailPanel.warnings.resolveOptions.manualLength'), manual: 'length', disabled: geometryDisabled },
          ignore,
        ];
      case 'LARGE_DEPTH_CHANGE':
        return [
          { id: 'manual', label: t('detailPanel.warnings.resolveOptions.manualDepth'), manual: 'depth', disabled: geometryDisabled },
          ignore,
        ];
      case 'NEGATIVE_LRUD':
        return [
          { id: 'lrud-abs', label: t('detailPanel.warnings.resolveOptions.useAbs'), disabled: geometryReadOnly },
          { id: 'lrud-clear', label: t('detailPanel.warnings.resolveOptions.clear'), disabled: geometryReadOnly },
          { id: 'manual', label: t('detailPanel.warnings.resolveOptions.manual'), manual: 'lrud', disabled: geometryReadOnly },
          ignore,
        ];
      case 'multiple_datums_per_merge_component':
        return [
          { id: 'remove-datum', label: t('detailPanel.warnings.resolveOptions.removeDatum'), disabled: geometryReadOnly || warning.datumStationIndex === undefined },
          { id: 'go-to-station', label: t('detailPanel.warnings.resolveOptions.goToStation'), navigate: true },
          ignore,
        ];
      default:
        return [ignore];
    }
  }, [warning.code, warning.datumStationIndex, shot, geometryDisabled, geometryReadOnly, t, precision]);

  // Default to the first enabled option (falls back to Ignore when every fix
  // is locked, e.g. a frozen shot in the closure-adjusted view).
  useEffect(() => {
    const firstEnabled = options.find((o) => !o.disabled) ?? options[options.length - 1];
    setSelected(firstEnabled?.id ?? '');
    if (shot) {
      setManual({
        azimuth: '',
        azimuthIn: shot.azimuth_in.toString(),
        azimuthOut: shot.azimuth_out.toString(),
        length: shot.length > 0 ? shot.length.toString() : '',
        depthIn: shot.depth_in.toString(),
        depthOut: shot.depth_out.toString(),
        left: shot.left?.toString() ?? '',
        right: shot.right?.toString() ?? '',
        up: shot.up?.toString() ?? '',
        down: shot.down?.toString() ?? '',
      });
    }
    // Re-seed only when the warning being resolved changes (resolve-all
    // stepping). Deliberately NOT keyed on `options`/`shot` object identity: a
    // background project refresh rebuilds those references and would otherwise
    // wipe the user's in-progress manual edit and reset their selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warning.sectionId, warning.shotId, warning.code]);

  const num = (key: string): number => parseFloat(manual[key] ?? '');

  /**
   * Apply the selected option.
   * - 'resolved': a suppression/fix was applied (advance + count).
   * - 'navigated': the user jumped elsewhere; do not count as resolved.
   * - 'failed': nothing applied (validation/command error); stay put.
   */
  const apply = async (): Promise<'resolved' | 'navigated' | 'failed'> => {
    if (!shot || !section) return 'failed';
    const opt = options.find((o) => o.id === selected);
    if (!opt) return 'failed';

    if (opt.ignore) {
      await resolveWarning(warning.sectionId, warning.shotId, warning.code);
      return 'resolved';
    }

    if (opt.navigate) {
      if (warning.datumStationIndex !== undefined) {
        const ref = { section_id: warning.sectionId, station_index: warning.datumStationIndex };
        setSource('detail-panel');
        setSelection({ type: 'station', stationRef: ref });
        triggerCenterOnStation(ref);
        setDetailPanelTab('details');
      }
      return 'navigated'; // jumped to the station; nothing was suppressed or fixed
    }

    if (opt.id === 'remove-datum') {
      if (warning.datumStationIndex === undefined) return 'failed';
      const result = await removeZeroDatum({ section_id: warning.sectionId, station_index: warning.datumStationIndex });
      if (!result.success) showToast(result.error ?? t('detailPanel.warnings.resolveFailed'), 'warning-resolve');
      return result.success ? 'resolved' : 'failed';
    }

    // Data fixes via the undoable update_shot command.
    const patch: Partial<ShotUpdates> = {};
    switch (opt.id) {
      case 'use-in':
        patch.azimuth_out = shot.azimuth_in;
        break;
      case 'use-out':
        patch.azimuth_in = shot.azimuth_out;
        break;
      case 'average': {
        const avg = averageAzimuth(shot.azimuth_in, shot.azimuth_out);
        patch.azimuth_in = avg;
        patch.azimuth_out = avg;
        break;
      }
      case 'normalize':
        patch.azimuth_in = normalizeAzimuth(shot.azimuth_in);
        patch.azimuth_out = normalizeAzimuth(shot.azimuth_out);
        break;
      case 'lrud-abs':
        for (const f of negativeLrud) patch[f] = Math.abs(shot[f] ?? 0);
        break;
      case 'lrud-clear':
        for (const f of negativeLrud) patch[f] = null;
        break;
      case 'manual':
        if (opt.manual === 'azimuth') {
          const v = num('azimuth');
          if (Number.isNaN(v)) { showToast(t('detailPanel.warnings.resolveInvalid'), 'warning-resolve'); return 'failed'; }
          const n = normalizeAzimuth(v);
          patch.azimuth_in = n;
          patch.azimuth_out = n;
        } else if (opt.manual === 'azimuthInOut') {
          const vi = num('azimuthIn'); const vo = num('azimuthOut');
          if (Number.isNaN(vi) || Number.isNaN(vo)) { showToast(t('detailPanel.warnings.resolveInvalid'), 'warning-resolve'); return 'failed'; }
          patch.azimuth_in = normalizeAzimuth(vi);
          patch.azimuth_out = normalizeAzimuth(vo);
        } else if (opt.manual === 'length') {
          const v = num('length');
          if (Number.isNaN(v) || v <= 0) { showToast(t('detailPanel.warnings.resolveInvalidLength'), 'warning-resolve'); return 'failed'; }
          patch.length = v;
        } else if (opt.manual === 'depth') {
          const vi = num('depthIn'); const vo = num('depthOut');
          if (Number.isNaN(vi) || Number.isNaN(vo)) { showToast(t('detailPanel.warnings.resolveInvalid'), 'warning-resolve'); return 'failed'; }
          patch.depth_in = vi;
          patch.depth_out = vo;
        } else if (opt.manual === 'lrud') {
          for (const f of LRUD_FIELDS) {
            const raw = manual[f]?.trim() ?? '';
            patch[f] = raw === '' ? null : parseFloat(raw);
          }
          if (LRUD_FIELDS.some((f) => patch[f] !== null && Number.isNaN(patch[f] as number))) {
            showToast(t('detailPanel.warnings.resolveInvalid'), 'warning-resolve');
            return 'failed';
          }
        }
        break;
      default:
        return 'failed';
    }

    // Guard against a no-op (e.g. lrud-abs/clear when nothing is negative after a
    // refresh): an empty patch would still push an undo entry and report success.
    if (Object.keys(patch).length === 0) {
      showToast(t('detailPanel.warnings.resolveInvalid'), 'warning-resolve');
      return 'failed';
    }

    const result = await updateShot(warning.sectionId, warning.shotId, patch);
    if (!result.success) showToast(result.error ?? t('detailPanel.warnings.resolveFailed'), 'warning-resolve');
    return result.success ? 'resolved' : 'failed';
  };

  const handleApply = async () => {
    setBusy(true);
    try {
      const result = await apply();
      if (result === 'resolved') onResolved();
      else if (result === 'navigated') onExit();
      // 'failed' → stay on this warning (a toast explained why).
    } finally {
      setBusy(false);
    }
  };

  const isResolveAll = position !== undefined;
  const selectedOption = options.find((o) => o.id === selected);

  return (
    <div className="p-2" data-testid="warning-resolution">
      {/* Header: back + (n of N) */}
      <div className="flex items-center justify-between mb-2 px-1">
        <button
          onClick={onExit}
          className="flex items-center gap-1 text-sm text-accent hover:underline"
          data-testid="warning-resolution-back"
        >
          <ChevronLeftIcon size={16} />
          {isResolveAll ? t('detailPanel.warnings.resolveExit') : t('detailPanel.warnings.resolveBack')}
        </button>
        {isResolveAll && position && (
          <span className="text-xs text-text-secondary" data-testid="warning-resolution-progress">
            {t('detailPanel.warnings.resolvePosition', { index: position.index + 1, total: position.total })}
          </span>
        )}
      </div>

      {/* The warning + current values */}
      <div className="px-1 mb-3">
        <div className="text-sm text-text-primary">{warning.message}</div>
        {shot && (warning.code === 'AZIMUTH_DEVIATION' || warning.code === 'INVALID_AZIMUTH') && (
          <div className="text-xs text-text-secondary mt-1">
            {t('detailPanel.labels.azimuthIn')} {az(shot.azimuth_in)} · {t('detailPanel.labels.azimuthOut')} {az(shot.azimuth_out)}
          </div>
        )}
        {shot && warning.code === 'LARGE_DEPTH_CHANGE' && (
          <div className="text-xs text-text-secondary mt-1">
            {t('detailPanel.labels.depthIn')} {dep(shot.depth_in)} · {t('detailPanel.labels.depthOut')} {dep(shot.depth_out)}
          </div>
        )}
        {shot && (warning.code === 'ZERO_LENGTH' || warning.code === 'NEGATIVE_LENGTH' || warning.code === 'SHORT_SHOT' || warning.code === 'LONG_SHOT') && (
          <div className="text-xs text-text-secondary mt-1">{t('detailPanel.labels.length')} {len(shot.length)}</div>
        )}
      </div>

      {!shot ? (
        <div className="px-1 text-sm text-text-secondary">{t('detailPanel.selectionNotFound')}</div>
      ) : (
        <div className="border-t border-border pt-2 space-y-1" role="radiogroup" aria-label={t('detailPanel.warnings.resolveTitle')}>
          {options.map((opt) => (
            <div key={opt.id}>
              <label
                className={`flex items-center gap-2 px-1 py-1 rounded text-sm cursor-pointer hover:bg-background-50 ${opt.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <input
                  type="radio"
                  name="warning-resolution-option"
                  value={opt.id}
                  checked={selected === opt.id}
                  disabled={opt.disabled}
                  onChange={() => setSelected(opt.id)}
                  data-testid={`warning-resolution-option-${opt.id}`}
                />
                <span>
                  {opt.label}
                  {opt.detail && <span className="text-text-secondary"> ({opt.detail})</span>}
                </span>
              </label>
              {/* Inline manual editors, shown when their option is selected. */}
              {selected === opt.id && opt.manual && (
                <div className="pl-6 pr-1 pb-1">
                  {opt.manual === 'azimuth' && (
                    <ManualField value={manual.azimuth ?? ''} onChange={(v) => setManual((m) => ({ ...m, azimuth: v }))} unit="°" placeholder={t('detailPanel.labels.azimuthIn')} testId="manual-azimuth" />
                  )}
                  {opt.manual === 'azimuthInOut' && (
                    <div className="grid grid-cols-2 gap-2">
                      <ManualField value={manual.azimuthIn ?? ''} onChange={(v) => setManual((m) => ({ ...m, azimuthIn: v }))} unit="°" placeholder={t('detailPanel.labels.azimuthIn')} testId="manual-azimuth-in" />
                      <ManualField value={manual.azimuthOut ?? ''} onChange={(v) => setManual((m) => ({ ...m, azimuthOut: v }))} unit="°" placeholder={t('detailPanel.labels.azimuthOut')} testId="manual-azimuth-out" />
                    </div>
                  )}
                  {opt.manual === 'length' && (
                    <ManualField value={manual.length ?? ''} onChange={(v) => setManual((m) => ({ ...m, length: v }))} unit={t('common.units.meters')} placeholder={t('detailPanel.labels.length')} testId="manual-length" />
                  )}
                  {opt.manual === 'depth' && (
                    <div className="grid grid-cols-2 gap-2">
                      <ManualField value={manual.depthIn ?? ''} onChange={(v) => setManual((m) => ({ ...m, depthIn: v }))} unit={t('common.units.meters')} placeholder={t('detailPanel.labels.depthIn')} testId="manual-depth-in" />
                      <ManualField value={manual.depthOut ?? ''} onChange={(v) => setManual((m) => ({ ...m, depthOut: v }))} unit={t('common.units.meters')} placeholder={t('detailPanel.labels.depthOut')} testId="manual-depth-out" />
                    </div>
                  )}
                  {opt.manual === 'lrud' && (
                    <div className="grid grid-cols-4 gap-2">
                      {LRUD_FIELDS.map((f) => (
                        <ManualField key={f} value={manual[f] ?? ''} onChange={(v) => setManual((m) => ({ ...m, [f]: v }))} placeholder={f[0]!.toUpperCase()} testId={`manual-${f}`} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between gap-2 pt-3 mt-2 border-t border-border">
        {isResolveAll ? (
          <Button size="sm" onClick={onSkip} disabled={busy} data-testid="warning-resolution-skip">
            {t('detailPanel.warnings.resolveSkip')}
          </Button>
        ) : (
          <span />
        )}
        <Button
          size="sm"
          variant="primary"
          onClick={() => void handleApply()}
          disabled={busy || !shot || !selectedOption || (selectedOption.disabled ?? false)}
          data-testid="warning-resolution-apply"
        >
          {isResolveAll ? t('detailPanel.warnings.resolveApplyNext') : t('detailPanel.warnings.resolveApply')}
        </Button>
      </div>
    </div>
  );
}

function ManualField({
  value,
  onChange,
  unit,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        inputMode="decimal"
        step="0.1"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full"
        data-testid={testId}
      />
      {unit && <span className="text-xs text-text-secondary">{unit}</span>}
    </div>
  );
}
